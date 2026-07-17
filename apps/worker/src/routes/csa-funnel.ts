import { Hono } from 'hono';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';

export type CsaFunnelEventType =
  | 'keyword_received'
  | 'form_issued'
  | 'form_opened'
  | 'form_submitted'
  | 'payment_reported'
  | 'payment_verified'
  | 'approved'
  | 'activation_sent'
  | 'membership_activated'
  | 'discord_linked'
  | 'reminder_sent';

type PaymentMethod = 'card' | 'bank_transfer';

export type CsaApplicantStage =
  | 'keyword_received'
  | 'form_issued'
  | 'form_opened'
  | 'form_submitted'
  | 'payment_pending'
  | 'payment_reported'
  | 'payment_verified'
  | 'onboarding_sent'
  | 'membership_active'
  | 'discord_linked';

export type CsaApplicant = {
  friendId: string | null;
  lineUserId: string;
  displayName: string | null;
  pictureUrl: string | null;
  currentStage: CsaApplicantStage;
  keywordReceivedAt: string | null;
  formIssuedAt: string | null;
  formOpenedAt: string | null;
  formSubmittedAt: string | null;
  paymentMethod: PaymentMethod | null;
  paymentReportedAt: string | null;
  paymentVerifiedAt: string | null;
  onboardingSentAt: string | null;
  membershipActivatedAt: string | null;
  discordLinkedAt: string | null;
  lastContactAt: string;
  lastReminderAt: string | null;
  reminderCount: number;
  attentionReason: string | null;
  attentionLevel: 'urgent' | 'waiting' | 'normal' | null;
  paymentMismatch: boolean;
  mismatchWarnings: string[];
};

export type FunnelEventRow = {
  id: string;
  friend_id: string | null;
  line_user_id: string;
  application_id: string | null;
  event_type: CsaFunnelEventType;
  payment_method: PaymentMethod | null;
  occurred_at: string;
  display_name: string | null;
  picture_url: string | null;
};

export type PaymentVerificationRow = {
  line_user_id: string;
  application_id: string;
  payment_method: PaymentMethod;
  verification_status: 'verified' | 'rejected' | 'revoked';
  occurred_at: string;
};

export type ReminderCountRow = {
  line_user_id: string;
  sent_count: number;
  last_reminder_at: string | null;
};

const STAGES: Array<{ key: CsaApplicantStage; label: string; timeKey?: keyof CsaApplicant }> = [
  { key: 'keyword_received', label: 'キーワード受信', timeKey: 'keywordReceivedAt' },
  { key: 'form_issued', label: 'フォーム発行済み', timeKey: 'formIssuedAt' },
  { key: 'form_opened', label: 'フォーム閲覧済み', timeKey: 'formOpenedAt' },
  { key: 'form_submitted', label: 'フォーム送信済み', timeKey: 'formSubmittedAt' },
  { key: 'payment_pending', label: '支払待ち' },
  { key: 'payment_reported', label: '支払申告済み', timeKey: 'paymentReportedAt' },
  { key: 'payment_verified', label: '決済確認済み', timeKey: 'paymentVerifiedAt' },
  { key: 'onboarding_sent', label: '会員登録案内済み', timeKey: 'onboardingSentAt' },
  { key: 'membership_active', label: '会員化完了', timeKey: 'membershipActivatedAt' },
  { key: 'discord_linked', label: 'Discord連携完了', timeKey: 'discordLinkedAt' },
];

const EVENT_TIME_KEYS: Partial<Record<CsaFunnelEventType, keyof CsaApplicant>> = {
  keyword_received: 'keywordReceivedAt',
  form_issued: 'formIssuedAt',
  form_opened: 'formOpenedAt',
  form_submitted: 'formSubmittedAt',
  payment_reported: 'paymentReportedAt',
  payment_verified: 'paymentVerifiedAt',
  activation_sent: 'onboardingSentAt',
  membership_activated: 'membershipActivatedAt',
  discord_linked: 'discordLinkedAt',
};

export const CURRENT_CSA_CAMPAIGN_FROM = '2026-07-17T20:00:00+09:00';

export const csaFunnel = new Hono<Env>();

export type RecordCsaFunnelEventInput = {
  friendId?: string | null;
  lineUserId: string;
  applicationId?: string | null;
  eventType: CsaFunnelEventType;
  paymentMethod?: PaymentMethod | null;
  source: string;
  sourceRef?: string | null;
  occurredAt: string;
  metadata?: Record<string, unknown>;
  dedupeKey: string;
};

csaFunnel.use('/api/csa-funnel/*', requireRole('owner', 'admin'));

