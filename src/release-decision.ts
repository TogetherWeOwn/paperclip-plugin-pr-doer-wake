import { REPO, SHA, UUID } from "./ci-config.js";

/** The complete target is presented to the RM in the confirmation itself. */
export interface ReleaseTarget {
  version: 1;
  repo: string;
  sha: string;
  stagingRunId: string;
  stagingRunAttempt: number;
  expiresAt: string;
}

export interface ReleaseDecision {
  confirmationId: string;
  target: ReleaseTarget;
  state: "accepted" | "revoked" | "expired";
}

const TITLE = "Accept exact production release?";
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/**
 * Parse a host interaction, not an authorization. The caller must independently
 * authenticate the host read and its company/issue context. This parser cannot
 * establish provenance from caller-supplied objects or authorize an operation.
 */
export function extractReleaseDecision(raw: unknown, rmId: string, now: number): ReleaseDecision | null {
  const interaction = record(raw);
  if (!interaction || !UUID.test(rmId) || !Number.isFinite(now)) return null;
  const payload = record(interaction.payload);
  const result = record(interaction.result);
  if (!payload || !result || interaction.kind !== "request_confirmation"
      || typeof interaction.id !== "string" || !UUID.test(interaction.id)
      || typeof interaction.addresseeAgentId !== "string"
      || interaction.addresseeAgentId.toLowerCase() !== rmId.toLowerCase()
      || typeof interaction.resolvedByAgentId !== "string"
      || interaction.resolvedByAgentId.toLowerCase() !== rmId.toLowerCase()
      || interaction.addresseeUserId != null || interaction.resolvedByUserId != null
      || typeof interaction.resolvedByRunId !== "string" || !UUID.test(interaction.resolvedByRunId)
      || interaction.title !== TITLE || interaction.summary != null
      || payload.version !== 1 || payload.prompt !== TITLE
      || Object.keys(payload).some((key) => !["version", "prompt", "detailsMarkdown", "allowDeclineReason"].includes(key))
      || (payload.allowDeclineReason !== undefined && payload.allowDeclineReason !== true)
      || typeof payload.detailsMarkdown !== "string" || payload.detailsMarkdown.length > 1024
      || result.version !== 1 || result.outcome !== "accepted"
      || Object.keys(result).sort().join(",") !== "outcome,version") return null;

  let details: Record<string, unknown> | null;
  try { details = record(JSON.parse(payload.detailsMarkdown)); } catch { return null; }
  if (!details || JSON.stringify(details) !== payload.detailsMarkdown
      || Object.keys(details).sort().join(",") !== "expiresAt,repo,sha,stagingRunAttempt,stagingRunId,version"
      || details.version !== 1 || typeof details.repo !== "string" || !REPO.test(details.repo)
      || details.repo !== details.repo.toLowerCase() || details.repo.endsWith("/.") || details.repo.endsWith("/..")
      || typeof details.sha !== "string" || !SHA.test(details.sha) || details.sha !== details.sha.toLowerCase()
      || typeof details.stagingRunId !== "string" || !/^[1-9][0-9]{0,19}$/.test(details.stagingRunId)
      || !Number.isSafeInteger(details.stagingRunAttempt) || (details.stagingRunAttempt as number) < 1
      || (details.stagingRunAttempt as number) > 2147483647
      || typeof details.expiresAt !== "string" || !UTC.test(details.expiresAt)) return null;
  const expiresMs = Date.parse(details.expiresAt);
  const resolvedMs = typeof interaction.resolvedAt === "string" ? Date.parse(interaction.resolvedAt) : NaN;
  if (!Number.isFinite(expiresMs) || new Date(expiresMs).toISOString().replace(".000Z", "Z") !== details.expiresAt
      || !Number.isFinite(resolvedMs) || resolvedMs > now || expiresMs <= resolvedMs
      || expiresMs - resolvedMs > MAX_TTL_MS) return null;
  if (interaction.status !== "accepted" || result.outcome !== "accepted") return null;
  return {
    confirmationId: interaction.id.toLowerCase(),
    target: details as unknown as ReleaseTarget,
    state: now >= expiresMs ? "expired" : "accepted",
  };
}
