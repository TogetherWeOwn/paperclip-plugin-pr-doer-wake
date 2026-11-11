import { REPO, SHA, UUID } from "./ci-config.js";
import type { GatesStatusState } from "./ci-github.js";

/**
 * Pure extraction of a publishable `paperclip/gates` decision from one
 * issue-thread interaction. No network, clock or host state access.
 *
 * A decision exists only when every one of these holds:
 * - kind is `request_confirmation`
 * - the card is addressed to the configured Release Manager agent
 *   (`addresseeAgentId`) and resolved by it (`resolvedByAgentId`) — who was
 *   asked and who answered are both the RM; the accepted action presented
 *   to the RM is the merge question itself, never an arbitrary prompt
 * - the outcome is terminal and publishable (accepted -> success;
 *   rejected/expired/cancelled/failed -> failure; superseded -> pending)
 * - the card carries the dedicated merge-authorization contract and nothing
 *   else: title `Merge <owner/repo>#<n>?`, prompt identical to the title,
 *   details the bare PR URL for the same repo/number, no summary and no
 *   acceptance label, and no target / tool-action / secret-proposal /
 *   connection-authorization payload block
 * - the contract text (title, prompt, details, resolution reason) names
 *   exactly one `owner/repo#N` PR reference and exactly one distinct
 *   40-hex head SHA — the SHA the RM cites in the resolution reason
 *
 * Missing, ambiguous, wrong-resolver, mis-addressed or non-contract text
 * publishes nothing. In particular, a generic confirmation that merely
 * mentions the word "merge" alongside one PR and one SHA — such as a hold
 * card asking "Confirm we must NOT merge ...?" — is not merge
 * authorization: acceptance of a non-merge prompt never greens a SHA. The
 * text fields are untrusted input: only projected identifiers and the
 * terminal outcome affect the result.
 */
export interface GatesDecision {
  repo: string;
  prNumber: number;
  sha: string;
  state: GatesStatusState;
  interactionId?: string;
  /**
   * Trusted host decision time in epoch ms, for authoritative precedence
   * when a thread retains several RM decisions for the same repo+SHA.
   * Parsed from `resolvedAt`, falling back to `updatedAt` then `createdAt`;
   * 0 when the host supplied no parseable timestamp. The runtime groups by
   * repo+SHA and keeps only the newest decision under this ordering, with
   * the interaction id as a deterministic tie-break, so list order returned
   * by the host never chooses the published state.
   */
  decidedAtMs: number;
}

export type GatesExtraction = { decision: GatesDecision } | { reason: string };

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function prRefs(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(/([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100})#(\d{1,10})/g)) {
    const repo = match[1]!.toLowerCase();
    const number = Number(match[2]!);
    if (!REPO.test(repo) || repo.endsWith("/.") || repo.endsWith("/..") || !Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) continue;
    found.add(`${repo}#${number}`);
  }
  return found;
}

function shas(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(/\b[0-9a-fA-F]{40}\b/g)) found.add(match[0]!.toLowerCase());
  return found;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Epoch ms for a host timestamp (`Date`, ISO string or epoch number), else null. */
function timeMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/** Host decision time for one interaction: resolution first, then update, then creation. */
function decidedAtMs(interaction: Record<string, unknown>): number {
  for (const field of ["resolvedAt", "updatedAt", "createdAt"]) {
    const ms = timeMs(interaction[field]);
    if (ms !== null) return ms;
  }
  return 0;
}

/** Combined prose an RM merge confirmation may cite its PR/SHA in. */
function combinedText(interaction: Record<string, unknown>): string {
  const payload = recordOf(interaction.payload);
  const result = recordOf(interaction.result);
  return [text(interaction.title), text(payload.prompt), text(payload.detailsMarkdown), text(result.reason)].join("\n");
}

/** Terminal outcome -> GitHub commit-status state, or null when it publishes nothing. */
function stateFor(interaction: Record<string, unknown>): GatesStatusState | null {
  const result = recordOf(interaction.result);
  const outcome = result && typeof result.outcome === "string" ? result.outcome : null;
  // Supersession replaces the card with a newer request: the old SHA stops
  // being green and returns to pending until the newer decision lands.
  if (outcome !== null && outcome.startsWith("superseded_")) return "pending";
  switch (interaction.status) {
    case "accepted": return "success";
    case "rejected": return "failure";
    case "expired": return "failure";
    case "cancelled": return "failure";
    case "failed": return "failure";
    default: return null;
  }
}

