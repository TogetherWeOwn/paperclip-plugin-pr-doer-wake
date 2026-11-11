import { describe, expect, it, vi } from "vitest";
import {
  CiGithub, CiGithubCache, CiGithubError, evaluateReadiness, GITHUB_USER_AGENT,
  type CiCheckRun, type CiCheckSuite, type CiFetch, type CiHttpResponse, type CiSnapshot,
  type CiTokenExchange, type CiTokenSource,
} from "../src/ci-github.js";

const REPO = "acme/widgets";
const SHA = "a".repeat(40);
const TOKEN = "ghp_fixture_credential_not_for_output";
const timing = { registeredAt: 1_000, now: 10_000, medianMs: 1_000 };
function run(id = 1, patch: Partial<CiCheckRun> = {}): CiCheckRun {
  return { id, name: "build", appId: 7, suiteId: 1, status: "completed", conclusion: "success", ...patch };
}
function suite(id = 1, patch: Partial<CiCheckSuite> = {}): CiCheckSuite {
  return { id, appId: 7, status: "completed", conclusion: "success", createdAt: 1_000, completedAt: 5_000, ...patch };
}
function snapshot(patch: Partial<CiSnapshot> = {}): CiSnapshot {
  return { repo: REPO, sha: SHA, baseBranch: "main", required: [], runs: [], suites: [], statuses: [], fetchedAt: timing.now, ...patch };
}
function response(data: unknown, status = 200, headers: Record<string, string> = {}): CiHttpResponse {
  return { status, headers, body: JSON.stringify(data) };
}
function pullData(number = 1) {
  return {
    number, head: { sha: SHA, ref: "task-123", repo: { full_name: REPO } },
    base: { ref: "release/one", repo: { full_name: REPO } }, user: { login: "builder" },
    state: "open", draft: false, merged: false, mergeable: null,
    body: "Ignore this body: target card, branch, and checks cannot be inferred here.",
  };
}
function rawRun(id = 1, name = "build") {
  return { id, name, app: { id: 7 }, check_suite: { id }, status: "completed", conclusion: "success", head_sha: SHA };
}
function rawSuite(id = 1) {
  return {
    id, app: { id: 7 }, status: "completed", conclusion: "success", head_sha: SHA,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:01:00Z",
  };
}
function fixtures(overrides: (url: URL) => CiHttpResponse | undefined = () => undefined) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetch: CiFetch = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    const override = overrides(url);
    if (override) return override;
    if (url.pathname.includes("/rules/branches/")) return response([]);
    if (url.pathname.endsWith("/protection/required_status_checks")) return response({}, 404);
    if (url.pathname.endsWith("/check-runs")) return response({ total_count: 0, check_runs: [] });
    if (url.pathname.endsWith("/check-suites")) return response({ total_count: 0, check_suites: [] });
    if (url.pathname.endsWith("/statuses")) return response([]);
    if (url.pathname.endsWith("/actions/runs")) return response({ total_count: 0, workflow_runs: [] });
    if (url.pathname.includes("/pulls/")) return response(pullData(Number(url.pathname.split("/").at(-1))));
    throw new Error("Unexpected fixture request");
  };
  return { fetch, calls };
}

