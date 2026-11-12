import { CiGithub, CiGithubError } from "./ci-github.js";

export interface CustodyPull {
  repo: string;
  number: number;
  headSha: string;
  headBranch: string;
  headRepo: string | null;
  author: string;
  authorIsBot: boolean;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  /** All timestamps are epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  mergedAt: number | null;
}

type ObjectValue = Record<string, unknown>;
function invalid(): never { throw new CiGithubError("response"); }
/** Tolerated disagreement between GitHub's updated sort and returned updated_at. */
export const ORDER_SKEW_MS = 5 * 60_000;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as ObjectValue;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) return invalid();
  return value;
}
function id(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return invalid();
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return invalid();
  return value;
}
function title(value: unknown): string {
  // Display text may contain format characters (for example emoji joiners), unlike identifiers.
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) return invalid();
  return value;
}
function body(value: unknown): string {
  if (value === null) return "";
  if (typeof value !== "string") return invalid();
  return value;
}
function repository(value: unknown, input = false): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/.test(value)
      || [".", ".."].includes(value.split("/")[1]!)) {
    if (input) throw new CiGithubError("input");
    return invalid();
  }
  return value.toLowerCase();
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{40}$/.test(value)) return invalid();
  return value.toLowerCase();
}
function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return invalid();
  const parsed = Date.parse(value);
  // Date.parse alone normalizes invalid calendar dates, such as February 30.
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0")}Z`)) return invalid();
  return parsed;
}
function nullableTimestamp(value: unknown): number | null { return value === null ? null : timestamp(value); }
function pull(value: unknown, repo: string, state?: "open" | "closed"): CustodyPull {
  const raw = object(value);
  const user = object(raw.user);
  const author = text(user.login);
  const head = object(raw.head);
  const headBranch = text(head.ref);
  if (/[\x00-\x20\x7f]/.test(headBranch) || headBranch === "." || headBranch === "..") return invalid();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}(?:\[bot\])?$/.test(author)
      || (user.type !== "User" && user.type !== "Bot")) return invalid();
  const createdAt = timestamp(raw.created_at);
  const updatedAt = timestamp(raw.updated_at);
  const closedAt = nullableTimestamp(raw.closed_at);
  const mergedAt = nullableTimestamp(raw.merged_at);
  if (repository(object(object(raw.base).repo).full_name) !== repo
      || (raw.state !== "open" && raw.state !== "closed") || (state !== undefined && raw.state !== state)
      || (raw.merged !== undefined && (typeof raw.merged !== "boolean" || raw.merged !== (mergedAt !== null)))
      || (raw.state === "open" && (closedAt !== null || mergedAt !== null))
      || (raw.state === "closed" && closedAt === null)
      || updatedAt < createdAt
      || (closedAt !== null && (closedAt < createdAt || closedAt > updatedAt))
      || (mergedAt !== null && (mergedAt < createdAt || closedAt === null || mergedAt > closedAt))) return invalid();
  return {
    repo, number: id(raw.number), headSha: sha(head.sha), headBranch,
    headRepo: head.repo === null ? null : repository(object(head.repo).full_name), author,
    authorIsBot: user.type === "Bot" || author.toLowerCase().endsWith("[bot]"),
    title: title(raw.title), body: body(raw.body), state: raw.state, merged: mergedAt !== null,
    createdAt, updatedAt, closedAt, mergedAt,
  };
}
function identity(pr: CustodyPull): { repo: string; number: number; headSha: string } {
  const repo = repository(pr.repo, true);
  if (!Number.isSafeInteger(pr.number) || pr.number <= 0 || typeof pr.headSha !== "string" || !/^[a-fA-F0-9]{40}$/.test(pr.headSha)
      || !Number.isSafeInteger(pr.createdAt) || pr.createdAt < 0) throw new CiGithubError("input");
  return { repo, number: pr.number, headSha: pr.headSha.toLowerCase() };
}

