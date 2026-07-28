// @ts-expect-error vitest is provided by the workspace SDK package used to run worker tests.
import { describe, expect, it } from 'vitest';
import {
  CSA_BANK_DETAILS,
  renderCsaCommerceLawPage,
  renderCsaPrepaymentPage,
  renderCsaTermsPage,
} from './csa-prepayment.js';

// 2026-07-28 夜、69d5268(CSA reminder dispatch 系統)が 71e199d(支店コード修正:
// 誤 〇一八支店 → 正 〇九八支店)を含まない古い枝から origin/main へ乗り、
// 顧客事実(振込支店・販売事業者名)が本番で黙って巻き戻った。
// この検問は「顧客事実の正本(src/lib/customer-facts/csa-payment.mjs 相当の
// 銀行口座名義・支店名)と齟齬する誤値が申込ページへ再混入したら CI を落とす」
// ための静的アサーションであり、削除・弱体化してはならない。

const PREPAYMENT_HTML = renderCsaPrepaymentPage({
  liffId: 'liff-test',
  formToken: '',
  tokenLineUserId: '',
  tokenLineDisplayName: '',
  localPreview: false,
});
const TERMS_HTML = renderCsaTermsPage();
const COMMERCE_LAW_HTML = renderCsaCommerceLawPage();

describe('CSA 顧客事実の巻き戻り防止(支店コード・販売事業者名)', () => {
  it('CSA_BANK_DETAILS の支店は正しい〇九八支店である', () => {
    expect(CSA_BANK_DETAILS.branch).toBe('〇九八支店');
  });

  it.each([
    ['申込ページ(csa-apply)', PREPAYMENT_HTML],
    ['利用規約(csa-terms)', TERMS_HTML],
    ['特定商取引法に基づく表記(csa-commerce-law)', COMMERCE_LAW_HTML],
  ])('%s に正しい支店・事業者名が含まれ、誤った旧値を含まない', (_label, html) => {
    if (html.includes('支店')) {
      expect(html).toContain('〇九八支店');
      expect(html).not.toContain('〇一八');
    }
    if (html.includes('販売事業者') || html.includes('提供する')) {
      expect(html).toContain('国際正規時計協会');
    }
    expect(html).not.toContain('合同会社GGC');
    expect(html).not.toContain('合同会社 GGC');
  });
});
