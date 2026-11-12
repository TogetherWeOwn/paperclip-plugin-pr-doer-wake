import type { PluginContext } from "@paperclipai/plugin-sdk";

/** The stock host RPC response is serialized; some SDK releases wrap it in Response. */
export interface CiHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export type CiFetch = (url: string, init?: RequestInit) => Promise<CiHttpResponse | Response>;
/** Omitted repositories means every repository the installation can access (custody's org-wide App mode). */
export type CiTokenExchange = (installationId: string, jwt: string, body: { repositories?: string[]; permissions: Record<string, string> }) => Promise<unknown>;
export interface CiTokenSource {
  token(path: string, exchange: CiTokenExchange): Promise<string>;
  invalidate(): void;
}
export interface CiGithubOptions {
  /** Counts every attempted fetch, including 304s and failed requests, for this instance. */
  maxRequests?: number;
  /** Synchronous caller admission gate; a refusal consumes no request or transport call. */
  beforeRequest?: () => void;
  /** Persist caller admission before starting the transport deadline; a failure sends no HTTP. */
  onRequestAdmitted?: () => Promise<void>;
  maxPages?: number;
  maxCacheEntries?: number;
  maxCacheBytes?: number;
  maxBodyBytes?: number;
  /** Per fetch/body-read deadline; default 15 seconds, at most 30 seconds. */
  requestTimeoutMs?: number;
  now?: () => number;
  /** Token-free state, scoped by the caller to one company/credential identity. */
  cache?: CiGithubCache;
  /** Installation quota only; may span companies, never contains response data. */
  backoff?: { until: number };
}
export interface CiRequiredContext {
  context: string;
  /** null means any integration; a positive ID can only be satisfied by that app. */
  appId: number | null;
}
export interface CiCheckRun {
  id: number;
  name: string;
  appId: number | null;
  /** Exact suite identity, when supplied; app IDs cannot distinguish workflows. */
  suiteId?: number | null;
  status: string;
  conclusion: string | null;
}
export interface CiCheckSuite {
  id: number;
  appId: number | null;
  /** Unknown counts retain the conservative active-suite behaviour. */
  latestCheckRunsCount?: number | null;
  status: string;
  conclusion: string | null;
  createdAt: number | null;
  /** Epoch milliseconds; GitHub's suite updated_at is used when completed_at is absent. */
  completedAt: number | null;
}
export interface CiCommitStatus {
  id: number;
  context: string;
  state: string;
  creatorLogin?: string | null;
  verifiedAppId?: number | null;
}
export interface CiSnapshot {
  repo: string;
  sha: string;
  baseBranch: string;
  required: CiRequiredContext[];
  runs: CiCheckRun[];
  suites: CiCheckSuite[];
  statuses: CiCommitStatus[];
  /** Exact check-run IDs corroborated by terminal jobs in a stable Actions attempt. */
  currentAttemptRunIds?: number[];
  fetchedAt: number;
}
export interface CiPull {
  repo: string;
  number: number;
  headSha: string;
  headBranch: string;
  headRepo: string | null;
  baseBranch: string;
  author: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
}
export const GATES_CONTEXT = "paperclip/gates";
export type GatesStatusState = "success" | "failure" | "error" | "pending";
export interface CiCreatedStatus {
  id: number;
  context: string;
  state: string;
}
export interface CiReadinessTiming {
  now: number;
  registeredAt: number;
  medianMs: number;
  draft?: boolean;
}
export interface CiReadiness {
  kind: "pending" | "pass" | "fail";
  failed: string[];
  missing: string[];
  pending: string[];
  lastSuiteCompletedAt: number | null;
  missingSince: number | null;
  missingFailAt: number | null;
}
export type CiGithubErrorCode = "input" | "auth" | "http" | "network" | "response" | "budget" | "pages" | "backoff" | "timeout";
/**
 * Deliberately contains neither response bodies, request headers, tokens, nor upstream errors.
 * The one exception: on a token_exchange refusal, `detail` may carry the exchange endpoint's
 * fixed GitHub refusal message (see exchangeDetail) — bounded, sanitized, credential-shaped
 * text refused, never the raw body.
 */
export class CiGithubError extends Error {
  constructor(
    public readonly code: CiGithubErrorCode,
    public readonly status?: number,
    public readonly retryAt?: number,
    public readonly detail?: string,
  ) {
    super(`GitHub CI ${code}${status === undefined ? "" : ` (${status})`}${detail === undefined ? "" : ` ${detail}`}`);
    this.name = "CiGithubError";
  }
}

/**
 * Refusal diagnostics for 403/429 only: a fixed allowlist of endpoint
 * templates (never the raw URL, which can carry a repository or branch name),
 * a fixed kind (permission evidence vs throttle vs unclassified), the
 * permissions GitHub itself reported as accepted on a 403, and the
 * rate-limit header values (remaining / retry-after), each re-emitted only
 * when it matches a strict shape. Bounded and secret-free: no bodies, no
 * other headers, no tokens. The rate-limit values separate a refused token
 * exchange from an installation rate limit when both answer 403.
 * For token_exchange 403s only, the endpoint's fixed GitHub refusal message
 * is also classified and emitted (exchangeDetail): both App consumers
 * (ci-wake, custody) die at that mint with an identical 403, and the
 * message — suspended installation vs enterprise/IP/SSO policy vs permission
 * — is the only decider. It is sanitized to one bounded token, credential
 * shapes are refused, and no other endpoint's body text is ever emitted.
 * This is the ci-wake twin of the custody diagnostic in PR #19 (TWO-5961):
 * the same templates and shape so registration/poll 403s name their source
 * (token_exchange vs repo_pulls/rules/protection/checks/statuses/actions)
 * in the ledger audit and the agent-facing refusal reason.
 */
