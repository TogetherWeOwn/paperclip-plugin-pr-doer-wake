export interface SecretRef {
  type: "secret_ref";
  secretId: string;
  version?: number | "latest";
}

export interface CiConfig {
  enabled: boolean;
  dryRun: boolean;
  allowedRepos: string[];
  githubTokenSecretRef: SecretRef | null;
  githubApp: { appId: string; installationId: string; privateKeySecretRef: SecretRef } | null;
  webhooksEnabled: boolean;
  webhookSecretRef: SecretRef | null;
  /** Cold-start baseline only; measured successful waits replace it. */
  repoMedianMs: Record<string, number>;
  gatesStatusEnabled: boolean;
  /** Shadow publishes no GitHub status; it only logs what would be published. */
  gatesStatusShadow: boolean;
  /** Agent whose accepted merge confirmations publish `paperclip/gates`. */
  releaseManagerAgentId: string | null;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
export const SHA = /^[0-9a-f]{40}$/;

function secretRef(value: unknown): SecretRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ref = value as Record<string, unknown>;
  if (Object.keys(ref).some((k) => !["type", "secretId", "version"].includes(k))) return null;
  if (ref.type !== "secret_ref" || typeof ref.secretId !== "string" || !UUID.test(ref.secretId)) return null;
  if (ref.version !== undefined && ref.version !== "latest" && !(Number.isSafeInteger(ref.version) && Number(ref.version) > 0)) return null;
  return ref as unknown as SecretRef;
}

function githubId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
}

export function parseCiConfig(raw: Record<string, unknown>): CiConfig {
  const repos = Array.isArray(raw.allowedRepos) ? raw.allowedRepos : [];
  const medians: Record<string, number> = Object.create(null);
  if (raw.repoMedianMs && typeof raw.repoMedianMs === "object" && !Array.isArray(raw.repoMedianMs)) {
    for (const [repo, ms] of Object.entries(raw.repoMedianMs)) {
      if (REPO.test(repo) && Number.isSafeInteger(ms) && Number(ms) >= 60_000 && Number(ms) <= 86_400_000) medians[repo.toLowerCase()] = Number(ms);
    }
  }
  return {
    enabled: raw.enabled === true,
    dryRun: raw.dryRun !== false,
    allowedRepos: repos.filter((r): r is string => typeof r === "string" && REPO.test(r) && !r.endsWith("/.") && !r.endsWith("/..")).slice(0, 200).map((r) => r.toLowerCase()),
    githubTokenSecretRef: secretRef(raw.githubTokenSecretRef),
    githubApp: githubId(raw.githubAppId) && githubId(raw.githubInstallationId) && secretRef(raw.githubAppPrivateKeySecretRef)
      ? { appId: raw.githubAppId, installationId: raw.githubInstallationId, privateKeySecretRef: secretRef(raw.githubAppPrivateKeySecretRef)! } : null,
    webhooksEnabled: raw.webhooksEnabled === true,
    webhookSecretRef: secretRef(raw.webhookSecretRef),
    repoMedianMs: medians,
    gatesStatusEnabled: raw.gatesStatusEnabled === true,
    gatesStatusShadow: raw.gatesStatusShadow !== false,
    releaseManagerAgentId: typeof raw.releaseManagerAgentId === "string" && UUID.test(raw.releaseManagerAgentId) ? raw.releaseManagerAgentId.toLowerCase() : null,
  };
}

