CREATE TABLE plugin_pr_doer_wake_2a97cdbae1.wake_ledger (
  company_id uuid NOT NULL,
  fingerprint text NOT NULL,
  repo text NOT NULL,
  pull_number integer NOT NULL,
  head_sha text NOT NULL,
  state text NOT NULL,
  issue_id uuid,
  outcome text NOT NULL DEFAULT 'claimed',
  attempts integer NOT NULL DEFAULT 0,
  signal jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wake_ledger_pk PRIMARY KEY (company_id, fingerprint)
);
CREATE INDEX wake_ledger_outcome_updated_idx ON plugin_pr_doer_wake_2a97cdbae1.wake_ledger (outcome, updated_at);