/**
 * REST enumeration and exact GraphQL activity. Inherits CI credential handling, bounded
 * ETags/bodies, request budget, rate-limit backoff, fixed origin and deadlines.
 * Any incomplete or incoherent observation throws: callers must treat it as UNKNOWN.
 */
export class CustodyGithub extends CiGithub {
  /** Fully enumerate an organization's repositories, including private repos visible to the credential. */
  async repositories(org: string): Promise<string[]> {
    if (typeof org !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(org)) throw new CiGithubError("input");
    org = org.toLowerCase();
    const names = new Set<string>();
    const values = await this.collect(`/orgs/${org}/repos?type=all&sort=full_name&direction=asc`, (value) => {
      const raw = object(value);
      const name = repository(raw.full_name);
      if (name.split("/")[0] !== org || typeof raw.archived !== "boolean" || names.has(name)) return invalid();
      names.add(name);
      return { key: id(raw.id), value: { name, archived: raw.archived } };
    });
    return values.filter((value) => !value.archived).map((value) => value.name);
  }

  /**
   * Closed enumeration requires a caller-supplied stored cursor or bounded bootstrap
   * timestamp. The updated-at boundary is inclusive, so equal-time rows are replayed.
   */
  async pulls(repo: string, state: "open" | "closed", since?: number): Promise<CustodyPull[]> {
    repo = repository(repo, true);
    if ((state !== "open" && state !== "closed") || (since !== undefined && (!Number.isSafeInteger(since) || since < 0))
        || (state === "closed" && since === undefined)) throw new CiGithubError("input");
    let previous = Infinity;
    const result = await this.collect(`/repos/${repo}/pulls?state=${state}&sort=updated&direction=desc`, (value) => {
      const parsed = pull(value, repo, state);
      // GitHub's updated sort can disagree with the returned updated_at by a
      // second or so. Small inversions are tolerated; a large one is refused.
      if (parsed.updatedAt > previous + ORDER_SKEW_MS) return invalid();
      previous = Math.min(previous, parsed.updatedAt);
      return { key: parsed.number, value: parsed };
    }, state === "closed" ? (batch) => batch.some((value) => value.updatedAt < since! - ORDER_SKEW_MS) : undefined);
    return state === "closed" ? result.filter((value) => value.updatedAt >= since!) : result;
  }

  /**
   * Seed a newly observed head from the latest head-bound evidence instead of
   * wall-clock arrival: head check-suite updated_at (scoped to the head
   * commit) and submitted reviews on the head commit itself. PR created_at
   * is only a floor. PR-wide evidence such as reviews of earlier commits or
   * the card disposition line cannot prove this SHA was present at their
   * time, so they never date a head; disposition still feeds the trigger
   * epoch in custodyTriggers. With no head-bound evidence this returns null
   * so the caller keeps the head UNKNOWN for idle purposes (no wake) and
   * retries the seed each tick, rather than fabricating an epoch from
   * arrival time. Seeded epochs never claim push time; they only keep
   * already-idle PRs from waiting out a fresh seven-day warmup.
   */
  async seedHead(pr: CustodyPull): Promise<number | null> {
    const { headSha } = identity(pr);
    if (pr.state !== "open") throw new CiGithubError("input");
    const commits = await this.connection(pr, "commits", (value) => {
      const oid = sha(object(object(value).commit).oid);
      return { key: oid, value: oid };
    });
    if (!commits.length || commits.at(-1) !== headSha) return invalid();
    const reviews = await this.connection(pr, "reviews", (value) => {
      const review = object(value);
      if (!["PENDING", "APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"].includes(text(review.state))) return invalid();
      const at = review.state === "PENDING" ? nullableTimestamp(review.submittedAt) : timestamp(review.submittedAt);
      if (review.state === "PENDING" && at !== null) return invalid();
      // PENDING reviews carry commit: null; that is not seed evidence, not
      // a malformed response. A null oid never matches headSha below.
      const oid = review.commit === null || review.commit === undefined ? null : sha(object(review.commit).oid);
      return { key: text(review.id), value: { at, oid } };
    });
    const suites = await this.connection(pr, "checkSuites", (value) => {
      const suite = object(value);
      if (!["QUEUED", "IN_PROGRESS", "COMPLETED", "REQUESTED", "WAITING", "PENDING"].includes(text(suite.status))) return invalid();
      const createdAt = timestamp(suite.createdAt);
      const updatedAt = timestamp(suite.updatedAt);
      if (updatedAt < createdAt) return invalid();
      return { key: text(suite.id), value: updatedAt };
    }, commits.length);
    // Only reviews on this exact commit establish it was present then.
    const evidence = [...reviews.filter((value) => value.at !== null && value.oid === headSha).map((value) => value.at!), ...suites];
    if (!evidence.length) return null;
    return Math.max(pr.createdAt, ...evidence);
  }

