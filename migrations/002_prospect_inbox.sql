-- DenchClaw CRM — migration 002: CRM-owned prospect_inbox (cross-engine handoff queue)
-- Apply against the `denchclaw` database as denchclaw_app.
-- The agent never runs this against a live DB — an operator applies it.
--
-- Reconciled with the engine-side semantics (automation_core.campaigns):
--   target_engine NULLABLE  → NULL = broadcast handoff (claimable by any engine, first-claim-consumes)
--   status        pending | claimed | enrolled | done
--   claimed_by    free TEXT (engines pass a label like 'nurturing' OR a campaign uuid)

CREATE TABLE IF NOT EXISTS prospect_inbox (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id         TEXT NOT NULL,
  contact_id         UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  source_engine      TEXT,
  target_engine      TEXT,
  suggested_campaign TEXT,
  status             TEXT NOT NULL DEFAULT 'pending',
  claimed_by         TEXT,
  metadata           JSONB DEFAULT '{}',
  created_at         TIMESTAMPTZ DEFAULT now(),
  claimed_at         TIMESTAMPTZ
);

-- Two partial unique indexes: NULLs are not unique by default, so the broadcast
-- (NULL target) case needs its own arbiter keyed on contact_id alone.
CREATE UNIQUE INDEX IF NOT EXISTS uq_prospect_inbox_contact_target
  ON prospect_inbox (contact_id, target_engine) WHERE target_engine IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_prospect_inbox_contact_broadcast
  ON prospect_inbox (contact_id) WHERE target_engine IS NULL;

CREATE INDEX IF NOT EXISTS idx_prospect_inbox_pending
  ON prospect_inbox (company_id, target_engine) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_prospect_inbox_company
  ON prospect_inbox (company_id);
