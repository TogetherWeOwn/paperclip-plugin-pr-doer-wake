import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PluginContext, PluginWebhookInput, ToolRunContext, ToolResult } from "@paperclipai/plugin-sdk";
import { parseCiConfig, parseRegistration, validateCiConfig, workspaceRepo, UUID, SHA, type CiConfig, type Registration } from "./ci-config.js";
import { CiGithub, CiGithubCache, CiGithubError, evaluateReadiness } from "./ci-github.js";
import { CiAppAuth } from "./ci-auth.js";
import { retryableBeforeQueue } from "./native-wake.js";

function authIdentity(config: CiConfig): string {
  return JSON.stringify([config.githubTokenSecretRef, config.githubApp]);
}

export const LIMITS = { active: 20, retained: 2_000, audit: 1_000, deliveries: 2_000, requestsPerTick: 240, wakePerTick: 20, waitMs: 7 * 86_400_000, retentionMs: 30 * 86_400_000, replayMs: 86_400_000, tickMs: 180_000, secretResolveMs: 15_000 } as const;
export interface CiWakeRuntimeOptions {
  /** Per-secret-resolve deadline; default 15 seconds, at most 30 seconds (matches CiGithub). */
  secretResolveTimeoutMs?: number;
}
const KEY = { scopeKind: "instance" as const, namespace: "ci-wake-v1", stateKey: "ledger" };
type WaitStatus = "open" | "waking" | "woken" | "would_wake" | "unconfirmed" | "retired";
export interface Wait extends Registration {
  waitId: string;
  companyId: string;
  projectId: string;
  workspaceId: string;
  branch: string;
  /**
   * Binding proof for custody: true only when the workspace branch observed
   * before and after the GitHub read equals the live PR head branch. Repo-only
   * registrations (false) must not be trusted by custody; see custody-policy.
   */
  branchVerified: boolean;
  runId: string;
  aliases: string[];
  registeredAt: number;
  expiresAt: number;
  status: WaitStatus;
  finishedAt?: number;
  lastAttemptAt?: number;
  reason?: string;
}
interface Audit { at: number; operation: string; runId?: string; companyId?: string; waitId?: string; outcome: string }
interface Ledger {
  version: 1;
  waits: Wait[];
  audits: Audit[];
  deliveries: Record<string, number>;
  hints: Record<string, number>;
  samples: Record<string, Array<{ sha: string; ms: number }>>;
}
const empty = (): Ledger => ({ version: 1, waits: [], audits: [], deliveries: {}, hints: {}, samples: {} });
class BindingChanged extends Error {}

/**
 * Enumerated, secret-free refusal codes for ci_wait_register.
 * A closed allowlist: known internal failures map to their code and
 * any other error folds to registration_refused. Error messages,
 * upstream bodies and host detail are never included.
 */
const REFUSAL_CODES = new Set([
  "invalid_registration", "invalid_run_context", "invalid_configuration",
  "plugin_disabled", "repo_refused", "checkout_refused",
  "issue_binding_refused", "workspace_binding_refused", "pr_binding_refused",
  "binding_changed", "registration_requires_new_run", "wait_alias_capacity",
  "wait_capacity", "github_backoff", "github_backoff_capacity",
  "secret_resolution_timeout", "credential_unavailable",
  "invalid_ledger", "registration_refused",
]);

function refusalCode(error: unknown): string {
  if (error instanceof CiGithubError) return `github_${error.code}`;
  if (error instanceof Error && REFUSAL_CODES.has(error.message)) return error.message;
  return "registration_refused";
}

