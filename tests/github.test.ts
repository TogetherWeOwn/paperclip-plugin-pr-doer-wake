import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { evaluate, fingerprint, indexFromGraph, isTrustedAuthor, mayAct, parseEvent, reviewScore, verifySignature } from "../src/github.js";

const repository = { full_name: "TogetherWeOwn/two-web-next", default_branch: "main", owner: { login: "TogetherWeOwn" } };
const config = parseConfig({ enabled: true, githubOrg: "TogetherWeOwn", webhookSecretRef: { type: "secret_ref", secretId: "x" } });
const HEAD = "c05b0b5df0000000000000000000000000000000";

function checkRun(name: string, conclusion: string, opts: { headSha?: string; prHead?: string; action?: string; title?: string } = {}) {
  return {
    action: opts.action ?? "completed",
    repository,
    check_run: {
      name,
      conclusion,
      head_sha: opts.headSha ?? HEAD,
      html_url: "https://github.com/TogetherWeOwn/two-web-next/runs/1",
      output: { title: opts.title ?? null },
      pull_requests: [{ number: 1903, head: { sha: opts.prHead ?? HEAD, ref: "TOG-43084-quality" }, base: { ref: "main" } }],
    },
  };
}

describe("verifySignature", () => {
  it("accepts GitHub's sha256 HMAC over the raw bytes and rejects anything else", () => {
    const body = '{"zen":"ok"}';
    const sig = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
    expect(verifySignature("s3cret", body, sig)).toBe(true);
    expect(verifySignature("other", body, sig)).toBe(false);
    expect(verifySignature("s3cret", body + " ", sig)).toBe(false);
    expect(verifySignature("s3cret", body, undefined)).toBe(false);
    expect(verifySignature("", body, sig)).toBe(false);
  });
});

describe("Paperclip Review check", () => {
  it("wakes on conclusion failure (complete assessment below threshold) with the score", () => {
    const parsed = parseEvent("check_run", checkRun("Paperclip Review", "failure", { title: "3/5" }), config);
    expect(parsed.signals).toHaveLength(1);
    expect(parsed.signals[0]).toMatchObject({ repo: "togetherweown/two-web-next", number: 1903, head: HEAD, state: "review_findings", detail: { score: 3 } });
  });
  it("never wakes on action_required (admission refusal / incomplete), success or neutral", () => {
    for (const conclusion of ["action_required", "success", "neutral", "cancelled"]) {
      expect(parseEvent("check_run", checkRun("Paperclip Review", conclusion, { title: "Authorized manual review required" }), config).signals).toEqual([]);
    }
  });
  it("parses only N/5 titles", () => {
    expect(reviewScore("4/5")).toBe(4);
    expect(reviewScore("Incomplete review")).toBeNull();
  });
});