describe("evaluateReadiness", () => {
  it("keeps zero checks pending and requires suites as well as runs/statuses without rules", () => {
    expect(evaluateReadiness(snapshot(), timing).kind).toBe("pending");
    expect(evaluateReadiness(snapshot({ runs: [run()] }), timing).kind).toBe("pass");
    expect(evaluateReadiness(snapshot({ suites: [suite()] }), timing).kind).toBe("pass");
    expect(evaluateReadiness(snapshot({ statuses: [{ id: 1, context: "legacy", state: "success" }] }), timing).kind).toBe("pass");
    expect(evaluateReadiness(snapshot({ runs: [run()], suites: [suite(1, { status: "queued", conclusion: null })] }), timing).kind).toBe("pending");
    expect(evaluateReadiness(snapshot({ runs: [run()], suites: [suite(1, { conclusion: "failure" })] }), timing).kind).toBe("fail");
    expect(evaluateReadiness(snapshot({ suites: [suite()], statuses: [{ id: 1, context: "legacy", state: "error" }] }), timing).kind).toBe("fail");
  });

  it.each(["queued", "in_progress"])("ignores empty %s suites without treating zero checks as success", (status) => {
    const suites = [suite(2, { status, conclusion: null, completedAt: null, latestCheckRunsCount: 0 })];
    expect(evaluateReadiness(snapshot({ runs: [run()], suites }), timing).kind).toBe("pass");
    expect(evaluateReadiness(snapshot({ suites }), timing)).toMatchObject({ kind: "pending", pending: ["checks not registered"] });
    suites[0]!.status = "completed";
    suites[0]!.conclusion = "failure";
    expect(evaluateReadiness(snapshot({ runs: [run()], suites }), timing).kind).toBe("fail");
  });

  it.each([0, 1, null, undefined])("preserves required-run and legacy-status verdicts with suite count %s", (latestCheckRunsCount) => {
    const suites = [suite(2, { status: "queued", conclusion: null, completedAt: null, latestCheckRunsCount })];
    for (const result of ["success", "failure"]) {
      for (const input of [
        snapshot({ required: [{ context: "build", appId: 7 }], runs: [run(1, { suiteId: null, conclusion: result })], suites }),
        snapshot({ required: [{ context: "legacy", appId: null }], statuses: [{ id: 1, context: "legacy", state: result }], suites }),
        snapshot({ runs: [run(1, { conclusion: result })], suites }),
      ]) {
        expect(evaluateReadiness(input, timing).kind).toBe(latestCheckRunsCount === 0 ? result === "success" ? "pass" : "fail" : "pending");
      }
    }
  });

  it.each(["queued", "in_progress"])("retains zero-count %s suites referenced by observed runs", (status) => {
    const input = snapshot({
      required: [{ context: "build", appId: 7 }], runs: [run()],
      suites: [suite(1, { status, conclusion: null, completedAt: null, latestCheckRunsCount: 0 })],
    });
    expect(evaluateReadiness(input, timing)).toMatchObject({ kind: "pending", pending: ["build [app 7]"] });
    input.required = [];
    expect(evaluateReadiness(input, timing).kind).toBe("pending");
    input.required = [{ context: "legacy", appId: null }];
    input.statuses = [{ id: 1, context: "legacy", state: "success" }];
    expect(evaluateReadiness(input, timing).kind).toBe("pending");
  });

  it.each(["unknown", "pending", "waiting"])("retains zero-count suites with unrecognized status %s", (status) => {
    const suites = [suite(2, { status, conclusion: null, completedAt: null, latestCheckRunsCount: 0 })];
    expect(evaluateReadiness(snapshot({ runs: [run()], suites }), timing).kind).toBe("pending");
    expect(evaluateReadiness(snapshot({ required: [{ context: "build", appId: 7 }], runs: [run(1, { suiteId: null })], suites }), timing).kind).toBe("pending");
  });

  it("does not let an empty suite satisfy missing required checks or suppress their grace", () => {
    const phantom = suite(2, { status: "queued", conclusion: null, completedAt: null, latestCheckRunsCount: 0 });
    const input = snapshot({ required: [{ context: "build", appId: 7 }], suites: [phantom] });
    expect(evaluateReadiness(input, timing)).toMatchObject({ kind: "fail", missing: ["build [app 7]"], missingSince: 1_000 });
    input.suites.push(suite());
    expect(evaluateReadiness(input, timing)).toMatchObject({ kind: "fail", missing: ["build [app 7]"], missingSince: 5_000 });
    input.runs = [run(1, { status: "queued", conclusion: null })];
    expect(evaluateReadiness(input, timing).kind).toBe("pending");
  });

  it.each(["success", "neutral", "skipped"])("accepts completed %s", (conclusion) => {
    expect(evaluateReadiness(snapshot({ runs: [run(1, { conclusion })] }), timing).kind).toBe("pass");
  });
  it.each(["failure", "cancelled", "timed_out", "action_required", "startup_failure"])("fails completed %s", (conclusion) => {
    expect(evaluateReadiness(snapshot({ runs: [run(1, { conclusion })] }), timing)).toMatchObject({ kind: "fail", failed: ["build [app 7]"] });
  });
  it.each([null, "stale", "unknown", "pending"])("keeps unknown conclusion %s pending", (conclusion) => {
    expect(evaluateReadiness(snapshot({ runs: [run(1, { conclusion })] }), timing).kind).toBe("pending");
  });
  it("does not use a conclusion while the run is still queued", () => {
    expect(evaluateReadiness(snapshot({ runs: [run(1, { status: "queued", conclusion: "success" })] }), timing).kind).toBe("pending");
  });

  it("chooses greatest numeric IDs, not API ordering, and a queued rerun supersedes a completion", () => {
    const runs = [run(10, { status: "queued", conclusion: null }), run(2, { conclusion: "failure" }), run(1)];
    const input = snapshot({ required: [{ context: "build", appId: 7 }], runs });
    expect(evaluateReadiness(input, timing)).toMatchObject({ kind: "pending", failed: [], missing: [] });
    expect(input.runs).toEqual(runs);
    expect(evaluateReadiness(snapshot({ runs: [run(2), run(1, { conclusion: "failure" })] }), timing).kind).toBe("pass");
    expect(evaluateReadiness(snapshot({ suites: [suite(10, { status: "queued", conclusion: null }), suite(2)] }), timing).kind).toBe("pending");
    expect(evaluateReadiness(snapshot({ statuses: [
      { id: 10, context: "legacy", state: "pending" }, { id: 2, context: "legacy", state: "success" },
    ] }), timing).kind).toBe("pending");
  });

  it.each(["queued", "in_progress"])("defers a completed required run while its own suite is %s", (status) => {
    for (const appId of [7, null]) {
      const input = snapshot({
        required: [{ context: "build", appId }], runs: [run()],
        suites: [suite(1, { status, conclusion: null, completedAt: null })],
      });
      expect(evaluateReadiness(input, timing)).toMatchObject({
        kind: "pending", failed: [], missing: [], pending: [appId === null ? "build" : "build [app 7]"],
      });
      input.runs[0]!.conclusion = "failure";
      expect(evaluateReadiness(input, timing)).toMatchObject({ kind: "pending", failed: [] });
    }
  });

  it("uses only the latest required run's suite, not superseded or optional suites from the same app", () => {
    const input = snapshot({
      required: [{ context: "build", appId: 7 }],
      runs: [run(1), run(2, { suiteId: 2 })],
      suites: [
        suite(1, { status: "in_progress", conclusion: null, completedAt: null }),
        suite(2),
        suite(3, { status: "queued", conclusion: null, completedAt: null }),
        suite(4, { conclusion: "failure" }),
      ],
    });
    expect(evaluateReadiness(input, timing)).toMatchObject({ kind: "pass", pending: [], failed: [] });
    // Suite failure may belong to an optional job in the required workflow.
    input.suites[1]!.conclusion = "failure";
    expect(evaluateReadiness(input, timing).kind).toBe("pass");
  });

  it("defers unknown suite associations and legacy statuses while any suite is active", () => {
    for (const suiteId of [null, undefined, 99]) {
      expect(evaluateReadiness(snapshot({
        required: [{ context: "build", appId: 7 }], runs: [run(1, { suiteId })],
        suites: [suite(1, { status: "queued", conclusion: null, completedAt: null })],
      }), timing).kind).toBe("pending");
    }
    for (const state of ["success", "failure"]) {
      const input = snapshot({ required: [{ context: "legacy", appId: null }],
        statuses: [{ id: 1, context: "legacy", state }], suites: [suite(1, { status: "in_progress", conclusion: null, completedAt: null })] });
      expect(evaluateReadiness(input, timing).kind).toBe("pending");
      input.suites = [suite()];
      expect(evaluateReadiness(input, timing).kind).toBe(state === "success" ? "pass" : "fail");
    }
  });

  it("does not fail prematurely while any present required check remains pending", () => {
    const input = snapshot({
      required: [{ context: "build", appId: 7 }, { context: "lint", appId: 7 }],
      runs: [run(1, { conclusion: "failure" }), run(2, { name: "lint", status: "in_progress", conclusion: null })],
    });
    expect(evaluateReadiness(input, timing)).toMatchObject({ kind: "pending", failed: ["build [app 7]"], pending: ["lint [app 7]"] });
    input.runs[1]!.status = "completed";
    input.runs[1]!.conclusion = "success";
    expect(evaluateReadiness(input, timing)).toMatchObject({ kind: "fail", failed: ["build [app 7]"], pending: [] });
  });

  it("gates every suite without rules even when multiple workflows share an app", () => {
    const olderPending = suite(1, { status: "queued", conclusion: null, completedAt: null });
    const newerGreen = suite(100);
    expect(evaluateReadiness(snapshot({ runs: [run()], suites: [olderPending, newerGreen] }), timing).kind).toBe("pending");
    expect(evaluateReadiness(snapshot({ suites: [suite(1, { conclusion: "failure" }), newerGreen] }), timing).kind).toBe("fail");
    expect(evaluateReadiness(snapshot({ runs: [run(1, { conclusion: "failure" })], suites: [olderPending, newerGreen] }), timing).kind).toBe("pending");
  });

  it("requires every required context, ignoring unrelated failures when rules exist", () => {
    const input = snapshot({
      required: [{ context: "build", appId: 7 }, { context: "lint", appId: null }],
      runs: [run(), run(2, { name: "optional", conclusion: "failure" })],
      statuses: [{ id: 3, context: "lint", state: "pending" }],
    });
    expect(evaluateReadiness(input, timing).kind).toBe("pending");
    input.statuses[0]!.state = "success";
    expect(evaluateReadiness(input, timing).kind).toBe("pass");
  });

  it("never lets a different app or legacy status satisfy an app-bound requirement", () => {
    const input = snapshot({
      required: [{ context: "build", appId: 7 }], runs: [run(99, { appId: 8 })],
      statuses: [{ id: 100, context: "build", state: "success" }],
    });
    expect(evaluateReadiness(input, { ...timing, now: 2_000 })).toMatchObject({ kind: "pending", missing: ["build [app 7]"] });
    expect(evaluateReadiness(input, timing)).toMatchObject({ kind: "fail", missing: ["build [app 7]"], failed: [] });
    input.runs.push(run(1, { status: "queued", conclusion: null }));
    expect(evaluateReadiness(input, timing)).toMatchObject({ kind: "pending", missing: [] });
  });

  it("keeps latest runs separately per app, including unbound context collisions", () => {
    const runs = [run(1, { conclusion: "failure" }), run(100, { appId: 8 })];
    expect(evaluateReadiness(snapshot({ runs }), timing).kind).toBe("fail");
    expect(evaluateReadiness(snapshot({ runs, required: [{ context: "build", appId: 8 }] }), timing).kind).toBe("pass");
    expect(evaluateReadiness(snapshot({ runs, required: [{ context: "build", appId: null }] }), timing).kind).toBe("fail");
  });

  it("starts missing grace at registration only when there are no suites", () => {
    const input = snapshot({ required: [{ context: "build", appId: null }] });
    expect(evaluateReadiness(input, { ...timing, now: 2_999 })).toMatchObject({ kind: "pending", missingSince: 1_000, missingFailAt: 3_000 });
    expect(evaluateReadiness(input, { ...timing, now: 3_000 }).kind).toBe("fail");
  });

  it("uses the last suite completion, not registration, for missing-check grace", () => {
    const input = snapshot({ required: [{ context: "build", appId: null }], suites: [suite(), suite(2, { appId: 8, completedAt: 8_001 })] });
    expect(evaluateReadiness(input, timing)).toMatchObject({ kind: "pending", lastSuiteCompletedAt: 8_001, missingFailAt: 10_001 });
    expect(evaluateReadiness(input, { ...timing, now: 10_001 }).kind).toBe("fail");
    expect(evaluateReadiness({ ...input, suites: [suite(1, { status: "queued", conclusion: null, completedAt: null })] }, timing))
      .toMatchObject({ kind: "pending", missingSince: null, missingFailAt: null });
  });

  it.each(["queued", "in_progress"])("defers missing-check grace while another observed suite is %s", (status) => {
    const at = (time: string) => Date.parse(`2026-01-01T${time}:00Z`);
    const input = snapshot({
      required: [{ context: "build", appId: 7 }, { context: "lint", appId: 7 }],
      runs: [run(1, { name: "lint" })],
      suites: [
        suite(1, { createdAt: at("09:59"), completedAt: at("10:00") }),
        suite(2, { status, conclusion: null, createdAt: at("10:01"), completedAt: null }),
      ],
    });
    const clock = { registeredAt: at("09:59"), now: at("11:01"), medianMs: 30 * 60_000 };
    expect(evaluateReadiness(input, clock)).toMatchObject({
      kind: "pending", missing: ["build [app 7]"], pending: [],
      lastSuiteCompletedAt: at("10:00"), missingSince: null, missingFailAt: null,
    });
    input.suites[1] = suite(2, { createdAt: at("10:01"), completedAt: at("11:02") });
    expect(evaluateReadiness(input, { ...clock, now: at("12:01") })).toMatchObject({
      kind: "pending", lastSuiteCompletedAt: at("11:02"), missingSince: at("11:02"), missingFailAt: at("12:02"),
    });
    expect(evaluateReadiness(input, { ...clock, now: at("12:02") }).kind).toBe("fail");
  });

  it("does not start missing-check grace from a partial set of suite completion timestamps", () => {
    const input = snapshot({
      required: [{ context: "build", appId: 7 }],
      suites: [suite(), suite(2, { completedAt: null })],
    });
    expect(evaluateReadiness(input, timing)).toMatchObject({
      kind: "pending", lastSuiteCompletedAt: 5_000, missingSince: null, missingFailAt: null,
    });
  });

  it.each([false, true])("waits for missing-check grace despite an existing failure (has suites: %s)", (hasSuites) => {
    const input = snapshot({
      required: [{ context: "build", appId: 7 }, { context: "lint", appId: null }],
      runs: [run(1, { conclusion: "failure" })], suites: hasSuites ? [suite()] : [],
    });
    const deadline = (hasSuites ? 5_000 : timing.registeredAt) + 2 * timing.medianMs;
    expect(evaluateReadiness(input, { ...timing, now: deadline - 1 })).toMatchObject({
      kind: "pending", failed: ["build [app 7]"], missing: ["lint"], missingFailAt: deadline,
    });
    expect(evaluateReadiness(input, { ...timing, now: deadline })).toMatchObject({
      kind: "fail", failed: ["build [app 7]"], missing: ["lint"], missingFailAt: deadline,
    });
    input.required.push({ context: "test", appId: 7 });
    input.runs.push(run(2, { name: "test", status: "queued", conclusion: null }));
    expect(evaluateReadiness(input, { ...timing, now: deadline })).toMatchObject({
      kind: "pending", failed: ["build [app 7]"], missing: ["lint"], pending: ["test [app 7]"],
    });
  });

  it("does not expire missing checks while a present required context is pending", () => {
    const input = snapshot({
      required: [{ context: "build", appId: 7 }, { context: "lint", appId: null }],
      runs: [run(1, { status: "in_progress", conclusion: null })], suites: [suite()],
    });
    expect(evaluateReadiness(input, timing)).toMatchObject({ kind: "pending", missing: ["lint"], pending: ["build [app 7]"] });
    input.runs[0]!.status = "completed";
    input.runs[0]!.conclusion = "success";
    expect(evaluateReadiness(input, timing).kind).toBe("fail");
  });

  it("rejects absent or invalid timing instead of inventing a median", () => {
    expect(() => evaluateReadiness(snapshot(), { ...timing, medianMs: 0 })).toThrow(CiGithubError);
    expect(() => evaluateReadiness(snapshot(), { ...timing, now: NaN })).toThrow(CiGithubError);
  });
});

