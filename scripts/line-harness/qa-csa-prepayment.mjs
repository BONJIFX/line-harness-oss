import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const prepaymentPath = resolve(root, 'apps/worker/src/routes/csa-prepayment.ts');
const csaRoutePath = resolve(root, 'apps/worker/src/routes/csa.ts');
const webhookPath = resolve(root, 'apps/worker/src/routes/webhook.ts');
const migrationPath = resolve(root, 'packages/db/migrations/029_csa_contract_consents.sql');
const sourceCopyPath = 'C:/Users/user/.agi-tools/workspaces/persistent-0710-150023/csa-company-sot/COPY_PREPAYMENT_SCREENS_FABLE_2026-07-16.md';

const prepayment = readFileSync(prepaymentPath, 'utf8');
const csaRoute = readFileSync(csaRoutePath, 'utf8');
const webhook = readFileSync(webhookPath, 'utf8');
const migration = readFileSync(migrationPath, 'utf8');

const requiredCopy = [
  'お申込み前の、最終確認です',
  'Candle Smart Academy(CSA)本講座',
  'ご利用開始から 6 か月間',
  '総額 330,000 円(税込)。上記以外に当社へお支払いいただく費用はありません。',
  '2026 年 7 月 17 日(金)〜 7 月 21 日(火)',
  'ご入金前は、お申込みの取り消しが可能です。ご入金後のキャンセル・返金・中途解約はいたしかねます。',
  '上記を確認・同意して、支払い方法を選ぶ',
  'クレジットカードで支払う',
  '銀行振込を選ぶ',
  '運営がご入金を確認しています。',
  'あなた専用の Discord 招待と会員開始のご案内',
];

const failures = [];
for (const text of requiredCopy) {
  if (!prepayment.includes(text)) failures.push(`missing copy: ${text}`);
}

if (/max-height\s*:\s*240px|class="contract"/.test(prepayment)) {
  failures.push('important conditions are still enclosed in the legacy scroll box');
}

for (const route of ['/api/liff/csa-terms', '/api/liff/csa-commerce-law', '/api/liff/csa-privacy']) {
  if (!csaRoute.includes(route)) failures.push(`missing legal route: ${route}`);
}

for (const field of [
  'displayed_copy_sha256',
  'agreed_terms',
  'agreed_privacy',
  'agreed_education_no_result',
  'user_agent',
]) {
  if (!migration.includes(field)) failures.push(`missing consent field: ${field}`);
}

if (!webhook.includes("altText = 'CSAのお申込み前の最終確認です。';")) {
  failures.push('LINE payment keyword does not route to prepayment confirmation');
}
if (!webhook.includes('buildCsaPostPaymentFlex()')) {
  failures.push('post-payment LINE response is missing');
}

const expectedWeekdays = [
  ['2026-07-17T12:00:00+09:00', 5, 'Friday'],
  ['2026-07-21T12:00:00+09:00', 2, 'Tuesday'],
];
for (const [value, expected, label] of expectedWeekdays) {
  if (new Date(value).getUTCDay() !== expected) failures.push(`weekday mismatch: ${label}`);
}

const hashMatch = prepayment.match(/CSA_COPY_SHA256 = '([A-F0-9]{64})'/);
if (!hashMatch) {
  failures.push('CSA_COPY_SHA256 is missing');
} else if (existsSync(sourceCopyPath)) {
  const sourceHash = createHash('sha256').update(readFileSync(sourceCopyPath)).digest('hex').toUpperCase();
  if (sourceHash !== hashMatch[1]) failures.push(`source copy hash mismatch: ${sourceHash} != ${hashMatch[1]}`);
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('PASS: CSA prepayment copy, routes, consent schema, weekday labels, and source hash');
