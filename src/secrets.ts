import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { SecretRef } from "./config.js";

/** A resolved secret is reused for this long before the next host resolution is scheduled. */
export const SECRET_TTL_MS = 10 * 60_000;
/**
 * Hard limit on verifying with a value past its TTL. Only a rate-limited re-resolution keeps an expired value at all
 * (every other failure evicts it); past this age it is refused even then.
 */
export const SECRET_MAX_STALE_MS = 30 * 60_000;
/**
 * After a verification miss, at most one re-resolution per key in this window; also how long a failed resolution
 * (secret unbound, deactivated or deleted, or the host's rate limit) is cached before `get` resolves again.
 */
export const SECRET_MISS_BACKOFF_MS = 60_000;
/** After GitHub rejects the token (HTTP 401), no re-resolution of it for this long. */
export const SECRET_REJECTED_BACKOFF_MS = 5 * 60_000;

/** `retryAfter`: no resolution through `get` before this time (negative cache after a failure or a 401). */
type Entry = { value: string | null; fetchedAt: number; attemptedAt: number; retryAfter: number };

/** Thrown by `get` while a failed or rejected secret backs off. Callers treat it as transient. */
export class SecretBackoffError extends Error {
  override name = "SecretBackoffError";
}

/**
 * The host's 30/min refusal (plugin-secrets-handler.ts:233-236). Only the message crosses the worker RPC bridge
 * (JsonRpcCallError), so match it as well as the host-side error name.
 */
export function isRateLimited(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "RateLimitExceededError" || /rate limit exceeded for secret resolution/i.test(error.message);
}

/**
 * Worker-memory cache of resolved secrets, keyed by company, config path, secret id and version.
 *
 * The host allows 30 resolutions per minute per company and plugin (createRateLimiter(30, 60_000) in
 * /app/server/src/services/plugin-secrets-handler.ts:195), shared by every secret this plugin reads, and the
 * webhook route is public and also accepts the plugin key (resolvePlugin in /app/server/src/routes/plugins.ts:377),
 * so anyone can POST to it. Resolving per delivery would let forged traffic spend that shared budget.
 *
 * One resolution per key runs at a time: the SDK dispatches host requests concurrently (worker-rpc-host.ts does not
 * await handleHostRequest), so concurrent callers await the in-flight promise instead of failing.
 *
 * Values live only in this process: never in plugin state, config, logs or error messages (PLUGIN_SPEC.md section 22).
 *
 * Fails closed: the SDK says resolved values must not be cached (types.ts, secrets.resolve), so this cache exists only
 * for the budget above. A re-resolution that fails for any reason other than the rate limit (secret deactivated,
 * binding removed, secret deleted) evicts the value at once, and an expired value is never used past
 * SECRET_MAX_STALE_MS.
 */
