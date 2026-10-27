import { definePlugin, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { parseConfig, validateConfig, type DoerWakeConfig, type SecretRef } from "./config.js";
import { DB_NAMESPACE, SWEEP_JOB_KEY, WEBHOOK_KEY } from "./constants.js";
import {
  evaluate,
  fingerprint,
  ONE_PR_QUERY,
  ONE_PR_WITH_CHECKS_QUERY,
  OPEN_PRS_QUERY,
  mayAct,
  ownerOf,
  parseEvent,
  policySkip,
  prStateFromGraph,
  SIGNATURE_RE,
  SUBSCRIBED_EVENTS,
  verifySignature,
  type GraphPr,
  type PrCheck,
  type Signal,
} from "./github.js";
import { SecretCache } from "./secrets.js";
import { MAX_RETRIES, compactSql, reclaimSql, retryableSql, seenSql } from "./sql.js";
import { deferSignal, forget, markUnconfirmed, recordOutcome, wakeForSignal, type WakeResult } from "./waker.js";

let ctxRef: PluginContext | null = null;
let lock: Promise<unknown> = Promise.resolve();
/** The sweep running in this worker, if any (single flight; see runSweep). */
let sweepInflight: Promise<WakeResult[]> | null = null;
const secrets = new SecretCache();
const MAX_SWEEP_ATTEMPTS = 6;
type OpenPrsConnection = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GraphPr[] };
type OpenPrsData = { repository: { pullRequests: OpenPrsConnection } | null };
/** A repo whose default branch moved. `cursor` resumes a sweep that hit sweepMaxPages; `unknownSeen` carries UNKNOWN mergeability across those pages. */
type SweepMark = { since: string; attempts: number; cursor?: string | null; unknownSeen?: boolean };
type Company = { companyId: string; config: DoerWakeConfig };

/** Serialize read-modify-write of plugin state inside this single worker. Never nest. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = lock.then(fn, fn);
  lock = next.catch(() => undefined);
  return next;
}

function requireCtx(): PluginContext {
  if (!ctxRef) throw new Error("pr-doer-wake is not set up");
  return ctxRef;
}

const SWEEP_KEY = { scopeKind: "instance" as const, namespace: "sweep", stateKey: "repos" };

function header(headers: PluginWebhookInput["headers"], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function companiesFor(ctx: PluginContext, owner: string | null): Promise<Company[]> {
  const out = [];
  for (const company of await ctx.companies.list()) {
    const config = parseConfig(await ctx.config.get(company.id));
    if (!config.enabled || validateConfig(config).length > 0) continue;
    if (owner && config.githubOrg.toLowerCase() !== owner.toLowerCase()) continue;
    out.push({ companyId: company.id, config });
  }
  return out;
}

/**
 * The company whose webhook secret signed this body. Cached secrets first, even past their TTL (an HMAC match
 * still proves authenticity; expiry only schedules one background re-resolution). Only on a miss, one
 * re-resolution per company per backoff window, joined by concurrent deliveries, so forged deliveries cannot drain
 * the 30/min resolution budget and genuine ones are never refused while it runs.
 */
async function verifiedCompany(ctx: PluginContext, candidates: Company[], rawBody: string, signature: string): Promise<Company | null> {
  const ref = (c: Company) => c.config.webhookSecretRef as SecretRef;
  for (const c of candidates) {
    const cached = secrets.cached(c.companyId, ref(c), "webhookSecretRef");
    if (cached && verifySignature(cached.value, rawBody, signature)) {
      if (cached.expired) secrets.revalidate(ctx, c.companyId, ref(c), "webhookSecretRef");
      return c;
    }
  }
  for (const c of candidates) {
    const secret = await secrets.refresh(ctx, c.companyId, ref(c), "webhookSecretRef");
    if (secret && verifySignature(secret, rawBody, signature)) return c;
  }
  return null;
}