csaFunnel.get('/api/csa-funnel/summary', async (c) => {
  const window = resolveCampaignWindow(c.req.query('campaignKey'), c.req.query('from'), c.req.query('to'));
  const applicants = filterApplicantsByWindow(await loadApplicants(c.env.DB, window.from, window.to), window.from, window.to);
  return c.json({
    success: true,
    data: { ...buildCsaFunnelSummary(applicants), campaignKey: window.campaignKey, from: window.from, to: window.to },
  });
});

csaFunnel.get('/api/csa-funnel/applicants', async (c) => {
  const window = resolveCampaignWindow(c.req.query('campaignKey'), c.req.query('from'), c.req.query('to'));
  let items = filterApplicantsByWindow(await loadApplicants(c.env.DB, window.from, window.to), window.from, window.to);
  const stage = c.req.query('stage');
  const attention = c.req.query('attention');
  const mismatch = c.req.query('mismatch');
  const paymentMethod = c.req.query('paymentMethod');
  const query = (c.req.query('q') || '').trim().toLocaleLowerCase('ja');

  if (stage) items = items.filter((item) => item.currentStage === stage);
  if (attention === 'true') items = items.filter((item) => Boolean(item.attentionReason));
  if (attention === 'false') items = items.filter((item) => !item.attentionReason);
  if (mismatch === 'true') items = items.filter((item) => item.paymentMismatch);
  if (mismatch === 'false') items = items.filter((item) => !item.paymentMismatch);
  if (paymentMethod === 'card' || paymentMethod === 'bank_transfer') {
    items = items.filter((item) => item.paymentMethod === paymentMethod);
  }
  if (query) {
    items = items.filter((item) =>
      item.lineUserId.toLocaleLowerCase('ja').includes(query)
      || (item.displayName || '').toLocaleLowerCase('ja').includes(query),
    );
  }

  const total = items.length;
  const limit = clampInteger(c.req.query('limit'), 50, 1, 200);
  const offset = clampInteger(c.req.query('offset'), 0, 0, Math.max(total, 0));
  items = items.slice(offset, offset + limit);

  return c.json({
    success: true,
    data: { items, total, campaignKey: window.campaignKey, from: window.from, to: window.to },
  });
});

export async function recordCsaFunnelEvent(
  db: D1Database,
  input: RecordCsaFunnelEventInput,
): Promise<{ id: string; created: boolean }> {
  const id = crypto.randomUUID();
  const result = await db.prepare(
    `INSERT INTO csa_application_funnel_events (
      id, friend_id, line_user_id, application_id, event_type, payment_method,
      source, source_ref, occurred_at, metadata_json, dedupe_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedupe_key) DO NOTHING`,
  ).bind(
    id,
    input.friendId || null,
    input.lineUserId,
    input.applicationId || null,
    input.eventType,
    input.paymentMethod || null,
    input.source,
    input.sourceRef || null,
    input.occurredAt,
    JSON.stringify(input.metadata || {}),
    input.dedupeKey,
  ).run();

  const saved = await db.prepare(
    `SELECT id, line_user_id, application_id, event_type, payment_method, dedupe_key
     FROM csa_application_funnel_events WHERE dedupe_key = ?`,
  ).bind(input.dedupeKey).first<{
    id: string;
    line_user_id: string;
    application_id: string | null;
    event_type: string;
    payment_method: string | null;
    dedupe_key: string;
  }>();

  if (
    !saved
    || saved.line_user_id !== input.lineUserId
    || saved.application_id !== (input.applicationId || null)
    || saved.event_type !== input.eventType
    || saved.payment_method !== (input.paymentMethod || null)
    || saved.dedupe_key !== input.dedupeKey
  ) {
    throw new Error('CSA funnel event readback mismatch');
  }

  return { id: saved.id, created: Number(result.meta.changes || 0) > 0 };
}

export async function recordCsaFunnelEventSafely(
  db: D1Database,
  input: RecordCsaFunnelEventInput,
  context: string,
): Promise<void> {
  try {
    await recordCsaFunnelEvent(db, input);
  } catch (error) {
    // Funnel tracking is recoverable from the append-only source records. It
    // must never block the application form or consume a LINE reply token.
    console.error(`CSA funnel tracking failed (${context}):`, error);
  }
}

