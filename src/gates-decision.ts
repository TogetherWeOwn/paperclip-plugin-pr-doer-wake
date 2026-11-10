import { REPO, SHA, UUID } from "./ci-config.js";
import type { GatesStatusState } from "./ci-github.js";

/**
 * Pure extraction of a publishable `paperclip/gates` decision from one
 * issue-thread interaction. No network, clock or host state access.
 *
 * A decision exists only when every one of these holds:
 * - kind is `request_confirmation` (the RM merge confirmation kind)
 * - resolvedByAgentId is the configured Release Manager agent
 * - the outcome is terminal and publishable (accepted -> success;
 *   rejected/expired/cancelled/failed -> failure; superseded -> pending)
 * - combined text mentions the merge and states exactly one `owner/repo#N`
 *   PR reference and exactly one distinct 40-hex head SHA
 *
 * Missing, ambiguous, wrong-resolver or non-merge text publishes nothing.
 * The text fields are untrusted input: only projected identifiers and the
 * terminal outcome affect the result.
 */
export interface GatesDecision {
  repo: string;
  prNumber: number;
  sha: string;
  state: GatesStatusState;
  interactionId?: string;
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

/** Combined prose an RM merge confirmation may cite its PR/SHA in. */
function combinedText(interaction: Record<string, unknown>): string {
  const payload = interaction.payload && typeof interaction.payload === "object" && !Array.isArray(interaction.payload)
    ? interaction.payload as Record<string, unknown> : {};
  const result = interaction.result && typeof interaction.result === "object" && !Array.isArray(interaction.result)
    ? interaction.result as Record<string, unknown> : {};
  return [text(interaction.title), text(interaction.summary), text(payload.prompt), text(payload.detailsMarkdown), text(result.reason)].join("\n");
}

/** Terminal outcome -> GitHub commit-status state, or null when it publishes nothing. */
function stateFor(interaction: Record<string, unknown>): GatesStatusState | null {
  const result = interaction.result && typeof interaction.result === "object" && !Array.isArray(interaction.result)
    ? interaction.result as Record<string, unknown> : null;
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

export function extractGatesDecision(raw: unknown, releaseManagerAgentId: string): GatesExtraction {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { reason: "not_an_interaction" };
  const interaction = raw as Record<string, unknown>;
  if (interaction.kind !== "request_confirmation") return { reason: "not_a_confirmation" };
  if (typeof interaction.resolvedByAgentId !== "string" || !UUID.test(interaction.resolvedByAgentId) || !UUID.test(releaseManagerAgentId)
      || interaction.resolvedByAgentId.toLowerCase() !== releaseManagerAgentId.toLowerCase()) return { reason: "wrong_resolver" };
  const state = stateFor(interaction);
  if (state === null) return { reason: "no_publishable_outcome" };
  const source = combinedText(interaction);
  if (!/\bmerge\b/i.test(source)) return { reason: "not_a_merge_confirmation" };
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
    },
  };
}

/** Bounded human description for the status; never exceeds the 140-char API limit. */
export function gatesDescription(decision: Pick<GatesDecision, "repo" | "prNumber" | "sha" | "state">): string {
  const full = `RM merge ${decision.state} ${decision.repo}#${decision.prNumber} @ ${decision.sha.slice(0, 7)}`;
  return full.length <= 140 ? full : `RM merge ${decision.state} @ ${decision.sha.slice(0, 7)}`;
}