  /**
   * Commit/push, submitted review, and head suite activity (even running).
   * REST commit dates alone do not establish push time; PR updated_at also
   * changes for metadata, which could postpone custody forever.
   * GitHub retired pushedDate. Activity is UNKNOWN unless the caller supplies a
   * persisted first-observed timestamp for this exact head SHA (seeded by
   * seedHead). That upper bound starts a conservative idle warmup on
   * discovery/head changes, never metadata.
   */
  async activity(pr: CustodyPull, observedHeadAt?: number): Promise<number> {
    const { headSha } = identity(pr);
    if (pr.state !== "open" || (observedHeadAt !== undefined
        && (!Number.isFinite(observedHeadAt) || observedHeadAt < 0 || observedHeadAt > 8_640_000_000_000_000))) throw new CiGithubError("input");
    if (observedHeadAt === undefined) return invalid();
    const commits = await this.connection(pr, "commits", (value) => {
      const commit = object(object(value).commit);
      const pushedAt = observedHeadAt;
      const committedAt = timestamp(commit.committedDate);
      const oid = sha(commit.oid);
      return { key: oid, value: { oid, at: Math.max(pushedAt, committedAt) } };
    });
    if (!commits.length || commits.at(-1)?.oid !== headSha) return invalid();
    const reviews = await this.connection(pr, "reviews", (value) => {
      const review = object(value);
      if (!["PENDING", "APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"].includes(text(review.state))) return invalid();
      const at = review.state === "PENDING" ? nullableTimestamp(review.submittedAt) : timestamp(review.submittedAt);
      if (review.state === "PENDING" && at !== null) return invalid();
      return { key: text(review.id), value: at };
    });
    const suites = await this.connection(pr, "checkSuites", (value) => {
      const suite = object(value);
      if (!["QUEUED", "IN_PROGRESS", "COMPLETED", "REQUESTED", "WAITING", "PENDING"].includes(text(suite.status))) return invalid();
      const createdAt = timestamp(suite.createdAt);
      const updatedAt = timestamp(suite.updatedAt);
      if (updatedAt < createdAt) return invalid();
      return { key: text(suite.id), value: updatedAt };
    }, commits.length);
    return Math.max(pr.createdAt, observedHeadAt ?? pr.createdAt, ...commits.map((value) => value.at),
      ...reviews.filter((value): value is number => value !== null), ...suites);
  }