export class SecretCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private key(companyId: string, ref: SecretRef, configPath: string): string {
    return `${companyId}|${configPath}|${ref.secretId}|${ref.version ?? "latest"}`;
  }

  /** The cached value while fresh; never resolves. */
  peek(companyId: string, ref: SecretRef, configPath: string): string | null {
    const entry = this.entries.get(this.key(companyId, ref, configPath));
    return entry?.value && this.now() - entry.fetchedAt < SECRET_TTL_MS ? entry.value : null;
  }

  /**
   * The cached value even past the TTL, up to SECRET_MAX_STALE_MS. An HMAC match with it still proves a delivery is
   * authentic, so expiry only schedules a re-resolution (`revalidate`); a rotated value replaces it when that lands,
   * and a failed one (other than the rate limit) evicts it.
   */
  cached(companyId: string, ref: SecretRef, configPath: string): { value: string; expired: boolean } | null {
    const entry = this.entries.get(this.key(companyId, ref, configPath));
    if (!entry?.value) return null;
    const age = this.now() - entry.fetchedAt;
    if (age >= SECRET_MAX_STALE_MS) return null;
    return { value: entry.value, expired: age >= SECRET_TTL_MS };
  }

  /**
   * The fresh cached value, else one shared host resolution. Throws host refusals, and SecretBackoffError while a
   * failed or rejected secret backs off (negative cache), so an unbound or deactivated secret costs one resolution
   * per backoff window however many lookups ask for it.
   */
  async get(ctx: PluginContext, companyId: string, ref: SecretRef, configPath: string): Promise<string> {
    const fresh = this.peek(companyId, ref, configPath);
    if (fresh) return fresh;
    const entry = this.entries.get(this.key(companyId, ref, configPath));
    if (entry && this.now() < entry.retryAfter) throw new SecretBackoffError(`${configPath} could not be resolved; backing off`);
    return this.resolveOnce(ctx, companyId, ref, configPath);
  }

  /**
   * Re-resolve after a verification miss (rotation). Joins a resolution already in flight; otherwise at most once
   * per SECRET_MISS_BACKOFF_MS per key, so forged deliveries cost at most one resolution per minute per company.
   * Null while backing off or when the host refuses.
   */
  async refresh(ctx: PluginContext, companyId: string, ref: SecretRef, configPath: string): Promise<string | null> {
    const key = this.key(companyId, ref, configPath);
    const running = this.inflight.get(key);
    const entry = this.entries.get(key);
    if (!running && entry && (this.now() - entry.attemptedAt < SECRET_MISS_BACKOFF_MS || this.now() < entry.retryAfter)) return null;
    try {
      return await (running ?? this.resolveOnce(ctx, companyId, ref, configPath));
    } catch (error) {
      ctx.logger.warn("pr-doer-wake: secret resolution refused", { companyId, configPath, error: error instanceof Error ? error.name : "error" });
      return null;
    }
  }

  /** Schedule one background re-resolution of an expired value (no-op while one runs or within the miss backoff). */
  revalidate(ctx: PluginContext, companyId: string, ref: SecretRef, configPath: string): void {
    void this.refresh(ctx, companyId, ref, configPath);
  }

  /** GitHub rejected this secret (HTTP 401): drop it and do not re-resolve it for SECRET_REJECTED_BACKOFF_MS. */
  reject(companyId: string, ref: SecretRef, configPath: string): void {
    const now = this.now();
    this.entries.set(this.key(companyId, ref, configPath), { value: null, fetchedAt: 0, attemptedAt: now, retryAfter: now + SECRET_REJECTED_BACKOFF_MS });
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  private resolveOnce(ctx: PluginContext, companyId: string, ref: SecretRef, configPath: string): Promise<string> {
    const key = this.key(companyId, ref, configPath);
    const running = this.inflight.get(key);
    if (running) return running;
    const now = this.now();
    const previous = this.entries.get(key);
    this.entries.set(key, { value: previous?.value ?? null, fetchedAt: previous?.fetchedAt ?? 0, attemptedAt: now, retryAfter: 0 });
    let request: Promise<string>;
    try {
      request = Promise.resolve(ctx.secrets.resolve(ref as never, { companyId, configPath }));
    } catch (error) {
      request = Promise.reject(error);
    }
    const promise = request.then(
      (value) => {
        this.entries.set(key, { value, fetchedAt: now, attemptedAt: now, retryAfter: 0 });
        return value;
      },
      (error: unknown) => {
        // Fail closed: keep the old value only when the host merely rate-limited this resolution. Either way, cache
        // the failure for SECRET_MISS_BACKOFF_MS so repeated lookups cannot spend the shared 30/min budget.
        const kept = isRateLimited(error) ? this.entries.get(key) : undefined;
        this.entries.set(key, { value: kept?.value ?? null, fetchedAt: kept?.fetchedAt ?? 0, attemptedAt: now, retryAfter: now + SECRET_MISS_BACKOFF_MS });
        throw error;
      },
    );
    this.inflight.set(key, promise);
    const settle = () => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    };
    promise.then(settle, settle);
    return promise;
  }
}
