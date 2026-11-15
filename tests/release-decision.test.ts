import { describe, expect, it } from "vitest";
import { extractReleaseDecision } from "../src/release-decision.js";

const rm = "c4bd17fa-72df-43b4-83cd-df59ec7de5d0";
const id = "c4bd17fa-72df-43b4-83cd-df59ec7de5d1";
const target = {
  version: 1, repo: "togetherweown/two-web-next", sha: "a".repeat(40),
  stagingRunId: "123", stagingRunAttempt: 2, expiresAt: "2026-11-15T03:00:00Z",
};
const now = Date.parse("2026-11-15T02:30:00Z");
function interaction(details: unknown = target) {
  return {
    id, kind: "request_confirmation", title: "Accept exact production release?",
    addresseeAgentId: rm, addresseeUserId: null, resolvedByAgentId: rm,
    resolvedByUserId: null, resolvedByRunId: id, status: "accepted",
    resolvedAt: "2026-11-15T02:20:00.000Z", result: { version: 1, outcome: "accepted" },
    payload: { version: 1, prompt: "Accept exact production release?", detailsMarkdown: JSON.stringify(details), allowDeclineReason: true, supersedeOnUserComment: false },
  };
}

describe("exact release confirmation extraction", () => {
  it("binds the accepted confirmation to the complete target shown to the RM", () => {
    expect(extractReleaseDecision(interaction(), rm, now)).toEqual({ confirmationId: id, target, state: "accepted" });
  });
  it("accepts only a host-normalized boolean supersession setting", () => {
    for (const supersedeOnUserComment of [false, true]) {
      const value = { ...interaction(), payload: { ...interaction().payload, supersedeOnUserComment } };
      expect(extractReleaseDecision(value, rm, now)?.state).toBe("accepted");
    }
    for (const supersedeOnUserComment of [undefined, null, 0, "false", {}, []]) {
      const value = { ...interaction(), payload: { ...interaction().payload, supersedeOnUserComment } };
      expect(extractReleaseDecision(value, rm, now)).toBeNull();
    }
  });
  it("fails closed for wrong resolver, addressee, outcome or enriched confirmation", () => {
    for (const value of [
      { ...interaction(), resolvedByAgentId: id }, { ...interaction(), addresseeAgentId: id },
      { ...interaction(), status: "rejected" }, { ...interaction(), result: { outcome: "superseded_by_comment" } },
      { ...interaction(), payload: { ...interaction().payload, target: {} } },
      { ...interaction(), payload: { ...interaction().payload, acceptLabel: "Approve another target" } },
      { ...interaction(), payload: { ...interaction().payload, unknown: true } },
      { ...interaction(), result: { version: 1, outcome: "accepted", toolAction: {} } },
      { ...interaction(), resolvedByAgentId: null, resolvedByRunId: null }, // host system sweep
      { ...interaction(), resolvedByAgentId: null, resolvedByUserId: "board-user", resolvedByRunId: null },
      { ...interaction(), resolvedByUserId: "board-user" },
      { ...interaction(), addresseeUserId: "board-user" },
      { ...interaction(), resolvedByRunId: null },
      { ...interaction(), result: { outcome: "accepted" } },
    ]) expect(extractReleaseDecision(value, rm, now)).toBeNull();
  });
  it("rejects ambiguous, noncanonical or incomplete target data", () => {
    for (const value of [
      { ...target, repo: "TogetherWeOwn/two-web-next" }, { ...target, sha: "a".repeat(39) },
      { ...target, stagingRunId: "01" }, { ...target, stagingRunAttempt: 0 },
      { ...target, expiresAt: "2026-11-16T03:00:00Z" }, { ...target, extra: true },
    ]) expect(extractReleaseDecision(interaction(value), rm, now)).toBeNull();
    const value = interaction();
    value.payload.detailsMarkdown = `{"version":1,${value.payload.detailsMarkdown.slice(1)}`;
    expect(extractReleaseDecision(value, rm, now)).toBeNull();
  });
  it("expires at the exact boundary and rejects malformed or future resolution time", () => {
    expect(extractReleaseDecision(interaction(), rm, Date.parse(target.expiresAt))?.state).toBe("expired");
    const marchTarget = { ...target, expiresAt: "2026-03-02T03:00:00Z" };
    const marchNow = Date.parse("2026-03-02T02:30:00Z");
    for (const resolvedAt of ["2026-02-30T02:20:00Z", "2026-02-30T02:20:00.000Z", "2026-03-02T02:20:00+00:00"]) {
      expect(extractReleaseDecision({ ...interaction(marchTarget), resolvedAt }, rm, marchNow)).toBeNull();
    }
    for (const resolvedAt of ["2026-03-02T02:20:00Z", "2026-03-02T02:20:00.123Z"]) {
      expect(extractReleaseDecision({ ...interaction(marchTarget), resolvedAt }, rm, marchNow)?.state).toBe("accepted");
    }
    expect(extractReleaseDecision({ ...interaction(), resolvedAt: "bad" }, rm, now)).toBeNull();
    expect(extractReleaseDecision({ ...interaction(), resolvedAt: "2026-11-15T02:40:00Z" }, rm, now)).toBeNull();
  });
});
