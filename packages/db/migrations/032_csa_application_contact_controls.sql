-- Per-applicant contact controls for the CSA application funnel.
-- This table stores current operator intent. Every change is also appended to
-- csa_application_audit_log by the API.

CREATE TABLE IF NOT EXISTS csa_application_contact_controls (
  line_user_id        TEXT PRIMARY KEY,
  reminders_enabled  INTEGER NOT NULL DEFAULT 1 CHECK (reminders_enabled IN (0, 1)),
  contact_status      TEXT NOT NULL DEFAULT 'normal' CHECK (contact_status IN (
    'normal',
    'payment_discussion',
    'payment_date_set',
    'considering',
    'manual_handling',
    'do_not_contact'
  )),
  pause_until         TEXT,
  promised_payment_at TEXT,
  resume_mode         TEXT NOT NULL DEFAULT 'candidate' CHECK (resume_mode IN ('candidate', 'manual', 'never')),
  operator_note       TEXT,
  updated_by          TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_csa_contact_controls_status
  ON csa_application_contact_controls (contact_status, reminders_enabled, pause_until);