/** What the GitHub token must be allowed to read (README "GitHub token"). */
export const TOKEN_PERMISSIONS =
  "pull requests and check runs of every repo in githubOrg: a classic token (no scope for public repos, `repo` for private ones) or another token with Pull requests: read and Checks: read; fine-grained personal access tokens cannot read check runs";

type GraphqlError = { type?: string; message?: string; path?: unknown[] };

async function githubGraphql<T>(ctx: PluginContext, companyId: string, config: DoerWakeConfig, query: string, variables: Record<string, unknown>): Promise<T | null> {
  if (!config.githubTokenSecretRef) throw new Error("githubTokenSecretRef is not configured");
  const token = await secrets.get(ctx, companyId, config.githubTokenSecretRef, "githubTokenSecretRef");
  const response = await ctx.http.fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "paperclip-pr-doer-wake" },
    body: JSON.stringify({ query, variables }),
  });
  // A dead token (expired PAT) must not re-resolve on every lookup: the budget is shared with the webhook secret.
  if (response.status === 401) secrets.reject(companyId, config.githubTokenSecretRef, "githubTokenSecretRef");
  if (!response.ok) throw new Error(`GitHub GraphQL HTTP ${response.status}`);
  const body = (await response.json()) as { data?: T; errors?: GraphqlError[] };
  if (body.errors) {
    // A field the token may not read comes back as a partial error beside partial data: a config error, never
    // read as "PR closed" or "check not red". The signal stays retryable and wakes once the token is fixed.
    const denied = (Array.isArray(body.errors) ? body.errors : []).filter(
      (e) => e?.type === "FORBIDDEN" || e?.type === "INSUFFICIENT_SCOPES" || /not accessible by/i.test(String(e?.message ?? "")),
    );
    if (denied.length > 0) {
      const paths = denied.map((e) => (Array.isArray(e.path) ? e.path.join(".") : "?"));
      ctx.logger.error("pr-doer-wake: GitHub token lacks a permission (config error); the signal is kept and retried", {
        companyId, paths, types: denied.map((e) => e.type ?? null), needs: TOKEN_PERMISSIONS,
      });
      throw new Error(`GitHub token lacks a permission for ${paths.join(", ")}`);
    }
    throw new Error("GitHub GraphQL returned errors");
  }
  return body.data ?? null;
}

/**
 * Is this signal's PR open, trusted, non-draft and on this head right now, and for a check signal is that check still
 * red there? Always one GraphQL read: webhook payloads arrive late, out of order and with tied updated_at values,
 * draft conversion or closing does not change the head, and checks are re-run on the same head, so nothing cached
 * can authorize a wake. Fails closed: unreadable is transient, missing is closed.
 */
