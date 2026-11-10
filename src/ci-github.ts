import type { PluginContext } from "@paperclipai/plugin-sdk";

/** The stock host RPC response is serialized; some SDK releases wrap it in Response. */
export interface CiHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export type CiFetch = (url: string, init?: RequestInit) => Promise<CiHttpResponse | Response>;
export interface CiGithubOptions {
  /** Counts every attempted fetch, including 304s and failed requests, for this instance. */
  maxRequests?: number;
  maxPages?: number;
  maxCacheEntries?: number;
  maxCacheBytes?: number;
  maxBodyBytes?: number;
  /** Per fetch/body-read deadline; default 15 seconds, at most 30 seconds. */
  requestTimeoutMs?: number;
  now?: () => number;
  /** Token-free state, scoped by the caller to one company/credential identity. */
  cache?: CiGithubCache;
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
}
export interface CiSnapshot {
  repo: string;
  sha: string;
  baseBranch: string;
  required: CiRequiredContext[];
  runs: CiCheckRun[];
  suites: CiCheckSuite[];
  statuses: CiCommitStatus[];
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
export interface CiReadinessTiming {
  now: number;
  registeredAt: number;
  medianMs: number;
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
export type CiGithubErrorCode = "input" | "http" | "network" | "response" | "budget" | "pages" | "backoff" | "timeout";
/** Deliberately contains neither response bodies, request headers, tokens, nor upstream errors. */
export class CiGithubError extends Error {
  constructor(
    public readonly code: CiGithubErrorCode,
    public readonly status?: number,
    public readonly retryAt?: number,
  ) {
    super(`GitHub CI ${code}${status === undefined ? "" : ` (${status})`}`);
    this.name = "CiGithubError";
  }
}

const ORIGIN = "https://api.github.com";
const PAGE_SIZE = 100;
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
  private readonly maxPages: number;
  private readonly maxBodyBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private requests = 0;
  private readonly cache: CiGithubCache;

  constructor(
    private readonly fetch: PluginContext["http"]["fetch"] | CiFetch,
    private readonly token: string,
    options: CiGithubOptions = {},
  ) {
    if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token)) throw new CiGithubError("input");
    this.maxRequests = bounded(options.maxRequests, 100, 10_000);
    this.maxPages = bounded(options.maxPages, 20, 100);
    this.maxBodyBytes = bounded(options.maxBodyBytes, 2 * 1024 * 1024, 8 * 1024 * 1024);
    this.requestTimeoutMs = bounded(options.requestTimeoutMs, 15_000, 30_000);
    this.cache = options.cache ?? new CiGithubCache(options);
    this.now = options.now ?? Date.now;
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

