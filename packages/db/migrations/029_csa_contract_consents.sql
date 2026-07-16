-- CSA prepayment contract consent audit log.
-- Append-only: consent rows must not be updated or deleted during normal operation.
CREATE TABLE IF NOT EXISTS csa_contract_consents (
  id                         TEXT PRIMARY KEY,
  line_user_id               TEXT NOT NULL,
  line_display_name          TEXT,
  application_id             TEXT,
  contract_version           TEXT NOT NULL,
  displayed_copy_version     TEXT NOT NULL,
  displayed_copy_sha256      TEXT NOT NULL,
  terms_version              TEXT NOT NULL,
  commerce_law_version       TEXT NOT NULL,
  privacy_policy_version     TEXT NOT NULL,
  agreed_terms               INTEGER NOT NULL CHECK (agreed_terms = 1),
  agreed_privacy             INTEGER NOT NULL CHECK (agreed_privacy = 1),
  agreed_education_no_result INTEGER NOT NULL CHECK (agreed_education_no_result = 1),
  agreed_at                  TEXT NOT NULL,
  payment_method             TEXT NOT NULL CHECK (payment_method IN ('card', 'bank_transfer')),
  user_agent                 TEXT NOT NULL,
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_csa_contract_consents_line_user
  ON csa_contract_consents (line_user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_csa_contract_consents_application
  ON csa_contract_consents (application_id);
