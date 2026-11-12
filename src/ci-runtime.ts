import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PluginContext, PluginWebhookInput, ToolRunContext, ToolResult } from "@paperclipai/plugin-sdk";
import { parseCiConfig, parseRegistration, validateCiConfig, workspaceRepo, UUID, SHA, InvalidRegistrationError, type CiConfig, type Registration } from "./ci-config.js";
import { CiGithub, CiGithubCache, CiGithubError, evaluateReadiness, relevantSuites, type CiReadiness, type CiReadinessTiming, type CiSnapshot } from "./ci-github.js";
import { CiAppAuth } from "./ci-auth.js";
import { retryableBeforeQueue } from "./native-wake.js";
import { parseWorkProductBindings } from "./custody-reader.js";
import { prRefFromUrl } from "./custody-policy.js";

function authIdentity(config: CiConfig): string {
  return JSON.stringify([config.githubTokenSecretRef, config.githubApp]);
}

export const LIMITS = { active: 300, retained: 8_000, audit: 5_000, deliveries: 10_000, reviewerWakes: 10_000, prHeadPending: 1_000, requestsPerTick: 3_600, wakePerTick: 100, waitMs: 7 * 86_400_000, retentionMs: 30 * 86_400_000, replayMs: 86_400_000, tickMs: 600_000, secretResolveMs: 15_000, webhookPending: 32, webhookAdmissionPerMin: 240, webhookVerifyPerMin: 120, webhookHintsPerMin: 120, webhookDebounceMs: 10_000 } as const;
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
   * Registering agent, for the pr-head reviewer-wake pusher exclusion.
   * Optional: waits persisted before this field existed have no known
   * pusher agent and are treated as ambiguous (prefer waking).
   */
  agentId?: string;
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
interface Audit { at: number; operation: string; runId?: string; companyId?: string; waitId?: string; outcome: string; detail?: string }
/**
 * A settled-candidate head change for a PR that still owes reviewer wakes.
 * Persisted so an unsettled head observed in one tick is rechecked (and
 * woken) on a later tick even after every wait for the old head retired.
 * `oldSha` is the head the reviewer last saw; `newSha` is the head now
 * awaiting settlement. `shadowLogged` records the candidate cards already
 * shadow-logged for this entry, so a candidate that becomes eligible later
 * is still logged once. A legacy `true` (pre-per-candidate ledger) is
 * migrated to `["*"]` — no candidate is re-logged for that old entry.
 */
export interface PrHeadPending {
  companyId: string;
  repo: string;
  prNumber: number;
  oldSha: string;
  newSha: string;
  observedAt: number;
  shadowLogged?: string[];
}
interface Ledger {
  version: 1;
  waits: Wait[];
  audits: Audit[];
  deliveries: Record<string, number>;
  hints: Record<string, number>;
  samples: Record<string, Array<{ sha: string; ms: number }>>;
  prHeadPending: Record<string, PrHeadPending>;
  /** Per-(company, card, SHA) wake dedupe timestamps for pr_head_changed. */
  reviewerWakes: Record<string, number>;
}
const empty = (): Ledger => ({ version: 1, waits: [], audits: [], deliveries: {}, hints: {}, samples: {}, prHeadPending: {}, reviewerWakes: {} });
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

/**
 * Safe, closed reason per refusal code. Reasons are fixed strings (plus the
 * numeric HTTP status on github_http, the 403/429 endpoint-class diagnostic,
 * and the shape-only field summary on invalid_registration): no upstream
 * bodies, host detail, or argument values ever cross into agent output.
 * The one exception is the token_exchange 403 diagnostic, whose bounded
 * GitHub-refusal-message token (one word-class plus a sanitized, truncated
 * underscore-joined message; credential shapes refused) crosses into both
 * the reason and the audit detail — the only body-derived text allowed out.
 */
