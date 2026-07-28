// @ts-expect-error vitest is provided by the workspace SDK package used to run worker tests.
import { describe, expect, it, vi, beforeEach } from 'vitest';

// This test mocks @line-crm/db and @line-crm/line-sdk BEFORE importing the
// module under test, so csa-reminder-delivery.ts never touches a real D1
// database or the real LINE Messaging API.
const pushMessageMock = vi.fn(async () => ({}));

vi.mock('@line-crm/line-sdk', () => {
  class LineClient {
    constructor(_token: string) {}
    pushMessage = pushMessageMock;
  }
  return { LineClient };
});

vi.mock('@line-crm/db', () => ({
  getFriendByLineUserId: vi.fn(async (_db: unknown, lineUserId: string) => ({
    id: `friend:${lineUserId}`,
    line_user_id: lineUserId,
    display_name: lineUserId,
    picture_url: null,
    status_message: null,
    is_following: 1,
    user_id: null,
    line_account_id: null,
    metadata: '{}',
    first_tracked_link_id: null,
    created_at: '2026-07-17T20:00:00+09:00',
    updated_at: '2026-07-17T20:00:00+09:00',
  })),
  getLineAccountById: vi.fn(async () => null),
  jstNow: () => '2026-07-18T12:00:00+09:00',
}));

const { processCsaReminderDeliveries, isDueTarget } = await import('./csa-reminder-delivery.js');
const { buildReminderCandidate } = await import('../routes/csa-funnel.js');

// ── Fake D1Database ────────────────────────────────────────────────────────
// Minimal in-memory stand-in covering only the statements this module issues:
// - SELECT ... FROM csa_application_funnel_events (via loadApplicants)
// - SELECT ... FROM csa_payment_verifications
// - SELECT ... FROM csa_application_reminders (aggregate + de-dupe lookup)
// - SELECT ... FROM csa_application_contact_controls
// - INSERT INTO messages_log
// - INSERT OR IGNORE INTO csa_application_reminders
// - INSERT ... INTO csa_application_funnel_events (recordCsaFunnelEventSafely)

type FunnelEventSeed = {
  id: string;
  friend_id: string | null;
  line_user_id: string;
  application_id: string | null;
  event_type: string;
  payment_method: string | null;
  occurred_at: string;
  display_name: string | null;
  picture_url: string | null;
};

