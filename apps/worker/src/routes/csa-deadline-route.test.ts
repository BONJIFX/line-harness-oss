// @ts-expect-error vitest is available in the workspace test runtime.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { csa } from './csa.js';
import {
  CSA_COMMERCE_LAW_VERSION,
  CSA_COPY_SHA256,
  CSA_COPY_VERSION,
  CSA_PRIVACY_VERSION,
  CSA_TERMS_VERSION,
} from './csa-prepayment.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('CSA application route deadline prevents intake side effects', () => {
  const application = {
    consentEventId: 'deadline-test-event',
    lineUserId: 'deadline-test-line-user',
    applicantName: 'Deadline test',
    email: 'deadline@example.test',
    paymentMethod: 'card',
    contractAgreedAt: '2026-09-30T14:59:59.999Z',
    displayedCopyVersion: CSA_COPY_VERSION,
    displayedCopySha256: CSA_COPY_SHA256,
    termsVersion: CSA_TERMS_VERSION,
    commerceLawVersion: CSA_COMMERCE_LAW_VERSION,
    privacyPolicyVersion: CSA_PRIVACY_VERSION,
    agreedTerms: true,
    agreedPrivacy: true,
    agreedEducationNoResult: true,
  };

  it('still reaches normal intake at the final millisecond of September in JST', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T23:59:59.999+09:00'));
    const intake = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, message: 'stubbed intake; no external request' }), { status: 503 }));
    vi.stubGlobal('fetch', intake);
    const prepare = vi.fn();
    const response = await csa.request('/api/liff/csa-application', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(application),
    }, { DB: { prepare }, API_KEY: 'test-secret', CSA_PAYMENT_INTAKE_URL: 'https://intake.example.test' });
    expect(response.status).toBe(502);
    expect(intake).toHaveBeenCalledTimes(1);
    expect(intake.mock.calls[0][0]).toBe('https://intake.example.test');
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each(['2026-10-01T00:00:00+09:00', '2026-10-01T09:00:00+09:00'])(
    'rejects new applications without intake or database access at %s', async (now) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      const intake = vi.fn();
      vi.stubGlobal('fetch', intake);
      const prepare = vi.fn();
      const response = await csa.request('/api/liff/csa-application', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(application),
      }, { DB: { prepare }, API_KEY: 'test-secret' });
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ ok: false, message: '現在、お申込み受付期間外です。' });
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(intake).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
    },
  );

  it('closes the public page before token parsing or database tracking at October midnight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00+09:00'));
    const intake = vi.fn();
    vi.stubGlobal('fetch', intake);
    const prepare = vi.fn();
    const response = await csa.request('https://example.test/api/liff/csa-apply?t=invalid-token', {}, { DB: { prepare }, API_KEY: 'test-secret' });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('現在、お申込み受付期間外です');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(intake).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });
});
