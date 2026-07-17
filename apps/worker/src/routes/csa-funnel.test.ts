// @ts-expect-error vitest is provided by the workspace SDK package used to run worker tests.
import { describe, expect, it } from 'vitest';
import {
  buildCsaApplicants,
  buildCsaFunnelSummary,
  CURRENT_CSA_CAMPAIGN_FROM,
  filterApplicantsByWindow,
  resolveCampaignWindow,
  type FunnelEventRow,
} from './csa-funnel.js';

function event(
  lineUserId: string,
  eventType: FunnelEventRow['event_type'],
  occurredAt: string,
  paymentMethod: FunnelEventRow['payment_method'] = null,
): FunnelEventRow {
  return {
    id: `${lineUserId}:${eventType}:${occurredAt}`,
    friend_id: `friend:${lineUserId}`,
    line_user_id: lineUserId,
    application_id: eventType === 'form_submitted' ? `application:${lineUserId}` : null,
    event_type: eventType,
    payment_method: paymentMethod,
    occurred_at: occurredAt,
    display_name: lineUserId,
    picture_url: null,
  };
}

describe('CSA application funnel', () => {
  it('shows the current four-person campaign without mixing the earlier bank-transfer test', () => {
    const rows: FunnelEventRow[] = [
      event('test-bank', 'keyword_received', '2026-07-17T02:30:00+09:00'),
      event('test-bank', 'form_submitted', '2026-07-17T02:31:00+09:00', 'bank_transfer'),
      ...['line-1', 'line-2', 'line-3', 'line-4'].flatMap((lineUserId, index) => [
        event(lineUserId, 'keyword_received', `2026-07-17T20:0${index}:00+09:00`),
        event(lineUserId, 'form_issued', `2026-07-17T20:1${index}:00+09:00`),
      ]),
      event('line-1', 'form_submitted', '2026-07-17T20:30:00+09:00', 'card'),
    ];

    const allApplicants = buildCsaApplicants(rows);
    const window = resolveCampaignWindow(undefined, undefined, undefined);
    const currentApplicants = filterApplicantsByWindow(allApplicants, window.from, window.to);
    const summary = buildCsaFunnelSummary(currentApplicants);

    expect(window).toEqual({ campaignKey: 'current', from: CURRENT_CSA_CAMPAIGN_FROM, to: null });
    expect(currentApplicants).toHaveLength(4);
    expect(summary.stages.find((stage) => stage.key === 'keyword_received')?.count).toBe(4);
    expect(summary.stages.find((stage) => stage.key === 'form_issued')?.count).toBe(4);
    expect(summary.stages.find((stage) => stage.key === 'form_submitted')?.count).toBe(1);
    expect(summary.stages.find((stage) => stage.key === 'payment_verified')?.count).toBe(0);
    expect(summary.autoReminderEnabled).toBe(false);
  });

  it('keeps payment report separate from verification and detects a method mismatch', () => {
    const applicants = buildCsaApplicants([
      event('line-1', 'keyword_received', '2026-07-17T20:00:00+09:00'),
      event('line-1', 'form_submitted', '2026-07-17T20:10:00+09:00', 'card'),
      event('line-1', 'payment_reported', '2026-07-17T20:20:00+09:00', 'bank_transfer'),
    ]);

    expect(applicants[0]).toMatchObject({
      currentStage: 'payment_reported',
      paymentReportedAt: '2026-07-17T20:20:00+09:00',
      paymentVerifiedAt: null,
      paymentMismatch: true,
      attentionReason: 'paymentMethodMismatch',
    });
  });

  it('only treats the latest verification record as currently verified', () => {
    const baseEvents = [
      event('line-1', 'keyword_received', '2026-07-17T20:00:00+09:00'),
      event('line-1', 'form_submitted', '2026-07-17T20:10:00+09:00', 'card'),
    ];
    const applicants = buildCsaApplicants(baseEvents, [
      {
        line_user_id: 'line-1',
        application_id: 'application:line-1',
        payment_method: 'card',
        verification_status: 'verified',
        occurred_at: '2026-07-17T20:20:00+09:00',
      },
      {
        line_user_id: 'line-1',
        application_id: 'application:line-1',
        payment_method: 'card',
        verification_status: 'revoked',
        occurred_at: '2026-07-17T20:21:00+09:00',
      },
    ]);

    expect(applicants[0].paymentVerifiedAt).toBeNull();
    expect(applicants[0].currentStage).toBe('payment_pending');
  });
});
