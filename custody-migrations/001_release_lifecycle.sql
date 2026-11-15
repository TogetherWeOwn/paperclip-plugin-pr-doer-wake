CREATE TABLE plugin_pr_custody_2a97cdbae1.release_lifecycle (
  company_id uuid NOT NULL,
  confirmation_id uuid NOT NULL,
  repo text NOT NULL,
  sha text NOT NULL,
  staging_run_id text NOT NULL,
  staging_run_attempt integer NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('available', 'claimed', 'consumed', 'revoked')),
  claim_id uuid,
  PRIMARY KEY (confirmation_id)
);