  async snapshot(repo: string, sha: string, baseBranch: string): Promise<CiSnapshot> {
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
      return {
        id: id(suite.id), appId: appId(suite.app), status, conclusion: nullableText(suite.conclusion),
        createdAt: timestamp(suite.created_at),
        completedAt: status === "completed" ? timestamp(suite.completed_at ?? suite.updated_at) : null,
      };
    });
    // /status is a combined, truncated summary. /statuses is the paginated history we need.
    const statuses = (await this.pages(`${root}/commits/${sha}/statuses`)).map((value): CiCommitStatus => {
      const status = object(value);
      return { id: id(status.id), context: text(status.context), state: text(status.state) };
    });
    const unique = new Map(required.map((check) => [JSON.stringify([check.context, check.appId]), check]));
    return { repo, sha, baseBranch, required: [...unique.values()], runs, suites, statuses, fetchedAt: this.now() };
  }

  private async pages(path: string, field?: string): Promise<unknown[]> {
    const values: unknown[] = [];
    let expectedTotal = 0;
    for (let page = 1; page <= this.maxPages; page++) {
      const result = await this.request(`${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}`);
      const envelope = field ? object(result.data) : null;
      const batch = array(envelope ? envelope[field!] : result.data);
      if (batch.length > PAGE_SIZE) return invalid();
      if (envelope) {
        const total = envelope.total_count;
        if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) return invalid();
        expectedTotal = Math.max(expectedTotal, total);
      }
      values.push(...batch);
      // Never follow server-provided URLs (and never send a token to a Link host).
      const hasNext = /(?:^|,)\s*<[^>]+>\s*;\s*rel="next"/.test(result.link);
      if (!hasNext && batch.length < PAGE_SIZE && values.length >= expectedTotal) return values;
      if (!hasNext && envelope && values.length >= expectedTotal) return values;
      // Empty/short pages cannot justify returning a partial snapshot when total_count says more.
      if (batch.length === 0) return invalid();
    }
    throw new CiGithubError("pages");
  }

  private rateLimit(status: number, headers: Record<string, string> | Headers): void {
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
    if ((remaining === "0" || status === 429 || status === 403) && reset !== undefined && reset.trim()) {
      const parsed = Number(reset) * 1000;
      if (Number.isFinite(parsed)) until = Math.max(until, parsed);
    }
    if ((status === 429 || status === 403) && until <= now) until = now + 60_000;
    if (remaining === "0" && until <= now) until = now + 60_000;
    this.cache.backoffUntil = Math.max(this.cache.backoffUntil, until);
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

  private async attempt(url: string, headers: Record<string, string>): Promise<CiHttpResponse | Response> {
    if (this.now() < this.cache.backoffUntil) throw new CiGithubError("backoff", undefined, this.cache.backoffUntil);
    if (this.requests >= this.maxRequests) throw new CiGithubError("budget");
    this.requests++;
    try { return await this.deadline(() => this.fetch(url, { method: "GET", headers, redirect: "error" })); }
    catch (error) {
      if (error instanceof CiGithubError && error.code === "timeout") throw error;
      throw new CiGithubError("network");
    }
  }

  private async request(path: string): Promise<Page> {
    const url = `${ORIGIN}${path}`;
    const cached = this.cache.get(url);
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (cached) headers["If-None-Match"] = cached.etag;
    let response: CiHttpResponse | Response;
    let unconditionalRetry = false;
    try { response = await this.attempt(url, headers); }
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
    this.rateLimit(response.status, response.headers);
    if (response.status === 304) {
      if (!cached || unconditionalRetry) return invalid();
      return { data: this.parse(cached.body), link: cached.link };
    }
    if (response.status !== 200) {
      throw new CiGithubError("http", response.status, this.cache.backoffUntil > this.now() ? this.cache.backoffUntil : undefined);
    }
    let body: string;
    try { body = typeof response.body === "string" ? response.body : await this.deadline(() => (response as Response).text()); }
    catch (error) {
      if (error instanceof CiGithubError && error.code === "timeout") throw error;
      throw new CiGithubError("response");
    }
    if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > this.maxBodyBytes) return invalid();
    const data = this.parse(body);
    const link = header(response.headers, "link") ?? "";
    const etag = header(response.headers, "etag");
    if (link.includes(this.token) || etag?.includes(this.token)) return invalid();
    if (etag) this.cache.remember(url, { body, etag, link, bytes: Buffer.byteLength(body + etag + link + url, "utf8") });
    else if (cached) this.cache.delete(url);
    return { data, link };
  }

  private parse(body: string): unknown {
    try {
      if (body.includes(this.token)) return invalid();
      // A reviver also catches reflection hidden by JSON escapes, including property names.
      return JSON.parse(body, (key: string, value: unknown) => {
        if (key.includes(this.token) || (typeof value === "string" && value.includes(this.token))) return invalid();
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

/** Pure, conservative readiness: no network, wall clock, branch fallback, or PR body policy. */
export function evaluateReadiness(snapshot: CiSnapshot, timing: CiReadinessTiming): CiReadiness {
  if (![timing.now, timing.registeredAt, timing.medianMs].every(Number.isFinite) || timing.medianMs <= 0) {
    throw new CiGithubError("input");
  }
  const runs = latest(snapshot.runs, (run) => JSON.stringify([run.name, run.appId]));
  const statuses = latest(snapshot.statuses, (status) => status.context);
  // Multiple workflows share the GitHub Actions app ID; app ID is not suite identity.
  // Without branch requirements every observed suite must finish, including older IDs.
  const suites = snapshot.suites;
  const completions = snapshot.suites.flatMap((suite) => suite.status === "completed" && suite.completedAt !== null ? [suite.completedAt] : []);
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
      // Legacy statuses have no authenticated app ID: never infer one from creator.id.
      const matchingStatuses = required.appId === null ? statuses.filter((status) => status.context === required.context) : [];
      if (!matchingRuns.length && !matchingStatuses.length) missing.push(label(required));
      for (const run of matchingRuns) {
        // Runs are read before suites: an active rerun can make the old result stale.
        // Gate only this latest run's suite, never other workflows sharing its app.
        const rerunning = suites.some((suite) => suite.id === run.suiteId && suite.status !== "completed");
        record(label(required), rerunning ? "pending" : conclusion(run.status, run.conclusion));
      }
      for (const status of matchingStatuses) record(label(required), statusVerdict(status.state));
    }
  } else {
    for (const run of runs) record(label({ context: run.name, appId: run.appId }), conclusion(run.status, run.conclusion));
    for (const status of statuses) record(status.context, statusVerdict(status.state));
    for (const suite of suites) record(`suite [app ${suite.appId ?? "unknown"}]`, conclusion(suite.status, suite.conclusion));
    if (!runs.length && !statuses.length && !suites.length) pending.push("checks not registered");
  }
  const missingExpired = missing.length > 0 && pending.length === 0 && missingFailAt !== null && timing.now >= missingFailAt;
  return {
    kind: pending.length || (missing.length && !missingExpired) ? "pending" : failed.length || missingExpired ? "fail" : "pass",
    failed: [...new Set(failed)], missing: [...new Set(missing)], pending: [...new Set(pending)],
    lastSuiteCompletedAt, missingSince, missingFailAt,
  };
}