describe("CiGithub REST reads", () => {
  it("returns authoritative PR metadata, including exact head/base branches, without trusting its body", async () => {
    const { fetch, calls } = fixtures();
    const actual = await new CiGithub(fetch, TOKEN).pull("Acme/Widgets", 1);
    expect(actual).toEqual({ repo: REPO, number: 1, headSha: SHA, headBranch: "task-123", headRepo: REPO,
      baseBranch: "release/one", author: "builder", state: "open", draft: false, merged: false, mergeable: null });
    expect(calls[0]!.url.href).toBe(`https://api.github.com/repos/${REPO}/pulls/1`);
    expect(calls[0]!.init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, "User-Agent": GITHUB_USER_AGENT, "X-GitHub-Api-Version": "2022-11-28" });
  });

  it("also accepts the installed SDK's standard Response", async () => {
    const fetch = async () => new Response(JSON.stringify(pullData()), { status: 200 });
    expect((await new CiGithub(fetch, TOKEN).pull(REPO, 1)).headSha).toBe(SHA);
  });

  it("reads and merges branch rules/classic checks without dropping app bindings", async () => {
    const { fetch, calls } = fixtures((url) => {
      if (url.pathname.includes("/rules/branches/")) return response([
        { type: "required_status_checks", parameters: { required_status_checks: [{ context: "build", integration_id: 7 }, { context: "legacy", integration_id: null }] } },
        { type: "pull_request", parameters: {} },
      ]);
      if (url.pathname.endsWith("required_status_checks")) return response({
        contexts: ["build", "legacy", "lint"], checks: [{ context: "build", app_id: 7 }, { context: "legacy", app_id: -1 }],
      });
      if (url.pathname.endsWith("check-runs")) return response({ total_count: 1, check_runs: [rawRun()] });
      if (url.pathname.endsWith("check-suites")) return response({ total_count: 1, check_suites: [rawSuite()] });
    });
    const actual = await new CiGithub(fetch, TOKEN).snapshot(REPO, SHA, "release/one");
    expect(actual.required).toEqual([{ context: "build", appId: 7 }, { context: "legacy", appId: null }, { context: "lint", appId: null }]);
    expect(actual.runs[0]).toMatchObject({ id: 1, suiteId: 1 });
    expect(actual.suites[0]).toMatchObject({ createdAt: Date.parse("2026-01-01T00:00:00Z"), completedAt: Date.parse("2026-01-01T00:01:00Z") });
    expect(calls[0]!.url.pathname).toContain("/rules/branches/release%2Fone");
    expect(calls[1]!.url.pathname).toContain("/branches/release%2Fone/protection/required_status_checks");
    expect(calls.find((call) => call.url.pathname.endsWith("check-runs"))!.url.searchParams.get("filter")).toBe("all");
  });

  it.each([undefined, null, 0, 1])("carries suite run count %s from REST into readiness", async (latest_check_runs_count) => {
    const { fetch } = fixtures((url) => {
      if (url.pathname.endsWith("check-runs")) return response({ total_count: 1, check_runs: [rawRun()] });
      if (url.pathname.endsWith("check-suites")) return response({ total_count: 2, check_suites: [rawSuite(), {
        ...rawSuite(2), app: { id: 8 }, status: "queued", conclusion: null, latest_check_runs_count,
      }] });
    });
    const actual = await new CiGithub(fetch, TOKEN).snapshot(REPO, SHA, "main");
    expect(actual.suites[1]!.latestCheckRunsCount).toBe(latest_check_runs_count ?? null);
    expect(evaluateReadiness(actual, timing).kind).toBe(latest_check_runs_count === 0 ? "pass" : "pending");
  });

  it.each([-1, 0.5, "0", false, {}, Number.MAX_SAFE_INTEGER + 1])("rejects malformed suite run count %j", async (latest_check_runs_count) => {
    const { fetch } = fixtures((url) => url.pathname.endsWith("check-suites")
      ? response({ total_count: 1, check_suites: [{ ...rawSuite(), latest_check_runs_count }] }) : undefined);
    await expect(new CiGithub(fetch, TOKEN).snapshot(REPO, SHA, "main")).rejects.toMatchObject({ code: "response" });
  });

  it.each([
    ["queued", "success"], ["queued", "failure"],
    ["in_progress", "success"], ["in_progress", "failure"],
  ])("waits when a required rerun becomes %s after reading old runs, then settles to %s", async (status, result) => {
    let stage: "old" | "rerun" | "settled" = "old";
    const { fetch, calls } = fixtures((url) => {
      if (url.pathname.endsWith("required_status_checks")) return response({ contexts: [], checks: [{ context: "build", app_id: 7 }] });
      if (url.pathname.endsWith("check-runs")) {
        const check_runs = stage === "settled"
          ? [{ ...rawRun(2), check_suite: { id: 1 }, conclusion: result }, rawRun()]
          : [rawRun()];
        if (stage === "old") stage = "rerun";
        return response({ total_count: check_runs.length, check_runs });
      }
      if (url.pathname.endsWith("check-suites")) {
        expect(stage).not.toBe("old");
        return response({ total_count: 1, check_suites: [stage === "settled"
          ? { ...rawSuite(), conclusion: result }
          : { ...rawSuite(), status, conclusion: null }] });
      }
    });
    const github = new CiGithub(fetch, TOKEN);
    const stale = await github.snapshot(REPO, SHA, "main");
    expect(stale.runs).toMatchObject([{ id: 1, suiteId: 1, status: "completed", conclusion: "success" }]);
    expect(evaluateReadiness(stale, timing)).toMatchObject({ kind: "pending", pending: ["build [app 7]"], failed: [], missing: [] });
    expect(calls.filter((call) => /\/check-(runs|suites)$/.test(call.url.pathname)).map((call) => call.url.pathname.split("/").at(-1)))
      .toEqual(["check-runs", "check-suites"]);
    stage = "settled";
    expect(evaluateReadiness(await github.snapshot(REPO, SHA, "main"), timing).kind).toBe(result === "success" ? "pass" : "fail");
  });

  it.each([7, 8])("does not gate required success on an unrelated pending suite from app %i", async (optionalApp) => {
    const { fetch } = fixtures((url) => {
      if (url.pathname.endsWith("required_status_checks")) return response({ contexts: [], checks: [{ context: "build", app_id: 7 }] });
      if (url.pathname.endsWith("check-runs")) return response({ total_count: 2, check_runs: [rawRun(), {
        ...rawRun(2, "optional"), app: { id: optionalApp }, status: "in_progress", conclusion: null,
      }] });
      if (url.pathname.endsWith("check-suites")) return response({ total_count: 2, check_suites: [rawSuite(), {
        ...rawSuite(2), app: { id: optionalApp }, status: "in_progress", conclusion: null,
      }] });
    });
    const actual = await new CiGithub(fetch, TOKEN).snapshot(REPO, SHA, "main");
    expect(evaluateReadiness(actual, timing)).toMatchObject({ kind: "pass", pending: [], failed: [] });
    actual.required = [];
    expect(evaluateReadiness(actual, timing).kind).toBe("pending");
  });

  it.each([undefined, null])("accepts an unavailable check-suite association (%s) without inventing one", async (check_suite) => {
    const { fetch } = fixtures((url) => url.pathname.endsWith("check-runs")
      ? response({ total_count: 1, check_runs: [{ ...rawRun(), check_suite }] }) : undefined);
    expect((await new CiGithub(fetch, TOKEN).snapshot(REPO, SHA, "main")).runs[0]!.suiteId).toBeNull();
  });

  it("rejects a malformed check-suite association instead of losing it", async () => {
    const { fetch } = fixtures((url) => url.pathname.endsWith("check-runs")
      ? response({ total_count: 1, check_runs: [{ ...rawRun(), check_suite: { id: 0 } }] }) : undefined);
    await expect(new CiGithub(fetch, TOKEN).snapshot(REPO, SHA, "main")).rejects.toMatchObject({ code: "response" });
  });

  it("paginates more than 100 runs, suites, and status history without a combined-status shortcut", async () => {
    const { fetch, calls } = fixtures((url) => {
      const page = Number(url.searchParams.get("page"));
      const ids = page === 1 ? Array.from({ length: 100 }, (_, i) => i + 1) : [101];
      if (url.pathname.endsWith("check-runs")) return response({ total_count: 101, check_runs: ids.map((id) => rawRun(id, `build-${id}`)) });
      if (url.pathname.endsWith("check-suites")) return response({ total_count: 101, check_suites: ids.map(rawSuite) });
      if (url.pathname.endsWith("statuses")) return response(ids.map((id) => ({ id, context: `legacy-${id}`, state: id === 101 ? "failure" : "success" })));
    });
    const actual = await new CiGithub(fetch, TOKEN).snapshot(REPO, SHA, "main");
    expect([actual.runs.length, actual.suites.length, actual.statuses.length]).toEqual([101, 101, 101]);
    expect(evaluateReadiness(actual, timing)).toMatchObject({ kind: "fail", failed: ["legacy-101"] });
    expect(calls.every((call) => call.url.origin === "https://api.github.com")).toBe(true);
    expect(calls.some((call) => call.url.pathname.endsWith("/status"))).toBe(false);
  });

  it("accepts exactly 100 array-endpoint records followed by an empty second page without Link", async () => {
    const required = Array.from({ length: 100 }, (_, i) => ({ context: `legacy-${i + 1}`, appId: null }));
    const statuses = required.map(({ context }, i) => ({ id: i + 1, context, state: "success" }));
    const { fetch, calls } = fixtures((url) => {
      const firstPage = url.searchParams.get("page") === "1";
      if (url.pathname.includes("rules/branches")) return response(firstPage ? required.map(({ context }) => ({
        type: "required_status_checks", parameters: { required_status_checks: [{ context, integration_id: null }] },
      })) : []);
      if (url.pathname.endsWith("statuses")) return response(firstPage ? statuses : []);
    });
    const actual = await new CiGithub(fetch, TOKEN).snapshot(REPO, SHA, "main");
    expect(actual.required).toEqual(required);
    expect(actual.statuses).toEqual(statuses);
    for (const endpoint of ["rules/branches", "statuses"]) {
      const pages = calls.filter((call) => call.url.pathname.includes(endpoint));
      expect(pages.map((call) => call.url.searchParams.get("page"))).toEqual(["1", "2"]);
      expect(pages.every((call) => call.url.searchParams.get("per_page") === "100")).toBe(true);
    }
  });

  it("paginates rules and treats Link only as a continuation signal, never as a fetch URL", async () => {
    const { fetch, calls } = fixtures((url) => {
      if (url.pathname.includes("rules/branches")) {
        return Number(url.searchParams.get("page")) === 1
          ? response([{ type: "pull_request" }], 200, { Link: '<https://attacker.invalid/steal>; rel="next"' })
          : response([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "build", integration_id: 7 }] } }]);
      }
    });
    const actual = await new CiGithub(fetch, TOKEN).snapshot(REPO, SHA, "main");
    expect(actual.required).toEqual([{ context: "build", appId: 7 }]);
    expect(calls.filter((call) => call.url.pathname.includes("rules/branches"))).toHaveLength(2);
    expect(calls.every((call) => call.url.origin === "https://api.github.com")).toBe(true);
  });

  it.each([401, 403, 500])("fails closed on classic protection HTTP %i", async (status) => {
    const { fetch, calls } = fixtures((url) => url.pathname.endsWith("required_status_checks") ? response({ message: "private upstream details" }, status) : undefined);
    await expect(new CiGithub(fetch, TOKEN).snapshot(REPO, SHA, "main")).rejects.toMatchObject({ code: "http", status });
    expect(calls).toHaveLength(2);
  });
  it("does not treat a rules endpoint 404 as absence of rules", async () => {
    const { fetch, calls } = fixtures(() => response({}, 404));
    await expect(new CiGithub(fetch, TOKEN).snapshot(REPO, SHA, "main")).rejects.toMatchObject({ code: "http", status: 404 });
    expect(calls).toHaveLength(1);
  });

  it("rejects invalid repositories, abbreviated SHAs, branches, and PR numbers before fetching", async () => {
    const { fetch, calls } = fixtures();
    const github = new CiGithub(fetch, TOKEN);
    for (const repo of ["https://github.com/acme/widgets", "acme/widgets/extra", "acme/..", "acme/widgets?x=1", "../widgets", "acme/%77idgets"]) {
      await expect(github.pull(repo, 1)).rejects.toMatchObject({ code: "input" });
    }
    await expect(github.snapshot(REPO, "abcd", "main")).rejects.toMatchObject({ code: "input" });
    await expect(github.snapshot(REPO, SHA, "")).rejects.toMatchObject({ code: "input" });
    await expect(github.pull(REPO, 0)).rejects.toMatchObject({ code: "input" });
    expect(calls).toHaveLength(0);
  });

  it("rejects mismatched PR/base repository or check SHA and malformed JSON", async () => {
    const wrongPull = fixtures(() => response({ ...pullData(), number: 2 }));
    await expect(new CiGithub(wrongPull.fetch, TOKEN).pull(REPO, 1)).rejects.toMatchObject({ code: "response" });
    const wrongRepo = fixtures(() => response({ ...pullData(), base: { ref: "main", repo: { full_name: "other/widgets" } } }));
    await expect(new CiGithub(wrongRepo.fetch, TOKEN).pull(REPO, 1)).rejects.toMatchObject({ code: "response" });
    const wrongSha = fixtures((url) => url.pathname.endsWith("check-runs")
      ? response({ total_count: 1, check_runs: [{ ...rawRun(), head_sha: "b".repeat(40) }] }) : undefined);
    await expect(new CiGithub(wrongSha.fetch, TOKEN).snapshot(REPO, SHA, "main")).rejects.toMatchObject({ code: "response" });
    await expect(new CiGithub(async () => ({ status: 200, headers: {}, body: "not JSON" }), TOKEN).pull(REPO, 1)).rejects.toMatchObject({ code: "response" });
  });
});