const ENDPOINT_TEMPLATES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/app\/installations\/[1-9][0-9]{0,15}\/access_tokens$/, "token_exchange"],
  [/^\/orgs\/[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/repos$/, "org_repos"],
  [/^\/repos\/[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]+\/issues\/[1-9][0-9]*\/comments$/, "repo_issue_comments"],
  [/^\/repos\/[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]+\/pulls(?:\/[1-9][0-9]*)?$/, "repo_pulls"],
  [/^\/repos\/[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]+\/commits\/[a-fA-F0-9]{40}\/(?:check-runs|check-suites)$/, "repo_checks"],
  [/^\/repos\/[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]+\/check-suites\/[1-9][0-9]*$/, "repo_checks"],
  [/^\/repos\/[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]+\/commits\/[a-fA-F0-9]{40}\/statuses$/, "repo_statuses"],
  [/^\/repos\/[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]+\/actions\/runs(?:\/[1-9][0-9]*(\/attempts\/[1-9][0-9]*\/jobs)?)?$/, "repo_actions"],
  [/^\/repos\/[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]+\/rules\/branches\/[^/]+$/, "repo_rules"],
  [/^\/repos\/[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]+\/branches\/[^/]+\/protection\/required_status_checks$/, "repo_branch_protection"],
  [/^\/graphql$/, "graphql"],
];
function endpointTemplate(path: string): string {
  const bare = path.split("?")[0] ?? "";
  return ENDPOINT_TEMPLATES.find(([pattern]) => pattern.test(bare))?.[1] ?? "other";
}
// GitHub's accepted-permission list, e.g. "metadata=read,issues=read". Up to
// four entries; anything else is dropped rather than echoed.
const NEEDS_PATTERN = /^[a-z_]+=(read|write|admin)(,[a-z_]+=(read|write|admin)){0,3}$/;
// Rate-limit evidence distinguishes a refused token exchange (quota left,
// no retry-after) from an installation rate limit (remaining 0 and/or
// retry-after) when both answer 403. Only strict shapes are re-emitted.
const REMAINING_PATTERN = /^\d{1,10}$/;
const RETRY_SECONDS_PATTERN = /^\d{1,6}$/;
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
function rateLimitDetail(headers: Record<string, string> | Headers): string[] {
  const parts: string[] = [];
  const remaining = header(headers, "x-ratelimit-remaining")?.trim();
  if (remaining !== undefined && REMAINING_PATTERN.test(remaining)) parts.push(`rl-remaining=${remaining}`);
  const retry = header(headers, "retry-after")?.trim();
  if (retry !== undefined && RETRY_SECONDS_PATTERN.test(retry)) {
    parts.push(`retry-after=${retry}`);
  } else if (retry !== undefined && HTTP_DATE.test(retry)) {
    const parsed = Date.parse(retry);
    if (Number.isFinite(parsed)) parts.push(`retry-after=${Math.floor(parsed / 1000)}`);
  }
  return parts;
}
// A token-exchange refusal is the one place a GitHub error `message` leaves the
// client: a single bounded token plus a fixed class, never the raw body, other
// JSON fields, or anything credential-shaped. The token Exchange response is a
// fixed GitHub string (installation suspended, enterprise/IP/SSO policy message,
// or a permission/rate-limit note); it carries no secret material, but the text is
// still treated as untrusted: control/format characters collapse to one space, the
// result is truncated, and SECRET_SHAPE hits drop the message entirely.
const EXCHANGE_MESSAGE_MAX = 160;
function exchangeDetail(message: string | undefined, path: string): string[] {
  if (message === undefined || endpointTemplate(path) !== "token_exchange") return [];
  const clean = message.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
  if (!clean || clean.length > 1024 || SECRET_SHAPE.test(clean)) return [];
  const truncated = clean.length > EXCHANGE_MESSAGE_MAX ? clean.slice(0, EXCHANGE_MESSAGE_MAX).trimEnd() : clean;
  const lower = clean.toLowerCase();
  const kind = lower.includes("suspended") ? "suspended"
    : lower.includes("ip address") || lower.includes("allow list") || lower.includes("allowlist") ? "ip_policy"
    : lower.includes("saml") || lower.includes("single sign-on") || /\bsso\b/.test(lower) ? "sso_policy"
    : lower.includes("enterprise") ? "enterprise_policy"
    : lower.includes("resource not accessible") ? "permission"
    : lower.includes("rate limit") ? "rate_limit"
    : lower.includes("bad credentials") ? "bad_credentials"
    : "unknown";
  return [`exchange_class=${kind}`, `exchange_msg=${truncated.replace(/ /g, "_")}`];
}
function refusalDetail(status: number, permissionDenied: boolean, path: string, headers: Record<string, string> | Headers, message?: string): string {
  const kind = status === 429 ? "throttle" : permissionDenied ? "permission" : "unclassified";
  const base = `${kind} ${endpointTemplate(path)}`;
  const suffix: string[] = [];
  if (status === 403) {
    const raw = header(headers, "x-accepted-github-permissions");
    if (raw !== undefined) {
      // The header may carry trailing guidance after ';'; only the list before it is ours.
      const needs = raw.split(";")[0]!.replace(/\s+/g, "");
      if (needs.length <= 128 && NEEDS_PATTERN.test(needs)) suffix.push(`needs=${needs}`);
    }
    suffix.push(...exchangeDetail(message, path));
  }
  suffix.push(...rateLimitDetail(headers));
  return suffix.length ? `${base} ${suffix.join(" ")}` : base;
}

