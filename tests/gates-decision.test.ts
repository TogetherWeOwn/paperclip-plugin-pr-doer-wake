import { describe, expect, it } from "vitest";
import { extractGatesDecision, gatesDescription } from "../src/gates-decision.js";

const RM = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const REPO = "acme/widget";
const PR = 17;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function interaction(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    kind: "request_confirmation",
    status: "accepted",
    resolvedByAgentId: RM,
    title: `Merge ${REPO}#${PR} at exact head ${SHA_A}`,
    payload: {
      version: 1,
      prompt: `Merge ${REPO}#${PR}?`,
      detailsMarkdown: `Head SHA ${SHA_A}.`,
    },
    result: { outcome: "accepted", reason: `approved at exact head ${SHA_A}` },
    ...overrides,
  };
}

describe("gates decision extraction", () => {
  it("publishes success for an RM-accepted merge confirmation citing one PR and one SHA", () => {
    expect(extractGatesDecision(interaction(), RM)).toEqual({
      decision: { repo: REPO, prNumber: PR, sha: SHA_A, state: "success", interactionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
  });

  it("publishes failure for rejected and expired RM decisions", () => {
    for (const status of ["rejected", "expired", "cancelled", "failed"]) {
      expect(extractGatesDecision(interaction({ status, result: { outcome: status } }), RM)).toMatchObject({ decision: { state: "failure" } });
    }
  });

  it("publishes pending for superseded cards, overriding a terminal status", () => {
    const superseded = extractGatesDecision(
      interaction({ status: "cancelled", result: { outcome: "superseded_by_newer_request" } }), RM,
    );
    expect(superseded).toMatchObject({ decision: { state: "pending", sha: SHA_A } });
  });

  it("publishes nothing when the payload states no SHA", () => {
    const extraction = extractGatesDecision(interaction({
      title: `Merge ${REPO}#${PR}`, payload: { prompt: "Merge it?", detailsMarkdown: null }, result: { outcome: "accepted" },
    }), RM);
    expect(extraction).toEqual({ reason: "no_sha" });
  });

  it("publishes nothing when the payload is ambiguous about the SHA or the PR", () => {
    expect(extractGatesDecision(interaction({ payload: { prompt: "Merge?", detailsMarkdown: `heads ${SHA_A} and ${SHA_B}` } }), RM))
      .toEqual({ reason: "ambiguous_sha" });
    expect(extractGatesDecision(interaction({ title: `Merge ${REPO}#${PR} and acme/other#9`, result: { outcome: "accepted" } }), RM))
      .toEqual({ reason: "ambiguous_pr" });
  });

  it("publishes nothing for a wrong resolver, even if everything else matches", () => {
    expect(extractGatesDecision(interaction({ resolvedByAgentId: OTHER }), RM)).toEqual({ reason: "wrong_resolver" });
    expect(extractGatesDecision(interaction({ resolvedByAgentId: null }), RM)).toEqual({ reason: "wrong_resolver" });
    expect(extractGatesDecision(interaction({ resolvedByAgentId: RM }), OTHER)).toEqual({ reason: "wrong_resolver" });
  });

  it("publishes nothing for non-merge confirmations, other kinds or a still-pending card", () => {
    expect(extractGatesDecision(interaction({ title: "Deploy", payload: { prompt: "Deploy?", detailsMarkdown: SHA_A } }), RM))
      .toEqual({ reason: "not_a_merge_confirmation" });
    expect(extractGatesDecision(interaction({ kind: "ask_user_questions" }), RM)).toEqual({ reason: "not_a_confirmation" });
    expect(extractGatesDecision(interaction({ status: "pending", resolvedByAgentId: null, result: null }), RM))
      .toEqual({ reason: "wrong_resolver" });
    expect(extractGatesDecision(null, RM)).toEqual({ reason: "not_an_interaction" });
  });

  it("never greens a new push: only the cited SHA is returned, never its successor", () => {
    // The accepted card cites the old head; a later push to SHA_B has no
    // decision of its own, so no success is ever published for it.
    const extraction = extractGatesDecision(interaction(), RM);
    expect(extraction).toMatchObject({ decision: { sha: SHA_A, state: "success" } });
    // A re-confirmation for the new head is required to green SHA_B.
    const newHead = extractGatesDecision(interaction({
      title: `Merge ${REPO}#${PR} at exact head ${SHA_B}`,
      payload: { prompt: "Merge?", detailsMarkdown: `Head SHA ${SHA_B}.` },
      result: { outcome: "accepted", reason: `approved at exact head ${SHA_B}` },
    }), RM);
    expect(newHead).toMatchObject({ decision: { sha: SHA_B, state: "success" } });
  });

  it("keeps the status description inside the GitHub 140-character limit", () => {
    const description = gatesDescription({ repo: `${"o".repeat(38)}/${"r".repeat(100)}`, prNumber: 2_147_483_647, sha: SHA_A, state: "success" });
    expect(description.length).toBeLessThanOrEqual(140);
    expect(description).not.toContain("r".repeat(50));
    expect(gatesDescription({ repo: REPO, prNumber: PR, sha: SHA_A, state: "success" })).toBe(`RM merge success ${REPO}#${PR} @ aaaaaaa`);
  });
});