/**
 * Parses the dedicated merge-authorization title: the exact directive
 * `Merge <owner/repo>#<n>?` a conforming merge confirmation presents to
 * the RM. Returns the lowercased repo and PR number, or null for anything
 * else (prose directives, negations, missing question mark, leading-zero
 * numbers, invalid repo or out-of-range number).
 */
function mergeTitle(title: unknown): { repo: string; prNumber: number } | null {
  if (typeof title !== "string") return null;
  const match = /^Merge ([A-Za-z0-9][A-Za-z0-9.-]{0,38}\/[A-Za-z0-9_.-]{1,100})#(\d{1,10})\?$/.exec(title);
  if (!match) return null;
  const repo = match[1]!.toLowerCase();
  if (!REPO.test(repo) || repo.endsWith("/.") || repo.endsWith("/..")) return null;
  const number = Number(match[2]!);
  if (String(number) !== match[2]!) return null;
  if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) return null;
  return { repo, prNumber: number };
}

/**
 * True when the interaction carries exactly the dedicated merge-authorization
 * contract: the merge question as both title and prompt, the bare PR URL as
 * the only details, and no summary, acceptance label, target, or other
 * approval-enrichment block that would change what acceptance means.
 */
function isMergeAuthorizationContract(interaction: Record<string, unknown>): boolean {
  const payload = recordOf(interaction.payload);
  if (payload.target != null || payload.toolAction != null || payload.secretProposal != null || payload.connectionAuthorization != null) return false;
  if (text(payload.acceptLabel).trim() !== "" || text(interaction.summary).trim() !== "") return false;
  const target = mergeTitle(interaction.title);
  if (!target) return false;
  if (text(payload.prompt) !== text(interaction.title)) return false;
  const expected = `https://github.com/${target.repo}/pull/${target.prNumber}`;
  if (text(payload.detailsMarkdown).toLowerCase() !== expected) return false;
  return true;
}

export function extractGatesDecision(raw: unknown, releaseManagerAgentId: string): GatesExtraction {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { reason: "not_an_interaction" };
  const interaction = raw as Record<string, unknown>;
  if (interaction.kind !== "request_confirmation") return { reason: "not_a_confirmation" };
  if (typeof interaction.resolvedByAgentId !== "string" || !UUID.test(interaction.resolvedByAgentId) || !UUID.test(releaseManagerAgentId)
      || interaction.resolvedByAgentId.toLowerCase() !== releaseManagerAgentId.toLowerCase()) return { reason: "wrong_resolver" };
  if (typeof interaction.addresseeAgentId !== "string" || !UUID.test(interaction.addresseeAgentId)
      || interaction.addresseeAgentId.toLowerCase() !== releaseManagerAgentId.toLowerCase()) return { reason: "not_addressed_to_rm" };
  const state = stateFor(interaction);
  if (state === null) return { reason: "no_publishable_outcome" };
  if (!isMergeAuthorizationContract(interaction)) return { reason: "not_a_merge_authorization" };
  const source = combinedText(interaction);
  const prs = prRefs(source);
  if (prs.size === 0) return { reason: "no_pr" };
  if (prs.size > 1) return { reason: "ambiguous_pr" };
  const heads = shas(source);
  if (heads.size === 0) return { reason: "no_sha" };
  if (heads.size > 1) return { reason: "ambiguous_sha" };
  const [sole] = [...prs];
  const [repo, prNumber] = sole!.split("#") as [string, string];
  const [sha] = [...heads];
  if (!SHA.test(sha!)) return { reason: "no_sha" };
  return {
    decision: {
      repo, prNumber: Number(prNumber), sha: sha!, state,
      ...(typeof interaction.id === "string" ? { interactionId: interaction.id } : {}),
      decidedAtMs: decidedAtMs(interaction),
    },
  };
}

/** Bounded human description for the status; never exceeds the 140-char API limit. */
export function gatesDescription(decision: Pick<GatesDecision, "repo" | "prNumber" | "sha" | "state">): string {
  const full = `RM merge ${decision.state} ${decision.repo}#${decision.prNumber} @ ${decision.sha.slice(0, 7)}`;
  return full.length <= 140 ? full : `RM merge ${decision.state} @ ${decision.sha.slice(0, 7)}`;
}