describe("CI checks", () => {
  it("wakes on a real failure, timeout or startup failure", () => {
    for (const conclusion of ["failure", "timed_out", "startup_failure"]) {
      const parsed = parseEvent("check_run", checkRun("build", conclusion), config);
      expect(parsed.signals.map((s) => s.state)).toEqual(["ci_red"]);
      expect(parsed.signals[0]!.draft).toBeNull(); // draft is resolved later from the index
    }
  });
  it("ignores cancelled, stale, skipped, neutral and in-progress runs", () => {
    for (const conclusion of ["cancelled", "stale", "skipped", "neutral", "success", "action_required"]) {
      expect(parseEvent("check_run", checkRun("pr-lint", conclusion), config).signals).toEqual([]);
    }
    expect(parseEvent("check_run", checkRun("build", "failure", { action: "created" }), config).signals).toEqual([]);
  });
  it("ignores checks on a superseded head", () => {
    expect(parseEvent("check_run", checkRun("build", "failure", { prHead: "f".repeat(40) }), config).signals).toEqual([]);
  });
  it("honours requiredChecks and ignoreChecks", () => {
    const strict = parseConfig({ ...config, requiredChecks: { "TogetherWeOwn/two-web-next": ["build"] }, ignoreChecks: ["nightly"] });
    expect(parseEvent("check_run", checkRun("lighthouse", "failure"), strict).signals).toEqual([]);
    expect(parseEvent("check_run", checkRun("build", "failure"), strict).signals).toHaveLength(1);
    const ignoring = parseConfig({ ...config, ignoreChecks: ["nightly"] });
    expect(parseEvent("check_run", checkRun("nightly", "failure"), ignoring).signals).toEqual([]);
  });
  it("never wakes for stopped repos", () => {
    const stopped = parseConfig({ ...config, stoppedRepos: ["togetherweown/two-web-next"] });
    expect(parseEvent("check_run", checkRun("build", "failure"), stopped).signals).toEqual([]);
  });
  it("does not consume commit status events (not subscribed: every status delivery is stored by the host)", () => {
    const status = { repository, sha: HEAD, state: "failure", context: "ci/legacy", target_url: "https://ci/1", branches: [{ name: "TOG-1-x" }] };
    expect(mayAct("status", status)).toBe(false);
    expect(parseEvent("status", status, config).signals).toEqual([]);
  });
});