export function validateCiConfig(raw: Record<string, unknown>): string[] {
  const config = parseCiConfig(raw);
  const errors: string[] = [];
  // The manifest's combined instance config also declares the custody keys
  // validated by custody-config; the CI validator must recognize them here
  // (without validating them) so shared configs are not rejected as unknown.
  const keys = ["enabled", "dryRun", "allowedRepos", "githubTokenSecretRef", "githubAppId", "githubInstallationId", "githubAppPrivateKeySecretRef", "webhooksEnabled", "webhookSecretRef", "repoMedianMs", "custodyEnabled", "custodyDryRun", "custodyCompanyId", "custodyOrg", "custodySummaryAgentId", "custodyClosedSince", "gatesStatusEnabled", "gatesStatusShadow", "releaseManagerAgentId"];
  if (Object.keys(raw).some((key) => !keys.includes(key))) errors.push("unknown configuration field");
  const bearer = Object.hasOwn(raw, "githubTokenSecretRef");
  const app = ["githubAppId", "githubInstallationId", "githubAppPrivateKeySecretRef"].some((key) => Object.hasOwn(raw, key));
  if (bearer && app || bearer && !config.githubTokenSecretRef || app && !config.githubApp || (config.enabled || config.gatesStatusEnabled) && !bearer && !app) {
    errors.push("configure exactly one complete authentication mode: githubTokenSecretRef OR githubAppId, githubInstallationId and githubAppPrivateKeySecretRef");
  }
  if (config.gatesStatusEnabled && !config.releaseManagerAgentId) errors.push("gatesStatusEnabled requires releaseManagerAgentId as a UUID");
  if (!config.enabled && !config.gatesStatusEnabled) return errors;
  if (!config.allowedRepos.length || !Array.isArray(raw.allowedRepos) || config.allowedRepos.length !== raw.allowedRepos.length) errors.push("allowedRepos must contain 1-200 valid owner/repo entries");
  if (config.webhooksEnabled && !config.webhookSecretRef) errors.push("webhooksEnabled requires webhookSecretRef");
  if (raw.repoMedianMs !== undefined && (!raw.repoMedianMs || typeof raw.repoMedianMs !== "object" || Array.isArray(raw.repoMedianMs) || Object.keys(raw.repoMedianMs).length !== Object.keys(config.repoMedianMs).length)) errors.push("repoMedianMs must map valid repos to integer durations from 60000 to 86400000 ms");
  return errors;
}

export interface Registration {
  issueId: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

/**
 * Refusal diagnostics for invalid registrations. `shape` names field
 * problems in terms of names/types/lengths only — never argument values —
 * so agents can self-correct and operators can replay real calls from the
 * audit ledger without the ledger holding secret or positional data.
 */
export class InvalidRegistrationError extends Error {
  readonly shape: string[];
  constructor(shape: string[]) {
    super("invalid_registration");
    this.name = "InvalidRegistrationError";
    this.shape = shape.slice(0, 8);
  }
}

export function parseRegistration(value: unknown): Registration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidRegistrationError(["body:not-object"]);
  const p = value as Record<string, unknown>;
  const shape: string[] = [];
  const fields = ["issueId", "repo", "prNumber", "headSha"] as const;
  for (const key of Object.keys(p)) if (!(fields as readonly string[]).includes(key)) shape.push(`extra:${key}`);
  for (const key of fields) if (!(key in p)) shape.push(`missing:${key}`);

  let issueId: string | null = null;
  if (typeof p.issueId === "string" && UUID.test(p.issueId)) issueId = p.issueId.toLowerCase();
  else if ("issueId" in p) shape.push(typeof p.issueId === "string" ? "issueId:not-uuid" : `issueId:${typeof p.issueId}`);

  // Unambiguous normalizations so common agent variants register instead
  // of refusing: exact GitHub URL forms for repo, case-insensitive hex SHA,
  // and digit-string PR numbers.
  let repo: string | null = null;
  if (typeof p.repo === "string") {
    const mapped = REPO.test(p.repo) ? p.repo : workspaceRepo(p.repo);
    if (mapped && !mapped.endsWith("/.") && !mapped.endsWith("/..")) repo = mapped.toLowerCase();
    else shape.push("repo:not-owner/repo");
  } else if ("repo" in p) shape.push(`repo:${typeof p.repo}`);

  let prNumber: number | null = null;
  const rawNumber = p.prNumber;
  if (typeof rawNumber === "number" || (typeof rawNumber === "string" && /^\d{1,10}$/.test(rawNumber))) {
    const parsed = Number(rawNumber);
    if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 2_147_483_647) prNumber = parsed;
  }
  if (prNumber === null && "prNumber" in p) shape.push(`prNumber:${typeof rawNumber === "string" ? "string-not-digits" : typeof rawNumber}`);

  let headSha: string | null = null;
  if (typeof p.headSha === "string") {
    if (/^[0-9a-fA-F]{40}$/.test(p.headSha)) headSha = p.headSha.toLowerCase();
    else shape.push(/^[0-9a-fA-F]*$/.test(p.headSha) ? `headSha:length=${p.headSha.length}` : "headSha:not-hex");
  } else if ("headSha" in p) shape.push(`headSha:${typeof p.headSha}`);

  if (shape.length || issueId === null || repo === null || prNumber === null || headSha === null) throw new InvalidRegistrationError(shape);
  return { issueId, repo, prNumber, headSha };
}

/** Exact GitHub repository identity; no host aliases, credentials, query or fragment. */
export function workspaceRepo(url: string | null): string | null {
  if (!url) return null;
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
  return match && REPO.test(match[1]!) ? match[1]!.toLowerCase() : null;
}