/**
 * GitHub requires a User-Agent on every REST request and answers UA-less calls
 * with a 403 text/plain ("Please make sure your request has a User-Agent
 * header") carrying no rate-limit headers. The host fetch goes through node
 * http.request, which adds no default User-Agent (unlike global fetch), so the
 * client sets this one explicitly on every request — token exchange included.
 * Keep the version in sync with package.json / manifest.ts.
 */
export const GITHUB_USER_AGENT = "togetherweown-paperclip-plugin-pr-doer-wake/0.3.0";
const ORIGIN = "https://api.github.com";
const PAGE_SIZE = 100;
// Recognize provider credential shapes without retaining expired/previous tokens.
const SECRET_SHAPE = /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{16,}|-----BEGIN (?:RSA )?PRIVATE KEY-----/;
const SECRET_SHAPE_GLOBAL = new RegExp(SECRET_SHAPE.source, "g");
// GitHub PR/issue free-text fields custody consumes as prose. Only these are
// redacted in place; every other credential-shaped string is dropped so strict
// identifier projections keep failing closed. Neither field can hold an identifier.
const FREE_TEXT_KEYS = new Set(["title", "body"]);
type JsonObject = Record<string, unknown>;
function invalid(): never { throw new CiGithubError("response"); }
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as JsonObject;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) return invalid();
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return invalid();
  return value;
}
function id(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return invalid();
  return value;
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
function appId(value: unknown): number | null {
  return value === null ? null : id(object(value).id);
}
function binding(value: unknown): number | null {
  if (value === undefined || value === null || value === -1) return null;
  return id(value);
}
function timestamp(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const parsed = Date.parse(text(value));
  if (!Number.isFinite(parsed)) return invalid();
  return parsed;
}
function repoName(repo: string): string {
  if (typeof repo !== "string" || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/[a-zA-Z0-9_.-]{1,100}$/.test(repo)
      || [".", ".."].includes(repo.split("/")[1]!)) throw new CiGithubError("input");
  return repo.toLowerCase();
}
function fullSha(sha: string): string {
  if (typeof sha !== "string" || !/^[a-fA-F0-9]{40}$/.test(sha)) throw new CiGithubError("input");
  return sha.toLowerCase();
}
function branchName(branch: string): string {
  if (typeof branch !== "string" || !branch || branch.length > 1024 || /[\x00-\x20\x7f]/.test(branch)
      || branch === "." || branch === "..") throw new CiGithubError("input");
  return branch;
}
function bounded(value: number | undefined, fallback: number, ceiling: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > ceiling) throw new CiGithubError("input");
  return result;
}
function header(headers: Record<string, string> | Headers, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}
interface CachedPage { body: string; etag: string; link: string; bytes: number }
interface Page { data: unknown; link: string }

/** Bounded ETags and rate-limit state only: retain this, not a token-bearing CiGithub. */
export class CiGithubCache {
  backoffUntil = 0;
  private bytes = 0;
  private readonly entries = new Map<string, CachedPage>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(options: Pick<CiGithubOptions, "maxCacheEntries" | "maxCacheBytes"> = {}) {
    this.maxEntries = bounded(options.maxCacheEntries, 128, 512);
    this.maxBytes = bounded(options.maxCacheBytes, 4 * 1024 * 1024, 16 * 1024 * 1024);
  }

  get(url: string): CachedPage | undefined {
    const entry = this.entries.get(url);
    if (entry) { this.entries.delete(url); this.entries.set(url, entry); }
    return entry;
  }

  delete(url: string): void {
    const entry = this.entries.get(url);
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(url); }
  }

  remember(url: string, entry: CachedPage): void {
    this.delete(url);
    if (entry.bytes > this.maxBytes) return;
    while (this.entries.size >= this.maxEntries || this.bytes + entry.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    this.entries.set(url, entry);
    this.bytes += entry.bytes;
  }
}

/**
 * Resolve a fresh token for each operation; discard this client afterwards, retaining only options.cache.
 * Old SDKs that throw while wrapping 304 cost two reads: failed conditional + fresh unconditional 200.
 * Deadlines bound waiting, not host execution: the stock host may ignore cancellation.
 */
export class CiGithub {
  private readonly maxRequests: number;
  protected readonly maxPages: number;
  private readonly maxBodyBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private requests = 0;
  private readonly cache: CiGithubCache;
  private readonly backoff: { until: number };
  #credential: string | CiTokenSource;
  private readonly beforeRequest: (() => void) | undefined;
  private readonly onRequestAdmitted: (() => Promise<void>) | undefined;

  /** Authoritative admitted attempts, including failed, cached and timed-out transport calls. */
  get requestCount(): number { return this.requests; }

  constructor(
    private readonly fetch: PluginContext["http"]["fetch"] | CiFetch,
    credential: string | CiTokenSource,
    options: CiGithubOptions = {},
  ) {
    if (typeof credential === "string" ? !credential.trim() || /[\r\n]/.test(credential) : !credential || typeof credential.token !== "function") throw new CiGithubError("input");
    this.#credential = credential;
    this.maxRequests = bounded(options.maxRequests, 100, 10_000);
    this.maxPages = bounded(options.maxPages, 20, 100);
    this.maxBodyBytes = bounded(options.maxBodyBytes, 2 * 1024 * 1024, 8 * 1024 * 1024);
    this.requestTimeoutMs = bounded(options.requestTimeoutMs, 15_000, 30_000);
    this.cache = options.cache ?? new CiGithubCache(options);
    this.backoff = options.backoff ?? { until: 0 };
    this.now = options.now ?? Date.now;
    this.beforeRequest = options.beforeRequest;
    this.onRequestAdmitted = options.onRequestAdmitted;
  }