function makeFakeDb(seed: { events: FunnelEventSeed[]; contactControls?: any[] }) {
  const state = {
    events: [...seed.events],
    reminders: [] as Array<{ id: string; line_user_id: string; reminder_type: string; due_at: string; status: string; sent_at: string; message_log_id: string }>,
    messagesLog: [] as Array<{ id: string; friend_id: string; content: string }>,
    contactControls: seed.contactControls || [],
  };

  const db = {
    prepare(sql: string) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      const makeStatement = (args: unknown[]) => ({
            bind(...nextArgs: unknown[]) {
              return makeStatement(nextArgs);
            },
            async all() {
              if (normalized.startsWith('SELECT e.id, e.friend_id, e.line_user_id')) {
                return { results: state.events };
              }
              if (normalized.startsWith('SELECT line_user_id, application_id, payment_method, verification_status')) {
                return { results: [] };
              }
              if (normalized.startsWith('SELECT line_user_id, COUNT(*) AS sent_count')) {
                const counts = new Map<string, number>();
                const lastAt = new Map<string, string>();
                for (const r of state.reminders) {
                  if (r.status !== 'sent') continue;
                  counts.set(r.line_user_id, (counts.get(r.line_user_id) || 0) + 1);
                  const cur = lastAt.get(r.line_user_id);
                  if (!cur || r.sent_at > cur) lastAt.set(r.line_user_id, r.sent_at);
                }
                return {
                  results: [...counts.entries()].map(([line_user_id, sent_count]) => ({
                    line_user_id,
                    sent_count,
                    last_reminder_at: lastAt.get(line_user_id) || null,
                  })),
                };
              }
              if (normalized.startsWith('SELECT line_user_id, reminders_enabled, contact_status')) {
                return { results: state.contactControls };
              }
              throw new Error(`fake D1: unhandled .all() for: ${normalized}`);
            },
            async first<T>() {
              if (normalized.startsWith('SELECT 1 AS found FROM csa_application_reminders')) {
                const [lineUserId, reminderType] = args as [string, string];
                const found = state.reminders.some(
                  (r) => r.line_user_id === lineUserId && r.reminder_type === reminderType && r.status === 'sent',
                );
                return (found ? { found: 1 } : null) as unknown as T;
              }
              if (normalized.startsWith('SELECT id, line_user_id, application_id, event_type, payment_method, dedupe_key')) {
                // recordCsaFunnelEvent readback — synthesize from the last funnel event insert
                const [dedupeKey] = args as [string];
                const row = (state as any).lastFunnelInsert;
                if (row && row.dedupe_key === dedupeKey) return row as unknown as T;
                return null as unknown as T;
              }
              throw new Error(`fake D1: unhandled .first() for: ${normalized}`);
            },
            async run() {
              if (normalized.startsWith('INSERT INTO messages_log')) {
                const [id, friend_id, content] = args as [string, string, string];
                state.messagesLog.push({ id, friend_id, content });
                return { meta: { changes: 1 } };
              }
              if (normalized.startsWith('INSERT OR IGNORE INTO csa_application_reminders')) {
                // Bind order matches the production statement's placeholders only
                // (NULL/'sent'/1/'system:...' are literals, not bind params):
                // id, line_user_id, reminder_type, due_at, sent_at, message_log_id
                const [id, line_user_id, reminder_type, due_at, sent_at, message_log_id] = args as [
                  string, string, string, string, string, string,
                ];
                const dup = state.reminders.some(
                  (r) => r.line_user_id === line_user_id && r.reminder_type === reminder_type && r.due_at === due_at,
                );
                if (!dup) {
                  state.reminders.push({ id, line_user_id, reminder_type, due_at, status: 'sent', sent_at, message_log_id });
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              if (normalized.startsWith('INSERT INTO csa_application_funnel_events')) {
                const [id, friend_id, line_user_id, application_id, event_type, payment_method, source, source_ref, occurred_at, metadata_json, dedupe_key] = args as string[];
                const row = {
                  id, friend_id, line_user_id, application_id, event_type,
                  payment_method, occurred_at, display_name: null, picture_url: null,
                  dedupe_key,
                };
                state.events.push(row as unknown as FunnelEventSeed);
                (state as any).lastFunnelInsert = row;
                return { meta: { changes: 1 } };
              }
              throw new Error(`fake D1: unhandled .run() for: ${normalized}`);
            },
      });
      return makeStatement([]);
    },
    state,
  };

  return db as unknown as D1Database & { state: typeof state };
}

function seedEvent(overrides: Partial<FunnelEventSeed> & { line_user_id: string; event_type: string; occurred_at: string }): FunnelEventSeed {
  return {
    id: `${overrides.line_user_id}:${overrides.event_type}:${overrides.occurred_at}`,
    friend_id: `friend:${overrides.line_user_id}`,
    application_id: null,
    payment_method: null,
    display_name: overrides.line_user_id,
    picture_url: null,
    ...overrides,
  } as FunnelEventSeed;
}

beforeEach(() => {
  pushMessageMock.mockClear();
});

describe('isDueTarget (scope filter)', () => {
  it('accepts a due form_not_opened candidate with user messaging allowed', () => {
    const candidate = buildReminderCandidate(
      {
        formIssuedAt: '2026-07-17T20:00:00+09:00',
        formOpenedAt: null,
        formSubmittedAt: null,
        paymentReportedAt: null,
        paymentVerifiedAt: null,
        onboardingSentAt: null,
        membershipActivatedAt: null,
        reminderCount: 0,
        contactControl: {
          remindersEnabled: true, contactStatus: 'normal', pauseUntil: null,
          promisedPaymentAt: null, resumeMode: 'candidate', operatorNote: null,
          updatedBy: null, updatedAt: null,
        },
      } as any,
      new Date('2026-07-18T12:00:00+09:00'),
    );
    expect(isDueTarget(candidate)).toBe(true);
  });

  it('rejects a card_payment_pending candidate (out of scope for this ticket)', () => {
    const candidate = buildReminderCandidate(
      {
        formIssuedAt: '2026-07-16T20:00:00+09:00',
        formOpenedAt: '2026-07-16T20:05:00+09:00',
        formSubmittedAt: '2026-07-17T10:00:00+09:00',
        paymentMethod: 'card',
        paymentReportedAt: null,
        paymentVerifiedAt: null,
        onboardingSentAt: null,
        membershipActivatedAt: null,
        reminderCount: 0,
        contactControl: {
          remindersEnabled: true, contactStatus: 'normal', pauseUntil: null,
          promisedPaymentAt: null, resumeMode: 'candidate', operatorNote: null,
          updatedBy: null, updatedAt: null,
        },
      } as any,
      new Date('2026-07-18T18:00:00+09:00'),
    );
    expect(candidate.kind).toBe('card_payment_pending');
    expect(isDueTarget(candidate)).toBe(false);
  });
});

describe('processCsaReminderDeliveries', () => {
  // 全テストで申込作成時刻(keyword_received)が CSA_REMINDER_EPOCH 以降になるよう、
  // epoch はテスト内の最も早い keyword_received より前の固定値を使う。
  const EPOCH = '2026-07-01T00:00:00+09:00';

  it('sends nothing when CSA_REMINDER_AUTO_SEND is not "true" (dry-run default)', async () => {
    const db = makeFakeDb({
      events: [
        seedEvent({ line_user_id: 'line-1', event_type: 'keyword_received', occurred_at: '2026-07-17T20:00:00+09:00' }),
        seedEvent({ line_user_id: 'line-1', event_type: 'form_issued', occurred_at: '2026-07-17T20:01:00+09:00' }),
      ],
    });

    await processCsaReminderDeliveries({ DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'token', CSA_REMINDER_EPOCH: EPOCH });

    expect(pushMessageMock).not.toHaveBeenCalled();
    expect(db.state.reminders).toHaveLength(0);
  });

  it('sends exactly once for a due, allowed candidate when CSA_REMINDER_AUTO_SEND="true"', async () => {
    const db = makeFakeDb({
      events: [
        seedEvent({ line_user_id: 'line-1', event_type: 'keyword_received', occurred_at: '2026-07-16T20:00:00+09:00' }),
        seedEvent({ line_user_id: 'line-1', event_type: 'form_issued', occurred_at: '2026-07-16T20:01:00+09:00' }),
      ],
    });

    await processCsaReminderDeliveries({ DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'token', CSA_REMINDER_AUTO_SEND: 'true', CSA_REMINDER_EPOCH: EPOCH });

    expect(pushMessageMock).toHaveBeenCalledTimes(1);
    expect(db.state.reminders).toHaveLength(1);
    expect(db.state.reminders[0]).toMatchObject({ line_user_id: 'line-1', status: 'sent', reminder_type: 'form_not_opened_next_12' });
  });

  it('does not send a second time for the same candidate on a repeat run', async () => {
    const db = makeFakeDb({
      events: [
        seedEvent({ line_user_id: 'line-1', event_type: 'keyword_received', occurred_at: '2026-07-16T20:00:00+09:00' }),
        seedEvent({ line_user_id: 'line-1', event_type: 'form_issued', occurred_at: '2026-07-16T20:01:00+09:00' }),
      ],
    });
    const env = { DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'token', CSA_REMINDER_AUTO_SEND: 'true', CSA_REMINDER_EPOCH: EPOCH };

    await processCsaReminderDeliveries(env);
    await processCsaReminderDeliveries(env);

    expect(pushMessageMock).toHaveBeenCalledTimes(1);
    expect(db.state.reminders).toHaveLength(1);
  });

  it('excludes a do_not_contact applicant from delivery', async () => {
    const db = makeFakeDb({
      events: [
        seedEvent({ line_user_id: 'line-1', event_type: 'keyword_received', occurred_at: '2026-07-16T20:00:00+09:00' }),
        seedEvent({ line_user_id: 'line-1', event_type: 'form_issued', occurred_at: '2026-07-16T20:01:00+09:00' }),
      ],
      contactControls: [{
        line_user_id: 'line-1',
        reminders_enabled: 1,
        contact_status: 'do_not_contact',
        pause_until: null,
        promised_payment_at: null,
        resume_mode: 'candidate',
        operator_note: null,
        updated_by: null,
        updated_at: null,
      }],
    });

    await processCsaReminderDeliveries({ DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'token', CSA_REMINDER_AUTO_SEND: 'true', CSA_REMINDER_EPOCH: EPOCH });

    expect(pushMessageMock).not.toHaveBeenCalled();
    expect(db.state.reminders).toHaveLength(0);
  });

  it('excludes an applicant who already has 2 reminders sent (reminder limit reached)', async () => {
    const db = makeFakeDb({
      events: [
        seedEvent({ line_user_id: 'line-1', event_type: 'keyword_received', occurred_at: '2026-07-10T20:00:00+09:00' }),
        seedEvent({ line_user_id: 'line-1', event_type: 'form_issued', occurred_at: '2026-07-10T20:01:00+09:00' }),
        seedEvent({ line_user_id: 'line-1', event_type: 'reminder_sent', occurred_at: '2026-07-11T12:00:00+09:00' }),
        seedEvent({ line_user_id: 'line-1', event_type: 'reminder_sent', occurred_at: '2026-07-12T12:00:00+09:00' }),
      ],
    });

    await processCsaReminderDeliveries({ DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'token', CSA_REMINDER_AUTO_SEND: 'true', CSA_REMINDER_EPOCH: EPOCH });

    expect(pushMessageMock).not.toHaveBeenCalled();
  });

  it('sends nothing and logs fail-closed when CSA_REMINDER_EPOCH is unset', async () => {
    const db = makeFakeDb({
      events: [
        seedEvent({ line_user_id: 'line-1', event_type: 'keyword_received', occurred_at: '2026-07-16T20:00:00+09:00' }),
        seedEvent({ line_user_id: 'line-1', event_type: 'form_issued', occurred_at: '2026-07-16T20:01:00+09:00' }),
      ],
    });

    await processCsaReminderDeliveries({ DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'token', CSA_REMINDER_AUTO_SEND: 'true' });

    expect(pushMessageMock).not.toHaveBeenCalled();
    expect(db.state.reminders).toHaveLength(0);
  });

  it('excludes an applicant whose application (keyword_received) predates CSA_REMINDER_EPOCH, even when otherwise due', async () => {
    const db = makeFakeDb({
      events: [
        // 申込作成(keyword_received) は epoch より前 = 有効化前の既存申込
        seedEvent({ line_user_id: 'line-old', event_type: 'keyword_received', occurred_at: '2026-06-15T20:00:00+09:00' }),
        seedEvent({ line_user_id: 'line-old', event_type: 'form_issued', occurred_at: '2026-06-15T20:01:00+09:00' }),
        // 対照群: 申込作成が epoch 以降 = 有効化後の新規申込
        seedEvent({ line_user_id: 'line-new', event_type: 'keyword_received', occurred_at: '2026-07-16T20:00:00+09:00' }),
        seedEvent({ line_user_id: 'line-new', event_type: 'form_issued', occurred_at: '2026-07-16T20:01:00+09:00' }),
      ],
    });

    await processCsaReminderDeliveries({ DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'token', CSA_REMINDER_AUTO_SEND: 'true', CSA_REMINDER_EPOCH: EPOCH });

    expect(pushMessageMock).toHaveBeenCalledTimes(1);
    expect(db.state.reminders).toHaveLength(1);
    expect(db.state.reminders[0]).toMatchObject({ line_user_id: 'line-new', status: 'sent' });
  });

  it('sends the Fable-approved soft-close wording for the 2nd (final) form_not_submitted reminder, with no hard "last time" phrasing and no self-justifying clause', async () => {
    const db = makeFakeDb({
      events: [
        seedEvent({ line_user_id: 'line-1', event_type: 'keyword_received', occurred_at: '2026-07-10T20:00:00+09:00' }),
        seedEvent({ line_user_id: 'line-1', event_type: 'form_issued', occurred_at: '2026-07-10T20:01:00+09:00' }),
        seedEvent({ line_user_id: 'line-1', event_type: 'form_opened', occurred_at: '2026-07-10T20:05:00+09:00' }),
        // 1回目のリマインドは送信済み(reminderCount=1) → 2回目=最終文面が候補になる
        seedEvent({ line_user_id: 'line-1', event_type: 'reminder_sent', occurred_at: '2026-07-11T12:00:00+09:00' }),
      ],
    });

    await processCsaReminderDeliveries({ DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'token', CSA_REMINDER_AUTO_SEND: 'true', CSA_REMINDER_EPOCH: EPOCH });

    expect(pushMessageMock).toHaveBeenCalledTimes(1);
    expect(db.state.reminders[0]).toMatchObject({ reminder_type: 'form_not_submitted_final', status: 'sent' });

    const sentMessages = pushMessageMock.mock.calls[0][1] as Array<{ type: string; text: string }>;
    const text = sentMessages[0].text;

    // Fable裁定(2026-07-28): (b)系統の柔らかい結びを採用・言い切り「今回で最後」禁止・
    // 「会員の皆さまを大切にしたいという思いから」の自己弁護的な一文は削除。
    expect(text).toContain('一旦このご案内はここまでとします。');
    expect(text).toContain('ご不明点があれば、いつでもお声がけください。');
    expect(text).not.toContain('今回で最後');
    expect(text).not.toContain('会員の皆さまを大切にしたいという思いから');
    expect(text).not.toContain('受講生');
  });
});
