// @ts-expect-error vitest is provided by the workspace SDK package used to run worker tests.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Env } from './index.js';

const getTrafficPoolBySlug = vi.fn();
const getRandomPoolAccount = vi.fn();
const getPoolAccounts = vi.fn();

vi.mock('@line-crm/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getTrafficPoolBySlug: (...args: unknown[]) => getTrafficPoolBySlug(...args),
    getRandomPoolAccount: (...args: unknown[]) => getRandomPoolAccount(...args),
    getPoolAccounts: (...args: unknown[]) => getPoolAccounts(...args),
  };
});

const worker = (await import('./index.js')).default;

function baseEnv(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    DB: {} as D1Database,
    IMAGES: {} as R2Bucket,
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) } as unknown as Fetcher,
    LINE_CHANNEL_SECRET: 'secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'token',
    API_KEY: 'api-key',
    LIFF_URL: undefined as unknown as string,
    LINE_CHANNEL_ID: 'channel-id',
    LINE_LOGIN_CHANNEL_ID: 'login-channel-id',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: 'https://example.workers.dev',
    ...overrides,
  };
}

const dummyCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

describe('/r/:ref — fail-graceful 修理 (台帳112, LIFF_URL 未設定時 500→404)', () => {
  beforeEach(() => {
    getTrafficPoolBySlug.mockReset();
    getRandomPoolAccount.mockReset();
    getPoolAccounts.mockReset();
    getTrafficPoolBySlug.mockResolvedValue(null); // 'main' プール未設定を模した本番相当の断面
  });

  it('断面1: LIFF_URL 未設定 → 500 ではなく 404 + 日本語案内', async () => {
    const env = baseEnv({ LIFF_URL: undefined as unknown as string });
    const res = await worker.fetch(
      new Request('https://example.workers.dev/r/some-ref'),
      env,
      dummyCtx,
    );

    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('準備中');
  });

  it('断面2: LIFF_URL 設定済み → 200 (LINE 起動案内ページ)', async () => {
    const env = baseEnv({ LIFF_URL: 'https://liff.line.me/1234567890-abcdefgh' });
    const res = await worker.fetch(
      new Request('https://example.workers.dev/r/some-ref'),
      env,
      dummyCtx,
    );

    expect(res.status).toBe(200);
  });

  it('断面3: 存在しない ref コード + LIFF_URL 未設定 → 500 ではなく 404 (ref の実在有無は無関係)', async () => {
    const env = baseEnv({ LIFF_URL: undefined as unknown as string });
    const res = await worker.fetch(
      new Request('https://example.workers.dev/r/nonexistent-test-code-999'),
      env,
      dummyCtx,
    );

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(500);
  });
});
