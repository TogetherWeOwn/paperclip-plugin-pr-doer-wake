import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { evaluate, fingerprint, isTrustedAuthor, mayAct, parseEvent, prStateFromGraph, reviewScore, verifySignature } from "../src/github.js";

const repository = { full_name: "TogetherWeOwn/two-web-next", default_branch: "main", owner: { login: "TogetherWeOwn" } };
const config = parseConfig({ enabled: true, githubOrg: "TogetherWeOwn", webhookSecretRef: { type: "secret_ref", secretId: "x" }, githubTokenSecretRef: { type: "secret_ref", secretId: "y" } });
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
      expect(parsed.signals[0]!.draft).toBeNull(); // draft comes from the authoritative GitHub lookup
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
  it("pull_request deliveries carry no wake decision: only a payload already reporting a conflict is a candidate", () => {
    for (const action of ["converted_to_draft", "closed", "labeled"]) {
      expect(mayAct("pull_request", pr({ mergeable_state: "dirty" }, action))).toBe(false);
      expect(parseEvent("pull_request", pr({ mergeable_state: "dirty" }, action), config).signals).toEqual([]);
    }
    expect(mayAct("pull_request", pr({}))).toBe(false);
    expect(parseEvent("pull_request", pr({ state: "closed", merged: true }, "closed"), config).signals).toEqual([]);
    const dirty = parseEvent("pull_request", pr({ mergeable_state: "dirty" }), config).signals;
    expect(dirty).toEqual([expect.objectContaining({ state: "conflict", draft: null, trusted: null })]); // decided by the lookup
  });
  it("marks fork PRs and outsider authors untrusted; trustedAuthors admits bots", () => {
    const node = { number: 7, url: "u", state: "OPEN" as const, isDraft: false, isCrossRepository: false, authorAssociation: "NONE", author: { login: "paperclip-agent[bot]" }, headRefOid: HEAD, headRefName: "TOG-1-x", baseRefName: "main", mergeable: "MERGEABLE" as const, updatedAt: "2026-10-27T04:00:00Z" };
    expect(prStateFromGraph("o/r", node, config).trusted).toBe(false);
    const allow = parseConfig({ ...config, trustedAuthors: ["Paperclip-Agent"] });
    expect(prStateFromGraph("o/r", node, allow).trusted).toBe(true);
    expect(prStateFromGraph("o/r", { ...node, isCrossRepository: true }, allow).trusted).toBe(false);
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) expect(isTrustedAuthor(config, association, "x")).toBe(true);
  });
  it("graph lookups respect state, cross-repo heads and author association", () => {
    const node = { number: 7, url: "u", state: "OPEN" as const, isDraft: false, isCrossRepository: false, authorAssociation: "MEMBER", author: { login: "doer" }, headRefOid: HEAD, headRefName: "TOG-1-x", baseRefName: "main", mergeable: "MERGEABLE" as const, updatedAt: "2026-10-27T04:00:00Z" };
    expect(prStateFromGraph("o/r", node, config)).toMatchObject({ open: true, trusted: true, mergeable: "MERGEABLE" });
    expect(prStateFromGraph("o/r", { ...node, state: "CLOSED" as const }, config).open).toBe(false);
    expect(prStateFromGraph("o/r", { ...node, state: "MERGED" as const }, config).open).toBe(false);
    expect(prStateFromGraph("o/r", { ...node, isCrossRepository: true }, config).trusted).toBe(false);
    expect(prStateFromGraph("o/r", { ...node, authorAssociation: "FIRST_TIME_CONTRIBUTOR" }, config).trusted).toBe(false);
  });
  it("evaluate gates closed, superseded, untrusted, draft and no-longer-conflicting PRs", () => {
    const signal = { repo: "o/r", number: 7, head: HEAD, state: "ci_red" as const, url: "u", headRef: null, draft: null, trusted: null, detail: {} };
    const entry = { repo: "o/r", number: 7, head: HEAD, headRef: "TOG-1-x", draft: false, url: "u", open: true, trusted: true, mergeable: "MERGEABLE" as const };
    const conflict = { ...signal, state: "conflict" as const };
    expect(evaluate({ ...entry, mergeable: "CONFLICTING" }, conflict)).toMatchObject({ kind: "ok" });
    expect(evaluate(entry, conflict)).toMatchObject({ kind: "skip", outcome: "not_conflicting" });
    expect(evaluate({ ...entry, mergeable: "UNKNOWN" }, conflict)).toMatchObject({ kind: "transient" });
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
