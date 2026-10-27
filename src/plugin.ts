import { definePlugin, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { parseConfig, validateConfig, type DoerWakeConfig, type SecretRef } from "./config.js";
import { DB_NAMESPACE, SWEEP_JOB_KEY, WEBHOOK_KEY } from "./constants.js";
import {
  evaluate,
  fingerprint,
  ONE_PR_QUERY,
  OPEN_PRS_QUERY,
  mayAct,
  ownerOf,
  parseEvent,
  prStateFromGraph,
  SIGNATURE_RE,
  SUBSCRIBED_EVENTS,
  verifySignature,
  type GraphPr,
  type PrCheck,
  type Signal,
} from "./github.js";
import { SecretCache } from "./secrets.js";
import { pruneSql, retryableSql, seenSql } from "./sql.js";
import { deferSignal, recordOutcome, wakeForSignal, type WakeResult } from "./waker.js";

let ctxRef: PluginContext | null = null;
let lock: Promise<unknown> = Promise.resolve();
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
  const body = (await response.json()) as { data?: T; errors?: unknown };
  if (body.errors) throw new Error("GitHub GraphQL returned errors");
  return body.data ?? null;
}

/**
 * Is this signal's PR open, trusted, non-draft and on this head right now? Always one GraphQL read: webhook
 * payloads arrive late, out of order and with tied updated_at values, and draft conversion or closing does not
 * change the head, so nothing cached can authorize a wake. Fails closed: unreadable is transient, missing is closed.
 */
async function currentPrState(ctx: PluginContext, companyId: string, config: DoerWakeConfig, signal: Signal): Promise<PrCheck> {
  const [owner, name] = signal.repo.split("/");
  let pr: GraphPr | null | undefined;
  try {
    const data = await githubGraphql<{ repository: { pullRequest: GraphPr | null } | null }>(ctx, companyId, config, ONE_PR_QUERY, { o: owner, r: name, n: signal.number });
    pr = data?.repository?.pullRequest;
  } catch (error) {
    return { kind: "transient", detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
  if (!pr) return { kind: "skip", outcome: "skipped_closed", detail: "PR not found" };
  return evaluate(prStateFromGraph(signal.repo, pr, config), signal);
}

async function alreadySeen(ctx: PluginContext, companyId: string, fp: string): Promise<boolean> {
  return (await ctx.db.query(seenSql(ctx.db.namespace || DB_NAMESPACE), [companyId, fp])).length > 0;
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
    if (await alreadySeen(ctx, companyId, fp)) {
      results.push({ fingerprint: fp, outcome: "duplicate" });
      continue;
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
    if (!config || !config.wakeStates.includes("conflict")) {
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
          const check = evaluate(prStateFromGraph(repo, pr, config), signal); // this page is the authoritative read
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

type RetryRow = { fingerprint: string; signal: string; issue_id: string | null; comment_posted_at: string | null; wake_attempted_at: string | null };

/** Finish failed and stuck wakes, re-reading the PR first so a now-draft, closed, merged or re-pushed PR is never woken. */
async function retryWakes(ctx: PluginContext, configs: Map<string, DoerWakeConfig>, results: WakeResult[]): Promise<void> {
  const ns = ctx.db.namespace || DB_NAMESPACE;
  for (const [companyId, config] of configs) {
    const rows = await ctx.db.query<RetryRow>(retryableSql(ns), [companyId]);
    for (const row of rows) {
      const signal = JSON.parse(row.signal) as Signal;
      const fp = row.fingerprint;
      const check = await currentPrState(ctx, companyId, config, signal);
      if (check.kind === "transient") {
        await recordOutcome(ctx, companyId, fp, "error", row.issue_id);
        results.push({ fingerprint: fp, outcome: "deferred", detail: check.detail });
      } else if (check.kind === "skip") {
        await recordOutcome(ctx, companyId, fp, `stale:${check.outcome}`, row.issue_id);
        results.push({ fingerprint: fp, outcome: check.outcome, detail: check.detail });
      } else {
        results.push(await wakeForSignal(ctx, companyId, config, check.signal, {
          retry: { issueId: row.issue_id, commentPostedAt: row.comment_posted_at, wakeAttemptedAt: row.wake_attempted_at },
        }));
      }
    }
  }
  await ctx.db.execute(pruneSql(ns));
}

export async function runSweep(): Promise<WakeResult[]> {
  const ctx = requireCtx();
  const results: WakeResult[] = [];
  const configs = new Map((await companiesFor(ctx, null)).map((c) => [c.companyId, c.config]));
  await sweepConflicts(ctx, configs, results);
  await retryWakes(ctx, configs, results);
  for (const r of results) if (r.outcome !== "duplicate") ctx.logger.info("pr-doer-wake sweep", { ...r });
  return results;
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