export function verifyCiSignature(secret: string, rawBody: string, signature: string | undefined): boolean {
  if (!secret || !signature || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`);
  const supplied = Buffer.from(signature);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function header(input: PluginWebhookInput, name: string): string | undefined {
  const key = Object.keys(input.headers).find((k) => k.toLowerCase() === name);
  const value = key ? input.headers[key] : undefined;
  return typeof value === "string" ? value : undefined;
}

/** One host-managed worker owns this ledger. All entrypoints share its lock, including overlapping job callbacks. */
export class CiWakeRuntime {
  private lock: Promise<unknown> = Promise.resolve();
  private pollInFlight = false;
  private targetedPoll = false;
  private fullPollRequested = false;
  private pendingWebhooks = 0;
  private webhookAdmissions = { since: 0, used: 0 };
  private readonly caches = new Map<string, CiGithubCache>();
  private readonly githubBackoffs = new Map<string, { until: number }>();
  private webhookBudget = { since: 0, used: 0 };

  private readonly secretResolveTimeoutMs: number;

  constructor(private readonly ctx: PluginContext, private readonly now: () => number = Date.now, options: CiWakeRuntimeOptions = {}) {
    const timeoutMs = options.secretResolveTimeoutMs ?? LIMITS.secretResolveMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("invalid_secret_resolve_timeout");
    this.secretResolveTimeoutMs = timeoutMs;
  }

  /**
   * Bound every secret RPC. A never-settling resolve must not hold the
   * serialized queue: on timeout the caller fails closed and a late settle
   * causes no fetch, client construction, or ledger effect.
   */
  private async resolveSecret(ref: NonNullable<CiConfig["githubTokenSecretRef"]>, companyId: string, configPath: string): Promise<string> {
    const pending = Promise.resolve().then(() => this.ctx.secrets.resolve(ref, { companyId, configPath }));
    // A late rejection after the deadline must not surface as unhandled.
    pending.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("secret_resolution_timeout")), this.secretResolveTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<Ledger> {
    const ledger = await this.ctx.state.get(KEY) as Ledger | null;
    if (!ledger) return empty();
    if (ledger.version !== 1 || !Array.isArray(ledger.waits) || !Array.isArray(ledger.audits) || !ledger.deliveries || !ledger.hints || !ledger.samples) throw new Error("invalid_ledger");
    return ledger;
  }

  private async save(ledger: Ledger): Promise<void> {
    await this.ctx.state.set(KEY, ledger);
  }

  private audit(ledger: Ledger, operation: string, outcome: string, run?: ToolRunContext, waitId?: string): void {
    ledger.audits.push({ at: this.now(), operation, outcome, ...(run && UUID.test(run.runId) && UUID.test(run.companyId) ? { runId: run.runId, companyId: run.companyId } : {}), ...(waitId ? { waitId } : {}) });
    while (ledger.audits.length > LIMITS.audit) {
      // Keep the current call's durable intent, but evict older routine intents
      // before wake/refusal evidence. This remains a bounded log, not an archive.
      const routine = ledger.audits.findIndex((entry, index) => index < ledger.audits.length - 1 && entry.operation === "poll" && entry.outcome === "intent");
      ledger.audits.splice(routine < 0 ? 0 : routine, 1);
    }
  }

  private compact(ledger: Ledger): void {
    const now = this.now();
    for (const wait of ledger.waits) {
      if (wait.status === "waking") { wait.status = "unconfirmed"; wait.finishedAt = now; }
      if (wait.status === "open" && wait.expiresAt <= now) { wait.status = "retired"; wait.finishedAt = now; wait.reason = "wait_expired"; }
    }
    ledger.waits = ledger.waits.filter((w) => w.status === "open" || now - (w.finishedAt ?? w.registeredAt) < LIMITS.retentionMs);
    const retainedRepos = new Set(ledger.waits.map((w) => `${w.companyId}:${w.repo}`));
    for (const repo of Object.keys(ledger.samples)) if (!retainedRepos.has(repo)) delete ledger.samples[repo];
    for (const [id, at] of Object.entries(ledger.deliveries)) if (now - at >= LIMITS.replayMs) delete ledger.deliveries[id];
    for (const [id, at] of Object.entries(ledger.hints)) if (now - at >= 60_000) delete ledger.hints[id];
  }

  private async config(companyId: string, requireEnabled = true): Promise<CiConfig> {
    const raw = await this.ctx.config.get(companyId);
    if (validateCiConfig(raw).length) throw new Error("invalid_configuration");
    const config = parseCiConfig(raw);
    if (requireEnabled && !config.enabled) throw new Error("plugin_disabled");
    return config;
  }

  private async client(companyId: string, config: CiConfig, repo: string, fetch: PluginContext["http"]["fetch"] = this.ctx.http.fetch.bind(this.ctx.http), cycle = new Map<string, CiAppAuth>()): Promise<CiGithub> {
    const app = config.githubApp;
    // Response bodies/ETags stay company scoped; App installation quota does not.
    const key = app ? `${companyId}:app:${app.appId}:${app.installationId}`
      : `${companyId}:${config.githubTokenSecretRef!.secretId}:${config.githubTokenSecretRef!.version ?? "latest"}`;
    const quota = app ? `app:${app.appId}:${app.installationId}` : `bearer:${key}`;
    for (const [id, entry] of this.githubBackoffs) if (entry.until <= this.now()) this.githubBackoffs.delete(id);
    let backoff = this.githubBackoffs.get(quota);
    if (!backoff) {
      // Never evict a live Retry-After to admit another identity or response cache.
      if (this.githubBackoffs.size >= LIMITS.retained) throw new Error("github_backoff_capacity");
      backoff = { until: 0 };
      this.githubBackoffs.set(quota, backoff);
    }
    if (this.now() < backoff.until) throw new Error("github_backoff");
    if (!this.caches.has(key)) {
      if (this.caches.size >= 8) this.caches.delete(this.caches.keys().next().value!);
      this.caches.set(key, new CiGithubCache());
    }
    const cache = this.caches.get(key)!;
    if (this.now() < cache.backoffUntil) throw new Error("github_backoff");
    let credential: string | CiAppAuth;
    if (app) {
      const scope = `${companyId}:${authIdentity(config)}:${repo}`;
      if (!cycle.has(scope)) cycle.set(scope, new CiAppAuth({
        appId: app.appId, installationId: app.installationId, repo, now: this.now,
        resolvePrivateKey: () => this.resolveSecret(app.privateKeySecretRef, companyId, "githubAppPrivateKeySecretRef"),
      }));
      credential = cycle.get(scope)!;
    } else {
      try {
        credential = await this.resolveSecret(config.githubTokenSecretRef!, companyId, "githubTokenSecretRef");
      } catch (error) {
        // Preserve the deadline code; any other host failure folds to a
        // secret-free credential code without leaking host detail.
        if (error instanceof Error && error.message === "secret_resolution_timeout") throw error;
        throw new Error("credential_unavailable");
      }
    }
    return new CiGithub(fetch, credential, { now: this.now, cache, backoff });
  }

  private async binding(wait: Registration, companyId: string, projectId?: string): Promise<{ workspaceId: string; projectId: string; branch: string }> {
    const issue = await this.ctx.issues.get(wait.issueId, companyId);
    if (!issue || issue.companyId !== companyId || !issue.projectId || (projectId && issue.projectId !== projectId) || !issue.executionWorkspaceId) throw new Error("issue_binding_refused");
    const workspace = await this.ctx.executionWorkspaces.get(issue.executionWorkspaceId, companyId);
    if (!workspace || workspace.companyId !== companyId || workspace.projectId !== issue.projectId || workspaceRepo(workspace.repoUrl) !== wait.repo) throw new Error("workspace_binding_refused");
    // Branch is recorded for ledger context only. Binding is the checked-out
    // workspace identity plus live PR number and head SHA; agents push from
    // work/<uuid> checkouts to the PR head branch, so branch-name equality
    // must never be a binding criterion.
    return { workspaceId: workspace.id, projectId: issue.projectId, branch: workspace.branchName ?? "" };
  }

  private async checkBinding(wait: Wait): Promise<void> {
    const issue = await this.ctx.issues.get(wait.issueId, wait.companyId);
    // Missing/ambiguous reads are retryable, not evidence that the binding moved.
    if (!issue || issue.id !== wait.issueId || issue.companyId !== wait.companyId || !issue.projectId || !issue.executionWorkspaceId) throw new Error("issue_binding_refused");
    if (issue.projectId !== wait.projectId || issue.executionWorkspaceId !== wait.workspaceId) throw new BindingChanged();
    const workspace = await this.ctx.executionWorkspaces.get(issue.executionWorkspaceId, wait.companyId);
    if (!workspace || workspace.id !== wait.workspaceId || workspace.companyId !== wait.companyId || !workspace.projectId) throw new Error("workspace_binding_refused");
    const repo = workspaceRepo(workspace.repoUrl);
    if (!repo) throw new Error("workspace_binding_refused");
    if (workspace.projectId !== wait.projectId || repo !== wait.repo) throw new BindingChanged();
  }

  private async checkoutOwner(issueId: string, run: ToolRunContext): Promise<void> {
    try {
      await this.ctx.issues.assertCheckoutOwner({ issueId, companyId: run.companyId, actorAgentId: run.agentId, actorRunId: run.runId });
    } catch {
      // Host detail in the denial is never propagated to agent output.
      throw new Error("checkout_refused");
    }
  }

  async register(params: unknown, run: ToolRunContext): Promise<ToolResult> {
    return this.serialized(async () => {
      // The ledger load lives inside the refusal boundary: a malformed
      // persisted ledger (invalid_ledger) or a host state-read failure must
      // return { code } instead of escaping as a rejection that could leak
      // raw host detail. When the ledger could not be read, return without
      // saving: the unreadable ledger cannot be audited in place.
      let ledger: Ledger | undefined;
      let waitId: string | undefined;
      try {
        ledger = await this.load();
        this.compact(ledger);
        const registration = parseRegistration(params);
        if (![run.companyId, run.agentId, run.runId, run.projectId].every((s) => UUID.test(s))) throw new Error("invalid_run_context");
        const config = await this.config(run.companyId);
        if (!config.allowedRepos.includes(registration.repo)) throw new Error("repo_refused");
        await this.checkoutOwner(registration.issueId, run);
        const binding = await this.binding(registration, run.companyId, run.projectId);
        waitId = createHash("sha256").update(JSON.stringify([run.companyId, run.runId, registration.issueId, registration.repo, registration.prNumber, registration.headSha])).digest("hex");
        const existing = ledger.waits.find((w) => w.waitId === waitId || w.aliases.includes(waitId!));
        if (existing) {
          if (existing.status === "open" && (existing.projectId !== binding.projectId || existing.workspaceId !== binding.workspaceId)) {
            existing.status = "retired"; existing.finishedAt = this.now(); existing.reason = "binding_changed";
            throw new Error("registration_requires_new_run");
          }
          this.audit(ledger, "register", "duplicate", run, waitId);
          await this.save(ledger);
          return { content: "CI wait already registered", data: { waitId: existing.waitId, status: existing.status, expiresAt: existing.expiresAt } };
        }
        const active = ledger.waits.find((w) => w.companyId === run.companyId && w.issueId === registration.issueId && w.repo === registration.repo && w.prNumber === registration.prNumber && w.headSha === registration.headSha && w.status === "open" && w.projectId === binding.projectId && w.workspaceId === binding.workspaceId);
        if (active) {
          if (active.aliases.length >= 100) throw new Error("wait_alias_capacity");
          active.aliases.push(waitId);
          this.audit(ledger, "register", "joined", run, active.waitId);
          await this.save(ledger);
          return { content: "Joined active CI wait", data: { waitId: active.waitId, status: active.status, expiresAt: active.expiresAt } };
        }
        const superseded = ledger.waits.filter((w) => w.companyId === run.companyId && w.repo === registration.repo && w.prNumber === registration.prNumber && w.issueId === registration.issueId && w.status === "open");
        if (ledger.waits.length >= LIMITS.retained || ledger.waits.filter((w) => w.status === "open").length - superseded.length >= LIMITS.active) throw new Error("wait_capacity");
        // Audit intent before resolving the credential or making any outbound request.
        this.audit(ledger, "register", "intent", run, waitId);
        await this.save(ledger);
        const github = await this.client(run.companyId, config, registration.repo);
        const pr = await github.pull(registration.repo, registration.prNumber);
        if (pr.number !== registration.prNumber || pr.state !== "open" || pr.merged || pr.headSha !== registration.headSha || pr.headRepo?.toLowerCase() !== registration.repo) throw new Error("pr_binding_refused");
        // Checkout ownership may have changed while GitHub answered.
        await this.checkoutOwner(registration.issueId, run);
        const current = await this.binding(registration, run.companyId, run.projectId);
        if (current.workspaceId !== binding.workspaceId) throw new Error("binding_changed");
        // Custody binding proof, not a ci-wake gate: ci-wake still registers
        // repo-only registrations, but only a verified workspace-to-PR branch
        // link is recorded for custody to trust. Both observations must match.
        const branchVerified = binding.branch === pr.headBranch && current.branch === pr.headBranch;
        const now = this.now();
        for (const old of ledger.waits) if (old.companyId === run.companyId && old.repo === registration.repo && old.prNumber === registration.prNumber && old.issueId === registration.issueId && old.status === "open") { old.status = "retired"; old.finishedAt = now; old.reason = "superseded"; }
        ledger.waits.push({ ...registration, ...binding, branchVerified, waitId, companyId: run.companyId, runId: run.runId, aliases: [], registeredAt: now, expiresAt: now + LIMITS.waitMs, status: "open" });
        this.audit(ledger, "register", "registered", run, waitId);
        await this.save(ledger);
        return { content: "CI wait registered", data: { waitId, status: "open", expiresAt: now + LIMITS.waitMs, dryRun: config.dryRun } };
      } catch (error) {
        // Neither host exceptions nor upstream response bodies are safe
        // agent output. Only the enumerated code crosses the boundary;
        // the audit row records the same code for operator triage.
        const code = refusalCode(error);
        if (ledger === undefined) return { error: `CI registration refused: ${code}`, data: { code } };
        this.audit(ledger, "register", code, run, waitId);
        await this.save(ledger);
        return { error: `CI registration refused: ${code}`, data: { code } };
      }
    });
  }

  async poll(only?: { companyId: string; repo: string; sha: string }): Promise<void> {
    if (this.pollInFlight) {
      if (!only && this.targetedPoll) this.fullPollRequested = true;
      return;
    }
    this.pollInFlight = true;
    this.targetedPoll = only !== undefined;
    try {
      await this.serialized(() => this.pollLocked(only));
      if (this.fullPollRequested) {
        this.targetedPoll = false;
        this.fullPollRequested = false;
        await this.serialized(() => this.pollLocked());
      }
    } finally {
      this.pollInFlight = false;
      this.targetedPoll = false;
      this.fullPollRequested = false;
    }
  }

  private async pollLocked(only?: { companyId: string; repo: string; sha: string }): Promise<void> {
    const ledger = await this.load();
    this.compact(ledger);
    await this.save(ledger);
    const started = this.now();
    let requests = 0;
    let wakes = 0;
    // Tokens are reusable only within this bounded poll, never a runtime field/state.
    const cycle = new Map<string, CiAppAuth>();
    const fetch: PluginContext["http"]["fetch"] = async (url, init) => {
      if (++requests > LIMITS.requestsPerTick || this.now() - started >= LIMITS.tickMs) throw new Error("tick_budget");
      return this.ctx.http.fetch(url, init);
    };
    // Oldest last-attempt first prevents one unavailable repository starving others.
    const pending = ledger.waits.filter((w) => w.status === "open" && (!only || w.companyId === only.companyId && w.repo === only.repo && w.headSha === only.sha)).sort((a, b) => (a.lastAttemptAt ?? 0) - (b.lastAttemptAt ?? 0));
    for (const wait of pending) {
      if (requests >= LIMITS.requestsPerTick || wakes >= LIMITS.wakePerTick || this.now() - started >= LIMITS.tickMs) break;
      try {
        wait.lastAttemptAt = this.now();
        const config = await this.config(wait.companyId, false);
        // Disabled polling still compacts above, but must not churn per-wait audit evidence.
        if (!config.enabled) continue;
        if (!config.allowedRepos.includes(wait.repo)) { wait.status = "retired"; wait.reason = "repo_revoked"; wait.finishedAt = this.now(); await this.save(ledger); continue; }
        await this.checkBinding(wait);
        this.audit(ledger, "poll", "intent", undefined, wait.waitId);
        await this.save(ledger);
        const github = await this.client(wait.companyId, config, wait.repo, fetch, cycle);
        const pr = await github.pull(wait.repo, wait.prNumber);
        if (pr.number !== wait.prNumber || pr.state !== "open" || pr.merged || pr.headSha !== wait.headSha || pr.headRepo?.toLowerCase() !== wait.repo) {
          wait.status = "retired"; wait.reason = "head_moved_or_closed"; wait.finishedAt = this.now(); await this.save(ledger); continue;
        }
        const snapshot = await github.snapshot(wait.repo, wait.headSha, pr.baseBranch);
        const samples = ledger.samples[`${wait.companyId}:${wait.repo}`] ?? [];
        const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
        const medianMs = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : config.repoMedianMs[wait.repo] ?? 30 * 60_000;
        const verdict = evaluateReadiness(snapshot, { registeredAt: wait.registeredAt, now: this.now(), medianMs });
        if (verdict.kind === "pending") continue;
        await this.checkBinding(wait);
        const freshConfig = await this.config(wait.companyId);
        if (!freshConfig.allowedRepos.includes(wait.repo) || freshConfig.dryRun !== config.dryRun || authIdentity(freshConfig) !== authIdentity(config)) throw new Error("configuration_changed");
        const current = await github.pull(wait.repo, wait.prNumber);
        // The final GitHub read is the last external I/O before durable wake
        // intent. Revalidate binding, enablement, allowlist, dry-run and the
        // credential identity immediately after it: a change during that
        // await must not be followed by a stale-authority requestWakeup.
        // Missing evidence throws (retryable, never woken); a confirmed
        // binding move retires via BindingChanged in the outer catch.
        await this.checkBinding(wait);
        const revalidated = await this.config(wait.companyId);
        if (!revalidated.allowedRepos.includes(wait.repo) || revalidated.dryRun !== config.dryRun || authIdentity(revalidated) !== authIdentity(config)) throw new Error("configuration_changed");
        if (current.number !== wait.prNumber || current.headSha !== wait.headSha || current.state !== "open" || current.merged || current.baseBranch !== pr.baseBranch || current.headRepo?.toLowerCase() !== wait.repo) {
          wait.status = "retired"; wait.reason = "head_moved_or_closed"; wait.finishedAt = this.now(); await this.save(ledger); continue;
        }
        if (!verdict.missing.length && !samples.some((s) => s.sha === wait.headSha)) {
          const starts = snapshot.suites.map((s) => s.createdAt).filter((n): n is number => n !== null);
          const finishes = snapshot.suites.map((s) => s.completedAt).filter((n): n is number => n !== null);
          if (starts.length && finishes.length && finishes.length === snapshot.suites.length) {
            const duration = Math.max(...finishes) - Math.min(...starts);
            if (duration >= 60_000 && duration <= 86_400_000) {
              ledger.samples[`${wait.companyId}:${wait.repo}`] = [...samples, { sha: wait.headSha, ms: duration }].slice(-31);
            }
          }
        }
        const failed = verdict.failed.join(", ").slice(0, 1_000);
        const missing = verdict.missing.join(", ").slice(0, 1_000);
        const reason = `CI ${verdict.kind} ${wait.repo}@${wait.headSha.slice(0, 7)}${failed ? `: ${failed}` : ""}${missing ? `; required check missing: ${missing}` : ""}`;
        wait.reason = reason;
        if (config.dryRun) {
          wait.status = "would_wake"; wait.finishedAt = this.now();
          this.audit(ledger, "wake", "would_wake", undefined, wait.waitId);
          await this.save(ledger);
          this.ctx.logger.info("ci-wake: would wake", { waitId: wait.waitId, repo: wait.repo, headSha: wait.headSha, verdict: verdict.kind });
        } else {
          // Persist before calling the host. Restart/ambiguous replies NEVER repeat an attempted effect.
          wait.status = "waking";
          this.audit(ledger, "wake", "intent", undefined, wait.waitId);
          try { await this.save(ledger); } catch {
            // The write may have committed, but no wake call has been made: restoring open is safe.
            wait.status = "open";
            throw new Error("wake_intent_write_failed");
          }
          wakes += 1;
          let result: Awaited<ReturnType<PluginContext["issues"]["requestWakeup"]>>;
          try {
            result = await this.ctx.issues.requestWakeup(wait.issueId, wait.companyId, { reason, contextSource: "plugin.ci-wake", idempotencyKey: `ci-wake:${wait.repo}:${wait.headSha}:${wait.waitId}` });
          } catch (error) {
            const deferred = retryableBeforeQueue(error);
            wait.status = deferred ? "open" : "unconfirmed";
            if (!deferred) wait.finishedAt = this.now();
            this.audit(ledger, "wake", deferred ? "host_deferred" : "unconfirmed", undefined, wait.waitId);
            await this.save(ledger);
            if (!deferred) this.ctx.logger.warn("ci-wake: wake unconfirmed; use the card backstop", { waitId: wait.waitId });
            continue;
          }
          wait.status = result.queued ? "woken" : "open";
          if (result.queued) wait.finishedAt = this.now();
          this.audit(ledger, "wake", result.queued ? "woken" : "host_deferred", undefined, wait.waitId);
          // Recording failures after dispatch are never classified as a pre-queue refusal.
          await this.save(ledger);
        }
      } catch (error) {
        if (error instanceof BindingChanged) {
          wait.status = "retired"; wait.reason = "binding_changed"; wait.finishedAt = this.now();
        }
        this.audit(ledger, "poll", error instanceof BindingChanged ? "binding_changed" : "retryable", undefined, wait.waitId);
        await this.save(ledger);
      }
    }
    await this.save(ledger);
  }

  async webhook(input: PluginWebhookInput): Promise<void> {
    if (input.endpointKey !== "github-ci") throw new Error("unknown_webhook");
    if (header(input, "x-github-event") !== "check_suite") return;
    if (Buffer.byteLength(input.rawBody, "utf8") > 65_536) throw new Error("webhook_too_large");
    const signature = header(input, "x-hub-signature-256");
    const delivery = header(input, "x-github-delivery");
    if (!signature || !/^sha256=[0-9a-f]{64}$/.test(signature) || !delivery || !UUID.test(delivery)) throw new Error("invalid_webhook_headers");
    const payload = JSON.parse(input.rawBody) as Record<string, any>;
    if (payload?.action !== "completed") return;
    const repo = typeof payload.repository?.full_name === "string" ? payload.repository.full_name.toLowerCase() : "";
    const sha = payload.check_suite?.head_sha;
    if (typeof sha !== "string" || !SHA.test(sha)) throw new Error("invalid_webhook_payload");
    if (this.now() - this.webhookAdmissions.since >= 60_000) this.webhookAdmissions = { since: this.now(), used: 0 };
    if (this.pendingWebhooks >= 2 || this.webhookAdmissions.used >= 6) throw new Error("webhook_admission_budget");
    this.webhookAdmissions.used += 1;
    this.pendingWebhooks += 1;
    try { await this.webhookAdmitted(input, repo, sha, signature, delivery); } finally { this.pendingWebhooks -= 1; }
  }

  private async webhookAdmitted(input: PluginWebhookInput, repo: string, sha: string, signature: string, delivery: string): Promise<void> {
    const payload = JSON.parse(input.rawBody) as Record<string, any>;
    let target: { companyId: string; repo: string; sha: string } | undefined;
    await this.serialized(async () => {
      const ledger = await this.load();
      this.compact(ledger);
      const companies = [...new Set(ledger.waits.filter((w) => w.status === "open" && w.repo === repo && w.headSha === sha).map((w) => w.companyId))];
      for (const companyId of companies) {
        let config: CiConfig;
        try { config = await this.config(companyId, false); } catch { continue; }
        if (!config.enabled || !config.webhooksEnabled || !config.webhookSecretRef || !config.allowedRepos.includes(repo)) continue;
        const owner = payload.repository?.owner?.login;
        if (typeof owner !== "string" || owner.toLowerCase() !== repo.split("/")[0]) continue;
        if (payload.organization !== undefined && (typeof payload.organization?.login !== "string" || payload.organization.login.toLowerCase() !== owner.toLowerCase())) continue;
        if (this.now() - this.webhookBudget.since >= 60_000) this.webhookBudget = { since: this.now(), used: 0 };
        if (++this.webhookBudget.used > 6) throw new Error("webhook_verification_budget");
        let secret: string;
        try { secret = await this.resolveSecret(config.webhookSecretRef!, companyId, "webhookSecretRef"); } catch { continue; }
        if (!verifyCiSignature(secret, input.rawBody, signature)) continue;
        const replayKey = `${companyId}:${delivery}`;
        if (ledger.deliveries[replayKey]) return;
        if (Object.keys(ledger.deliveries).length >= LIMITS.deliveries) throw new Error("replay_capacity");
        ledger.deliveries[replayKey] = this.now();
        const hintKey = `${companyId}:${repo}:${sha}`;
        const recent = Object.values(ledger.hints).filter((at) => this.now() - at < 60_000).length;
        if (recent < 6 && (ledger.hints[hintKey] === undefined || this.now() - ledger.hints[hintKey]! >= 20_000)) {
          ledger.hints[hintKey] = this.now();
          target = { companyId, repo, sha };
        }
        this.audit(ledger, "webhook", target ? "hint" : "debounced");
        await this.save(ledger);
        return;
      }
      // No registration means no mapping, no branch fallback and no wake.
      if (companies.length) throw new Error("webhook_signature_refused");
    });
    if (target) await this.poll(target);
  }
}
