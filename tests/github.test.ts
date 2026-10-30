import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { checkVerdict, evaluate, fingerprint, isTrustedAuthor, mayAct, parseEvent, policySkip, prStateFromGraph, reviewScore, verifySignature, type Signal } from "../src/github.js";

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
  it("ignores successful, neutral and cancelled review runs", () => {
    for (const conclusion of ["success", "neutral", "cancelled"]) {
      expect(parseEvent("check_run", checkRun("Paperclip Review", conclusion, { title: "Authorized manual review required" }), config).signals).toEqual([]);
    }
  });
  it("parses only N/5 titles", () => {
    expect(reviewScore("4/5")).toBe(4);
    expect(reviewScore("Incomplete review")).toBeNull();
  });
});

describe("CI checks", () => {
  it("wakes on a failure, timeout or action required", () => {
    for (const conclusion of ["failure", "timed_out", "action_required"]) {
      const parsed = parseEvent("check_run", checkRun("build", conclusion), config);
      expect(parsed.signals.map((s) => s.state)).toEqual(["ci_red"]);
      expect(parsed.signals[0]!.draft).toBeNull(); // draft comes from the authoritative GitHub lookup
    }
  });
  it("ignores cancelled, stale, skipped, neutral and in-progress runs", () => {
    for (const conclusion of ["cancelled", "stale", "skipped", "neutral", "success", "startup_failure"]) {
      expect(parseEvent("check_run", checkRun("pr-lint", conclusion), config).signals).toEqual([]);
    }
    expect(parseEvent("check_run", checkRun("build", "failure", { action: "created" }), config).signals).toEqual([]);
  });
  it("ignores checks on a superseded head", () => {
    expect(parseEvent("check_run", checkRun("build", "failure", { prHead: "f".repeat(40) }), config).signals).toEqual([]);
  });
  it("ignores stale requiredChecks and honours ignoreChecks", () => {
    const strict = parseConfig({ ...config, requiredChecks: { "TogetherWeOwn/two-web-next": ["build"] }, ignoreChecks: ["nightly"] });
    expect(parseEvent("check_run", checkRun("lighthouse", "failure"), strict).signals).toHaveLength(1);
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
  it("only synchronize is a conflict candidate; closed is admitted for cleanup", () => {
    for (const action of ["converted_to_draft", "labeled", "opened", "reopened", "ready_for_review", "edited"]) {
      expect(mayAct("pull_request", pr({ mergeable_state: "dirty" }, action))).toBe(false);
      expect(parseEvent("pull_request", pr({ mergeable_state: "dirty" }, action), config).signals).toEqual([]);
    }
    expect(mayAct("pull_request", pr({ state: "closed", merged: true }, "closed"))).toBe(true);
    expect(parseEvent("pull_request", pr({ state: "closed", merged: true }, "closed"), config).signals).toEqual([]);
    for (const extra of [{}, { mergeable_state: "unknown", mergeable: null }, { mergeable_state: "dirty", mergeable: false }]) {
      expect(mayAct("pull_request", pr(extra))).toBe(true);
      expect(parseEvent("pull_request", pr(extra), config).signals[0]).toEqual(expect.objectContaining({ state: "conflict", draft: null, trusted: null }));
    }
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
    const red = [{ id: "CR_1", name: "build", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-27T04:00:00Z" }];
    const entry = { repo: "o/r", number: 7, head: HEAD, headRef: "TOG-1-x", draft: false, url: "u", open: true, trusted: true, mergeable: "MERGEABLE" as const, checkRuns: red };
    const conflict = { ...signal, state: "conflict" as const };
    expect(evaluate({ ...entry, mergeable: "CONFLICTING" }, conflict, config)).toMatchObject({ kind: "ok" });
    expect(evaluate(entry, conflict, config)).toMatchObject({ kind: "skip", outcome: "not_conflicting" });
    expect(evaluate({ ...entry, mergeable: "UNKNOWN" }, conflict, config)).toMatchObject({ kind: "transient" });
    expect(evaluate(entry, signal, config)).toMatchObject({ kind: "ok", signal: { draft: false, trusted: true, headRef: "TOG-1-x" } });
    expect(evaluate({ ...entry, open: false }, signal, config)).toMatchObject({ kind: "skip", outcome: "skipped_closed" });
    expect(evaluate({ ...entry, head: "f".repeat(40) }, signal, config)).toMatchObject({ kind: "skip", outcome: "stale_head" });
    expect(evaluate({ ...entry, trusted: false }, signal, config)).toMatchObject({ kind: "skip", outcome: "untrusted" });
    expect(evaluate({ ...entry, draft: true }, signal, config)).toMatchObject({ kind: "skip", outcome: "skipped_draft" });
    const { checkRuns: _unread, ...unread } = entry;
    expect(evaluate(unread, signal, config)).toMatchObject({ kind: "transient" }); // a check signal never wakes without its checks read
  });
  it("never signals a draft PR from its payload (ready_for_review starts it again)", () => {
    expect(mayAct("pull_request", pr({ draft: true }, "opened"))).toBe(false);
    expect(parseEvent("pull_request", pr({ mergeable_state: "dirty", draft: true }), config).signals).toEqual([]);
  });
  it("does not initiate conflict sweeps on push", () => {
    expect(parseEvent("push", { repository, ref: "refs/heads/main" }, config).sweepRepos).toEqual([]);
    expect(parseEvent("push", { repository, ref: "refs/heads/TOG-1-x" }, config).sweepRepos).toEqual([]);
  });
});

describe("checkVerdict (the failing checks are revalidated)", () => {
  const signal = (detail: Signal["detail"], state: Signal["state"] = "ci_red"): Signal => ({ repo: "o/r", number: 7, head: HEAD, state, url: "u", headRef: null, draft: null, trusted: null, detail: { checkName: state === "review_findings" ? "Paperclip Review" : "build", ...detail } });
  const run = (id: string, conclusion: string | null, startedAt: string | null, status = "COMPLETED", name = "build") => ({ id, name, status, conclusion, startedAt, url: `https://github.com/o/r/runs/${id}` });
  const review = (id: string, conclusion: string | null) => run(id, conclusion, "2026-10-27T04:00:00Z", "COMPLETED", "Paperclip Review");
  const mine = { checkRunId: "CR_100", checkStartedAt: "2026-10-27T04:00:00Z" };
  it("red when GitHub's newest run of the check is completed and red", () => {
    expect(checkVerdict([run("CR_100", "FAILURE", "2026-10-27T04:00:00Z")], signal(mine), config)).toMatchObject({ kind: "red", run: { id: "CR_100" } });
    expect(checkVerdict([run("CR_100", "FAILURE", "2026-10-27T04:00:00Z"), run("CR_101", "ACTION_REQUIRED", "2026-10-27T04:01:00Z")], signal(mine), config)).toMatchObject({ kind: "red", run: { id: "CR_101" } });
  });
  it("stale when a newer run passed, is re-running, or the same run is no longer red", () => {
    expect(checkVerdict([run("CR_100", "FAILURE", "2026-10-27T04:00:00Z"), run("CR_200", "SUCCESS", "2026-10-27T04:05:00Z")], signal(mine), config)).toMatchObject({ kind: "skip", outcome: "check_not_red" });
    expect(checkVerdict([run("CR_200", "SUCCESS", "2026-10-27T04:05:00Z")], signal(mine), config)).toMatchObject({ kind: "skip", outcome: "check_not_red" });
    expect(checkVerdict([run("CR_100", "FAILURE", "2026-10-27T04:00:00Z"), run("CR_101", null, null, "QUEUED")], signal(mine), config)).toMatchObject({ kind: "skip", outcome: "check_not_red" });
    expect(checkVerdict([run("CR_100", "SUCCESS", "2026-10-27T04:00:00Z")], signal(mine), config)).toMatchObject({ kind: "skip", outcome: "check_not_red" });
  });
  it("transient while GitHub still lists the delivered run itself as not completed (read lag)", () => {
    expect(checkVerdict([run("CR_100", null, "2026-10-27T04:00:00Z", "IN_PROGRESS")], signal(mine), config)).toMatchObject({ kind: "transient" });
  });
  it("ci_red: any other gating check still red on the head keeps the signal red, with that check as evidence", () => {
    const runs = [run("CR_100", "SUCCESS", "2026-10-27T04:00:00Z"), run("CR_300", "FAILURE", "2026-10-27T04:00:00Z", "COMPLETED", "test")];
    expect(checkVerdict(runs, signal(mine), config)).toMatchObject({ kind: "red", run: { name: "test" } });
    const ignoring = parseConfig({ ...config, ignoreChecks: ["test"] });
    expect(checkVerdict(runs, signal(mine), ignoring)).toMatchObject({ kind: "skip", outcome: "check_not_red" });
    expect(checkVerdict([run("CR_100", "SUCCESS", "2026-10-27T04:00:00Z"), review("CR_9", "FAILURE")], signal(mine), config)).toMatchObject({ kind: "skip" }); // the review is not CI
  });
  it("a run supersedes only runs of the same name in its own check suite", () => {
    const inSuite = (r: ReturnType<typeof run>, suite: string) => ({ ...r, suite });
    const failed = inSuite(run("CR_100", "FAILURE", "2026-10-27T04:00:00Z"), "CS_1");
    expect(checkVerdict([failed, inSuite(run("CR_200", "SUCCESS", "2026-10-27T04:05:00Z"), "CS_2")], signal(mine), config)).toMatchObject({ kind: "red", run: { id: "CR_100" } });
    expect(checkVerdict([failed, inSuite(run("CR_200", "SUCCESS", "2026-10-27T04:05:00Z"), "CS_1")], signal(mine), config)).toMatchObject({ kind: "skip", outcome: "check_not_red" });
  });
  it("Paperclip Review accepts the three red conclusions on the review check itself", () => {
    expect(checkVerdict([review("CR_100", "FAILURE")], signal(mine, "review_findings"), config)).toMatchObject({ kind: "red" });
    expect(checkVerdict([review("CR_100", "TIMED_OUT")], signal(mine, "review_findings"), config)).toMatchObject({ kind: "red" });
    expect(checkVerdict([review("CR_100", "ACTION_REQUIRED")], signal(mine, "review_findings"), config)).toMatchObject({ kind: "red" });
    expect(checkVerdict([review("CR_100", "SUCCESS"), run("CR_5", "FAILURE", "2026-10-27T04:00:00Z")], signal(mine, "review_findings"), config)).toMatchObject({ kind: "skip" });
  });
  it("transient when GitHub lists no run of the check or only runs older than the delivered one", () => {
    expect(checkVerdict(undefined, signal(mine), config)).toMatchObject({ kind: "transient" });
    expect(checkVerdict([], signal(mine), config)).toMatchObject({ kind: "transient" });
    expect(checkVerdict([run("CR_050", "SUCCESS", "2026-10-27T03:50:00Z")], signal(mine), config)).toMatchObject({ kind: "transient" });
    expect(checkVerdict([run("CR_050", "SUCCESS", "2026-10-27T03:50:00Z")], signal({}), config)).toMatchObject({ kind: "skip" }); // old ledger row: no identity
  });
  it("a head-level re-evaluation (no delivered run) judges every gating check and is never transient", () => {
    const head = (state: Signal["state"] = "ci_red"): Signal => ({ repo: "o/r", number: 7, head: HEAD, state, url: "u", headRef: null, draft: null, trusted: null, detail: {} });
    expect(checkVerdict([run("CR_300", "FAILURE", "2026-10-27T04:00:00Z", "COMPLETED", "test")], head(), config)).toMatchObject({ kind: "red", run: { id: "CR_300" } });
    expect(checkVerdict([], head(), config)).toMatchObject({ kind: "skip", outcome: "check_not_red" });
    expect(checkVerdict([run("CR_1", "SUCCESS", "2026-10-27T04:00:00Z"), run("CR_2", null, null, "IN_PROGRESS", "test")], head(), config)).toMatchObject({ kind: "skip", outcome: "check_not_red" });
    expect(checkVerdict([review("CR_9", "FAILURE")], head(), config)).toMatchObject({ kind: "skip", outcome: "check_not_red" }); // the review is not CI
    expect(checkVerdict([review("CR_9", "FAILURE")], head("review_findings"), config)).toMatchObject({ kind: "red", run: { id: "CR_9" } });
    expect(checkVerdict([], head("review_findings"), config)).toMatchObject({ kind: "skip", outcome: "check_not_red" });
    expect(checkVerdict([review("CR_9", "ACTION_REQUIRED")], head("review_findings"), config)).toMatchObject({ kind: "red" });
  });
  it("parseEvent carries the delivered run's identity", () => {
    const payload = checkRun("build", "failure");
    (payload.check_run as any).node_id = "CR_100";
    (payload.check_run as any).started_at = "2026-10-27T04:00:00Z";
    expect(parseEvent("check_run", payload, config).signals[0]!.detail).toMatchObject({ checkRunId: "CR_100", checkStartedAt: "2026-10-27T04:00:00Z" });
  });
  it("prStateFromGraph carries the head runs only when they were read", () => {
    const node = { number: 7, url: "u", state: "OPEN" as const, isDraft: false, isCrossRepository: false, authorAssociation: "MEMBER", author: { login: "doer" }, headRefOid: HEAD, headRefName: "x", baseRefName: "main", mergeable: "MERGEABLE" as const, updatedAt: "t" };
    expect(prStateFromGraph("o/r", node, config).checkRuns).toBeUndefined();
    expect(prStateFromGraph("o/r", node, config, [run("CR_1", "FAILURE", null)]).checkRuns?.map((r) => r.id)).toEqual(["CR_1"]);
  });

});

describe("policySkip", () => {
  it("re-applies stoppedRepos and wakeStates", () => {
    expect(policySkip(parseConfig({ ...config, stoppedRepos: ["O/R"] }), { repo: "o/r", state: "ci_red" })).toBe("stopped_repo");
    expect(policySkip(parseConfig({ ...config, wakeStates: ["conflict"] }), { repo: "o/r", state: "ci_red" })).toBe("skipped_state");
    expect(policySkip(config, { repo: "o/r", state: "ci_red" })).toBeNull();
  });
});

describe("fingerprint", () => {
  it("is (repo, PR, head, state)", () => {
    expect(fingerprint({ repo: "TogetherWeOwn/Kofra", number: 7, head: "abc", state: "ci_red" })).toBe("togetherweown/kofra#7@abc:ci_red");
  });
});
