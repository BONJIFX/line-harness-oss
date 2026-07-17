-- CSA application funnel foundation.
-- Funnel events and audit records are append-only. Operational actions such as
-- payment verification and reminder delivery are intentionally not enabled by
-- this migration.
CREATE TABLE IF NOT EXISTS csa_application_funnel_events (
  id             TEXT PRIMARY KEY,
  friend_id      TEXT REFERENCES friends (id) ON DELETE SET NULL,
  line_user_id   TEXT NOT NULL,
  application_id TEXT,
  event_type     TEXT NOT NULL CHECK (event_type IN (
    'keyword_received',
    'form_issued',
    'form_opened',
    'form_submitted',
    'payment_reported',
    'payment_verified',
    'approved',
    'activation_sent',
    'membership_activated',
    'discord_linked',
    'reminder_sent'
  )),
  payment_method TEXT CHECK (payment_method IS NULL OR payment_method IN ('card', 'bank_transfer')),
  source         TEXT NOT NULL,
  source_ref     TEXT,
  occurred_at    TEXT NOT NULL,
  metadata_json  TEXT NOT NULL DEFAULT '{}',
  dedupe_key     TEXT NOT NULL UNIQUE,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_csa_funnel_events_line_occurred
  ON csa_application_funnel_events (line_user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_csa_funnel_events_application
  ON csa_application_funnel_events (application_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_csa_funnel_events_type_occurred
  ON csa_application_funnel_events (event_type, occurred_at);

CREATE TRIGGER IF NOT EXISTS trg_csa_funnel_events_no_update
BEFORE UPDATE ON csa_application_funnel_events
BEGIN
  SELECT RAISE(ABORT, 'csa_application_funnel_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_csa_funnel_events_no_delete
BEFORE DELETE ON csa_application_funnel_events
BEGIN
  SELECT RAISE(ABORT, 'csa_application_funnel_events is append-only');
END;

CREATE TABLE IF NOT EXISTS csa_application_reminders (
  id                TEXT PRIMARY KEY,
  line_user_id      TEXT NOT NULL,
  application_id    TEXT,
  reminder_type     TEXT NOT NULL,
  due_at            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN (
    'candidate', 'scheduled', 'sent', 'cancelled', 'skipped', 'failed'
  )),
  auto_send_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_send_enabled = 0),
  sent_at           TEXT,
  message_log_id    TEXT REFERENCES messages_log (id) ON DELETE SET NULL,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  stop_reason       TEXT,
  created_by        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (line_user_id, reminder_type, due_at)
);

CREATE INDEX IF NOT EXISTS idx_csa_reminders_status_due
  ON csa_application_reminders (status, due_at);
CREATE INDEX IF NOT EXISTS idx_csa_reminders_line
  ON csa_application_reminders (line_user_id, created_at);

CREATE TABLE IF NOT EXISTS csa_payment_verifications (
  id                  TEXT PRIMARY KEY,
  line_user_id        TEXT NOT NULL,
  application_id      TEXT NOT NULL,
  payment_method      TEXT NOT NULL CHECK (payment_method IN ('card', 'bank_transfer')),
  verification_status TEXT NOT NULL CHECK (verification_status IN ('verified', 'rejected', 'revoked')),
  verified_amount     INTEGER,
  provider_reference  TEXT,
  note                TEXT,
  actor_staff_id      TEXT,
  occurred_at         TEXT NOT NULL,
  dedupe_key          TEXT NOT NULL UNIQUE,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_csa_payment_verifications_application
  ON csa_payment_verifications (application_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_csa_payment_verifications_line
  ON csa_payment_verifications (line_user_id, occurred_at);

CREATE TRIGGER IF NOT EXISTS trg_csa_payment_verifications_no_update
BEFORE UPDATE ON csa_payment_verifications
BEGIN
  SELECT RAISE(ABORT, 'csa_payment_verifications is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_csa_payment_verifications_no_delete
BEFORE DELETE ON csa_payment_verifications
BEGIN
  SELECT RAISE(ABORT, 'csa_payment_verifications is append-only');
END;

CREATE TABLE IF NOT EXISTS csa_application_audit_log (
  id             TEXT PRIMARY KEY,
  line_user_id   TEXT,
  application_id TEXT,
  actor_staff_id TEXT,
  action         TEXT NOT NULL,
  before_json    TEXT,
  after_json     TEXT,
  reason         TEXT,
  occurred_at    TEXT NOT NULL,
  request_id     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_csa_audit_application
  ON csa_application_audit_log (application_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_csa_audit_line
  ON csa_application_audit_log (line_user_id, occurred_at);

CREATE TRIGGER IF NOT EXISTS trg_csa_audit_no_update
BEFORE UPDATE ON csa_application_audit_log
BEGIN
  SELECT RAISE(ABORT, 'csa_application_audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_csa_audit_no_delete
BEFORE DELETE ON csa_application_audit_log
BEGIN
  SELECT RAISE(ABORT, 'csa_application_audit_log is append-only');
END;

INSERT OR IGNORE INTO csa_application_audit_log (
  id, actor_staff_id, action, before_json, after_json, reason, occurred_at, request_id
) VALUES (
  'system:csa-funnel:auto-reminders-disabled:v1',
  'system',
  'auto_reminders_configured',
  NULL,
  json_object(
    'enabled', 0,
    'automaticDelivery', 0,
    'manualConfirmationRequired', 1,
    'deliveryWindowStartJst', '09:00',
    'deliveryWindowEndJst', '21:00'
  ),
  'Initial CSA funnel release: candidate visibility only; no reminder route or delivery job',
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'),
  'migration:031'
);

-- Safe, idempotent backfill from the evidence already held by LINE Harness.
INSERT OR IGNORE INTO csa_application_funnel_events (
  id, friend_id, line_user_id, application_id, event_type, payment_method,
  source, source_ref, occurred_at, metadata_json, dedupe_key
)
SELECT
  'backfill:keyword:' || ml.id,
  f.id,
  f.line_user_id,
  NULL,
  'keyword_received',
  NULL,
  'messages_log',
  ml.id,
  ml.created_at,
  json_object('content', trim(ml.content)),
  'messages_log:' || ml.id || ':keyword_received'
FROM messages_log ml
JOIN friends f ON f.id = ml.friend_id
WHERE ml.direction = 'incoming'
  AND lower(trim(ml.content)) IN ('決済', '申込', '申し込み', '入会', 'csa申込', 'csa申し込み');

INSERT OR IGNORE INTO csa_application_funnel_events (
  id, friend_id, line_user_id, application_id, event_type, payment_method,
  source, source_ref, occurred_at, metadata_json, dedupe_key
)
SELECT
  'backfill:form-issued:' || ml.id,
  f.id,
  f.line_user_id,
  NULL,
  'form_issued',
  NULL,
  'messages_log',
  ml.id,
  ml.created_at,
  json_object('messageType', ml.message_type),
  'messages_log:' || ml.id || ':form_issued'
FROM messages_log ml
JOIN friends f ON f.id = ml.friend_id
WHERE ml.direction = 'outgoing'
  AND ml.source = 'csa_payment_intake'
  AND ml.content LIKE '%/api/liff/csa-apply%';

INSERT OR IGNORE INTO csa_application_funnel_events (
  id, friend_id, line_user_id, application_id, event_type, payment_method,
  source, source_ref, occurred_at, metadata_json, dedupe_key
)
SELECT
  'backfill:legacy-payment-reported:' || ml.id,
  f.id,
  f.line_user_id,
  NULL,
  'payment_reported',
  CASE
    WHEN ml.content LIKE '%銀行%' OR ml.content LIKE '%振込%' THEN 'bank_transfer'
    WHEN ml.content LIKE '%カード%' OR ml.content LIKE '%クレカ%' THEN 'card'
    ELSE NULL
  END,
  'messages_log',
  ml.id,
  ml.created_at,
  json_object('content', trim(ml.content), 'legacy', 1),
  'messages_log:' || ml.id || ':payment_reported'
FROM messages_log ml
JOIN friends f ON f.id = ml.friend_id
WHERE ml.direction = 'incoming'
  AND trim(ml.content) = '支払い完了';

INSERT OR IGNORE INTO csa_application_funnel_events (
  id, friend_id, line_user_id, application_id, event_type, payment_method,
  source, source_ref, occurred_at, metadata_json, dedupe_key
)
SELECT
  'backfill:consent:' || cc.id,
  f.id,
  cc.line_user_id,
  cc.application_id,
  'form_submitted',
  cc.payment_method,
  'csa_contract_consents',
  cc.id,
  cc.agreed_at,
  json_object('contractVersion', cc.contract_version),
  'csa_contract_consents:' || cc.id || ':form_submitted'
FROM csa_contract_consents cc
LEFT JOIN friends f ON f.line_user_id = cc.line_user_id;

INSERT OR IGNORE INTO csa_application_funnel_events (
  id, friend_id, line_user_id, application_id, event_type, payment_method,
  source, source_ref, occurred_at, metadata_json, dedupe_key
)
SELECT
  'backfill:payment-reported:' || pn.id,
  f.id,
  pn.line_user_id,
  pn.application_id,
  'payment_reported',
  pn.payment_method,
  'csa_payment_completion_notices',
  pn.id,
  pn.reported_at,
  json_object('confirmationSentAt', pn.confirmation_sent_at),
  'csa_payment_completion_notices:' || pn.id || ':payment_reported'
FROM csa_payment_completion_notices pn
LEFT JOIN friends f ON f.line_user_id = pn.line_user_id;