const REFUSAL_REASONS: Record<string, string> = {
  invalid_registration: "Send exactly issueId (Paperclip issue UUID, not the TWO-#### identifier), repo (owner/repo), prNumber (integer), and headSha (full 40-character commit SHA, e.g. from `git rev-parse HEAD`).",
  invalid_run_context: "The run context is invalid; register from a fresh run.",
  invalid_configuration: "Plugin configuration is invalid; ask the operator to check the instance config.",
  plugin_disabled: "CI wake is not enabled for this company.",
  repo_refused: "Repository is not in the configured allowlist.",
  checkout_refused: "This run does not own the issue checkout.",
  issue_binding_refused: "The execution workspace does not match the issue checkout.",
  workspace_binding_refused: "The execution workspace does not match the issue checkout.",
  pr_binding_refused: "The live PR does not match the registered number, head SHA, or repository.",
  binding_changed: "Workspace binding changed during registration; register from a new run.",
  registration_requires_new_run: "This wait is bound to a different workspace; register from a new run.",
  wait_alias_capacity: "CI wait alias capacity reached; retry later.",
  wait_capacity: "CI wait capacity reached; retry later.",
  github_auth: "GitHub App token mint failed; ask the operator to check the App installation.",
  github_backoff: "GitHub budget or backoff is in effect; retry shortly.",
  github_backoff_capacity: "GitHub budget or backoff is in effect; retry shortly.",
  github_response: "GitHub returned an unexpected response.",
  github_pages: "GitHub returned an unexpected response.",
  github_input: "GitHub returned an unexpected response.",
  github_network: "GitHub returned an unexpected response.",
  github_timeout: "GitHub returned an unexpected response.",
  secret_resolution_timeout: "GitHub credential unavailable; retry shortly.",
  credential_unavailable: "GitHub credential unavailable; retry shortly.",
  invalid_ledger: "The stored CI ledger is invalid; ask the operator to inspect it.",
  registration_refused: "Registration refused.",
};

function refusalDetail(error: unknown): { code: string; reason: string; auditDetail?: string } {
  const code = refusalCode(error);
  let reason = REFUSAL_REASONS[code] ?? REFUSAL_REASONS.registration_refused!;
  let auditDetail: string | undefined;
  if (code === "github_http") {
    const status = error instanceof CiGithubError ? error.status : undefined;
    const detail = error instanceof CiGithubError ? error.detail : undefined;
    reason = status === undefined ? "GitHub request failed." : detail === undefined ? `GitHub returned HTTP ${status}.` : `GitHub returned HTTP ${status} (${detail}).`;
    // The audit ledger is the durable triage record: when the agent-facing
    // reason is masked upstream (e.g. a gateway that drops plugin content),
    // the numeric status here still distinguishes permission (403) from
    // missing repo access (404) from throttling (429). When the 403/429
    // diagnostic is present it also names the allowlisted endpoint class
    // (and, for 403, the required permissions, plus — for a token-exchange
    // 403 — the classified GitHub refusal message) so the failing call is
    // identifiable without raw URLs/repos/branches in the ledger.
    if (status !== undefined) auditDetail = detail === undefined ? `status=${status}` : `status=${status} ${detail}`;
  }
  if (error instanceof InvalidRegistrationError) {
    const received = error.shape.join(", ");
    reason += ` Received: ${received}.`;
    auditDetail = `shape=${received}`;
  }
  return { code, reason, auditDetail };
}

