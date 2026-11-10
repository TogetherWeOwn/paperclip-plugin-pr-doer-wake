import { parseCiConfig, UUID, type SecretRef } from "./ci-config.js";

export interface CustodyConfig {
  enabled: boolean;
  dryRun: boolean;
  companyId: string;
  org: string;
  summaryAgentId: string;
  closedSince: number;
  /** Exactly one authentication mode per tick: bearer token or the read-only App exchange. */
  tokenRef: SecretRef | null;
  githubApp: { appId: string; installationId: string; privateKeySecretRef: SecretRef } | null;
}
export function validateCustodyConfig(raw: Record<string, unknown>): string[] {
  if (raw.custodyEnabled !== true) return [];
  const errors: string[] = [];
  if (typeof raw.custodyCompanyId !== "string" || !UUID.test(raw.custodyCompanyId)) errors.push("custodyCompanyId must be a UUID");
  if (typeof raw.custodySummaryAgentId !== "string" || !UUID.test(raw.custodySummaryAgentId)) errors.push("custodySummaryAgentId must be a UUID");
  if (typeof raw.custodyOrg !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(raw.custodyOrg)) errors.push("custodyOrg must be an organization login");
  if (typeof raw.custodyClosedSince !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(raw.custodyClosedSince) || !Number.isFinite(Date.parse(raw.custodyClosedSince)) || new Date(raw.custodyClosedSince).toISOString().replace(".000Z", "Z") !== raw.custodyClosedSince) errors.push("custodyClosedSince must be a UTC initial closed-inventory boundary");
  const ci = parseCiConfig(raw);
  if (Boolean(ci.githubTokenSecretRef) === Boolean(ci.githubApp)) errors.push("custody requires exactly one authentication mode: githubTokenSecretRef OR githubAppId, githubInstallationId and githubAppPrivateKeySecretRef");
  return errors;
}
export function parseCustodyConfig(raw: Record<string, unknown>): CustodyConfig | null {
  if (raw.custodyEnabled !== true) return null;
  if (validateCustodyConfig(raw).length) throw new Error("invalid_custody_configuration");
  return {
    enabled: true, dryRun: raw.custodyDryRun !== false,
    companyId: String(raw.custodyCompanyId).toLowerCase(), org: String(raw.custodyOrg).toLowerCase(),
    summaryAgentId: String(raw.custodySummaryAgentId).toLowerCase(), closedSince: Date.parse(String(raw.custodyClosedSince)),
    tokenRef: parseCiConfig(raw).githubTokenSecretRef,
    githubApp: parseCiConfig(raw).githubApp,
  };
}
