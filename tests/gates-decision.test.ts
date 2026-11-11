import { describe, expect, it } from "vitest";
import { extractGatesDecision, gatesDescription } from "../src/gates-decision.js";

const RM = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const REPO = "acme/widget";
const PR = 17;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const prUrl = (repo: string, pr: number) => `https://github.com/${repo}/pull/${pr}`;

function interaction(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    kind: "request_confirmation",
    status: "accepted",
    addresseeAgentId: RM,
    resolvedByAgentId: RM,
    title: `Merge ${REPO}#${PR}?`,
    payload: {
      version: 1,
      prompt: `Merge ${REPO}#${PR}?`,
      detailsMarkdown: prUrl(REPO, PR),
    },
    result: { outcome: "accepted", reason: `approved at exact head ${SHA_A}` },
    ...overrides,
  };
}

describe("gates decision extraction", () => {
  it("publishes success for an RM-accepted merge-authorization contract citing one PR and one SHA", () => {
    expect(extractGatesDecision(interaction(), RM)).toEqual({
      decision: { repo: REPO, prNumber: PR, sha: SHA_A, state: "success", interactionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", decidedAtMs: 0 },
    });
  });

  it("publishes failure for rejected and expired RM decisions", () => {
    for (const status of ["rejected", "expired", "cancelled", "failed"]) {
      expect(extractGatesDecision(interaction({ status, result: { outcome: status, reason: `decided at exact head ${SHA_A}` } }), RM)).toMatchObject({ decision: { state: "failure" } });
    }
  });

  it("publishes pending for superseded cards, overriding a terminal status", () => {
    const superseded = extractGatesDecision(
      interaction({ status: "cancelled", result: { outcome: "superseded_by_newer_request", reason: `head ${SHA_A}` } }), RM,
    );
    expect(superseded).toMatchObject({ decision: { state: "pending", sha: SHA_A } });
  });

  it("rejects the hold-card confusion: a NOT-merge prompt with a blocking acceptance label never greens", () => {
    // Security finding: generic confirmation acceptance as merge authorization.
    // A requester addresses the RM with a hold card naming the real PR and
    // head SHA; the RM accepts the hold. Extraction must publish nothing,
    // even though the prose mentions merge, one PR and one SHA.
    const hold = interaction({
      title: `Confirm we must NOT merge ${REPO}#${PR} at ${SHA_A}.`,
      payload: {
        version: 1,
        prompt: `Confirm we must NOT merge ${REPO}#${PR} at ${SHA_A}.`,
        acceptLabel: "Keep blocked",
        detailsMarkdown: prUrl(REPO, PR),
      },
    });
    expect(extractGatesDecision(hold, RM)).toEqual({ reason: "not_a_merge_authorization" });
  });

  it("rejects a canonical title whose prompt is not the merge question", () => {
    // Title looks like a merge directive but the prompt actually presented
    // to the RM asks for the opposite: prompt must be identical to the title.
    const contradiction = interaction({
      payload: { version: 1, prompt: `Confirm we must NOT merge ${REPO}#${PR} at ${SHA_A}.`, detailsMarkdown: prUrl(REPO, PR) },
    });
    expect(extractGatesDecision(contradiction, RM)).toEqual({ reason: "not_a_merge_authorization" });
  });

  it("rejects a contract-shaped card that is not addressed to the RM", () => {
    expect(extractGatesDecision(interaction({ addresseeAgentId: OTHER }), RM)).toEqual({ reason: "not_addressed_to_rm" });
    expect(extractGatesDecision(interaction({ addresseeAgentId: null }), RM)).toEqual({ reason: "not_addressed_to_rm" });
  });

  it("rejects document/custom targets and tool-action, secret and connection enrichment blocks", () => {
    for (const block of [
      { target: { type: "issue_document", key: "spec", revisionId: "rev-1" } },
      { target: { type: "custom", key: "custody-review", revisionId: "rev-1" } },
      { toolAction: { version: 1, toolName: "merge" } },
      { secretProposal: { version: 1, proposalId: "p-1" } },
      { connectionAuthorization: { version: 1, providerName: "Gmail" } },
    ]) {
      const card = interaction({ payload: { version: 1, prompt: `Merge ${REPO}#${PR}?`, detailsMarkdown: prUrl(REPO, PR), ...block } });
      expect(extractGatesDecision(card, RM)).toEqual({ reason: "not_a_merge_authorization" });
    }
  });

  it("rejects a custom acceptance label or a summary carrying extra prose", () => {
    expect(extractGatesDecision(interaction({
      payload: { version: 1, prompt: `Merge ${REPO}#${PR}?`, acceptLabel: "Keep blocked", detailsMarkdown: prUrl(REPO, PR) },
    }), RM)).toEqual({ reason: "not_a_merge_authorization" });
    expect(extractGatesDecision(interaction({ summary: `Merge ${REPO}#${PR} at exact head ${SHA_A}` }), RM))
      .toEqual({ reason: "not_a_merge_authorization" });
  });

  it("publishes nothing when the resolution states no SHA", () => {
    const extraction = extractGatesDecision(interaction({ result: { outcome: "accepted", reason: "approved" } }), RM);
    expect(extraction).toEqual({ reason: "no_sha" });
  });

  it("publishes nothing when the resolution is ambiguous about the SHA or the PR", () => {
    expect(extractGatesDecision(interaction({ result: { outcome: "accepted", reason: `heads ${SHA_A} and ${SHA_B}` } }), RM))
      .toEqual({ reason: "ambiguous_sha" });
    expect(extractGatesDecision(interaction({ result: { outcome: "accepted", reason: `approved ${REPO}#${PR} and acme/other#9 at ${SHA_A}` } }), RM))
      .toEqual({ reason: "ambiguous_pr" });
  });

  it("publishes nothing for a wrong resolver, even if everything else matches", () => {
    expect(extractGatesDecision(interaction({ resolvedByAgentId: OTHER }), RM)).toEqual({ reason: "wrong_resolver" });
    expect(extractGatesDecision(interaction({ resolvedByAgentId: null }), RM)).toEqual({ reason: "wrong_resolver" });
    expect(extractGatesDecision(interaction({ resolvedByAgentId: RM }), OTHER)).toEqual({ reason: "wrong_resolver" });
  });

  it("publishes nothing for non-merge confirmations, other kinds or a still-pending card", () => {
    expect(extractGatesDecision(interaction({
      title: "Deploy", payload: { version: 1, prompt: "Deploy?", detailsMarkdown: prUrl(REPO, PR) },
    }), RM)).toEqual({ reason: "not_a_merge_authorization" });
    expect(extractGatesDecision(interaction({ kind: "ask_user_questions" }), RM)).toEqual({ reason: "not_a_confirmation" });
    expect(extractGatesDecision(interaction({ status: "pending", resolvedByAgentId: null, addresseeAgentId: RM, result: null }), RM))
      .toEqual({ reason: "wrong_resolver" });
    expect(extractGatesDecision(null, RM)).toEqual({ reason: "not_an_interaction" });
  });

  it("accepts the bare PR URL case-insensitively but rejects trailing prose or a different PR URL", () => {
    expect(extractGatesDecision(interaction({
      payload: { version: 1, prompt: `Merge ${REPO}#${PR}?`, detailsMarkdown: prUrl(REPO.toUpperCase(), PR).toUpperCase() },
    }), RM)).toMatchObject({ decision: { repo: REPO, prNumber: PR } });
    expect(extractGatesDecision(interaction({
      payload: { version: 1, prompt: `Merge ${REPO}#${PR}?`, detailsMarkdown: `${prUrl(REPO, PR)} with extra prose` },
    }), RM)).toEqual({ reason: "not_a_merge_authorization" });
    expect(extractGatesDecision(interaction({
      payload: { version: 1, prompt: `Merge ${REPO}#${PR}?`, detailsMarkdown: prUrl(REPO, PR + 1) },
    }), RM)).toEqual({ reason: "not_a_merge_authorization" });
  });

  it("rejects malformed merge titles (leading zeros, missing question mark, wrong case)", () => {
    for (const title of [`Merge ${REPO}#017?`, `Merge ${REPO}#${PR}`, `merge ${REPO}#${PR}?`, `Merge ${REPO}#${PR} at exact head ${SHA_A}?`]) {
      expect(extractGatesDecision(interaction({ title, payload: { version: 1, prompt: title, detailsMarkdown: prUrl(REPO, PR) } }), RM))
        .toEqual({ reason: "not_a_merge_authorization" });
    }
  });

  it("never greens a new push: only the cited SHA is returned, never its successor", () => {
    // The accepted card cites the old head; a later push to SHA_B has no
    // decision of its own, so no success is ever published for it.
    const extraction = extractGatesDecision(interaction(), RM);
    expect(extraction).toMatchObject({ decision: { sha: SHA_A, state: "success" } });
    // A re-confirmation for the new head is required to green SHA_B.
    const newHead = extractGatesDecision(interaction({
      result: { outcome: "accepted", reason: `approved at exact head ${SHA_B}` },
    }), RM);
    expect(newHead).toMatchObject({ decision: { sha: SHA_B, state: "success" } });
  });

  it("carries the host decision time for authoritative precedence (resolvedAt, then updatedAt, then createdAt)", () => {
    const resolved = new Date("2026-11-10T12:00:00.000Z").getTime();
    expect(extractGatesDecision(interaction({
      resolvedAt: "2026-11-10T12:00:00.000Z", updatedAt: "2026-11-10T13:00:00.000Z", createdAt: "2026-11-10T11:00:00.000Z",
    }), RM)).toMatchObject({ decision: { decidedAtMs: resolved } });
    expect(extractGatesDecision(interaction({
      resolvedAt: null, updatedAt: "2026-11-10T13:30:00.000Z", createdAt: "2026-11-10T11:00:00.000Z",
    }), RM)).toMatchObject({ decision: { decidedAtMs: new Date("2026-11-10T13:30:00.000Z").getTime() } });
    expect(extractGatesDecision(interaction({
      resolvedAt: null, updatedAt: null, createdAt: new Date("2026-11-10T11:15:00.000Z"),
    }), RM)).toMatchObject({ decision: { decidedAtMs: new Date("2026-11-10T11:15:00.000Z").getTime() } });
    expect(extractGatesDecision(interaction({ resolvedAt: "not-a-date", updatedAt: undefined, createdAt: undefined }), RM))
      .toMatchObject({ decision: { decidedAtMs: 0 } });
  });

  it("keeps the status description inside the GitHub 140-character limit", () => {
    const description = gatesDescription({ repo: `${"o".repeat(38)}/${"r".repeat(100)}`, prNumber: 2_147_483_647, sha: SHA_A, state: "success" });
    expect(description.length).toBeLessThanOrEqual(140);
    expect(description).not.toContain("r".repeat(50));
    expect(gatesDescription({ repo: REPO, prNumber: PR, sha: SHA_A, state: "success" })).toBe(`RM merge success ${REPO}#${PR} @ aaaaaaa`);
  });
});
