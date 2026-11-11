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
  };
}

export function validateCiConfig(raw: Record<string, unknown>): string[] {
  const config = parseCiConfig(raw);
  const errors: string[] = [];
  // The manifest's combined instance config also declares the custody keys
  // validated by custody-config; the CI validator must recognize them here
  // (without validating them) so shared configs are not rejected as unknown.
  const keys = ["enabled", "dryRun", "allowedRepos", "githubTokenSecretRef", "githubAppId", "githubInstallationId", "githubAppPrivateKeySecretRef", "webhooksEnabled", "webhookSecretRef", "repoMedianMs", "custodyEnabled", "custodyDryRun", "custodyCompanyId", "custodyOrg", "custodySummaryAgentId", "custodyClosedSince"];
  if (Object.keys(raw).some((key) => !keys.includes(key))) errors.push("unknown configuration field");
  const bearer = Object.hasOwn(raw, "githubTokenSecretRef");
  const app = ["githubAppId", "githubInstallationId", "githubAppPrivateKeySecretRef"].some((key) => Object.hasOwn(raw, key));
  if (bearer && app || bearer && !config.githubTokenSecretRef || app && !config.githubApp || config.enabled && !bearer && !app) {
    errors.push("configure exactly one complete authentication mode: githubTokenSecretRef OR githubAppId, githubInstallationId and githubAppPrivateKeySecretRef");
  }
  if (!config.enabled) return errors;
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

export function parseRegistration(value: unknown): Registration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_registration");
  const p = value as Record<string, unknown>;
  if (Object.keys(p).length !== 4 || Object.keys(p).some((k) => !["issueId", "repo", "prNumber", "headSha"].includes(k))) throw new Error("invalid_registration");
  if (typeof p.issueId !== "string" || !UUID.test(p.issueId) || typeof p.repo !== "string" || !REPO.test(p.repo) || p.repo.endsWith("/.") || p.repo.endsWith("/..") || typeof p.headSha !== "string" || !SHA.test(p.headSha) || !Number.isSafeInteger(p.prNumber) || Number(p.prNumber) < 1 || Number(p.prNumber) > 2_147_483_647) throw new Error("invalid_registration");
  return { issueId: p.issueId.toLowerCase(), repo: p.repo.toLowerCase(), prNumber: Number(p.prNumber), headSha: p.headSha };
}

/** Exact GitHub repository identity; no host aliases, credentials, query or fragment. */
export function workspaceRepo(url: string | null): string | null {
  if (!url) return null;
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
  return match && REPO.test(match[1]!) ? match[1]!.toLowerCase() : null;
}