  async pull(repo: string, prNumber: number): Promise<CiPull> {
    repo = repoName(repo);
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new CiGithubError("input");
    const raw = object((await this.request(`/repos/${repo}/pulls/${prNumber}`)).data);
    const head = object(raw.head);
    const base = object(raw.base);
    if (raw.number !== prNumber || repoName(text(object(base.repo).full_name)) !== repo
        || (raw.state !== "open" && raw.state !== "closed") || typeof raw.draft !== "boolean"
        || typeof raw.merged !== "boolean" || (raw.mergeable !== null && typeof raw.mergeable !== "boolean")) return invalid();
    return {
      repo, number: prNumber, headSha: fullSha(text(head.sha)), headBranch: branchName(text(head.ref)),
      headRepo: head.repo === null ? null : repoName(text(object(head.repo).full_name)),
      baseBranch: branchName(text(base.ref)), author: text(object(raw.user).login),
      state: raw.state, draft: raw.draft, merged: raw.merged, mergeable: raw.mergeable,
    };
  }

  async snapshot(repo: string, sha: string, baseBranch: string, appIds = new Map<string, number | null>()): Promise<CiSnapshot> {
    repo = repoName(repo);
    sha = fullSha(sha);
    baseBranch = branchName(baseBranch);
    const root = `/repos/${repo}`;
    const required: CiRequiredContext[] = [];
    // Failure to read rules (including 404) is not evidence of an unprotected branch.
    const rules = await this.pages(`${root}/rules/branches/${encodeURIComponent(baseBranch)}`);
    for (const value of rules) {
      const rule = object(value);
      if (text(rule.type) !== "required_status_checks") continue;
      for (const value of array(object(rule.parameters).required_status_checks)) {
        const check = object(value);
        required.push({ context: text(check.context), appId: binding(check.integration_id) });
      }
    }
    try {
      const classic = object((await this.request(`${root}/branches/${encodeURIComponent(baseBranch)}/protection/required_status_checks`)).data);
      // checks carries app bindings; contexts repeats these names for compatibility, not extra unbound rules.
      const checks = classic.checks === undefined ? [] : array(classic.checks);
      const boundNames = new Set<string>();
      for (const value of checks) {
        const check = object(value);
        const context = text(check.context);
        boundNames.add(context);
        required.push({ context, appId: binding(check.app_id) });
      }
      for (const value of array(classic.contexts)) {
        const context = text(value);
        if (!boundNames.has(context)) required.push({ context, appId: null });
      }
    } catch (error) {
      if (!(error instanceof CiGithubError && error.code === "http" && error.status === 404)) throw error;
    }
    const runs = (await this.pages(`${root}/commits/${sha}/check-runs?filter=all`, "check_runs")).map((value): CiCheckRun => {
      const run = object(value);
      if (fullSha(text(run.head_sha)) !== sha) return invalid();
      return {
        id: id(run.id), name: text(run.name), appId: appId(run.app),
        suiteId: run.check_suite === undefined || run.check_suite === null ? null : id(object(run.check_suite).id),
        status: text(run.status), conclusion: nullableText(run.conclusion),
      };
    });
    const suites = (await this.pages(`${root}/commits/${sha}/check-suites`, "check_suites")).map((value): CiCheckSuite => {
      const suite = object(value);
      if (fullSha(text(suite.head_sha)) !== sha) return invalid();
      const status = text(suite.status);
      const count = suite.latest_check_runs_count;
      if (count !== undefined && count !== null && (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) return invalid();
      return {
        id: id(suite.id), appId: appId(suite.app), status, conclusion: nullableText(suite.conclusion),
        latestCheckRunsCount: count ?? null,
        createdAt: timestamp(suite.created_at),
        completedAt: status === "completed" ? timestamp(suite.completed_at ?? suite.updated_at) : null,
      };
    });
    // /status is a combined, truncated summary. /statuses is the paginated history we need.
    const statuses = (await this.pages(`${root}/commits/${sha}/statuses`)).map((value): CiCommitStatus => {
      const status = object(value);
      const result: CiCommitStatus = { id: id(status.id), context: text(status.context), state: text(status.state) };
      if (status.creator != null) result.creatorLogin = text(object(status.creator).login);
      return result;
    });
    for (const status of statuses) {
      if (!required.some((check) => check.appId !== null && check.context === status.context)) continue;
      const match = /^([a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*)\[bot\]$/.exec(status.creatorLogin ?? "");
      if (!match || match[1]!.length > 100) continue;
      const slug = match[1]!.toLowerCase();
      if (!appIds.has(slug)) {
        try {
          appIds.set(slug, id(object((await this.request(`/apps/${slug}`)).data).id));
        } catch (error) {
          if (!(error instanceof CiGithubError && error.code === "http" && !error.retryAt && (error.status === 403 || error.status === 404))) throw error;
          appIds.set(slug, null);
        }
      }
      status.verifiedAppId = appIds.get(slug) ?? null;
    }
    const unique = new Map(required.map((check) => [JSON.stringify([check.context, check.appId]), check]));
    const relevant = latest(runs, (run) => JSON.stringify([run.name, run.appId])).filter((run) =>
      [...unique.values()].some((check) => check.context === run.name && (check.appId === null || check.appId === run.appId)));
    const currentAttemptRunIds: number[] = [];
    for (const suite of suites) {
      const candidates = relevant.filter((run) => run.suiteId === suite.id && run.appId === suite.appId);
      if (suite.status !== "completed" && candidates.length) {
        try {
          currentAttemptRunIds.push(...await this.currentAttempt(repo, sha, suite, candidates));
        } catch (error) {
          // Unavailable optional corroboration supplies no generation proof.
          // Rule/check reads above remain mandatory; real throttles still back off.
          if (!(error instanceof CiGithubError && error.code === "http" && (error.status === 403 || error.status === 404))) throw error;
        }
      }
    }
    return { repo, sha, baseBranch, required: [...unique.values()], runs, suites, statuses, currentAttemptRunIds, fetchedAt: this.now() };
  }

  /**
   * Create one `paperclip/gates` commit status. This is the plugin's only
   * GitHub write: a fixed context, a fixed path shape and a two-field body.
   * No target URL is sent. Callers gate this behind the RM-decision parser,
   * the repo allowlist and the ledger dedupe/cap.
   */
  async createCommitStatus(repo: string, sha: string, state: GatesStatusState, description: string): Promise<CiCreatedStatus> {
    repo = repoName(repo);
    sha = fullSha(sha);
    if (!["success", "failure", "error", "pending"].includes(state)) throw new CiGithubError("input");
    if (typeof description !== "string" || !description.trim() || description.length > 140 || /[\x00-\x1f\x7f]/.test(description)) throw new CiGithubError("input");
    const body = JSON.stringify({ state, context: GATES_CONTEXT, description });
    const raw = object((await this.request(`/repos/${repo}/commits/${sha}/statuses`, undefined, undefined, body)).data);
    if (text(raw.context) !== GATES_CONTEXT || text(raw.state) !== state) return invalid();
    return { id: id(raw.id), context: GATES_CONTEXT, state };
  }

  private async currentAttempt(repo: string, sha: string, suite: CiCheckSuite, runs: CiCheckRun[]): Promise<number[]> {
    // A queued suite contradicts an old in-progress workflow, even if its jobs
    // still look terminal. Wait for a coherent observation on a later poll.
    if (suite.status !== "in_progress" || suite.conclusion !== null) return [];
    const root = `/repos/${repo}`;
    const workflow = (value: unknown) => {
      const raw = object(value);
      if (fullSha(text(raw.head_sha)) !== sha || id(raw.check_suite_id) !== suite.id
          || repoName(text(object(raw.repository).full_name)) !== repo) return invalid();
      return { id: id(raw.id), attempt: id(raw.run_attempt), status: text(raw.status), conclusion: nullableText(raw.conclusion) };
    };
    const discovered = (await this.pages(`${root}/actions/runs?head_sha=${sha}&check_suite_id=${suite.id}`, "workflow_runs", true)).map(workflow);
    // No association (or multiple associations) supplies no current-generation proof.
    if (discovered.length !== 1) return [];
    const found = discovered[0]!;
    const path = `${root}/actions/runs/${found.id}`;
    const before = workflow((await this.request(path)).data);
    if (before.id !== found.id || before.attempt !== found.attempt || before.status !== "in_progress" || before.conclusion !== null) return [];
    const jobs = await this.pages(`${path}/attempts/${before.attempt}/jobs`, "jobs", true);
    const jobIds = new Set<number>();
    const checkIds = new Set<number>();
    const corroborated: number[] = [];
    for (const value of jobs) {
      const job = object(value);
      const jobId = id(job.id);
      if (jobIds.has(jobId) || id(job.run_id) !== before.id || id(job.run_attempt) !== before.attempt
          || fullSha(text(job.head_sha)) !== sha) return invalid();
      jobIds.add(jobId);
      // Validate identity only. Never fetch a URL supplied by a response.
      const reference = text(job.check_run_url);
      const match = /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/check-runs\/([1-9][0-9]*)$/.exec(reference);
      if (!match || repoName(match[1]!) !== repo) return invalid();
      const checkId = id(Number(match[2]!));
      if (checkIds.has(checkId)) return invalid();
      checkIds.add(checkId);
      const name = text(job.name);
      const status = text(job.status);
      const result = nullableText(job.conclusion);
      const run = runs.find((run) => run.id === checkId && run.name === name);
      if (run && run.status === status && run.conclusion === result && conclusion(status, result) !== "pending") corroborated.push(run.id);
    }
    // Observe the suite again after jobs, then the workflow. This is a bounded
    // consistency check, not a transaction or an enumeration of uncreated targets.
    const later = object((await this.request(`${root}/check-suites/${suite.id}`)).data);
    if (id(later.id) !== suite.id || fullSha(text(later.head_sha)) !== sha || appId(later.app) !== suite.appId) return invalid();
    const after = workflow((await this.request(path)).data);
    if (text(later.status) !== suite.status || nullableText(later.conclusion) !== suite.conclusion
        || after.id !== before.id || after.attempt !== before.attempt
        || after.status !== before.status || after.conclusion !== before.conclusion) return [];
    return corroborated;
  }

  private async pages(path: string, field?: string, strict = false): Promise<unknown[]> {
    const values: unknown[] = [];
    let expectedTotal = 0;
    const complete = () => strict && values.length !== expectedTotal ? invalid() : values;
    for (let page = 1; page <= this.maxPages; page++) {
      const result = await this.request(`${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}`);
      const envelope = field ? object(result.data) : null;
      const batch = array(envelope ? envelope[field!] : result.data);
      if (batch.length > PAGE_SIZE) return invalid();
      if (envelope) {
        const total = envelope.total_count;
        if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0
            || (strict && page > 1 && total !== expectedTotal)) return invalid();
        expectedTotal = Math.max(expectedTotal, total);
      }
      values.push(...batch);
      // Never follow server-provided URLs (and never send a token to a Link host).
      const hasNext = /(?:^|,)\s*<[^>]+>\s*;\s*rel="next"/.test(result.link);
      if (!hasNext && batch.length < PAGE_SIZE && values.length >= expectedTotal) return complete();
      if (!hasNext && envelope && values.length >= expectedTotal) return complete();
      // Empty/short pages cannot justify returning a partial snapshot when total_count says more.
      if (batch.length === 0) return invalid();
    }
    throw new CiGithubError("pages");
  }

  private async parseErrorBody(response: CiHttpResponse | Response): Promise<{ permissionDenied: boolean; message: string | undefined }> {
    if (response.status !== 403) return { permissionDenied: false, message: undefined };
    try {
      const body = typeof response.body === "string" ? response.body : await this.deadline(() => (response as Response).text());
      if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > this.maxBodyBytes) return { permissionDenied: false, message: undefined };
      const message = object(this.parse(body)).message;
      // Only positive permission evidence exempts a 403 from conservative backoff.
      // Never retain, return or log the error body, including unknown throttle text:
      // the single `message` string is the only text that leaves this method, and
      // only the token_exchange diagnostic ever emits it (see exchangeDetail).
      return {
        permissionDenied: message === "Resource not accessible by integration" || message === "Resource not accessible by personal access token",
        message: typeof message === "string" ? message : undefined,
      };
    } catch { return { permissionDenied: false, message: undefined }; }
  }