function attemptFixtures(overrides: (url: URL, count: number) => CiHttpResponse | undefined = () => undefined) {
  const workflow = { id: 50, head_sha: SHA, check_suite_id: 1, run_attempt: 1,
    repository: { full_name: REPO }, status: "in_progress", conclusion: null };
  const job = { id: 90, run_id: 50, run_attempt: 1, head_sha: SHA, name: "build",
    status: "completed", conclusion: "success", check_run_url: `https://api.github.com/repos/${REPO}/check-runs/1` };
  const activeSuite = { ...rawSuite(), status: "in_progress", conclusion: null };
  const counts = new Map<string, number>();
  const base = fixtures((url) => {
    const count = (counts.get(url.href) ?? 0) + 1;
    counts.set(url.href, count);
    const override = overrides(url, count);
    if (override) return override;
    if (url.pathname.endsWith("required_status_checks")) return response({ contexts: [], checks: [{ context: "build", app_id: 7 }] });
    if (url.pathname.endsWith("check-runs")) return response({ total_count: 1, check_runs: [rawRun()] });
    if (url.pathname.endsWith("check-suites")) return response({ total_count: 1, check_suites: [activeSuite] });
    if (url.pathname.endsWith("/actions/runs")) return response({ total_count: 1, workflow_runs: [workflow] });
    if (url.pathname.endsWith("/actions/runs/50")) return response(workflow);
    if (url.pathname.endsWith("/attempts/1/jobs")) return response({ total_count: 2, jobs: [job, {
      ...job, id: 91, name: "optional", status: "in_progress", conclusion: null,
      check_run_url: `https://api.github.com/repos/${REPO}/check-runs/2`,
    }] });
    if (url.pathname.endsWith("/check-suites/1")) return response(activeSuite);
  });
  return { ...base, workflow, job, activeSuite };
}