async function currentPrState(ctx: PluginContext, companyId: string, config: DoerWakeConfig, signal: Signal): Promise<PrCheck> {
  const [owner, name] = signal.repo.split("/");
  let pr: GraphPr | null | undefined;
  try {
    const data = await githubGraphql<{ repository: { pullRequest: GraphPr | null } | null }>(
      ctx, companyId, config,
      signal.state === "conflict" ? ONE_PR_QUERY : ONE_PR_WITH_CHECKS_QUERY,
      { o: owner, r: name, n: signal.number },
    );
    pr = data?.repository?.pullRequest;
  } catch (error) {
    return { kind: "transient", detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
  if (!pr) return { kind: "skip", outcome: "skipped_closed", detail: "PR not found" };
  return evaluate(prStateFromGraph(signal.repo, pr, config), signal, config);
}

type LedgerRow = {
  fingerprint: string;
  outcome: string;
  attempts: number;
  updated_at: string;
  signal: string;
  issue_id: string | null;
  comment_posted_at: string | null;
  wake_attempted_at: string | null;
};

/**
 * A row whose wake was never requested and that no attempt holds right now: a signal may resume it at once.
 * `stale:<reason>` rows were written by builds before 0.1.2 final for skips that did not burn anything.
 */
function resumable(row: LedgerRow): boolean {
  const pending = row.outcome === "error" || row.outcome === "no_card" || row.outcome.startsWith("stale:");
  return pending && !row.wake_attempted_at && row.signal !== "{}";
}

/**
 * Take one ledger row (conditional UPDATE, rowCount 1 = this attempt owns it) and finish it: re-apply policy and
 * re-read the PR from GitHub, then wake, keep it for another retry, or forget it. Shared by the sweep and by an
 * authenticated redelivery (`fresh`, the newly delivered signal for the same fingerprint, whose run identity tells
 * GitHub read lag from a recovered check). A row whose wake may have reached the host is closed as
 * wake_unconfirmed and never requested again; a row past MAX_RETRIES is forgotten so a later signal starts over.
 */
async function retryRow(ctx: PluginContext, companyId: string, config: DoerWakeConfig, row: LedgerRow, fresh?: Signal): Promise<WakeResult> {
  const ns = ctx.db.namespace || DB_NAMESPACE;
  const fp = row.fingerprint;
  const claimed = await ctx.db.execute(reclaimSql(ns), [companyId, fp, row.outcome, row.updated_at]);
  if (claimed.rowCount !== 1) return { fingerprint: fp, outcome: "duplicate", detail: "taken by another attempt" };
  if (row.wake_attempted_at) {
    // Sent before, result unknown: never requested twice (no host receipt to tell; see markUnconfirmed).
    return markUnconfirmed(ctx, companyId, fp, row.issue_id, "an earlier attempt already requested the wake");
  }
  if (Number(row.attempts) >= MAX_RETRIES) {
    await forget(ctx, companyId, fp);
    ctx.logger.warn("pr-doer-wake: retries spent; the row is forgotten and a later signal starts over", { fingerprint: fp, lastOutcome: row.outcome });
    return { fingerprint: fp, outcome: "gave_up", detail: row.outcome };
  }
  const signal = fresh ?? (JSON.parse(row.signal) as Signal);
  const policy = policySkip(config, signal);
  if (policy) {
    await forget(ctx, companyId, fp);
    return { fingerprint: fp, outcome: policy };
  }
  const check = await currentPrState(ctx, companyId, config, signal);
  if (check.kind === "transient") {
    await recordOutcome(ctx, companyId, fp, "error", row.issue_id);
    return { fingerprint: fp, outcome: "deferred", detail: check.detail };
  }
  if (check.kind === "skip") {
    // Not woken: forgotten, so a later genuine signal on the same head and state can still wake.
    await forget(ctx, companyId, fp);
    return { fingerprint: fp, outcome: check.outcome, detail: check.detail };
  }
  return wakeForSignal(ctx, companyId, config, check.signal, {
    retry: { issueId: row.issue_id, commentPostedAt: row.comment_posted_at, wakeAttemptedAt: row.wake_attempted_at },
  });
}

export async function handleGithubEvent(eventName: string, payload: Record<string, any>, companyId: string, config: DoerWakeConfig): Promise<WakeResult[]> {
  const ctx = requireCtx();
  const parsed = parseEvent(eventName, payload, config);
  if (parsed.sweepRepos.length > 0) {
    await serialized(async () => {
      const marks = ((await ctx.state.get(SWEEP_KEY)) as Record<string, SweepMark> | null) ?? {};
      for (const repo of parsed.sweepRepos) marks[`${companyId}|${repo}`] = { since: new Date().toISOString(), attempts: 0 };
      await ctx.state.set(SWEEP_KEY, marks);
    });
  }
  const results: WakeResult[] = [];
  for (const raw of parsed.signals) {
    const fp = fingerprint(raw);
    if (!config.wakeStates.includes(raw.state)) {
      results.push({ fingerprint: fp, outcome: "skipped_state" });
      continue;
    }
    const [existing] = await ctx.db.query<LedgerRow>(seenSql(ctx.db.namespace || DB_NAMESPACE), [companyId, fp]);
    if (existing) {
      // A row whose wake was never attempted (GitHub was down, no owning card yet) is resumed now instead of
      // waiting for its backoff; any other row is a duplicate and costs no GitHub lookup. A row whose retries are
      // spent is forgotten, and this signal then starts over below.
      const resumed = resumable(existing) ? await retryRow(ctx, companyId, config, existing, raw) : { fingerprint: fp, outcome: "duplicate" as const };
      if (resumed.outcome !== "gave_up") {
        results.push(resumed);
        continue;
      }
    }
    const check = await currentPrState(ctx, companyId, config, raw);
    if (check.kind === "ok") results.push(await wakeForSignal(ctx, companyId, config, check.signal));
    else if (check.kind === "transient") results.push(await deferSignal(ctx, companyId, config, raw, check.detail));
    else results.push({ fingerprint: fp, outcome: check.outcome, detail: check.detail });
  }
  for (const r of results) {
    if (r.outcome !== "duplicate") ctx.logger.info("pr-doer-wake", { ...r });
  }
  return results;
}

async function sweepConflicts(ctx: PluginContext, configs: Map<string, DoerWakeConfig>, results: WakeResult[]): Promise<void> {
  const marks = await serialized(async () => ((await ctx.state.get(SWEEP_KEY)) as Record<string, SweepMark> | null) ?? {});
  const next = new Map<string, SweepMark | null>(); // null = done
  for (const [key, mark] of Object.entries(marks)) {
    const [companyId, repo] = key.split("|") as [string, string];
    const config = configs.get(companyId);
    // Current policy, not the one at push time: a repo stopped since then is dropped without reading GitHub.
    if (!config || policySkip(config, { repo, state: "conflict" })) {
      next.set(key, null);
      continue;
    }
    const [owner, name] = repo.split("/");
    let unknown = mark.unknownSeen === true;
    let cursor: string | null = mark.cursor ?? null;
    let finished = false;
    let failed = false;
    try {
      for (let page = 0; page < config.sweepMaxPages; page += 1) {
        const data = await githubGraphql<OpenPrsData>(ctx, companyId, config, OPEN_PRS_QUERY, { o: owner, r: name, base: null, cursor });
        const connection = data?.repository?.pullRequests;
        if (!connection) {
          finished = true;
          break;
        }
        for (const pr of connection.nodes) {
          if (pr.mergeable === "UNKNOWN") unknown = true;
          if (pr.mergeable !== "CONFLICTING") continue;
          const signal: Signal = {
            repo, number: pr.number, head: pr.headRefOid, state: "conflict", url: pr.url, headRef: pr.headRefName, draft: null, trusted: null, detail: {},
          };
          const check = evaluate(prStateFromGraph(repo, pr, config), signal, config); // this page is the authoritative read
          results.push(check.kind === "ok" ? await wakeForSignal(ctx, companyId, config, check.signal) : { fingerprint: fingerprint(signal), outcome: check.kind === "skip" ? check.outcome : "error" });
        }
        if (!connection.pageInfo.hasNextPage) {
          finished = true;
          break;
        }
        cursor = connection.pageInfo.endCursor;
      }
    } catch (error) {
      ctx.logger.warn("pr-doer-wake: conflict sweep failed", { repo, error: String(error) });
      failed = true;
    }
    const attempts = mark.attempts ?? 0;
    if (failed) {
      next.set(key, attempts + 1 < MAX_SWEEP_ATTEMPTS ? { ...mark, attempts: attempts + 1 } : null);
    } else if (!finished) {
      ctx.logger.warn("pr-doer-wake: conflict sweep reached sweepMaxPages; continuing from the cursor next tick", { repo, pages: config.sweepMaxPages });
      next.set(key, { ...mark, cursor, unknownSeen: unknown });
    } else if (unknown) {
      // GitHub computes mergeability lazily; UNKNOWN heads are read again from the first page next tick.
      next.set(key, attempts + 1 < MAX_SWEEP_ATTEMPTS ? { since: mark.since, attempts: attempts + 1 } : null);
    } else {
      next.set(key, null);
    }
  }
  await serialized(async () => {
    const latest = ((await ctx.state.get(SWEEP_KEY)) as Record<string, SweepMark> | null) ?? {};
    for (const [key, mark] of next) {
      if (latest[key]?.since !== marks[key]?.since) continue; // a newer push re-marked it meanwhile
      if (mark) latest[key] = mark;
      else delete latest[key];
    }
    await ctx.state.set(SWEEP_KEY, latest);
  });
}

/** Finish failed, stuck and card-pending wakes (retryableSql backoff), one row at a time (retryRow). */
async function retryWakes(ctx: PluginContext, configs: Map<string, DoerWakeConfig>, results: WakeResult[]): Promise<void> {
  const ns = ctx.db.namespace || DB_NAMESPACE;
  for (const [companyId, config] of configs) {
    for (const row of await ctx.db.query<LedgerRow>(retryableSql(ns), [companyId])) {
      results.push(await retryRow(ctx, companyId, config, row));
    }
  }
  await ctx.db.execute(compactSql(ns));
}

/**
 * One sweep at a time per worker. The host releases its own overlap guard when a job times out (5 minutes, equal to
 * the schedule) without cancelling the worker call, so the next tick can arrive while this one still runs; it is
 * skipped instead of retrying the same rows concurrently. reclaimSql still guards each row across processes.
 */
export function runSweep(): Promise<WakeResult[]> {
  const ctx = requireCtx();
  if (sweepInflight) {
    ctx.logger.warn("pr-doer-wake: previous sweep still running; this tick is skipped");
    return Promise.resolve([]);
  }
  const run = (async () => {
    const results: WakeResult[] = [];
    const configs = new Map((await companiesFor(ctx, null)).map((c) => [c.companyId, c.config]));
    await sweepConflicts(ctx, configs, results);
    await retryWakes(ctx, configs, results);
    for (const r of results) if (r.outcome !== "duplicate") ctx.logger.info("pr-doer-wake sweep", { ...r });
    return results;
  })();
  sweepInflight = run;
  const settle = () => {
    if (sweepInflight === run) sweepInflight = null;
  };
  run.then(settle, settle);
  return run;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctxRef = ctx;
    secrets.clear();
    ctx.jobs.register(SWEEP_JOB_KEY, async () => {
      await runSweep();
    });
    ctx.logger.info("pr-doer-wake ready");
  },
  async onValidateConfig(config) {
    const errors = validateConfig(parseConfig(config));
    return errors.length ? { ok: false, errors } : { ok: true };
  },
  async onWebhook(input) {
    if (input.endpointKey !== WEBHOOK_KEY) throw new Error(`unknown webhook endpoint ${input.endpointKey}`);
    const ctx = requireCtx();
    const eventName = header(input.headers, "x-github-event") ?? "";
    if (!SUBSCRIBED_EVENTS.has(eventName)) return; // ping and unsubscribed events: acknowledged, no work
    const payload = (input.parsedBody ?? JSON.parse(input.rawBody || "{}")) as Record<string, any>;
    if (!mayAct(eventName, payload)) return; // non-actionable deliveries: no secret resolution, no work
    const signature = header(input.headers, "x-hub-signature-256");
    if (!signature || !SIGNATURE_RE.test(signature)) throw new Error("GitHub webhook signature missing or malformed");
    const company = await verifiedCompany(ctx, await companiesFor(ctx, ownerOf(payload)), input.rawBody, signature);
    if (!company) throw new Error("GitHub webhook signature did not verify for any enabled company");
    await handleGithubEvent(eventName, payload, company.companyId, company.config);
  },
  async onHealth() {
    return { status: "ok", message: "pr-doer-wake ready" };
  },
});

export default plugin;