  private rateLimit(status: number, headers: Record<string, string> | Headers, permissionDenied = false): void {
    const now = this.now();
    const retry = header(headers, "retry-after");
    const remaining = header(headers, "x-ratelimit-remaining");
    const reset = header(headers, "x-ratelimit-reset");
    let until = 0;
    if (retry !== undefined) {
      const seconds = Number(retry);
      const parsed = retry.trim() && Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : Date.parse(retry);
      if (Number.isFinite(parsed)) until = Math.max(until, parsed);
    }
    if ((remaining === "0" || status === 429) && reset !== undefined && reset.trim()) {
      const parsed = Number(reset) * 1000;
      if (Number.isFinite(parsed)) until = Math.max(until, parsed);
    }
    if ((status === 429 || (status === 403 && (!permissionDenied || retry !== undefined))) && until <= now) until = now + 60_000;
    if (remaining === "0" && until <= now) until = now + 60_000;
    this.cache.backoffUntil = Math.max(this.cache.backoffUntil, until);
    this.backoff.until = Math.max(this.backoff.until, until);
  }

  private async deadline<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new CiGithubError("timeout")), this.requestTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async attempt(url: string, headers: Record<string, string>, body?: string): Promise<CiHttpResponse | Response> {
    if (this.now() < Math.max(this.cache.backoffUntil, this.backoff.until)) throw new CiGithubError("backoff", undefined, Math.max(this.cache.backoffUntil, this.backoff.until));
    if (this.requests >= this.maxRequests) throw new CiGithubError("budget");
    this.beforeRequest?.();
    this.requests++;
    // Caller persistence is not a transport failure and must not trigger a conditional retry.
    if (this.onRequestAdmitted) await this.onRequestAdmitted();
    try { return await this.deadline(() => this.fetch(url, { method: body === undefined ? "GET" : "POST", headers, redirect: "error", ...(body === undefined ? {} : { body }) })); }
    catch (error) {
      if (error instanceof CiGithubError && error.code === "timeout") throw error;
      throw new CiGithubError("network");
    }
  }

  protected async request(path: string, graphqlBody?: string, exchange?: { jwt: string; body: string }, statusBody?: string): Promise<Page> {
    // POSTs are reserved for fixed-origin GraphQL, the installation-token exchange and
    // the single gates commit-status create; none of them reuses a URL-only ETag.
    if (!path.startsWith("/") || path.startsWith("//") || (graphqlBody !== undefined && path !== "/graphql") || (exchange !== undefined && !/^\/app\/installations\/[1-9][0-9]{0,15}\/access_tokens$/.test(path)) || (statusBody !== undefined && !/^\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/commits\/[a-f0-9]{40}\/statuses$/.test(path))) throw new CiGithubError("input");
    if ([graphqlBody, exchange, statusBody].filter((part) => part !== undefined).length > 1) throw new CiGithubError("input");
    // Backoff/budget apply before secret resolution as well as to every fetch.
    if (this.now() < Math.max(this.cache.backoffUntil, this.backoff.until)) throw new CiGithubError("backoff", undefined, Math.max(this.cache.backoffUntil, this.backoff.until));
    if (this.requests >= this.maxRequests) throw new CiGithubError("budget");
    const token = exchange ? exchange.jwt : typeof this.#credential === "string" ? this.#credential
      : await this.deadline(() => (this.#credential as CiTokenSource).token(path, async (installationId, jwt, body) => {
        if (!/^[1-9][0-9]{0,15}$/.test(installationId)) throw new CiGithubError("input");
        return (await this.request(`/app/installations/${installationId}/access_tokens`, undefined, { jwt, body: JSON.stringify(body) })).data;
      })).catch((error: unknown) => {
        // A path-shape refusal is a caller error, not a credential failure: keep the source.
        if (!(error instanceof CiGithubError && error.code === "input")) (this.#credential as CiTokenSource).invalidate();
        if (error instanceof CiGithubError) throw error;
        throw new CiGithubError("auth");
      });
    const url = `${ORIGIN}${path}`;
    const cached = graphqlBody === undefined && !exchange && statusBody === undefined ? this.cache.get(url) : undefined;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
      "User-Agent": GITHUB_USER_AGENT, "X-GitHub-Api-Version": "2022-11-28",
      ...(exchange || statusBody ? { "Content-Type": "application/json" } : {}),
    };
    if (cached) headers["If-None-Match"] = cached.etag;
    if (graphqlBody !== undefined) headers["Content-Type"] = "application/json";
    let response: CiHttpResponse | Response;
    let unconditionalRetry = false;
    try { response = await this.attempt(url, headers, exchange?.body ?? graphqlBody ?? statusBody); }
    catch (error) {
      if (!cached || !(error instanceof CiGithubError) || error.code !== "network") throw error;
      // Some stock SDKs construct Response("", {status:304}) and throw. Never assume
      // that is what happened: pay for exactly one unconditional read and require 200.
      // A timeout is not retried because the host cannot cancel the original request.
      unconditionalRetry = true;
      const freshHeaders = { ...headers };
      delete freshHeaders["If-None-Match"];
      response = await this.attempt(url, freshHeaders);
    }
    if (!response || !Number.isInteger(response.status) || !response.headers) return invalid();
    // Also fail closed if an SDK/host ignores RequestInit.redirect and follows a redirect.
    if ("redirected" in response && response.redirected) return invalid();
    if ("url" in response && response.url && response.url !== url) return invalid();
    const parsedError = await this.parseErrorBody(response);
    const denied = parsedError.permissionDenied;
    this.rateLimit(response.status, response.headers, denied);
    if (response.status === 304) {
      if (!cached || unconditionalRetry) return invalid();
      return { data: this.parse(cached.body, token), link: cached.link };
    }
    // GitHub create-status answers 201; plain reads answer 200. Either created
    // status number is accepted, then strictly projected before returning.
    if (!(exchange ? response.status === 201 : statusBody !== undefined ? response.status === 200 || response.status === 201 : response.status === 200)) {
      if (!exchange && response.status === 401 && typeof this.#credential !== "string") this.#credential.invalidate();
      const detail = response.status === 403 || response.status === 429
        ? refusalDetail(response.status, denied, path, response.headers, parsedError.message)
        : undefined;
      throw new CiGithubError("http", response.status, this.cache.backoffUntil > this.now() ? this.cache.backoffUntil : undefined, detail);
    }
    let body: string;
    try { body = typeof response.body === "string" ? response.body : await this.deadline(() => (response as Response).text()); }
    catch (error) {
      if (error instanceof CiGithubError && error.code === "timeout") throw error;
      throw new CiGithubError("response");
    }
    // Installation-wide token responses carry one entry per accessible repository (GitHub caps at 500);
    // single-repo and org-wide responses both stay far below this ceiling.
    if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > (exchange ? Math.min(this.maxBodyBytes, 256 * 1024) : statusBody ? Math.min(this.maxBodyBytes, 16_384) : this.maxBodyBytes)) return invalid();
    const data = this.parse(body, token, exchange !== undefined);
    // Installation-token and status-create responses must never enter the ETag cache.
    if (exchange || statusBody) return { data, link: "" };
    const link = header(response.headers, "link") ?? "";
    const etag = header(response.headers, "etag");
    if (link.includes(token) || etag?.includes(token) || SECRET_SHAPE.test(link) || etag && SECRET_SHAPE.test(etag)) return invalid();
    const safeBody = JSON.stringify(data);
    if (etag && graphqlBody === undefined) this.cache.remember(url, { body: safeBody, etag, link, bytes: Buffer.byteLength(safeBody + etag + link + url, "utf8") });
    else if (cached) this.cache.delete(url);
    return { data, link };
  }

  private parse(body: string, token?: string, exchange = false): unknown {
    try {
      if (token && body.includes(token)) return invalid();
      // A reviver also catches reflection hidden by JSON escapes, including property names.
      return JSON.parse(body, (key: string, value: unknown) => {
        if (token && (key.includes(token) || (typeof value === "string" && value.includes(token)))) return invalid();
        if (SECRET_SHAPE.test(key)) {
          if (exchange) return invalid();
          return undefined;
        }
        if (typeof value === "string" && !(exchange && key === "token") && SECRET_SHAPE.test(value)) {
          if (exchange) return invalid();
          // Custody consumes PR/issue prose as text: redact credential shapes
          // in place so inventory survives without retaining them in the cache.
          // A PEM block's base64 body is credential material even though only
          // its header matches SECRET_SHAPE, so redact the whole block.
          if (FREE_TEXT_KEYS.has(key)) return value
            .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/g, "[REDACTED]")
            .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*$/g, "[REDACTED]")
            .replace(SECRET_SHAPE_GLOBAL, "[REDACTED]");
          // Drop token-like unused prose before caching. A consumed field removed
          // here still fails its strict projection; unused PR/CI prose does not.
          return undefined;
        }
        return value;
      }) as unknown;
    } catch { throw new CiGithubError("response"); }
  }
}

