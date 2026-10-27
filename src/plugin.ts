import { definePlugin, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { parseConfig, validateConfig, type DoerWakeConfig } from "./config.js";
import { DB_NAMESPACE, SWEEP_JOB_KEY, WEBHOOK_KEY } from "./constants.js";
import {
  indexFromGraph,
  ONE_PR_QUERY,
  OPEN_PRS_QUERY,
  mayAct,
  ownerOf,
  parseEvent,
  verifySignature,
  type GraphPr,
  type PrIndexEntry,
  type Signal,
} from "./github.js";
import { pruneSql, retryableSql } from "./sql.js";
import { wakeForSignal, type WakeResult } from "./waker.js";

let ctxRef: PluginContext | null = null;
let lock: Promise<unknown> = Promise.resolve();
const MAX_SWEEP_ATTEMPTS = 6;
type OpenPrsConnection = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GraphPr[] };
type OpenPrsData = { repository: { pullRequests: OpenPrsConnection } | null };

/** Serialize read-modify-write of plugin state inside this single worker. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = lock.then(fn, fn);
  lock = next.catch(() => undefined);
  return next;
}

function requireCtx(): PluginContext {
  if (!ctxRef) throw new Error("pr-doer-wake is not set up");
  return ctxRef;
}

const indexKey = (repo: string, n: number) => ({ scopeKind: "instance" as const, namespace: "pr", stateKey: `${repo}#${n}` });
const SWEEP_KEY = { scopeKind: "instance" as const, namespace: "sweep", stateKey: "repos" };

function header(headers: PluginWebhookInput["headers"], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function companiesFor(ctx: PluginContext, owner: string | null): Promise<Array<{ companyId: string; config: DoerWakeConfig }>> {
  const out = [];
  for (const company of await ctx.companies.list()) {
    const config = parseConfig(await ctx.config.get(company.id));
    if (!config.enabled || validateConfig(config).length > 0) continue;
    if (owner && config.githubOrg.toLowerCase() !== owner.toLowerCase()) continue;
    out.push({ companyId: company.id, config });
  }
  return out;
}

async function resolveToken(ctx: PluginContext, companyId: string, config: DoerWakeConfig): Promise<string | null> {
  if (!config.githubTokenSecretRef) return null;
  return ctx.secrets.resolve(config.githubTokenSecretRef as never, { companyId, configPath: "githubTokenSecretRef" });
}

async function githubGraphql<T>(ctx: PluginContext, companyId: string, config: DoerWakeConfig, query: string, variables: Record<string, unknown>, resolved?: string | null): Promise<T | null> {
  // One sweep run passes the token it resolved once, so N repos x M pages cost one of the 30/min secret resolutions.
  const token = resolved === undefined ? await resolveToken(ctx, companyId, config) : resolved;
  if (!token) return null;
  const response = await ctx.http.fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "paperclip-pr-doer-wake" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`GitHub GraphQL HTTP ${response.status}`);
  const body = (await response.json()) as { data?: T; errors?: unknown };
  if (body.errors) throw new Error("GitHub GraphQL returned errors");
  return body.data ?? null;
}

/** Fill in draft/headRef for a signal from the index, or one GraphQL lookup when the PR was never seen. */
async function hydrate(ctx: PluginContext, companyId: string, config: DoerWakeConfig, signal: Signal): Promise<Signal> {
  if (signal.state === "merged") return signal;
  let entry = (await ctx.state.get(indexKey(signal.repo, signal.number))) as PrIndexEntry | null;
  if (!entry || entry.head !== signal.head) {
    const [owner, name] = signal.repo.split("/");
    const data = await githubGraphql<{ repository: { pullRequest: GraphPr | null } | null }>(ctx, companyId, config, ONE_PR_QUERY, { o: owner, r: name, n: signal.number }).catch((error) => {
      ctx.logger.warn("pr-doer-wake: PR lookup failed", { pr: `${signal.repo}#${signal.number}`, error: String(error) });
      return null;
    });
    const pr = data?.repository?.pullRequest;
    if (pr) {
      entry = indexFromGraph(signal.repo, pr);
      await ctx.state.set(indexKey(signal.repo, signal.number), entry);
    }
  }
  if (!entry || entry.head !== signal.head) return { ...signal, draft: signal.draft ?? null };
  return { ...signal, draft: entry.draft, headRef: signal.headRef ?? entry.headRef };
}

export async function handleGithubEvent(eventName: string, payload: Record<string, any>, companyId: string, config: DoerWakeConfig): Promise<WakeResult[]> {
  const ctx = requireCtx();
  const parsed = parseEvent(eventName, payload, config);
  for (const entry of parsed.upsertIndex) await ctx.state.set(indexKey(entry.repo, entry.number), entry);
  for (const gone of parsed.removeIndex) await ctx.state.delete(indexKey(gone.repo, gone.number));
  if (parsed.sweepRepos.length > 0) {
    await serialized(async () => {
      const marks = ((await ctx.state.get(SWEEP_KEY)) as Record<string, { since: string; attempts: number }> | null) ?? {};
      for (const repo of parsed.sweepRepos) marks[`${companyId}|${repo}`] = { since: new Date().toISOString(), attempts: 0 };
      await ctx.state.set(SWEEP_KEY, marks);
    });
  }
  const signals = [...parsed.signals];
  for (const failure of parsed.statusFailures) {
    // Commit statuses carry no PR number: match the head against PRs this plugin has indexed.
    const { repo, sha } = failure;
    const candidates = (payload.branches ?? []) as Array<{ name: string }>;
    for (const branch of candidates) {
      const n = Number((await ctx.state.get({ scopeKind: "instance", namespace: "head", stateKey: `${repo}@${branch.name}` })) ?? 0);
      if (!n) continue;
      const entry = (await ctx.state.get(indexKey(repo, n))) as PrIndexEntry | null;
      if (entry?.head === sha) {
        signals.push({ repo, number: n, head: sha, state: "ci_red", url: entry.url, headRef: entry.headRef, draft: null, detail: { checkName: failure.context, checkUrl: failure.url, conclusion: "failure" } });
      }
    }
  }
  for (const entry of parsed.upsertIndex) {
    if (entry.headRef) await ctx.state.set({ scopeKind: "instance", namespace: "head", stateKey: `${entry.repo}@${entry.headRef}` }, entry.number);
  }
  const results: WakeResult[] = [];
  for (const raw of signals) {
    const signal = await hydrate(ctx, companyId, config, raw);
    results.push(await wakeForSignal(ctx, companyId, config, signal));
  }
  for (const r of results) {
    if (r.outcome !== "duplicate") ctx.logger.info("pr-doer-wake", { ...r });
  }
  return results;
}