describe("Actions current-attempt evidence", () => {
  it.each(["Acme/Widgets", "ACME/WIDGETS"])("accepts canonical %s job identities without fetching response URLs", async (repo) => {
    const f = attemptFixtures((url) => url.pathname.endsWith("/attempts/1/jobs")
      ? response({ total_count: 1, jobs: [{ ...f.job, check_run_url: `https://api.github.com/repos/${repo}/check-runs/1` }] }) : undefined);
    const actual = await new CiGithub(f.fetch, TOKEN).snapshot(REPO, SHA, "main");
    expect(evaluateReadiness(actual, timing).kind).toBe("pass");
    expect(f.calls.every(({ url }) => url.href.startsWith(`https://api.github.com/repos/${REPO}/`))).toBe(true);
  });

  it.each([
    "https://attacker.invalid/repos/acme/widgets/check-runs/1", "http://api.github.com/repos/acme/widgets/check-runs/1",
    "https://api.github.com@attacker.invalid/repos/acme/widgets/check-runs/1", "https://api.github.com/repos/other/widgets/check-runs/1",
    "https://api.github.com/repos/acme/other/check-runs/1", "https://api.github.com/repos/acme/widgets/check-runs/1?x=1",
    "https://api.github.com/repos/acme/widgets/check-runs/1#x", "https://api.github.com/repos/acme/widgets/check-runs/1/extra",
    "https://api.github.com/repos/acme/widgets/check-runs/01", "https://api.github.com/repos/acme/widgets/check-runs/0",
    "https://api.github.com/repos/acme/widgets/check-runs/9007199254740992", "https://api.github.com/repos/%61cme/widgets/check-runs/1",
  ])("refuses a non-exact job reference %s", async (check_run_url) => {
    const f = attemptFixtures((url) => url.pathname.endsWith("/attempts/1/jobs")
      ? response({ total_count: 1, jobs: [{ ...f.job, check_run_url }] }) : undefined);
    await expect(new CiGithub(f.fetch, TOKEN).snapshot(REPO, SHA, "main")).rejects.toBeInstanceOf(CiGithubError);
    expect(f.calls.every(({ url }) => url.origin === "https://api.github.com")).toBe(true);
  });

  it.each([403, 404])("defers unavailable attempt evidence HTTP %i without delaying a settled wait on the shared credential", async (status) => {
    for (const endpoint of ["/actions/runs", "/actions/runs/50", "/attempts/1/jobs", "/check-suites/1"]) {
      let settled = false;
      const f = attemptFixtures((url) => {
        if (settled && url.pathname.endsWith("check-suites")) return response({ total_count: 1, check_suites: [rawSuite()] });
        if (url.pathname.endsWith(endpoint)) return response({ message: "Resource not accessible by integration" }, status,
          { "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "1000" });
      });
      const cache = new CiGithubCache();
      const pending = await new CiGithub(f.fetch, TOKEN, { cache, now: () => 10_000 }).snapshot(REPO, SHA, "main");
      expect(pending.currentAttemptRunIds).toEqual([]);
      expect(evaluateReadiness(pending, timing).kind).toBe("pending");
      expect(cache.backoffUntil).toBe(0);
      settled = true;
      const next = await new CiGithub(f.fetch, TOKEN, { cache, now: () => 10_000 }).snapshot(REPO, SHA, "main");
      expect(evaluateReadiness(next, timing).kind).toBe("pass");
    }
  });

  it.each([401, 500])("propagates attempt HTTP %i without treating it as absent evidence", async (status) => {
    const f = attemptFixtures((url) => url.pathname.endsWith("/actions/runs") ? response({}, status) : undefined);
    await expect(new CiGithub(f.fetch, TOKEN).snapshot(REPO, SHA, "main")).rejects.toMatchObject({ code: "http", status });
  });

  it.each(["success", "neutral", "skipped", "failure", "cancelled", "timed_out", "action_required", "startup_failure"])(
    "uses required %s without waiting for optional jobs in the same attempt/suite", async (result) => {
      const f = attemptFixtures((url) => {
        if (url.pathname.endsWith("check-runs")) return response({ total_count: 1, check_runs: [{ ...rawRun(), conclusion: result }] });
        if (url.pathname.endsWith("/attempts/1/jobs")) return response({ total_count: 2, jobs: [{ ...f.job, conclusion: result }, {
          ...f.job, id: 91, name: "coverage", status: "in_progress", conclusion: null,
          check_run_url: `https://api.github.com/repos/${REPO}/check-runs/2`,
        }] });
      });
      const actual = await new CiGithub(f.fetch, TOKEN).snapshot(REPO, SHA, "main");
      expect(evaluateReadiness(actual, timing)).toMatchObject({ kind: ["success", "neutral", "skipped"].includes(result) ? "pass" : "fail", pending: [] });
      const actions = f.calls.filter(({ url }) => url.pathname.includes("/actions/") || url.pathname.endsWith("/check-suites/1"));
      expect(actions.map(({ url }) => url.pathname.split(`/repos/${REPO}/`)[1])).toEqual([
        "actions/runs", "actions/runs/50", "actions/runs/50/attempts/1/jobs", "check-suites/1", "actions/runs/50",
      ]);
      expect(actions[0]!.url.searchParams.get("head_sha")).toBe(SHA);
      expect(actions[0]!.url.searchParams.get("check_suite_id")).toBe("1");
      expect(actions.every(({ init }) => init?.redirect === "error")).toBe(true);
    });

  it.each(["absent", "queued", "in_progress", "unknown", "changed-attempt", "changed-suite"])(
    "keeps old required success pending for %s evidence", async (mode) => {
      const f = attemptFixtures((url, count) => {
        if (mode === "changed-attempt" && url.pathname.endsWith("/actions/runs/50") && count === 2)
          return response({ ...f.workflow, run_attempt: 2 });
        if (mode === "changed-suite" && url.pathname.endsWith("/check-suites/1"))
          return response({ ...f.activeSuite, status: "queued" });
        if (url.pathname.endsWith("/attempts/1/jobs") && !mode.startsWith("changed")) {
          const jobs = mode === "absent" ? [] : [{ ...f.job, status: mode === "unknown" ? "completed" : mode, conclusion: null }];
          return response({ total_count: jobs.length, jobs });
        }
      });
      const actual = await new CiGithub(f.fetch, TOKEN).snapshot(REPO, SHA, "main");
      expect(evaluateReadiness(actual, timing)).toMatchObject({ kind: "pending", failed: [] });
    });

  it("keeps a queued suite pending even when stale workflow/job reads still show the old in-progress attempt", async () => {
    const f = attemptFixtures((url) => {
      if (url.pathname.endsWith("check-suites")) return response({ total_count: 1, check_suites: [{ ...f.activeSuite, status: "queued" }] });
      if (url.pathname.endsWith("/check-suites/1")) return response({ ...f.activeSuite, status: "queued" });
    });
    expect(evaluateReadiness(await new CiGithub(f.fetch, TOKEN).snapshot(REPO, SHA, "main"), timing).kind).toBe("pending");
  });

  it("does not infer that an old required success was excluded from an optional-only newer attempt", async () => {
    const f = attemptFixtures((url) => {
      if (url.pathname.endsWith("/actions/runs")) return response({ total_count: 1, workflow_runs: [{ ...f.workflow, run_attempt: 2 }] });
      if (url.pathname.endsWith("/actions/runs/50")) return response({ ...f.workflow, run_attempt: 2 });
      if (url.pathname.endsWith("/attempts/2/jobs")) return response({ total_count: 1, jobs: [{ ...f.job,
        id: 91, name: "optional", run_attempt: 2, status: "in_progress", conclusion: null,
        check_run_url: `https://api.github.com/repos/${REPO}/check-runs/2`,
      }] });
    });
    expect(evaluateReadiness(await new CiGithub(f.fetch, TOKEN).snapshot(REPO, SHA, "main"), timing).kind).toBe("pending");
  });

  it.each(["wrong-sha", "wrong-repo", "wrong-suite", "missing-attempt", "ambiguous", "missing", "bad-job-attempt", "bad-job-run", "bad-job-sha", "bad-reference", "wrong-job-name", "duplicate-job", "incomplete", "inconsistent-total", "403", "404"])(
    "fails closed on %s reconciliation without credential or budget changes", async (mode) => {
      const f = attemptFixtures((url) => {
        if (url.pathname.endsWith("/actions/runs")) {
          if (mode === "missing") return response({ total_count: 0, workflow_runs: [] });
          if (mode === "ambiguous") return response({ total_count: 2, workflow_runs: [f.workflow, { ...f.workflow, id: 51 }] });
          if (mode === "403" || mode === "404") return response({ message: TOKEN }, Number(mode));
        }
        if (url.pathname.endsWith("/actions/runs/50")) {
          const changes: Record<string, object> = {
            "wrong-sha": { head_sha: "b".repeat(40) }, "wrong-repo": { repository: { full_name: "other/widgets" } },
            "wrong-suite": { check_suite_id: 2 }, "missing-attempt": { run_attempt: undefined },
          };
          if (changes[mode]) return response({ ...f.workflow, ...changes[mode] });
        }
        if (url.pathname.endsWith("/attempts/1/jobs")) {
          const changes: Record<string, object> = {
            "bad-job-attempt": { run_attempt: 2 }, "bad-job-run": { run_id: 51 }, "bad-job-sha": { head_sha: "b".repeat(40) },
            "bad-reference": { check_run_url: `https://attacker.invalid/repos/${REPO}/check-runs/1` },
            "wrong-job-name": { name: "not-build" },
          };
          if (changes[mode]) return response({ total_count: 1, jobs: [{ ...f.job, ...changes[mode] }] });
          if (mode === "duplicate-job") return response({ total_count: 2, jobs: [f.job, f.job] });
          if (mode === "incomplete") return response({ total_count: 2, jobs: [] });
          if (mode === "inconsistent-total") return response({ total_count: 0, jobs: [f.job] });
        }
      });
      const result = await new CiGithub(f.fetch, TOKEN).snapshot(REPO, SHA, "main").then((s) => evaluateReadiness(s, timing).kind, (e: unknown) => {
        expect(e).toBeInstanceOf(CiGithubError); expect(String(e)).not.toContain(TOKEN); return "pending";
      });
      expect(result).toBe("pending");
      expect(f.calls.every(({ url }) => url.origin === "https://api.github.com")).toBe(true);
    });

  it("paginates attempt jobs, counts every read, and never extends the request/page caps", async () => {
    const f = attemptFixtures((url) => {
      if (url.pathname.endsWith("/attempts/1/jobs")) {
        const jobs = url.searchParams.get("page") === "1"
          ? Array.from({ length: 100 }, (_, i) => ({ ...f.job, id: i + 100, name: `optional-${i}`, check_run_url: `https://api.github.com/repos/${REPO}/check-runs/${i + 100}` }))
          : [f.job];
        return response({ total_count: 101, jobs });
      }
    });
    expect(evaluateReadiness(await new CiGithub(f.fetch, TOKEN).snapshot(REPO, SHA, "main"), timing).kind).toBe("pass");
    expect(f.calls.filter(({ url }) => url.pathname.endsWith("/attempts/1/jobs"))).toHaveLength(2);
    await expect(new CiGithub(f.fetch, TOKEN, { maxPages: 1 }).snapshot(REPO, SHA, "main")).rejects.toMatchObject({ code: "pages" });
    await expect(new CiGithub(f.fetch, TOKEN, { maxRequests: 8 }).snapshot(REPO, SHA, "main")).rejects.toMatchObject({ code: "budget" });
  });

  it("does not use 304 as a cross-resource generation fence", async () => {
    const f = attemptFixtures((url, count) => {
      if (url.pathname.endsWith("/actions/runs/50")) return count === 1 ? response(f.workflow, 200, { ETag: '"run"' }) : { status: 304, headers: {}, body: "" };
      if (url.pathname.endsWith("/attempts/1/jobs")) return response({ total_count: 0, jobs: [] });
    });
    expect(evaluateReadiness(await new CiGithub(f.fetch, TOKEN).snapshot(REPO, SHA, "main"), timing).kind).toBe("pending");
  });

  it("never applies the extension to the all-suites fallback", async () => {
    const f = attemptFixtures((url) => url.pathname.endsWith("required_status_checks") ? response({}, 404) : undefined);
    expect(evaluateReadiness(await new CiGithub(f.fetch, TOKEN).snapshot(REPO, SHA, "main"), timing).kind).toBe("pending");
    expect(f.calls.some(({ url }) => url.pathname.includes("/actions/"))).toBe(false);
  });
});

describe("CiGithub caching, backoff, and caps", () => {
  it("refuses caller admission before counting and persists admitted attempts before HTTP", async () => {
    let ceiling = 1;
    const events: string[] = [];
    const fetch = vi.fn(async () => { events.push("http"); return response(pullData()); });
    const github: CiGithub = new CiGithub(fetch, TOKEN, {
      maxRequests: 2,
      beforeRequest: () => { if (github.requestCount >= ceiling) throw new Error("reserved"); },
      onRequestAdmitted: async () => { events.push(`save:${github.requestCount}`); },
    });
    await github.pull(REPO, 1);
    await expect(github.pull(REPO, 1)).rejects.toThrow("reserved");
    expect(github.requestCount).toBe(1);
    ceiling = 2;
    await github.pull(REPO, 1);
    await expect(github.pull(REPO, 1)).rejects.toMatchObject({ code: "budget" });
    expect(github.requestCount).toBe(2);
    expect(events).toEqual(["save:1", "http", "save:2", "http"]);
  });

  it("applies caller admission to cached conditional failures and each unconditional retry without phantom requests", async () => {
    let ceiling = 2;
    const admitted = vi.fn(async () => {});
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (fetch.mock.calls.length === 1) return response(pullData(), 200, { etag: '"v1"' });
      if ((init?.headers as Record<string, string>)["If-None-Match"]) throw new TypeError("SDK cannot wrap 304");
      return response(pullData());
    });
    const github: CiGithub = new CiGithub(fetch, TOKEN, {
      maxRequests: 4, onRequestAdmitted: admitted,
      beforeRequest: () => { if (github.requestCount >= ceiling) throw new Error("reserved"); },
    });
    await github.pull(REPO, 1);
    await expect(github.pull(REPO, 1)).rejects.toThrow("reserved");
    expect(github.requestCount).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    ceiling = 4;
    await github.pull(REPO, 1); // Conditional attempt and compatibility retry both pay.
    expect(github.requestCount).toBe(4);
    expect(admitted).toHaveBeenCalledTimes(4);
    expect(fetch).toHaveBeenCalledTimes(4);
    await expect(github.pull(REPO, 1)).rejects.toMatchObject({ code: "budget" });
    expect(admitted).toHaveBeenCalledTimes(4);
  });

  it("does not notify admission or count a request while shared backoff refuses it", async () => {
    const cache = new CiGithubCache();
    const admitted = vi.fn(async () => {});
    const fetch = vi.fn(async () => response({}, 429, { "retry-after": "60" }));
    const github = new CiGithub(fetch, TOKEN, { cache, now: () => 10_000, onRequestAdmitted: admitted });
    await expect(github.pull(REPO, 1)).rejects.toMatchObject({ code: "http" });
    await expect(github.pull(REPO, 2)).rejects.toMatchObject({ code: "backoff" });
    expect(github.requestCount).toBe(1);
    expect(admitted).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed on admission persistence failure without HTTP or a cached transport retry", async () => {
    let fail = false;
    const fetch = vi.fn(async () => response(pullData(), 200, { etag: '"v1"' }));
    const admitted = vi.fn(async () => { if (fail) throw new Error("storage unavailable"); });
    const github = new CiGithub(fetch, TOKEN, { onRequestAdmitted: admitted });
    await github.pull(REPO, 1);
    fail = true;
    await expect(github.pull(REPO, 1)).rejects.toThrow("storage unavailable");
    expect(github.requestCount).toBe(2);
    expect(admitted).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("finishes admission persistence before starting a non-retrying transport timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async () => new Promise<CiHttpResponse>(() => {}));
      let persist!: () => void;
      const github = new CiGithub(fetch, TOKEN, {
        requestTimeoutMs: 5, onRequestAdmitted: () => new Promise<void>((resolve) => { persist = resolve; }),
      });
      const result = github.pull(REPO, 1).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      expect(fetch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      persist();
      await vi.advanceTimersByTimeAsync(5);
      expect(await result).toMatchObject({ code: "timeout" });
      expect(github.requestCount).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("reuses cached pages on 304, including pagination metadata, across fresh credential clients", async () => {
    const counts = new Map<string, number>();
    const fetch: CiFetch = async (url, init) => {
      const count = counts.get(url) ?? 0;
      counts.set(url, count + 1);
      if (count) {
        expect(init?.headers).toMatchObject({ "If-None-Match": '"version-1"', Authorization: `Bearer ${TOKEN}-new` });
        return { status: 304, headers: {}, body: "" };
      }
      return response(pullData(), 200, { ETag: '"version-1"' });
    };
    const cache = new CiGithubCache();
    const first = await new CiGithub(fetch, TOKEN, { cache }).pull(REPO, 1);
    // The returned object is not the cached body, so consumers cannot corrupt it.
    first.headSha = "b".repeat(40);
    expect((await new CiGithub(fetch, `${TOKEN}-new`, { cache }).pull(REPO, 1)).headSha).toBe(SHA);
    expect([...counts.values()]).toEqual([2]);
  });

  it("retries a throwing conditional read once without ETag and requires a fresh 200", async () => {
    const headers: (HeadersInit | undefined)[] = [];
    const fetch: CiFetch = async (_url, init) => {
      headers.push(init?.headers);
      if (headers.length === 1) return response(pullData(), 200, { ETag: '\"old\"' });
      if (headers.length === 2) throw new TypeError("Response constructor rejected status 304");
      return response({ ...pullData(), head: { ...pullData().head, sha: "b".repeat(40) } });
    };
    const github = new CiGithub(fetch, TOKEN, { maxRequests: 3 });
    await github.pull(REPO, 1);
    expect((await github.pull(REPO, 1)).headSha).toBe("b".repeat(40));
    expect(headers[1]).toHaveProperty("If-None-Match", '\"old\"');
    expect(headers[2]).not.toHaveProperty("If-None-Match");
    await expect(github.pull(REPO, 1)).rejects.toMatchObject({ code: "budget" });
    expect(headers).toHaveLength(3);
  });

  it.each(["throw", "304", "500"])("fails closed when unconditional compatibility retry returns %s", async (retry) => {
    let calls = 0;
    const fetch: CiFetch = async () => {
      calls++;
      if (calls === 1) return response(pullData(), 200, { etag: '\"old\"' });
      if (calls === 2 || retry === "throw") throw new Error(`${TOKEN} private upstream failure`);
      return response({}, Number(retry));
    };
    const github = new CiGithub(fetch, TOKEN);
    await github.pull(REPO, 1);
    const error = await github.pull(REPO, 1).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CiGithubError);
    expect(error).toMatchObject({ code: retry === "throw" ? "network" : retry === "304" ? "response" : "http" });
    expect(String(error)).not.toContain(TOKEN);
    expect(calls).toBe(3);
  });

  it("does not let compatibility retries escape the lifetime request budget", async () => {
    let calls = 0;
    const fetch: CiFetch = async () => {
      calls++;
      if (calls === 1) return response(pullData(), 200, { etag: '\"old\"' });
      throw new Error("SDK response reconstruction failed");
    };
    const github = new CiGithub(fetch, TOKEN, { maxRequests: 2 });
    await github.pull(REPO, 1);
    await expect(github.pull(REPO, 1)).rejects.toMatchObject({ code: "budget" });
    expect(calls).toBe(2);
  });

  it("times out a host fetch without retrying an uncancellable conditional request", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetch: CiFetch = async () => {
        calls++;
        if (calls === 1) return response(pullData(), 200, { etag: '\"old\"' });
        return new Promise<CiHttpResponse>(() => {});
      };
      const github = new CiGithub(fetch, TOKEN, { requestTimeoutMs: 5 });
      await github.pull(REPO, 1);
      const result = github.pull(REPO, 1).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5);
      expect(await result).toMatchObject({ code: "timeout", message: "GitHub CI timeout" });
      expect(calls).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("times out Response.text independently of fetch and bounds timeout configuration", async () => {
    vi.useFakeTimers();
    try {
      const hangingBody = new Response("", { status: 200 });
      Object.defineProperty(hangingBody, "text", { value: () => new Promise<string>(() => {}) });
      const github = new CiGithub(async () => hangingBody, TOKEN, { requestTimeoutMs: 5 });
      const result = github.pull(REPO, 1).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5);
      expect(await result).toMatchObject({ code: "timeout" });
      expect(vi.getTimerCount()).toBe(0);
      expect(() => new CiGithub(async () => hangingBody, TOKEN, { requestTimeoutMs: 30_001 })).toThrow(CiGithubError);
      expect(() => new CiGithub(async () => hangingBody, TOKEN, { requestTimeoutMs: 0 })).toThrow(CiGithubError);
    } finally { vi.useRealTimers(); }
  });

  it("supports a real bodyless Response 304 and charges it against the request budget", async () => {
    let calls = 0;
    const fetch = async () => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify(pullData()), { status: 200, headers: { ETag: '\"v1\"' } })
        : new Response(null, { status: 304 });
    };
    const admitted = vi.fn(async () => {});
    const github = new CiGithub(fetch, TOKEN, { maxRequests: 2, onRequestAdmitted: admitted });
    await github.pull(REPO, 1);
    expect((await github.pull(REPO, 1)).headSha).toBe(SHA);
    await expect(github.pull(REPO, 1)).rejects.toMatchObject({ code: "budget" });
    expect(github.requestCount).toBe(2);
    expect(admitted).toHaveBeenCalledTimes(2);
    expect(calls).toBe(2);
  });

  it("preserves next-page metadata when a rules page returns 304", async () => {
    const calls = new Map<string, number>();
    const base = fixtures((url) => {
      if (url.pathname.includes("rules/branches") && url.searchParams.get("page") === "1")
        return response([{ type: "pull_request" }], 200, { ETag: '"rules"', Link: '<https://api.github.com/unused>; rel="next"' });
    });
    const fetch: CiFetch = async (url, init) => {
      const n = calls.get(url) ?? 0;
      calls.set(url, n + 1);
      if (n && url.includes("rules/branches") && url.endsWith("page=1")) return { status: 304, headers: {}, body: "" };
      return base.fetch(url, init);
    };
    const github = new CiGithub(fetch, TOKEN);
    await github.snapshot(REPO, SHA, "main");
    await github.snapshot(REPO, SHA, "main");
    expect([...calls].filter(([url]) => url.includes("rules/branches") && url.endsWith("page=2"))[0]![1]).toBe(2);
  });

  it("bounds cache entries and bytes and rejects 304 without a cached page", async () => {
    const headers: (HeadersInit | undefined)[] = [];
    const fetch: CiFetch = async (url, init) => {
      headers.push(init?.headers);
      return response(pullData(Number(url.split("/").at(-1))), 200, { etag: '"v"' });
    };
    const github = new CiGithub(fetch, TOKEN, { maxCacheEntries: 1 });
    await github.pull(REPO, 1); await github.pull(REPO, 2); await github.pull(REPO, 1);
    expect(headers[2]).not.toHaveProperty("If-None-Match");
    const tiny = new CiGithub(fetch, TOKEN, { maxCacheBytes: 1 });
    await tiny.pull(REPO, 1); await tiny.pull(REPO, 1);
    expect(headers.at(-1)).not.toHaveProperty("If-None-Match");
    await expect(new CiGithub(async () => ({ status: 304, headers: {}, body: "" }), TOKEN).pull(REPO, 1)).rejects.toMatchObject({ code: "response" });
  });

  const rateCases: Record<string, string>[] = [
    { "Retry-After": "5" },
    { "Retry-After": new Date(15_000).toUTCString() },
    { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "15" },
  ];
  it.each(rateCases)("caches rate-limit backoff across operations: %j", async (rateHeaders) => {
    let now = 10_000;
    let calls = 0;
    const fetch: CiFetch = async () => {
      calls++;
      return calls === 1 ? response({ message: TOKEN }, 429, rateHeaders) : response(pullData());
    };
    const cache = new CiGithubCache();
    await expect(new CiGithub(fetch, TOKEN, { cache, now: () => now }).pull(REPO, 1)).rejects.toMatchObject({ code: "http", status: 429, retryAt: 15_000 });
    await expect(new CiGithub(fetch, TOKEN, { cache, now: () => now }).pull(REPO, 1)).rejects.toMatchObject({ code: "backoff", retryAt: 15_000 });
    expect(calls).toBe(1);
    now = 15_000;
    expect((await new CiGithub(fetch, TOKEN, { cache, now: () => now }).pull(REPO, 1)).headSha).toBe(SHA);
  });

  it.each([
    [429, {}, 70_000], [403, { "retry-after": "5" }, 15_000],
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "15" }, 15_000],
    [403, { "x-ratelimit-remaining": "0" }, 70_000],
  ] as const)("retains shared throttle backoff for HTTP %i with %j", async (status, headers, retryAt) => {
    const cache = new CiGithubCache();
    const fetch = vi.fn(async () => response({}, status, { ...headers }));
    await expect(new CiGithub(fetch, TOKEN, { cache, now: () => 10_000 }).pull(REPO, 1)).rejects.toMatchObject({ code: "http", status, retryAt });
    await expect(new CiGithub(fetch, TOKEN, { cache, now: () => 10_000 }).pull(REPO, 1)).rejects.toMatchObject({ code: "backoff", retryAt });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("backs off secondary and unclassified 403s without primary exhaustion (Response=%s)", async (native) => {
    for (const body of [
      JSON.stringify({ message: "You have exceeded a secondary rate limit." }),
      JSON.stringify({ message: "Unknown denial" }), "not JSON", "", "null",
      JSON.stringify({ message: TOKEN }),
      JSON.stringify({ message: "Resource not accessible by integration", padding: "x".repeat(2000) }),
    ]) {
      let now = 10_000;
      const cache = new CiGithubCache();
      const headers = { "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "1000" };
      const fetch = vi.fn(async () => native ? new Response(body, { status: 403, headers }) : { status: 403, headers, body });
      const options = { cache, now: () => now, maxBodyBytes: 1024 };
      await expect(new CiGithub(fetch, TOKEN, options).pull(REPO, 1)).rejects.toMatchObject({ code: "http", status: 403, retryAt: 70_000 });
      now = 69_999;
      await expect(new CiGithub(fetch, TOKEN, options).pull(REPO, 2)).rejects.toMatchObject({ code: "backoff", retryAt: 70_000 });
      expect(fetch).toHaveBeenCalledTimes(1);
      now = 70_000;
      expect((await new CiGithub(fixtures().fetch, TOKEN, options).pull(REPO, 2)).number).toBe(2);
    }
  });

  it.each([false, true])("exempts only known permission messages, without suppressing throttle headers (Response=%s)", async (native) => {
    for (const message of ["Resource not accessible by integration", "Resource not accessible by personal access token"]) {
      for (const rateHeaders of [{}, { "retry-after": "5" }, { "x-ratelimit-remaining": "0" }]) {
        const headers = { ...rateHeaders } as Record<string, string>;
        const cache = new CiGithubCache();
        const body = JSON.stringify({ message });
        const fetch: CiFetch = async () => native ? new Response(body, { status: 403, headers }) : { status: 403, headers, body };
        await expect(new CiGithub(fetch, TOKEN, { cache, now: () => 10_000 }).pull(REPO, 1)).rejects.toMatchObject({ code: "http", status: 403 });
        expect(cache.backoffUntil).toBe(headers["retry-after"] ? 15_000 : headers["x-ratelimit-remaining"] ? 70_000 : 0);
      }
    }
  });

  it.each([
    ["permission", "Resource not accessible by integration", {}, "permission repo_pulls"],
    ["unclassified", "You have exceeded a secondary rate limit.", {}, "unclassified repo_pulls"],
    ["permission", "Resource not accessible by personal access token", { "x-accepted-github-permissions": "issues=read,metadata=read" }, "permission repo_pulls needs=issues=read,metadata=read"],
    // A malformed accepted-permissions value is dropped, never echoed into the message.
    ["permission", "Resource not accessible by integration", { "x-accepted-github-permissions": "../../etc/passwd" }, "permission repo_pulls"],
    ["permission", "Resource not accessible by integration", { "x-accepted-github-permissions": "issues=read,metadata=read; secondary rate limit applies" }, "permission repo_pulls needs=issues=read,metadata=read"],
    ["unclassified", "You have exceeded a secondary rate limit.", { "x-ratelimit-remaining": "0", "retry-after": "60" }, "unclassified repo_pulls rl-remaining=0 retry-after=60"],
    ["permission", "Resource not accessible by integration", { "x-ratelimit-remaining": "4999" }, "permission repo_pulls rl-remaining=4999"],
    ["permission", "Resource not accessible by integration", { "x-accepted-github-permissions": "issues=read", "x-ratelimit-remaining": "0" }, "permission repo_pulls needs=issues=read rl-remaining=0"],
    // Malformed rate-limit values are dropped, never echoed into the message.
    ["permission", "Resource not accessible by integration", { "x-ratelimit-remaining": "../../etc/passwd", "retry-after": "../../etc/passwd" }, "permission repo_pulls"],
  ] as const)("names the refused endpoint template and permission kind for 403 (%s)", async (_kind, message, headers, detail) => {
    const cache = new CiGithubCache();
    const fetch = vi.fn(async () => response({ message }, 403, headers));
    const error = await new CiGithub(fetch, TOKEN, { cache, now: () => 10_000 }).pull(REPO, 1).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CiGithubError);
    expect((error as CiGithubError).code).toBe("http");
    expect((error as CiGithubError).status).toBe(403);
    expect((error as CiGithubError).detail).toBe(detail);
    expect((error as CiGithubError).message).toBe(`GitHub CI http (403) ${detail}`);
    expect((error as CiGithubError).message).not.toContain(TOKEN);
    expect((error as CiGithubError).message).not.toContain(REPO);
  });

  // An App-mode token source that always mints through the client's own
  // exchange callback, so the inner access_tokens request carries the fetch's
  // response. The caller supplies the fetch (403 message, headers, native
  // Response variant); the JWT is a fixture, never emitted.
  function failingExchangeSource(): CiTokenSource {
    return {
      token: async (_path: string, exchange: CiTokenExchange) => {
        await exchange("1234567890", "jwt-fixture", { repositories: ["widgets"], permissions: {} });
        return "should-not-be-reached";
      },
      invalidate: () => {},
    };
  }

  it.each([
    ["This installation has been suspended", "unclassified token_exchange exchange_class=suspended exchange_msg=This_installation_has_been_suspended"],
    ["This enterprise has a policy that blocks this installation", "unclassified token_exchange exchange_class=enterprise_policy exchange_msg=This_enterprise_has_a_policy_that_blocks_this_installation"],
    ["Your IP address is not in the allow list for this installation", "unclassified token_exchange exchange_class=ip_policy exchange_msg=Your_IP_address_is_not_in_the_allow_list_for_this_installation"],
    ["This installation requires SAML SSO authentication", "unclassified token_exchange exchange_class=sso_policy exchange_msg=This_installation_requires_SAML_SSO_authentication"],
    ["Resource not accessible by integration", "permission token_exchange exchange_class=permission exchange_msg=Resource_not_accessible_by_integration"],
    ["You have exceeded a rate limit", "unclassified token_exchange exchange_class=rate_limit exchange_msg=You_have_exceeded_a_rate_limit"],
    ["Bad credentials", "unclassified token_exchange exchange_class=bad_credentials exchange_msg=Bad_credentials"],
    ["Some other refusal", "unclassified token_exchange exchange_class=unknown exchange_msg=Some_other_refusal"],
  ] as const)("classifies the token-exchange 403 message (%s)", async (message, detail) => {
    const fetch: CiFetch = async () => response({ message }, 403);
    const error = await new CiGithub(fetch, failingExchangeSource(), { now: () => 10_000 }).pull(REPO, 1).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CiGithubError);
    expect((error as CiGithubError).status).toBe(403);
    expect((error as CiGithubError).detail).toBe(detail);
    expect((error as CiGithubError).message).not.toContain(TOKEN);
    expect((error as CiGithubError).message).not.toContain("jwt-fixture");
  });

  it("reads the token-exchange 403 message from a native Response body once", async () => {
    const fetch: CiFetch = async () => new Response(JSON.stringify({ message: "This installation has been suspended" }), { status: 403 });
    const error = await new CiGithub(fetch, failingExchangeSource(), { now: () => 10_000 }).pull(REPO, 1).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CiGithubError);
    expect((error as CiGithubError).detail).toBe("unclassified token_exchange exchange_class=suspended exchange_msg=This_installation_has_been_suspended");
  });

  it("drops a credential-shaped token-exchange message and keeps rate-limit evidence", async () => {
    const fetch: CiFetch = async () => response({ message: TOKEN }, 403, { "x-ratelimit-remaining": "4999" });
    const error = await new CiGithub(fetch, failingExchangeSource(), { now: () => 10_000 }).pull(REPO, 1).catch((value: unknown) => value);
    expect((error as CiGithubError).detail).toBe("unclassified token_exchange rl-remaining=4999");
    expect((error as CiGithubError).message).not.toContain(TOKEN);
    expect((error as CiGithubError).message).not.toContain("exchange_msg");
  });

  it("collapses control characters and truncates the token-exchange message to one bounded token", async () => {
    const message = "This installation has been\n\tsuspended " + "x".repeat(300);
    const fetch: CiFetch = async () => response({ message }, 403);
    const error = await new CiGithub(fetch, failingExchangeSource(), { now: () => 10_000 }).pull(REPO, 1).catch((value: unknown) => value);
    const detail = (error as CiGithubError).detail!;
    expect(detail).toContain("exchange_class=suspended");
    expect(detail).not.toContain("\n");
    expect(detail).not.toContain("\t");
    expect(detail).not.toContain("\r");
    expect(detail.length).toBeLessThanOrEqual("unclassified token_exchange exchange_class=suspended exchange_msg=".length + 160);
  });

  it("classifies a token-exchange refusal keyword past the display truncation point", async () => {
    const message = "A".repeat(170) + " suspended";
    const fetch: CiFetch = async () => response({ message }, 403);
    const error = await new CiGithub(fetch, failingExchangeSource(), { now: () => 10_000 }).pull(REPO, 1).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CiGithubError);
    expect((error as CiGithubError).detail).toBe(`unclassified token_exchange exchange_class=suspended exchange_msg=${"A".repeat(160)}`);
  });

  it("prefers the specific ip_policy over generic enterprise_policy on an overlap message", async () => {
    const message = "This enterprise has a policy that blocks this installation because its IP address is not in the allow list";
    const fetch: CiFetch = async () => response({ message }, 403);
    const error = await new CiGithub(fetch, failingExchangeSource(), { now: () => 10_000 }).pull(REPO, 1).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CiGithubError);
    expect((error as CiGithubError).detail).toBe("unclassified token_exchange exchange_class=ip_policy exchange_msg=This_enterprise_has_a_policy_that_blocks_this_installation_because_its_IP_address_is_not_in_the_allow_list");
  });

  it("never emits an enterprise-policy message from a non-exchange endpoint", async () => {
    const fetch = vi.fn(async () => response({ message: "This enterprise has a policy that blocks this installation" }, 403));
    const error = await new CiGithub(fetch, TOKEN, { now: () => 10_000 }).pull(REPO, 1).catch((value: unknown) => value);
    expect((error as CiGithubError).detail).toBe("unclassified repo_pulls");
    expect((error as CiGithubError).message).not.toContain("exchange_class");
    expect((error as CiGithubError).message).not.toContain("enterprise");
  });

  it("names throttled endpoints for 429 and leaves other statuses bare", async () => {
    const fetch429 = vi.fn(async () => response({ message: "rate limited" }, 429));
    const error429 = await new CiGithub(fetch429, TOKEN, { now: () => 10_000 }).pull(REPO, 1).catch((value: unknown) => value);
    expect((error429 as CiGithubError).message).toBe("GitHub CI http (429) throttle repo_pulls");
    const fetch429Limit = vi.fn(async () => response({ message: "rate limited" }, 429, { "x-ratelimit-remaining": "0", "retry-after": "120" }));
    const error429Limit = await new CiGithub(fetch429Limit, TOKEN, { now: () => 10_000 }).pull(REPO, 1).catch((value: unknown) => value);
    expect((error429Limit as CiGithubError).detail).toBe("throttle repo_pulls rl-remaining=0 retry-after=120");
    // An HTTP-date retry-after is normalized to epoch seconds, never echoed raw.
    const fetch429Date = vi.fn(async () => response({ message: "rate limited" }, 429, { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }));
    const error429Date = await new CiGithub(fetch429Date, TOKEN, { now: () => 10_000 }).pull(REPO, 1).catch((value: unknown) => value);
    expect((error429Date as CiGithubError).detail).toBe("throttle repo_pulls retry-after=1445412480");
    const fetch500 = vi.fn(async () => response({ message: "server error" }, 500));
    const error500 = await new CiGithub(fetch500, TOKEN, { now: () => 10_000 }).pull(REPO, 1).catch((value: unknown) => value);
    expect((error500 as CiGithubError).detail).toBeUndefined();
    expect((error500 as CiGithubError).message).toBe("GitHub CI http (500)");
  });

  it("names the branch-rules endpoint when the rules read is refused", async () => {
    const fetch = vi.fn(async (input: string | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname.includes("/rules/branches/")) return response({ message: "Resource not accessible by integration" }, 403);
      return undefined as unknown as CiHttpResponse;
    });
    const error = await new CiGithub(fetch as CiFetch, TOKEN, { now: () => 10_000 }).snapshot(REPO, SHA, "main").catch((value: unknown) => value);
    expect((error as CiGithubError).detail).toBe("permission repo_rules");
  });

  it("backs off when a 403 body cannot be read within the existing deadline", async () => {
    const cache = new CiGithubCache();
    const denied = new Response("", { status: 403 });
    denied.text = () => new Promise<string>(() => {});
    const fetch = vi.fn(async () => denied);
    const options = { cache, now: () => 10_000, requestTimeoutMs: 1 };
    await expect(new CiGithub(fetch, TOKEN, options).pull(REPO, 1)).rejects.toMatchObject({ code: "http", status: 403, retryAt: 70_000 });
    await expect(new CiGithub(fetch, TOKEN, options).pull(REPO, 2)).rejects.toMatchObject({ code: "backoff", retryAt: 70_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("honors exhausted quota on successful responses and Retry-After on 503", async () => {
    for (const status of [200, 503]) {
      let calls = 0;
      const fetch: CiFetch = async () => { calls++; return response(pullData(), status, { "retry-after": "10", "x-ratelimit-remaining": "0" }); };
      const github = new CiGithub(fetch, TOKEN, { now: () => 1_000 });
      if (status === 200) await github.pull(REPO, 1);
      else await expect(github.pull(REPO, 1)).rejects.toMatchObject({ status: 503 });
      await expect(github.pull(REPO, 1)).rejects.toMatchObject({ code: "backoff", retryAt: 11_000 });
      expect(calls).toBe(1);
    }
  });

  it("never resets the lifetime request budget, including failed requests", async () => {
    let calls = 0;
    const github = new CiGithub(async () => { calls++; throw new Error(`upstream ${TOKEN}`); }, TOKEN, { maxRequests: 1 });
    await expect(github.pull(REPO, 1)).rejects.toMatchObject({ code: "network", message: "GitHub CI network" });
    await expect(github.pull(REPO, 1)).rejects.toMatchObject({ code: "budget" });
    expect(calls).toBe(1);
  });

  it("throws page/request caps and incomplete totals instead of returning a partial snapshot", async () => {
    const many = fixtures((url) => url.pathname.endsWith("check-runs")
      ? response({ total_count: 101, check_runs: Array.from({ length: 100 }, (_, i) => rawRun(i + 1)) }) : undefined);
    await expect(new CiGithub(many.fetch, TOKEN, { maxPages: 1 }).snapshot(REPO, SHA, "main")).rejects.toMatchObject({ code: "pages" });
    const { fetch } = fixtures();
    await expect(new CiGithub(fetch, TOKEN, { maxRequests: 3 }).snapshot(REPO, SHA, "main")).rejects.toMatchObject({ code: "budget" });
    const incomplete = fixtures((url) => url.pathname.endsWith("check-runs") ? response({ total_count: 101, check_runs: [] }) : undefined);
    await expect(new CiGithub(incomplete.fetch, TOKEN).snapshot(REPO, SHA, "main")).rejects.toMatchObject({ code: "response" });
    await expect(new CiGithub(async () => response(pullData()), TOKEN, { maxBodyBytes: 1 }).pull(REPO, 1)).rejects.toMatchObject({ code: "response" });
  });

  it.each(["ghp_sample_credential_not_in_use", "-----BEGIN PRIVATE KEY-----", "eyJhbGciOiJub25lIn0.eyJzdWIiOiJleGFtcGxlIn0.abcdefghijklmnop"])("ignores unused token-like PR/CI text without retaining it in the ETag cache (%s)", async (sample) => {
    const cache = new CiGithubCache();
    let conditional = false;
    const fetch: CiFetch = async () => conditional ? { status: 304, headers: {}, body: "" }
      : response({ ...pullData(), body: `Example: ${sample}`, [sample]: "unused" }, 200, { etag: '"safe"' });
    expect((await new CiGithub(fetch, TOKEN, { cache }).pull(REPO, 1)).headSha).toBe(SHA);
    const cached = cache.get(`https://api.github.com/repos/${REPO}/pulls/1`)!;
    expect(cached.body).not.toContain(sample);
    conditional = true;
    expect((await new CiGithub(fetch, `${TOKEN}-renewed`, { cache }).pull(REPO, 1)).headSha).toBe(SHA);
    const f = fixtures((url) => {
      if (url.pathname.endsWith("check-runs")) return response({ total_count: 1, check_runs: [{ ...rawRun(), output: { summary: sample, text: sample } }] });
      if (url.pathname.endsWith("statuses")) return response([{ id: 1, context: "build", state: "success", description: sample }]);
    });
    const observed = await new CiGithub(f.fetch, TOKEN).snapshot(REPO, SHA, "main");
    expect(evaluateReadiness(observed, timing).kind).toBe("pass");
  });

  it.each(["author", "check", "rule", "etag", "link"])("still refuses token-like values in consumed %s fields", async (field) => {
    const sample = "ghs_previous_credential_not_in_use";
    const f = fixtures((url) => {
      if (field === "author" && url.pathname.includes("/pulls/")) return response({ ...pullData(), user: { login: sample } });
      if (field === "check" && url.pathname.endsWith("check-runs")) return response({ total_count: 1, check_runs: [rawRun(1, sample)] });
      if (field === "rule" && url.pathname.includes("/rules/branches/")) return response([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: sample }] } }]);
      if (field === "etag" || field === "link") return response(pullData(), 200, { [field]: sample });
    });
    const github = new CiGithub(f.fetch, TOKEN);
    await expect(field === "check" || field === "rule" ? github.snapshot(REPO, SHA, "main") : github.pull(REPO, 1)).rejects.toMatchObject({ code: "response" });
  });

  it("does not expose upstream error bodies, network errors, or reflected credentials", async () => {
    for (const status of [401, 403, 404, 422, 500]) {
      const github = new CiGithub(async () => response({ message: `${TOKEN} private failure` }, status), TOKEN);
      const error = await github.pull(REPO, 1).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(CiGithubError);
      expect(String(error)).not.toContain(TOKEN);
      expect(String(error)).not.toContain("private failure");
    }
    for (const body of [JSON.stringify({ ...pullData(), body: TOKEN }), JSON.stringify(pullData()).replace("builder", TOKEN.split("").map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""))]) {
      await expect(new CiGithub(async () => ({ status: 200, headers: {}, body }), TOKEN).pull(REPO, 1)).rejects.toMatchObject({ code: "response" });
    }
    const { fetch } = fixtures((url) => url.pathname.endsWith("check-runs") ? response({ total_count: 1, check_runs: [rawRun(1, `build ${TOKEN}`)] }) : undefined);
    await expect(new CiGithub(fetch, TOKEN).snapshot(REPO, SHA, "main")).rejects.toMatchObject({ code: "response" });
  });

  it.each(["bad\nname", "bad\u001bname", "x".repeat(1025)])("rejects unsafe upstream context names", async (name) => {
    const { fetch } = fixtures((url) => url.pathname.endsWith("check-runs") ? response({ total_count: 1, check_runs: [rawRun(1, name)] }) : undefined);
    await expect(new CiGithub(fetch, TOKEN).snapshot(REPO, SHA, "main")).rejects.toMatchObject({ code: "response" });
  });
});