  private async connection<T>(
    pr: CustodyPull,
    kind: "commits" | "reviews" | "checkSuites",
    parse: (value: unknown) => { key: string; value: T },
    commitCount?: number,
  ): Promise<T[]> {
    const { repo, number, headSha } = identity(pr);
    const [owner, name] = repo.split("/");
    const selection = kind === "commits" ? "commits(first:100,after:$cursor){totalCount pageInfo{hasNextPage endCursor} nodes{commit{oid committedDate}}}"
      : kind === "reviews" ? "reviews(first:100,after:$cursor){totalCount pageInfo{hasNextPage endCursor} nodes{id state submittedAt commit{oid}}}"
        : "commits(last:1){totalCount nodes{commit{oid checkSuites(first:100,after:$cursor){totalCount pageInfo{hasNextPage endCursor} nodes{id status createdAt updatedAt}}}}}";
    const query = `query CustodyActivity($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){number state headRefOid createdAt repository{nameWithOwner} ${selection}}}}`;
    const values: T[] = [];
    const keys = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let expected: number | undefined;
    for (let page = 1; page <= this.maxPages; page++) {
      const raw = object((await this.request("/graphql", JSON.stringify({ query, variables: { owner, name, number, cursor } }))).data);
      if (raw.errors !== undefined && array(raw.errors).length > 0) return invalid();
      const resultRepo = object(object(raw.data).repository);
      const resultPull = object(resultRepo.pullRequest);
      if (repository(resultRepo.nameWithOwner) !== repo || repository(object(resultPull.repository).nameWithOwner) !== repo
          || resultPull.number !== number || resultPull.state !== "OPEN" || sha(resultPull.headRefOid) !== headSha
          || timestamp(resultPull.createdAt) !== pr.createdAt) return invalid();
      let connection: ObjectValue;
      if (kind === "checkSuites") {
        const head = object(resultPull.commits);
        const nodes = array(head.nodes);
        if (id(head.totalCount) !== commitCount || nodes.length !== 1) return invalid();
        const commit = object(object(nodes[0]).commit);
        if (sha(commit.oid) !== headSha) return invalid();
        connection = object(commit.checkSuites);
      } else connection = object(resultPull[kind]);
      const total = connection.totalCount;
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 || (expected !== undefined && total !== expected)) return invalid();
      expected = total;
      const nodes = array(connection.nodes);
      const info = object(connection.pageInfo);
      if (nodes.length > 100 || typeof info.hasNextPage !== "boolean") return invalid();
      if (info.endCursor !== null) text(info.endCursor);
      for (const node of nodes) {
        const parsed = parse(node);
        if (keys.has(parsed.key)) return invalid();
        keys.add(parsed.key);
        values.push(parsed.value);
      }
      if (values.length > total) return invalid();
      if (!info.hasNextPage) {
        if (values.length !== total) return invalid();
        return values;
      }
      const next = text(info.endCursor);
      if (nodes.length !== 100 || values.length >= total || cursors.has(next)) return invalid();
      cursors.add(next);
      cursor = next;
    }
    throw new CiGithubError("pages");
  }

  /** PR body and all issue comment bodies; no untrusted response URL is fetched. */
  async closureTexts(pr: CustodyPull): Promise<string[]> {
    const { repo, number } = identity(pr);
    const comments = await this.collect(`/repos/${repo}/issues/${number}/comments`, (value) => {
      const comment = object(value);
      const createdAt = timestamp(comment.created_at);
      if (timestamp(comment.updated_at) < createdAt) return invalid();
      return { key: id(comment.id), value: body(comment.body) };
    });
    if (typeof pr.body !== "string") throw new CiGithubError("input");
    return [pr.body, ...comments];
  }

  /** Endpoint-specific pagination: plain REST arrays have no total_count. */
  private async collect<T>(
    path: string,
    parse: (value: unknown) => { key: string | number; value: T },
    stop?: (batch: T[]) => boolean,
  ): Promise<T[]> {
    const values: T[] = [];
    const seen = new Set<string | number>();
    for (let page = 1; page <= this.maxPages; page++) {
      const response = await this.request(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      const batch = array(response.data);
      if (batch.length > 100) return invalid();
      const parsed = batch.map((value) => {
        const item = parse(value);
        if (seen.has(item.key)) return invalid();
        seen.add(item.key);
        return item.value;
      });
      values.push(...parsed);
      // Links are hints only. Reconstruct the next numbered page on the fixed origin.
      const next = /(?:^|,)\s*<[^>]+>\s*;\s*rel="next"/.test(response.link);
      if (next && batch.length < 100) return invalid();
      if (stop?.(parsed)) return values;
      if (!next && batch.length < 100) return values;
    }
    throw new CiGithubError("pages");
  }
}
