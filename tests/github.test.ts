import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { fingerprint, parseEvent, reviewScore, verifySignature } from "../src/github.js";

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
  it("records failed commit statuses for head matching", () => {
    const parsed = parseEvent("status", { repository, sha: HEAD, state: "failure", context: "ci/legacy", target_url: "https://ci/1", branches: [{ name: "TOG-1-x" }] }, config);
    expect(parsed.statusFailures).toEqual([{ repo: "togetherweown/two-web-next", sha: HEAD, context: "ci/legacy", url: "https://ci/1" }]);
  });
});

describe("pull_request and push", () => {
  const pr = (extra: Record<string, unknown>, action = "synchronize") => ({
    action,
    repository,
    pull_request: { number: 1903, state: "open", draft: false, html_url: "https://github.com/TogetherWeOwn/two-web-next/pull/1903", head: { sha: HEAD, ref: "feat/x" }, base: { ref: "main" }, ...extra },
  });
  it("indexes head, branch and draft flag", () => {
    const parsed = parseEvent("pull_request", pr({ draft: true }, "converted_to_draft"), config);
    expect(parsed.upsertIndex[0]).toMatchObject({ number: 1903, head: HEAD, headRef: "feat/x", draft: true });
    expect(parsed.signals).toEqual([]);
  });
  it("signals merged and drops the index entry; a plain close only drops it", () => {
    const merged = parseEvent("pull_request", pr({ state: "closed", merged: true }, "closed"), config);
    expect(merged.signals.map((s) => s.state)).toEqual(["merged"]);
    expect(merged.removeIndex).toEqual([{ repo: "togetherweown/two-web-next", number: 1903 }]);
    const closed = parseEvent("pull_request", pr({ state: "closed", merged: false }, "closed"), config);
    expect(closed.signals).toEqual([]);
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
