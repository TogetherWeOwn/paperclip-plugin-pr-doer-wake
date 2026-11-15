import { REPO, SHA, UUID } from "./ci-config.js";

/** Exact confirmation target; this value is not promotion authorization. */
export interface ReleaseIdentity {
  confirmationId: string;
  repo: string;
  sha: string;
  stagingRunId: string;
  stagingRunAttempt: number;
  expiresAt: string;
}

/** Reject aliases so a confirmation can have only one representation. */
export function validReleaseIdentity(value: ReleaseIdentity): boolean {
  if (!value || typeof value !== "object"
      || typeof value.confirmationId !== "string" || !UUID.test(value.confirmationId)
      || value.confirmationId !== value.confirmationId.toLowerCase()
      || typeof value.repo !== "string" || !REPO.test(value.repo)
      || value.repo !== value.repo.toLowerCase() || value.repo.endsWith("/.") || value.repo.endsWith("/..")
      || typeof value.sha !== "string" || !SHA.test(value.sha)
      || typeof value.stagingRunId !== "string" || !/^[1-9][0-9]{0,19}$/.test(value.stagingRunId)
      || !Number.isSafeInteger(value.stagingRunAttempt) || value.stagingRunAttempt < 1
      || value.stagingRunAttempt > 2147483647 || typeof value.expiresAt !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.expiresAt)) return false;
  const expiry = Date.parse(value.expiresAt);
  return Number.isFinite(expiry) && new Date(expiry).toISOString().replace(".000Z", "Z") === value.expiresAt;
}