describe("pull_request and push", () => {
  const pr = (extra: Record<string, unknown>, action = "synchronize") => ({
    action,
    repository,
    pull_request: {
      number: 1903, state: "open", draft: false, html_url: "https://github.com/TogetherWeOwn/two-web-next/pull/1903",
      head: { sha: HEAD, ref: "feat/x", repo: { full_name: "TogetherWeOwn/two-web-next" } },
      base: { ref: "main", repo: { full_name: "TogetherWeOwn/two-web-next" } },
      user: { login: "doer" }, author_association: "MEMBER", updated_at: "2026-10-27T04:00:00Z", ...extra,
    },
  });
  it("indexes head, branch and draft flag", () => {
    const parsed = parseEvent("pull_request", pr({ draft: true }, "converted_to_draft"), config);
    expect(parsed.upsertIndex[0]).toMatchObject({ number: 1903, head: HEAD, headRef: "feat/x", draft: true, open: true, trusted: true, updatedAt: "2026-10-27T04:00:00Z" });
    expect(parsed.signals).toEqual([]);
  });
  it("signals merged and tombstones the index entry as closed; a plain close only tombstones it", () => {
    const merged = parseEvent("pull_request", pr({ state: "closed", merged: true }, "closed"), config);
    expect(merged.signals.map((s) => s.state)).toEqual(["merged"]);
    expect(merged.upsertIndex).toEqual([expect.objectContaining({ repo: "togetherweown/two-web-next", number: 1903, open: false })]);
    const closed = parseEvent("pull_request", pr({ state: "closed", merged: false }, "closed"), config);
    expect(closed.signals).toEqual([]);
    expect(closed.upsertIndex[0]!.open).toBe(false);
  });
  it("marks fork PRs and outsider authors untrusted; trustedAuthors admits bots", () => {
    const fork = parseEvent("pull_request", pr({ head: { sha: HEAD, ref: "TOG-43084-x", repo: { full_name: "evil/two-web-next" } } }), config);
    expect(fork.upsertIndex[0]!.trusted).toBe(false);
    const deletedFork = parseEvent("pull_request", pr({ head: { sha: HEAD, ref: "TOG-43084-x", repo: null } }), config);
    expect(deletedFork.upsertIndex[0]!.trusted).toBe(false);
    const outsider = parseEvent("pull_request", pr({ author_association: "CONTRIBUTOR" }), config);
    expect(outsider.upsertIndex[0]!.trusted).toBe(false);
    const bot = pr({ author_association: "NONE", user: { login: "paperclip-agent[bot]" } });
    expect(parseEvent("pull_request", bot, config).upsertIndex[0]!.trusted).toBe(false);
    const allow = parseConfig({ ...config, trustedAuthors: ["Paperclip-Agent"] });
    expect(parseEvent("pull_request", bot, allow).upsertIndex[0]!.trusted).toBe(true);
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) expect(isTrustedAuthor(config, association, "x")).toBe(true);
    // A merged fork PR carries trusted=false so the gate refuses it.
    const mergedFork = parseEvent("pull_request", pr({ state: "closed", merged: true, author_association: "NONE" }, "closed"), config);
    expect(mergedFork.signals[0]!.trusted).toBe(false);
  });
  it("graph lookups respect state, cross-repo heads and author association", () => {
    const node = { number: 7, url: "u", state: "OPEN" as const, isDraft: false, isCrossRepository: false, authorAssociation: "MEMBER", author: { login: "doer" }, headRefOid: HEAD, headRefName: "TOG-1-x", baseRefName: "main", mergeable: "MERGEABLE" as const, updatedAt: "2026-10-27T04:00:00Z" };
    expect(indexFromGraph("o/r", node, config)).toMatchObject({ open: true, trusted: true, updatedAt: "2026-10-27T04:00:00Z" });
    expect(indexFromGraph("o/r", { ...node, state: "CLOSED" as const }, config).open).toBe(false);
    expect(indexFromGraph("o/r", { ...node, state: "MERGED" as const }, config).open).toBe(false);
    expect(indexFromGraph("o/r", { ...node, isCrossRepository: true }, config).trusted).toBe(false);
    expect(indexFromGraph("o/r", { ...node, authorAssociation: "FIRST_TIME_CONTRIBUTOR" }, config).trusted).toBe(false);
  });
  it("evaluate gates closed, superseded, untrusted and draft PRs", () => {
    const signal = { repo: "o/r", number: 7, head: HEAD, state: "ci_red" as const, url: "u", headRef: null, draft: null, trusted: null, detail: {} };
    const entry = { repo: "o/r", number: 7, head: HEAD, headRef: "TOG-1-x", base: "main", draft: false, url: "u", open: true, trusted: true, updatedAt: null };
    expect(evaluate(entry, signal)).toMatchObject({ kind: "ok", signal: { draft: false, trusted: true, headRef: "TOG-1-x" } });
    expect(evaluate({ ...entry, open: false }, signal)).toMatchObject({ kind: "skip", outcome: "skipped_closed" });
    expect(evaluate({ ...entry, head: "f".repeat(40) }, signal)).toMatchObject({ kind: "skip", outcome: "stale_head" });
    expect(evaluate({ ...entry, trusted: false }, signal)).toMatchObject({ kind: "skip", outcome: "untrusted" });
    expect(evaluate({ ...entry, draft: true }, signal)).toMatchObject({ kind: "skip", outcome: "skipped_draft" });
  });
  it("signals a conflict when GitHub already reports mergeable_state dirty on a non-draft PR", () => {
    expect(parseEvent("pull_request", pr({ mergeable_state: "dirty" }), config).signals.map((s) => s.state)).toEqual(["conflict"]);
    expect(parseEvent("pull_request", pr({ mergeable_state: "dirty", draft: true }), config).signals).toEqual([]);
  });
  it("marks a repo for the conflict sweep only when its default branch moves", () => {
    expect(parseEvent("push", { repository, ref: "refs/heads/main" }, config).sweepRepos).toEqual(["togetherweown/two-web-next"]);
    expect(parseEvent("push", { repository, ref: "refs/heads/TOG-1-x" }, config).sweepRepos).toEqual([]);
  });
});

describe("fingerprint", () => {
  it("is (repo, PR, head, state)", () => {
    expect(fingerprint({ repo: "TogetherWeOwn/Kofra", number: 7, head: "abc", state: "ci_red" })).toBe("togetherweown/kofra#7@abc:ci_red");
  });
});