export async function runSweep(): Promise<WakeResult[]> {
  const ctx = requireCtx();
  const results: WakeResult[] = [];
  const configs = new Map((await companiesFor(ctx, null)).map((c) => [c.companyId, c.config]));
  const marks = await serialized(async () => ((await ctx.state.get(SWEEP_KEY)) as Record<string, { since: string; attempts: number }> | null) ?? {});
  const done: string[] = [];
  const retry: string[] = [];
  const tokens = new Map<string, string | null>(); // per sweep run only; never persisted
  for (const key of Object.keys(marks)) {
    const [companyId, repo] = key.split("|") as [string, string];
    const config = configs.get(companyId);
    if (!config || !config.githubTokenSecretRef || !config.wakeStates.includes("conflict")) {
      done.push(key);
      continue;
    }
    const [owner, name] = repo.split("/");
    let unknown = false;
    try {
      if (!tokens.has(companyId)) tokens.set(companyId, await resolveToken(ctx, companyId, config));
      const token = tokens.get(companyId) ?? null;
      let cursor: string | null = null;
      for (let page = 0; page < 4; page += 1) {
        const data: OpenPrsData | null = await githubGraphql<OpenPrsData>(ctx, companyId, config, OPEN_PRS_QUERY, { o: owner, r: name, base: null, cursor }, token);
        const connection: OpenPrsConnection | undefined = data?.repository?.pullRequests;
        if (!connection) break;
        for (const pr of connection.nodes) {
          const entry = indexFromGraph(repo, pr);
          await ctx.state.set(indexKey(repo, pr.number), entry);
          if (pr.mergeable === "UNKNOWN") unknown = true;
          if (pr.mergeable !== "CONFLICTING") continue;
          results.push(await wakeForSignal(ctx, companyId, config, {
            repo, number: pr.number, head: pr.headRefOid, state: "conflict", url: pr.url, headRef: pr.headRefName, draft: pr.isDraft, detail: {},
          }));
        }
        if (!connection.pageInfo.hasNextPage) break;
        cursor = connection.pageInfo.endCursor;
      }
    } catch (error) {
      ctx.logger.warn("pr-doer-wake: conflict sweep failed", { repo, error: String(error) });
      unknown = true;
    }
    // GitHub computes mergeability lazily; UNKNOWN heads are read again next tick.
    if (unknown && (marks[key]?.attempts ?? 0) + 1 < MAX_SWEEP_ATTEMPTS) retry.push(key);
    else done.push(key);
  }
  await serialized(async () => {
    const latest = ((await ctx.state.get(SWEEP_KEY)) as Record<string, { since: string; attempts: number }> | null) ?? {};
    for (const key of done) if (latest[key]?.since === marks[key]?.since) delete latest[key];
    for (const key of retry) if (latest[key]?.since === marks[key]?.since) latest[key] = { since: marks[key]!.since, attempts: (marks[key]!.attempts ?? 0) + 1 };
    await ctx.state.set(SWEEP_KEY, latest);
  });
  const ns = ctx.db.namespace || DB_NAMESPACE;
  for (const [companyId, config] of configs) {
    const rows = await ctx.db.query<{ fingerprint: string; signal: string }>(retryableSql(ns), [companyId]);
    for (const row of rows) results.push(await wakeForSignal(ctx, companyId, config, JSON.parse(row.signal) as Signal, { retry: true }));
  }
  await ctx.db.execute(pruneSql(ns));
  for (const r of results) if (r.outcome !== "duplicate") ctx.logger.info("pr-doer-wake sweep", { ...r });
  return results;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctxRef = ctx;
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
    const signature = header(input.headers, "x-hub-signature-256");
    const payload = (input.parsedBody ?? JSON.parse(input.rawBody || "{}")) as Record<string, any>;
    if (!mayAct(eventName, payload)) return; // ping and non-actionable deliveries: no secret resolution, no work
    const owner = ownerOf(payload);
    for (const { companyId, config } of await companiesFor(ctx, owner)) {
      const secret = await ctx.secrets.resolve(config.webhookSecretRef as never, { companyId, configPath: "webhookSecretRef" });
      if (!verifySignature(secret, input.rawBody, signature)) continue;
      await handleGithubEvent(eventName, payload, companyId, config);
      return;
    }
    throw new Error("GitHub webhook signature did not verify for any enabled company");
  },
  async onHealth() {
    return { status: "ok", message: "pr-doer-wake ready" };
  },
});

export default plugin;