export function buildCsaApplicants(
  events: FunnelEventRow[],
  verifications: PaymentVerificationRow[] = [],
  reminderCounts: ReminderCountRow[] = [],
): CsaApplicant[] {
  const byLineUser = new Map<string, CsaApplicant & { paymentMethods: Set<PaymentMethod>; eventReminderCount: number }>();
  const dbReminderCounts = new Map(reminderCounts.map((row) => [row.line_user_id, row]));

  for (const event of [...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))) {
    const applicant = byLineUser.get(event.line_user_id) || createApplicant(event);
    if (!applicant.friendId && event.friend_id) applicant.friendId = event.friend_id;
    if (!applicant.displayName && event.display_name) applicant.displayName = event.display_name;
    if (!applicant.pictureUrl && event.picture_url) applicant.pictureUrl = event.picture_url;
    applicant.lastContactAt = maxDate(applicant.lastContactAt, event.occurred_at);
    if (event.payment_method) {
      applicant.paymentMethods.add(event.payment_method);
      applicant.paymentMethod = event.payment_method;
    }
    const timeKey = EVENT_TIME_KEYS[event.event_type];
    if (timeKey) setLatestTime(applicant, timeKey, event.occurred_at);
    if (event.event_type === 'reminder_sent') {
      applicant.eventReminderCount += 1;
      applicant.lastReminderAt = maxNullableDate(applicant.lastReminderAt, event.occurred_at);
    }
    byLineUser.set(event.line_user_id, applicant);
  }

  for (const verification of [...verifications].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))) {
    const applicant = byLineUser.get(verification.line_user_id);
    if (!applicant) continue;
    applicant.paymentMethods.add(verification.payment_method);
    applicant.paymentMethod = verification.payment_method;
    applicant.lastContactAt = maxDate(applicant.lastContactAt, verification.occurred_at);
    applicant.paymentVerifiedAt = verification.verification_status === 'verified'
      ? verification.occurred_at
      : null;
  }

  return [...byLineUser.values()].map((applicant) => {
    applicant.paymentMismatch = applicant.paymentMethods.size > 1;
    const reminderRow = dbReminderCounts.get(applicant.lineUserId);
    applicant.reminderCount = Math.max(
      applicant.eventReminderCount,
      Number(reminderRow?.sent_count || 0),
    );
    applicant.lastReminderAt = maxNullableDate(applicant.lastReminderAt, reminderRow?.last_reminder_at || null);
    applicant.currentStage = currentStage(applicant);
    applicant.attentionReason = attentionReason(applicant);
    applicant.attentionLevel = attentionLevel(applicant.attentionReason);
    applicant.mismatchWarnings = applicant.paymentMismatch
      ? [`payment methods do not match: ${[...applicant.paymentMethods].sort().join(', ')}`]
      : [];
    const { paymentMethods: _paymentMethods, eventReminderCount: _eventReminderCount, ...result } = applicant;
    return result;
  }).sort((a, b) => b.lastContactAt.localeCompare(a.lastContactAt));
}

export function buildCsaFunnelSummary(applicants: CsaApplicant[]) {
  const reached = (timeKey: keyof CsaApplicant) => applicants.filter((item) => Boolean(item[timeKey])).length;
  const stages = STAGES.map((stage) => ({
    key: stage.key,
    label: stage.label,
    count: stage.timeKey
      ? reached(stage.timeKey)
      : applicants.filter((item) => item.currentStage === stage.key).length,
  }));
  const keywordCount = reached('keywordReceivedAt');
  const submittedCount = reached('formSubmittedAt');
  const verifiedCount = reached('paymentVerifiedAt');
  const activatedCount = reached('membershipActivatedAt');

  return {
    stages,
    conversionRates: {
      keywordToFormSubmitted: percentage(submittedCount, keywordCount),
      formSubmittedToPaymentVerified: percentage(verifiedCount, submittedCount),
      paymentVerifiedToActivated: percentage(activatedCount, verifiedCount),
    },
    attentionCount: applicants.filter((item) => Boolean(item.attentionReason)).length,
    mismatchCount: applicants.filter((item) => item.paymentMismatch).length,
    autoReminderEnabled: false,
  };
}

async function loadApplicants(db: D1Database, from: string | null, to: string | null): Promise<CsaApplicant[]> {
  const [eventsResult, verificationsResult, remindersResult] = await Promise.all([
    db.prepare(
      `SELECT e.id, e.friend_id, e.line_user_id, e.application_id, e.event_type,
              e.payment_method, e.occurred_at, f.display_name, f.picture_url
       FROM csa_application_funnel_events e
       LEFT JOIN friends f ON f.line_user_id = e.line_user_id
       WHERE (? IS NULL OR julianday(e.occurred_at) >= julianday(?))
         AND (? IS NULL OR julianday(e.occurred_at) <= julianday(?))
       ORDER BY e.occurred_at ASC`,
    ).bind(from, from, to, to).all<FunnelEventRow>(),
    db.prepare(
      `SELECT line_user_id, application_id, payment_method, verification_status, occurred_at
       FROM csa_payment_verifications
       WHERE (? IS NULL OR julianday(occurred_at) >= julianday(?))
         AND (? IS NULL OR julianday(occurred_at) <= julianday(?))
       ORDER BY occurred_at ASC`,
    ).bind(from, from, to, to).all<PaymentVerificationRow>(),
    db.prepare(
      `SELECT line_user_id, COUNT(*) AS sent_count, MAX(sent_at) AS last_reminder_at
       FROM csa_application_reminders
       WHERE status = 'sent'
         AND (? IS NULL OR julianday(sent_at) >= julianday(?))
         AND (? IS NULL OR julianday(sent_at) <= julianday(?))
       GROUP BY line_user_id`,
    ).bind(from, from, to, to).all<ReminderCountRow>(),
  ]);
  return buildCsaApplicants(eventsResult.results, verificationsResult.results, remindersResult.results);
}

