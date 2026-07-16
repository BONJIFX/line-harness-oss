-- Bank-transfer completion notices submitted from the CSA LIFF flow.
CREATE TABLE IF NOT EXISTS csa_payment_completion_notices (
  id             TEXT PRIMARY KEY,
  line_user_id   TEXT NOT NULL,
  application_id TEXT NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method = 'bank_transfer'),
  reported_at    TEXT NOT NULL,
  user_agent     TEXT NOT NULL,
  confirmation_sent_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (application_id, payment_method)
);

CREATE INDEX IF NOT EXISTS idx_csa_payment_notices_line_user
  ON csa_payment_completion_notices (line_user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_csa_payment_notices_application
  ON csa_payment_completion_notices (application_id);