type Verdict = "pass" | "pending" | "fail";
const PASS = new Set(["success", "neutral", "skipped"]);
const FAIL = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);
function conclusion(status: string, result: string | null): Verdict {
  if (status !== "completed") return "pending";
  return result !== null && PASS.has(result) ? "pass" : result !== null && FAIL.has(result) ? "fail" : "pending";
}
function latest<T extends { id: number }>(values: readonly T[], key: (value: T) => string): T[] {
  const found = new Map<string, T>();
  for (const value of values) {
    const name = key(value);
    const previous = found.get(name);
    if (!previous || value.id > previous.id) found.set(name, value);
  }
  return [...found.values()];
}
function label(check: CiRequiredContext): string {
  return check.appId === null ? check.context : `${check.context} [app ${check.appId}]`;
}

/** Suites that can still contribute checks or represent observed work. */
export function relevantSuites(snapshot: CiSnapshot): CiSnapshot["suites"] {
  return snapshot.suites.filter((suite) => suite.latestCheckRunsCount !== 0
    || !["queued", "in_progress"].includes(suite.status)
    || snapshot.runs.some((run) => run.suiteId === suite.id && run.appId === suite.appId));
}

/** Pure, conservative readiness: no network, wall clock, branch fallback, or PR body policy. */
export function evaluateReadiness(snapshot: CiSnapshot, timing: CiReadinessTiming): CiReadiness {
  if (![timing.now, timing.registeredAt, timing.medianMs].every(Number.isFinite) || timing.medianMs <= 0) {
    throw new CiGithubError("input");
  }
  const runs = latest(snapshot.runs, (run) => JSON.stringify([run.name, run.appId]));
  const statuses = latest(snapshot.statuses, (status) => status.context);
  // Multiple workflows share the GitHub Actions app ID; app ID is not suite identity.
  // Installed Apps can leave empty queued suites forever. Unknown states and suites
  // referenced by observed runs retain generation safety, even if a later count is zero.
  const suites = relevantSuites(snapshot);
  const completions = suites.flatMap((suite) => suite.status === "completed" && suite.completedAt !== null ? [suite.completedAt] : []);
  const lastSuiteCompletedAt = completions.length ? Math.max(...completions) : null;
  // A partial set of completions cannot start grace while another suite may still register checks.
  const missingSince = suites.length === 0 ? timing.registeredAt
    : completions.length === suites.length ? lastSuiteCompletedAt : null;
  const missingFailAt = missingSince === null ? null : missingSince + 2 * timing.medianMs;
  const failed: string[] = [];
  const missing: string[] = [];
  const pending: string[] = [];
  function record(name: string, verdict: Verdict): void {
    if (verdict === "fail") failed.push(name);
    if (verdict === "pending") pending.push(name);
  }
  function statusVerdict(state: string): Verdict {
    return state === "success" ? "pass" : state === "failure" || state === "error" ? "fail" : "pending";
  }
  if (snapshot.required.length) {
    for (const required of snapshot.required) {
      const matchingRuns = runs.filter((run) => run.name === required.context && (required.appId === null || run.appId === required.appId));
      // A creator's user ID is not an app ID; only a verified app lookup counts.
      const matchingStatuses = required.appId === null ? statuses.filter((status) => status.context === required.context)
        : latest(snapshot.statuses.filter((status) => status.context === required.context && status.verifiedAppId === required.appId), (status) => status.context);
      // A failed lookup is not proof of a different app, even when a matching
      // run exists. Ignore superseded statuses from the same creator only.
      const unverified = required.appId !== null && latest(
        snapshot.statuses.filter((status) => status.context === required.context),
        (status) => (status.creatorLogin ?? "").toLowerCase(),
      ).some((status) => status.verifiedAppId === null);
      if (unverified) pending.push(label(required));
      if (!matchingRuns.length && !matchingStatuses.length && !unverified) missing.push(label(required));
      for (const run of matchingRuns) {
        // An active suite can hide a required rerun not yet materialized. Only
        // positive current-attempt job evidence permits same-suite optional work.
        const associated = suites.find((suite) => suite.id === run.suiteId && suite.appId === run.appId);
        const ambiguous = associated ? associated.status !== "completed" : suites.some((suite) => suite.status !== "completed");
        const corroborated = associated && snapshot.currentAttemptRunIds?.includes(run.id);
        record(label(required), ambiguous && !corroborated ? "pending" : conclusion(run.status, run.conclusion));
      }
      // Statuses do not identify their workflow/generation; defer while suites run.
      for (const status of matchingStatuses) record(label(required), suites.some((suite) => suite.status !== "completed") ? "pending" : statusVerdict(status.state));
    }
  } else {
    for (const run of runs) record(label({ context: run.name, appId: run.appId }), conclusion(run.status, run.conclusion));
    for (const status of statuses) record(status.context, statusVerdict(status.state));
    for (const suite of suites) record(`suite [app ${suite.appId ?? "unknown"}]`, conclusion(suite.status, suite.conclusion));
    if (!runs.length && !statuses.length && !suites.length) pending.push("checks not registered");
  }
  const missingExpired = !timing.draft && missing.length > 0 && pending.length === 0 && missingFailAt !== null && timing.now >= missingFailAt;
  return {
    kind: pending.length || (missing.length && !missingExpired && !(timing.draft && failed.length)) ? "pending" : failed.length || missingExpired ? "fail" : "pass",
    failed: [...new Set(failed)], missing: [...new Set(missing)], pending: [...new Set(pending)],
    lastSuiteCompletedAt, missingSince, missingFailAt,
  };
}