function transientTimelineError(error: unknown): boolean {
  if (!(error instanceof CiGithubError)) return false;
  if (["network", "timeout", "backoff", "auth"].includes(error.code)) return true;
  return error.code === "http" && (error.retryAt !== undefined || error.status === 429 || (error.status ?? 0) >= 500);
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

/**
 * Extract the exact head SHA a signed delivery claims completion for, or null
 * when the event/action is not a CI-hint trigger. A returned SHA is only a
 * ledger lookup key: without an open wait matching it exactly, nothing is read.
 */
function webhookHeadSha(event: string | undefined, rawBody: string): string | null {
  // Unsupported events are ignored without parsing, even when malformed.
  if (!["check_suite", "check_run", "workflow_run", "pull_request"].includes(event ?? "")) return null;
  let payload: Record<string, any>;
  try { payload = JSON.parse(rawBody) as Record<string, any>; } catch { throw new Error("invalid_webhook_payload"); }
  const shaOf = (value: unknown): string | null => (typeof value === "string" && SHA.test(value) ? value : null);
  switch (event) {
    case "check_suite":
    case "check_run":
    case "workflow_run": {
      if (payload?.action !== "completed") return null;
      const sha = shaOf(event === "check_suite" ? payload.check_suite?.head_sha : event === "check_run" ? payload.check_run?.head_sha : payload.workflow_run?.head_sha);
      if (!sha) throw new Error("invalid_webhook_payload");
      return sha;
    }
    case "pull_request":
      // Non-CI transitions (assigned, labeled, ...) carry no head evidence.
      if (!["opened", "reopened", "synchronize", "ready_for_review"].includes(payload?.action)) return null;
      return shaOf(payload.pull_request?.head?.sha) ?? (() => { throw new Error("invalid_webhook_payload"); })();
    default:
      return null;
  }
}

/** One host-managed worker owns this ledger. All entrypoints share its lock, including overlapping job callbacks. */
export class CiWakeRuntime {
  private lock: Promise<unknown> = Promise.resolve();
  private pollInFlight = false;
  private targetedPoll = false;
  private fullPollRequested = false;
  private readonly pendingTargets = new Map<string, { companyId: string; repo: string; sha: string }>();
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
    // Ledgers persisted before pr_head_changed existed lack these fields.
    ledger.prHeadPending ??= {};
    ledger.reviewerWakes ??= {};
    return ledger;
  }

  private async save(ledger: Ledger): Promise<void> {
    await this.ctx.state.set(KEY, ledger);
  }

  private audit(ledger: Ledger, operation: string, outcome: string, run?: ToolRunContext, waitId?: string, detail?: string): void {
    ledger.audits.push({ at: this.now(), operation, outcome, ...(run && UUID.test(run.runId) && UUID.test(run.companyId) ? { runId: run.runId, companyId: run.companyId } : {}), ...(waitId ? { waitId } : {}), ...(detail ? { detail } : {}) });
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
    for (const [key, entry] of Object.entries(ledger.prHeadPending)) {
      // Migrate the pre-per-candidate boolean flag (see PrHeadPending).
      if (entry && (entry as { shadowLogged?: unknown }).shadowLogged === true) entry.shadowLogged = ["*"];
      else if (entry && (entry as { shadowLogged?: unknown }).shadowLogged !== undefined && !Array.isArray((entry as { shadowLogged?: unknown }).shadowLogged)) entry.shadowLogged = [];
      if (!entry || typeof entry.companyId !== "string" || typeof entry.repo !== "string" || !Number.isSafeInteger(entry.prNumber) || !SHA.test(entry.newSha) || !SHA.test(entry.oldSha)) delete ledger.prHeadPending[key];
      else if (now - entry.observedAt >= LIMITS.waitMs) delete ledger.prHeadPending[key];
    }
    for (const [key, at] of Object.entries(ledger.reviewerWakes)) if (now - at >= LIMITS.retentionMs) delete ledger.reviewerWakes[key];
    // Explicit count caps (mirroring deliveries), evicting oldest first so a
    // busy company cannot grow these maps without bound between TTL expiries.
    if (Object.keys(ledger.prHeadPending).length > LIMITS.prHeadPending) {
      const oldest = Object.entries(ledger.prHeadPending).sort((a, b) => a[1].observedAt - b[1].observedAt).slice(0, Object.keys(ledger.prHeadPending).length - LIMITS.prHeadPending);
      for (const [key] of oldest) delete ledger.prHeadPending[key];
    }
    if (Object.keys(ledger.reviewerWakes).length > LIMITS.reviewerWakes) {
      // Never evict a dedupe record a still-pending entry relies on: its
      // successfully-woken candidates would be woken again on the next
      // tick. (Keys are companyId:issueId:sha; UUIDs and SHAs carry no
      // colons, so membership is a (company, sha) pair check.)
      const live = new Set(Object.values(ledger.prHeadPending).map((entry) => `${entry.companyId}:${entry.newSha}`));
      const evictable = Object.entries(ledger.reviewerWakes)
        .filter(([key]) => { const [c, , s] = key.split(":"); return !live.has(`${c}:${s}`); })
        .sort((a, b) => a[1] - b[1]);
      const excess = Object.keys(ledger.reviewerWakes).length - LIMITS.reviewerWakes;
      for (const [key] of evictable.slice(0, excess)) delete ledger.reviewerWakes[key];
      // Protected records alone exceeding the cap: evict oldest overall
      // rather than grow without bound (pending entries are capped at
      // 1,000, bounding this in practice).
      const remaining = Object.keys(ledger.reviewerWakes).length - LIMITS.reviewerWakes;
      if (remaining > 0) {
        const oldest = Object.entries(ledger.reviewerWakes).sort((a, b) => a[1] - b[1]).slice(0, remaining);
        for (const [key] of oldest) delete ledger.reviewerWakes[key];
      }
    }
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
      // A 600s tick outlives one 180s auth cycle: mint a fresh source rather
      // than reusing an expired one (which would fail every later wait).
      const existing = cycle.get(scope);
      if (!existing || existing.expired()) cycle.set(scope, new CiAppAuth({
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
        // The normal flow is push-then-register: an open wait never survives
        // long enough for a poll to observe the moved head, and a settled
        // wait is never polled again. Registering a new head therefore
        // records the change itself when the most recent prior wait for this
        // card/PR was for a different head (the live PR head was verified
        // above, so a differing prior head means the PR really moved).
        const prior = ledger.waits
          .filter((w) => w.companyId === run.companyId && w.repo === registration.repo && w.prNumber === registration.prNumber && w.issueId === registration.issueId)
          .sort((a, b) => b.registeredAt - a.registeredAt)[0];
        if (prior) this.noteHeadChange(ledger, run.companyId, registration.repo, registration.prNumber, prior.headSha, registration.headSha);
        ledger.waits.push({ ...registration, ...binding, branchVerified, waitId, companyId: run.companyId, runId: run.runId, agentId: run.agentId.toLowerCase(), aliases: [], registeredAt: now, expiresAt: now + LIMITS.waitMs, status: "open" });
        this.audit(ledger, "register", "registered", run, waitId);
        await this.save(ledger);
        return { content: "CI wait registered", data: { waitId, status: "open", expiresAt: now + LIMITS.waitMs, dryRun: config.dryRun } };
      } catch (error) {
        // Neither host exceptions nor upstream response bodies are safe
        // agent output. Only the enumerated code plus its closed safe
        // reason cross the boundary, in `content` (the agent-visible
        // channel) and `data`; the audit row records both for triage.
        const { code, reason, auditDetail } = refusalDetail(error);
        const content = `CI registration refused: ${code}. ${reason}`;
        if (ledger === undefined) return { content, error: `CI registration refused: ${code}`, data: { code, reason } };
        this.audit(ledger, "register", code, run, waitId, auditDetail);
        await this.save(ledger);
        return { content, error: `CI registration refused: ${code}`, data: { code, reason } };
      }
    });
  }

  /**
   * Record an observed head change for later reviewer-wake processing.
   * Only a genuine new head on an open, same-repo PR counts: closes,
   * merges, forks and number mismatches are not pushes.
   */
  private noteHeadChange(ledger: Ledger, companyId: string, repo: string, prNumber: number, oldSha: string, newSha: string): void {
    if (oldSha === newSha) return;
    const key = `${companyId}:${repo}:${prNumber}`;
    const existing = ledger.prHeadPending[key];
    if (existing && existing.newSha === newSha) return;
    ledger.prHeadPending[key] = { companyId, repo, prNumber, oldSha: existing?.oldSha ?? oldSha, newSha, observedAt: this.now() };
  }

  /** Exact work-product match for one PR; mirrors custody's work_product tier. */
  private hasPrWorkProduct(issue: { workProducts?: unknown }, repo: string, prNumber: number): boolean {
    const bindings = parseWorkProductBindings(issue.workProducts);
    if (!bindings) return false;
    const ref = `${repo.toLowerCase()}#${prNumber}`;
    for (const w of bindings) {
      if (w.url !== null && prRefFromUrl(w.url) !== ref) continue;
      const metaRepo = w.metadata && typeof w.metadata.repo === "string" ? w.metadata.repo.toLowerCase() : null;
      const metaNumber = w.metadata && typeof w.metadata.number === "number" ? w.metadata.number : null;
      if (metaRepo !== null && metaRepo !== repo.toLowerCase()) continue;
      if (metaNumber !== null && metaNumber !== prNumber) continue;
      if ((w.url !== null && prRefFromUrl(w.url) === ref) || (metaRepo !== null && metaNumber !== null)) return true;
    }
    return false;
  }

  /**
   * Pusher/author exclusion. GitHub PR author/pusher identities are
   * logins, never Paperclip agent IDs, so they cannot be mapped; only
   * definite agent-ID equality excludes. Ambiguous identity (human
   * participant, legacy wait without agentId, no returnAssignee) wakes.
   */
  private isAuthorParticipant(issue: any, ledger: Ledger, entry: PrHeadPending): boolean {
    const participant = issue?.executionState?.currentParticipant;
    if (!participant || participant.type !== "agent" || typeof participant.agentId !== "string") return false;
    const agent = participant.agentId.toLowerCase();
    if (!UUID.test(agent)) return false;
    const authors = new Set<string>();
    for (const wait of ledger.waits) {
      if (wait.companyId === entry.companyId && wait.repo === entry.repo && wait.prNumber === entry.prNumber && wait.agentId) authors.add(wait.agentId.toLowerCase());
    }
    const returnAgent = issue?.executionState?.returnAssignee?.agentId;
    if (typeof returnAgent === "string" && UUID.test(returnAgent)) authors.add(returnAgent.toLowerCase());
    // Deliberately NOT the card's assigneeAgentId: on a real in_review card
    // Paperclip reassigns the card to the pending participant, so the
    // assignee IS the participant in essentially every production shape.
    // Treating it as authorship excluded every reviewer and the feature
    // never fired. See the production-shape regression test.
    return authors.has(agent);
  }

  /**
   * Checks that only run on ready PRs register after the draft flips. Only a
   * missing-check-only failure on a ready PR consults the timeline, so its
   * grace restarts at the latest ready_for_review event. Null: retry later.
   * Only transient timeline errors retry; a repeatable one (page cap, budget,
   * malformed body, 4xx) would retry until the wait expires, so it falls back
   * to the un-graced verdict: at worst one early wake, never a lost one.
   */
  private async readyGrace(github: CiGithub, repo: string, prNumber: number, draft: boolean, snapshot: CiSnapshot, timing: CiReadinessTiming): Promise<{ verdict: CiReadiness; consulted: boolean } | null> {
    const verdict = evaluateReadiness(snapshot, timing);
    if (verdict.kind !== "fail" || verdict.failed.length || !verdict.missing.length || draft) return { verdict, consulted: false };
    let readySince: number | undefined;
    try { readySince = await github.readySince(repo, prNumber); } catch (error) {
      if (transientTimelineError(error)) return null;
      readySince = undefined;
    }
    return { verdict: readySince === undefined ? verdict : evaluateReadiness(snapshot, { ...timing, readySince }), consulted: true };
  }

  async poll(only?: { companyId: string; repo: string; sha: string }): Promise<void> {
    if (this.pollInFlight) {
      if (!only && this.targetedPoll) this.fullPollRequested = true;
      // Queue targeted hints instead of dropping them: a completed head whose
      // hint arrives mid-poll must not wait for the next backstop tick.
      else if (only) this.pendingTargets.set(`${only.companyId}:${only.repo}:${only.sha}`, only);
      return;
    }
    this.pollInFlight = true;
    this.targetedPoll = only !== undefined;
    try {
      await this.serialized(() => this.pollLocked(only));
      // Drain requests that arrived while this poll ran (targets may arrive
      // during the drain too; loop until nothing is left).
      while (this.fullPollRequested || this.pendingTargets.size > 0) {
        if (this.fullPollRequested) {
          this.targetedPoll = false;
          this.fullPollRequested = false;
          await this.serialized(() => this.pollLocked());
        } else {
          const targets = [...this.pendingTargets.values()];
          this.pendingTargets.clear();
          this.targetedPoll = true;
          for (const target of targets) await this.serialized(() => this.pollLocked(target));
          this.targetedPoll = false;
        }
      }
    } finally {
      this.pollInFlight = false;
      this.targetedPoll = false;
      this.fullPollRequested = false;
      this.pendingTargets.clear();
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
    const appIdsByIdentity = new Map<string, Map<string, number | null>>();
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
          if (pr.number === wait.prNumber && pr.state === "open" && !pr.merged && pr.headSha !== wait.headSha && pr.headRepo?.toLowerCase() === wait.repo) {
            this.noteHeadChange(ledger, wait.companyId, wait.repo, wait.prNumber, wait.headSha, pr.headSha);
          }
          wait.status = "retired"; wait.reason = "head_moved_or_closed"; wait.finishedAt = this.now(); await this.save(ledger); continue;
        }
        const identity = `${wait.companyId}:${authIdentity(config)}`;
        let appIds = appIdsByIdentity.get(identity);
        if (!appIds) { appIds = new Map(); appIdsByIdentity.set(identity, appIds); }
        const snapshot = await github.snapshot(wait.repo, wait.headSha, pr.baseBranch, appIds);
        const samples = ledger.samples[`${wait.companyId}:${wait.repo}`] ?? [];
        const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
        const medianMs = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : config.repoMedianMs[wait.repo] ?? 30 * 60_000;
        const graced = await this.readyGrace(github, wait.repo, wait.prNumber, pr.draft, snapshot, { registeredAt: wait.registeredAt, now: this.now(), medianMs, draft: pr.draft });
        if (!graced || graced.verdict.kind === "pending") continue;
        const { verdict } = graced;
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
        if (current.draft !== pr.draft) continue;
        if (current.number !== wait.prNumber || current.headSha !== wait.headSha || current.state !== "open" || current.merged || current.baseBranch !== pr.baseBranch || current.headRepo?.toLowerCase() !== wait.repo) {
          if (current.number === wait.prNumber && current.state === "open" && !current.merged && current.headSha !== wait.headSha && current.headRepo?.toLowerCase() === wait.repo) {
            this.noteHeadChange(ledger, wait.companyId, wait.repo, wait.prNumber, wait.headSha, current.headSha);
          }
          wait.status = "retired"; wait.reason = "head_moved_or_closed"; wait.finishedAt = this.now(); await this.save(ledger); continue;
        }
        // A draft/ready toggle after the timeline read changes updated_at.
        if (graced.consulted && (current.updatedAt == null || current.updatedAt !== pr.updatedAt)) continue;
        if (!verdict.missing.length && !samples.some((s) => s.sha === wait.headSha)) {
          const suites = relevantSuites(snapshot);
          const starts = suites.map((s) => s.createdAt).filter((n): n is number => n !== null);
          const finishes = suites.map((s) => s.completedAt).filter((n): n is number => n !== null);
          // A missing start may be the earliest one; a partial span would understate CI duration.
          if (suites.length && starts.length === suites.length && finishes.length === suites.length) {
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
    // Reviewer wakes for observed head changes (settled heads only).
    {
      const entries = Object.entries(ledger.prHeadPending)
        .filter(([, e]) => !only || (e.companyId === only.companyId && e.repo === only.repo && e.newSha === only.sha))
        .sort((a, b) => a[1].observedAt - b[1].observedAt);
      for (const [key, entry] of entries) {
        if (requests >= LIMITS.requestsPerTick || wakes >= LIMITS.wakePerTick || this.now() - started >= LIMITS.tickMs) break;
        try {
          const config = await this.config(entry.companyId, false);
          // Feature off: drop the entry rather than accumulate stale wakes.
          if (!config.enabled || !config.prHeadWakeEnabled) { delete ledger.prHeadPending[key]; await this.save(ledger); continue; }
          if (!config.allowedRepos.includes(entry.repo)) { delete ledger.prHeadPending[key]; await this.save(ledger); continue; }
          const github = await this.client(entry.companyId, config, entry.repo, fetch, cycle);
          const current = await github.pull(entry.repo, entry.prNumber);
          if (current.number !== entry.prNumber || current.state !== "open" || current.merged || current.headRepo?.toLowerCase() !== entry.repo) { delete ledger.prHeadPending[key]; await this.save(ledger); continue; }
          if (current.headSha !== entry.newSha) {
            // Newer push superseded the pending head: re-target, keeping the
            // oldest oldSha the reviewer last saw.
            entry.oldSha = entry.newSha; entry.newSha = current.headSha; entry.observedAt = this.now(); entry.shadowLogged = [];
            await this.save(ledger); continue;
          }
          const snapshot = await github.snapshot(entry.repo, entry.newSha, current.baseBranch);
          const samples = ledger.samples[`${entry.companyId}:${entry.repo}`] ?? [];
          const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
          const medianMs = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : config.repoMedianMs[entry.repo] ?? 30 * 60_000;
          const graced = await this.readyGrace(github, entry.repo, entry.prNumber, current.draft, snapshot, { registeredAt: entry.observedAt, now: this.now(), medianMs, draft: current.draft });
          // Unsettled heads do not wake yet; the entry stays for a later tick.
          if (!graced || graced.verdict.kind === "pending") continue;
          const { verdict } = graced;
          // Mirror the CI path: re-read the live PR after the readiness
          // snapshot and before any wake intent. A push during the snapshot
          // must retarget the entry, never wake for the stale SHA.
          const checked = await github.pull(entry.repo, entry.prNumber);
          if (checked.number !== entry.prNumber || checked.state !== "open" || checked.merged || checked.headRepo?.toLowerCase() !== entry.repo) { delete ledger.prHeadPending[key]; await this.save(ledger); continue; }
          if (checked.headSha !== entry.newSha) {
            // Newer push superseded the pending head: re-target, keeping the
            // oldest oldSha the reviewer last saw.
            entry.oldSha = entry.newSha; entry.newSha = checked.headSha; entry.observedAt = this.now(); entry.shadowLogged = [];
            await this.save(ledger); continue;
          }
          if (checked.draft !== current.draft) continue;
          if (checked.baseBranch !== current.baseBranch) {
            // Base-only edit: the head the reviewer last saw is unchanged, so
            // keep oldSha/newSha (never collapse them into a meaningless
            // same-SHA wake) and retry against the new base next tick.
            entry.observedAt = this.now();
            await this.save(ledger); continue;
          }
          if (graced.consulted && (checked.updatedAt == null || checked.updatedAt !== current.updatedAt)) continue;
          // Revalidate binding, enablement, allowlist, pr-head flags, dry-run
          // and the credential identity immediately after the final GitHub
          // read: an operator rollback (dryRun: true, disable, revoke) made
          // during that await must not be followed by a stale-authority wake.
          const revalidated = await this.config(entry.companyId);
          if (!revalidated.enabled || !revalidated.prHeadWakeEnabled || !revalidated.allowedRepos.includes(entry.repo) || revalidated.prHeadWakeShadow !== config.prHeadWakeShadow || revalidated.dryRun !== config.dryRun || authIdentity(revalidated) !== authIdentity(config)) throw new Error("configuration_changed");
          // dryRun is the global rollback kill-switch: it forces no-fire
          // (effective shadow) exactly like prHeadWakeShadow, so an operator
          // rollback via dryRun: true silences this path too.
          const shadow = revalidated.prHeadWakeShadow || revalidated.dryRun;
          const candidates = [...new Set(ledger.waits.filter((w) => w.companyId === entry.companyId && w.repo === entry.repo && w.prNumber === entry.prNumber).map((w) => w.issueId))];
          let outstanding = false;
          for (const issueId of candidates) {
            const wakeKey = `${entry.companyId}:${issueId}:${entry.newSha}`;
            if (ledger.reviewerWakes[wakeKey] !== undefined) continue;
            let issue: any;
            try { issue = await this.ctx.issues.get(issueId, entry.companyId); }
            catch { outstanding = true; continue; }
            if (!issue || issue.id !== issueId || issue.companyId !== entry.companyId) { outstanding = true; continue; }
            if (issue.status !== "in_review") continue;
            const state = issue.executionState;
            if (!state || state.status !== "pending" || state.currentStageId == null || !state.currentParticipant) continue;
            if (!this.hasPrWorkProduct(issue, entry.repo, entry.prNumber)) continue;
            if (this.isAuthorParticipant(issue, ledger, entry)) continue;
            const reason = `pr_head_changed: ${entry.repo}#${entry.prNumber} head ${entry.oldSha.slice(0, 7)} -> ${entry.newSha.slice(0, 7)}; CI ${verdict.kind}`;
            if (shadow) {
              entry.shadowLogged ??= [];
              if (!entry.shadowLogged.includes(issueId) && !entry.shadowLogged.includes("*")) {
                entry.shadowLogged.push(issueId);
                this.audit(ledger, "pr_head_wake", "would_wake");
                await this.save(ledger);
                this.ctx.logger.info("pr-head-wake: would wake", { companyId: entry.companyId, issueId, repo: entry.repo, prNumber: entry.prNumber, oldSha: entry.oldSha, newSha: entry.newSha });
              }
              outstanding = true;
              continue;
            }
            // Per-tick wake budget applies inside the candidate loop too:
            // one PR can have many eligible cards. Stop dispatching, keep
            // the entry, and resume the rest on the next tick; already
            // woken cards stay deduped via reviewerWakes.
            if (wakes >= LIMITS.wakePerTick || requests >= LIMITS.requestsPerTick || this.now() - started >= LIMITS.tickMs) { outstanding = true; break; }
            // Persist dedupe intent BEFORE the host call. A lost reply or
            // restart never repeats this (card, SHA) effect.
            ledger.reviewerWakes[wakeKey] = this.now();
            this.audit(ledger, "pr_head_wake", "intent");
            try { await this.save(ledger); } catch {
              delete ledger.reviewerWakes[wakeKey];
              outstanding = true; throw new Error("wake_intent_write_failed");
            }
            wakes += 1;
            let result: Awaited<ReturnType<PluginContext["issues"]["requestWakeup"]>>;
            try {
              result = await this.ctx.issues.requestWakeup(issueId, entry.companyId, { reason, contextSource: "plugin.ci-wake", idempotencyKey: `pr-head-wake:${entry.repo}:${entry.prNumber}:${entry.newSha}:${issueId}` });
            } catch (error) {
              if (retryableBeforeQueue(error)) {
                delete ledger.reviewerWakes[wakeKey];
                this.audit(ledger, "pr_head_wake", "host_deferred");
                outstanding = true;
              } else {
                this.audit(ledger, "pr_head_wake", "unconfirmed");
                this.ctx.logger.warn("pr-head-wake: wake unconfirmed; use the card backstop", { issueId, repo: entry.repo, prNumber: entry.prNumber });
              }
              await this.save(ledger);
              continue;
            }
            if (result.queued) {
              this.audit(ledger, "pr_head_wake", "woken");
            } else {
              delete ledger.reviewerWakes[wakeKey];
              this.audit(ledger, "pr_head_wake", "host_deferred");
              outstanding = true;
            }
            await this.save(ledger);
          }
          // Clear only when every candidate is woken/deduped/ineligible/excluded.
          if (!outstanding && !shadow) { delete ledger.prHeadPending[key]; await this.save(ledger); }
        } catch (error) {
          this.audit(ledger, "pr_head_wake", "retryable");
          await this.save(ledger);
        }
      }
    }
    await this.save(ledger);
  }

  async webhook(input: PluginWebhookInput): Promise<void> {
    if (input.endpointKey !== "github-ci") throw new Error("unknown_webhook");
    const event = header(input, "x-github-event");
    // Unsupported events are ignored without parsing, even when malformed or oversized.
    if (!["check_suite", "check_run", "workflow_run", "pull_request"].includes(event ?? "")) return;
    // Supported events: enforce the size cap before any JSON parsing, so an
    // unauthenticated sender cannot force an oversized parse. An oversized
    // non-terminal action is therefore rejected rather than ignored — its
    // action cannot be known without parsing. Within-cap non-terminal
    // actions are still ignored below without ledger reads.
    if (Buffer.byteLength(input.rawBody, "utf8") > 65_536) throw new Error("webhook_too_large");
    const sha = webhookHeadSha(event, input.rawBody);
    if (sha === null) return;
    const signature = header(input, "x-hub-signature-256");
    const delivery = header(input, "x-github-delivery");
    if (!signature || !/^sha256=[0-9a-f]{64}$/.test(signature) || !delivery || !UUID.test(delivery)) throw new Error("invalid_webhook_headers");
    const payload = JSON.parse(input.rawBody) as Record<string, any>;
    const repo = typeof payload.repository?.full_name === "string" ? payload.repository.full_name.toLowerCase() : "";
    if (this.now() - this.webhookAdmissions.since >= 60_000) this.webhookAdmissions = { since: this.now(), used: 0 };
    if (this.pendingWebhooks >= LIMITS.webhookPending || this.webhookAdmissions.used >= LIMITS.webhookAdmissionPerMin) throw new Error("webhook_admission_budget");
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
        if (++this.webhookBudget.used > LIMITS.webhookVerifyPerMin) throw new Error("webhook_verification_budget");
        let secret: string;
        try { secret = await this.resolveSecret(config.webhookSecretRef!, companyId, "webhookSecretRef"); } catch { continue; }
        if (!verifyCiSignature(secret, input.rawBody, signature)) continue;
        const replayKey = `${companyId}:${delivery}`;
        if (ledger.deliveries[replayKey]) return;
        if (Object.keys(ledger.deliveries).length >= LIMITS.deliveries) throw new Error("replay_capacity");
        ledger.deliveries[replayKey] = this.now();
        const hintKey = `${companyId}:${repo}:${sha}`;
        const recent = Object.values(ledger.hints).filter((at) => this.now() - at < 60_000).length;
        if (recent < LIMITS.webhookHintsPerMin && (ledger.hints[hintKey] === undefined || this.now() - ledger.hints[hintKey]! >= LIMITS.webhookDebounceMs)) {
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