function createApplicant(event: FunnelEventRow) {
  return {
    friendId: event.friend_id,
    lineUserId: event.line_user_id,
    displayName: event.display_name,
    pictureUrl: event.picture_url,
    currentStage: 'keyword_received' as CsaApplicantStage,
    keywordReceivedAt: null,
    formIssuedAt: null,
    formOpenedAt: null,
    formSubmittedAt: null,
    paymentMethod: null,
    paymentReportedAt: null,
    paymentVerifiedAt: null,
    onboardingSentAt: null,
    membershipActivatedAt: null,
    discordLinkedAt: null,
    lastContactAt: event.occurred_at,
    lastReminderAt: null,
    reminderCount: 0,
    attentionReason: null,
    attentionLevel: null,
    paymentMismatch: false,
    mismatchWarnings: [],
    paymentMethods: new Set<PaymentMethod>(),
    eventReminderCount: 0,
  };
}

function setLatestTime(applicant: CsaApplicant, key: keyof CsaApplicant, occurredAt: string) {
  const current = applicant[key];
  if ((typeof current !== 'string' || occurredAt > current)) {
    (applicant as unknown as Record<string, unknown>)[key] = occurredAt;
  }
}

function currentStage(applicant: CsaApplicant): CsaApplicantStage {
  for (let index = STAGES.length - 1; index >= 0; index -= 1) {
    const stage = STAGES[index];
    if (stage.key === 'payment_pending' && applicant.formSubmittedAt && !applicant.paymentReportedAt && !applicant.paymentVerifiedAt) {
      return stage.key;
    }
    if (stage.timeKey && applicant[stage.timeKey]) return stage.key;
  }
  return 'keyword_received';
}

function attentionReason(applicant: CsaApplicant): string | null {
  if (applicant.paymentMismatch) return 'paymentMethodMismatch';
  if (!applicant.formSubmittedAt) return 'formNotSubmitted';
  if (!applicant.paymentVerifiedAt) {
    return applicant.paymentReportedAt ? 'paymentVerificationPending' : 'paymentNotReported';
  }
  if (!applicant.onboardingSentAt) return 'activationNotSent';
  if (!applicant.membershipActivatedAt) return 'activationIncomplete';
  if (!applicant.discordLinkedAt) return 'discordNotLinked';
  return null;
}

function attentionLevel(reason: string | null): 'urgent' | 'waiting' | 'normal' | null {
  if (!reason) return null;
  if (reason === 'paymentMethodMismatch' || reason === 'paymentVerificationPending' || reason === 'activationNotSent') {
    return 'urgent';
  }
  return 'waiting';
}

function maxDate(left: string, right: string): string {
  return right > left ? right : left;
}

function maxNullableDate(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return maxDate(left, right);
}

function percentage(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

function clampInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function resolveCampaignWindow(campaignKey?: string, from?: string, to?: string) {
  const allTime = campaignKey === 'all';
  return {
    campaignKey: allTime ? 'all' : 'current',
    from: allTime ? normalizeWindowDate(from) : normalizeWindowDate(from) || CURRENT_CSA_CAMPAIGN_FROM,
    to: normalizeWindowDate(to),
  };
}

function normalizeWindowDate(value?: string): string | null {
  if (!value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

export function filterApplicantsByWindow(applicants: CsaApplicant[], from: string | null, to: string | null): CsaApplicant[] {
  const fromMs = from ? Date.parse(from) : Number.NEGATIVE_INFINITY;
  const toMs = to ? Date.parse(to) : Number.POSITIVE_INFINITY;
  return applicants.filter((applicant) => {
    const anchor = applicant.keywordReceivedAt || applicant.formIssuedAt || applicant.lastContactAt;
    const anchorMs = Date.parse(anchor);
    return Number.isFinite(anchorMs) && anchorMs >= fromMs && anchorMs <= toMs;
  });
}
