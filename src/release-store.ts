import { UUID } from "./ci-config.js";
import { validReleaseIdentity, type ReleaseIdentity } from "./release-identity.js";

const NAMESPACE = "plugin_pr_custody_2a97cdbae1";
const TABLE = `${NAMESPACE}.release_lifecycle`;
const MATCH = "company_id = $1::uuid AND confirmation_id = $2::uuid AND repo = $3 AND sha = $4 AND staging_run_id = $5 AND staging_run_attempt = $6 AND expires_at = $7::timestamptz";

export type TransitionResult = "applied" | "rejected" | "unknown";
export interface NamespaceDatabase {
  namespace: string;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}

/** Atomic lifecycle transitions only. No result authorizes an external effect. */
export class ReleaseStore {
  constructor(private readonly db: NamespaceDatabase) {}

  private async transition(companyId: string, identity: ReleaseIdentity, operation: "create" | "claim" | "consume" | "revoke", claimId?: string): Promise<TransitionResult> {
    if (this.db.namespace !== NAMESPACE || typeof companyId !== "string" || !UUID.test(companyId)
        || companyId !== companyId.toLowerCase() || !validReleaseIdentity(identity)
        || ((operation === "claim" || operation === "consume")
          && (typeof claimId !== "string" || !UUID.test(claimId) || claimId !== claimId.toLowerCase()))) return "rejected";
    const args: unknown[] = [companyId, identity.confirmationId, identity.repo, identity.sha,
      identity.stagingRunId, identity.stagingRunAttempt, identity.expiresAt];
    let sql: string;
    if (operation === "create") {
      sql = `INSERT INTO ${TABLE} (company_id, confirmation_id, repo, sha, staging_run_id, staging_run_attempt, expires_at, state) SELECT $1::uuid, $2::uuid, $3, $4, $5, $6, $7::timestamptz, 'available' WHERE $7::timestamptz > CURRENT_TIMESTAMP AND $7::timestamptz <= CURRENT_TIMESTAMP + interval '24 hours' ON CONFLICT (confirmation_id) DO NOTHING`;
    } else if (operation === "revoke") {
      sql = `UPDATE ${TABLE} SET state = 'revoked' WHERE ${MATCH} AND state IN ('available', 'claimed')`;
    } else {
      args.push(claimId);
      sql = operation === "claim"
        ? `UPDATE ${TABLE} SET state = 'claimed', claim_id = $8::uuid WHERE ${MATCH} AND state = 'available' AND expires_at > CURRENT_TIMESTAMP`
        : `UPDATE ${TABLE} SET state = 'consumed' WHERE ${MATCH} AND state = 'claimed' AND claim_id = $8::uuid AND expires_at > CURRENT_TIMESTAMP`;
    }
    try {
      const result = await this.db.execute(sql, args);
      // Stock hosts may convert a missing database count to zero.
      return result?.rowCount === 1 ? "applied" : "unknown";
    } catch {
      return "unknown";
    }
  }

  create(companyId: string, identity: ReleaseIdentity): Promise<TransitionResult> {
    return this.transition(companyId, identity, "create");
  }
  claim(companyId: string, identity: ReleaseIdentity, claimId: string): Promise<TransitionResult> {
    return this.transition(companyId, identity, "claim", claimId);
  }
  consume(companyId: string, identity: ReleaseIdentity, claimId: string): Promise<TransitionResult> {
    return this.transition(companyId, identity, "consume", claimId);
  }
  revoke(companyId: string, identity: ReleaseIdentity): Promise<TransitionResult> {
    return this.transition(companyId, identity, "revoke");
  }
}
