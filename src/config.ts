import { WAKE_STATES, type WakeState } from "./constants.js";

export interface SecretRef {
  type: "secret_ref";
  secretId: string;
  version?: number | "latest";
}

export interface DoerWakeConfig {
  enabled: boolean;
  /** Log and dedupe only: no comment, no wake. Use to run beside pr-controller before cutover. */
  shadow: boolean;
  githubOrg: string;
  webhookSecretRef: SecretRef | null;
  /** Required when enabled: every wake candidate is revalidated against GitHub (open, non-draft, head, trust). */
  githubTokenSecretRef: SecretRef | null;
  reviewCheckName: string;
  ignoreChecks: string[];
  /** Lowercase "org/repo" entries that never wake. */
  stoppedRepos: string[];
  /** Agents whose cards never own a PR here (for example the Reviewer). */
  excludeAgentIds: string[];
  wakeStates: WakeState[];
  /** Cards whose own status is `blocked` are held even without a blocker edge (pr-controller parity). */
  skipBlockedStatus: boolean;
  /** Head-branch prefix that names the owning card, e.g. `TOG-123-slug`. */
  branchIdentifierPattern: string;
  /**
   * Extra PR author logins trusted besides OWNER/MEMBER/COLLABORATOR (for example the agents' GitHub App bot).
   * Stored normalized: lowercase, without a trailing `[bot]`.
   */
  trustedAuthors: string[];
  /** GraphQL pages (50 PRs each) the conflict sweep reads per repo per tick; it resumes from the cursor next tick. */
  sweepMaxPages: number;
}

export function normalizeLogin(login: string): string {
  return login.toLowerCase().replace(/\[bot\]$/, "");
}

export const DEFAULT_CONFIG: DoerWakeConfig = {
  enabled: false,
  shadow: true,
  githubOrg: "",
  webhookSecretRef: null,
  githubTokenSecretRef: null,
  reviewCheckName: "Paperclip Review",
  ignoreChecks: [],
  stoppedRepos: ["togetherweown/nntune"],
  excludeAgentIds: [],
  wakeStates: [...WAKE_STATES],
  skipBlockedStatus: true,
  branchIdentifierPattern: "^([A-Z][A-Z0-9]*-[0-9]+)-",
  trustedAuthors: [],
  sweepMaxPages: 4,
};

function asSecretRef(value: unknown): SecretRef | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "secret_ref" || typeof record.secretId !== "string") return null;
  return record as unknown as SecretRef;
}

function stringList(value: unknown, lower = false): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0).map((v) => (lower ? v.toLowerCase() : v));
}

export function parseConfig(raw: Record<string, unknown> | null | undefined): DoerWakeConfig {
  const value = raw ?? {};
  const states = stringList(value.wakeStates).filter((s): s is WakeState => (WAKE_STATES as readonly string[]).includes(s));
  return {
    enabled: value.enabled === true,
    shadow: value.shadow === undefined ? DEFAULT_CONFIG.shadow : value.shadow === true,
    githubOrg: typeof value.githubOrg === "string" ? value.githubOrg : "",
    webhookSecretRef: asSecretRef(value.webhookSecretRef),
    githubTokenSecretRef: asSecretRef(value.githubTokenSecretRef),
    reviewCheckName: typeof value.reviewCheckName === "string" && value.reviewCheckName ? value.reviewCheckName : DEFAULT_CONFIG.reviewCheckName,
    ignoreChecks: stringList(value.ignoreChecks),
    stoppedRepos: value.stoppedRepos === undefined ? [...DEFAULT_CONFIG.stoppedRepos] : stringList(value.stoppedRepos, true),
    excludeAgentIds: stringList(value.excludeAgentIds),
    wakeStates: Array.isArray(value.wakeStates) ? states : [...DEFAULT_CONFIG.wakeStates],
    skipBlockedStatus: value.skipBlockedStatus === undefined ? true : value.skipBlockedStatus === true,
    branchIdentifierPattern:
      typeof value.branchIdentifierPattern === "string" && value.branchIdentifierPattern
        ? value.branchIdentifierPattern
        : DEFAULT_CONFIG.branchIdentifierPattern,
    trustedAuthors: stringList(value.trustedAuthors).map(normalizeLogin),
    sweepMaxPages:
      typeof value.sweepMaxPages === "number" && Number.isInteger(value.sweepMaxPages)
        ? Math.min(20, Math.max(1, value.sweepMaxPages))
        : DEFAULT_CONFIG.sweepMaxPages,
  };
}

export function validateConfig(config: DoerWakeConfig): string[] {
  const errors: string[] = [];
  if (!config.enabled) return errors;
  if (!config.githubOrg) errors.push("githubOrg is required when enabled");
  if (!config.webhookSecretRef) errors.push("webhookSecretRef (secret_ref) is required when enabled");
  if (!config.githubTokenSecretRef) {
    errors.push("githubTokenSecretRef (secret_ref) is required when enabled: every wake is revalidated against GitHub");
  }
  try {
    new RegExp(config.branchIdentifierPattern);
  } catch {
    errors.push("branchIdentifierPattern is not a valid regular expression");
  }
  return errors;
}
