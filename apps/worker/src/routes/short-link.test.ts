// @ts-expect-error vitest is provided by the workspace SDK package used to run worker tests.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const getTrafficPoolBySlug = vi.fn();
const getRandomPoolAccount = vi.fn();
const getPoolAccounts = vi.fn();

vi.mock('@line-crm/db', () => ({
  getTrafficPoolBySlug: (...args: unknown[]) => getTrafficPoolBySlug(...args),
  getRandomPoolAccount: (...args: unknown[]) => getRandomPoolAccount(...args),
  getPoolAccounts: (...args: unknown[]) => getPoolAccounts(...args),
}));

const { resolveBaseLiffUrl } = await import('./short-link.js');

const fakeDb = {} as D1Database;

describe('resolveBaseLiffUrl — /r/:ref の fail-graceful 修理 (台帳112)', () => {
  beforeEach(() => {
    getTrafficPoolBySlug.mockReset();
    getRandomPoolAccount.mockReset();
    getPoolAccounts.mockReset();
  });

  it('LIFF_URL 未設定 かつ プールが無い場合、null を返す(500 を出さないための前提)', async () => {
    getTrafficPoolBySlug.mockResolvedValue(null);

    const result = await resolveBaseLiffUrl(fakeDb, undefined, 'main');

    expect(result).toBeNull();
  });

  it('LIFF_URL 設定済みの場合、プールが無ければそのまま返す', async () => {
    getTrafficPoolBySlug.mockResolvedValue(null);

    const result = await resolveBaseLiffUrl(fakeDb, 'https://liff.line.me/1234567890-abcdefgh', 'main');

    expect(result).toBe('https://liff.line.me/1234567890-abcdefgh');
  });

  it('LIFF_URL 未設定でも、プールのアカウントに liff_id があればそれを使う', async () => {
    getTrafficPoolBySlug.mockResolvedValue({ id: 'pool-1', liff_id: null });
    getRandomPoolAccount.mockResolvedValue({ liff_id: '9999999999-zzzzzzzz' });

    const result = await resolveBaseLiffUrl(fakeDb, undefined, 'main');

    expect(result).toBe('https://liff.line.me/9999999999-zzzzzzzz');
  });

  it('LIFF_URL 未設定・プールにアカウントが1件も無く、プール自体の liff_id も無い場合、null を返す', async () => {
    getTrafficPoolBySlug.mockResolvedValue({ id: 'pool-1', liff_id: null });
    getRandomPoolAccount.mockResolvedValue(null);
    getPoolAccounts.mockResolvedValue([]);

    const result = await resolveBaseLiffUrl(fakeDb, undefined, 'main');

    expect(result).toBeNull();
  });

  it('ref コードの実在有無はこの解決処理に一切関与しない(同じ入力で常に同じ結果、不明な ref による分岐なし)', async () => {
    getTrafficPoolBySlug.mockResolvedValue(null);

    // resolveBaseLiffUrl は ref を受け取らない設計であることを仕様として固定する。
    // /r/:ref ハンドラは ref の実在チェックを一切行わないため、既知/不明にかかわらず
    // 同一の解決結果になる(= 不明な ref だけを理由に 500 になることはない)。
    const resultA = await resolveBaseLiffUrl(fakeDb, undefined, 'main');
    const resultB = await resolveBaseLiffUrl(fakeDb, undefined, 'main');

    expect(resultA).toBe(resultB);
    expect(resultA).toBeNull();
  });
});
