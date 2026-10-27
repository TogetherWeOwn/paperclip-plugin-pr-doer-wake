import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { SecretRef } from "./config.js";

/** A resolved secret is reused for this long before the next host resolution. */
export const SECRET_TTL_MS = 10 * 60_000;
/** After a verification miss, at most one re-resolution per key in this window. */
export const SECRET_MISS_BACKOFF_MS = 60_000;

type Entry = { value: string | null; fetchedAt: number; attemptedAt: number };

/**
 * Worker-memory cache of resolved secrets, keyed by company, config path, secret id and version.
 *
 * The host allows 30 resolutions per minute per company and plugin (createRateLimiter(30, 60_000) in
 * /app/server/src/services/plugin-secrets-handler.ts:195), and the webhook route is public and also accepts the
 * plugin key (resolvePlugin in /app/server/src/routes/plugins.ts:377), so anyone can POST to it. Resolving per
 * delivery would let forged traffic spend that shared budget. Values live only in this process: never in plugin
 * state, config, logs or error messages (PLUGIN_SPEC.md section 22).
 */
export class SecretCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private key(companyId: string, ref: SecretRef, configPath: string): string {
    return `${companyId}|${configPath}|${ref.secretId}|${ref.version ?? "latest"}`;
  }

  /** The cached value while fresh; never resolves. */
  peek(companyId: string, ref: SecretRef, configPath: string): string | null {
    const entry = this.entries.get(this.key(companyId, ref, configPath));
    return entry?.value && this.now() - entry.fetchedAt < SECRET_TTL_MS ? entry.value : null;
  }

  /** The cached value, or one host resolution when missing or expired. Host refusals (rate limit) are thrown. */
  async get(ctx: PluginContext, companyId: string, ref: SecretRef, configPath: string): Promise<string> {
    return this.peek(companyId, ref, configPath) ?? this.resolve(ctx, companyId, ref, configPath);
  }

  /**
   * Re-resolve after a verification miss (rotation), at most once per SECRET_MISS_BACKOFF_MS per key, so forged
   * deliveries cost at most one resolution per minute per company. Null while backing off or when the host refuses.
   */
  async refresh(ctx: PluginContext, companyId: string, ref: SecretRef, configPath: string): Promise<string | null> {
    const entry = this.entries.get(this.key(companyId, ref, configPath));
    if (entry && this.now() - entry.attemptedAt < SECRET_MISS_BACKOFF_MS) return null;
    try {
      return await this.resolve(ctx, companyId, ref, configPath);
    } catch (error) {
      ctx.logger.warn("pr-doer-wake: secret resolution refused", { companyId, configPath, error: error instanceof Error ? error.name : "error" });
      return null;
    }
  }

  invalidate(companyId: string, ref: SecretRef, configPath: string): void {
    this.entries.delete(this.key(companyId, ref, configPath));
  }

  clear(): void {
    this.entries.clear();
  }

  private async resolve(ctx: PluginContext, companyId: string, ref: SecretRef, configPath: string): Promise<string> {
    const key = this.key(companyId, ref, configPath);
    const now = this.now();
    const previous = this.entries.get(key);
    this.entries.set(key, { value: previous?.value ?? null, fetchedAt: previous?.fetchedAt ?? 0, attemptedAt: now });
    const value = await ctx.secrets.resolve(ref as never, { companyId, configPath });
    this.entries.set(key, { value, fetchedAt: now, attemptedAt: now });
    return value;
  }
}
