import { Hono } from 'hono';
import type { Env } from '../index.js';
import { jstNow } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import {
  CSA_COMMERCE_LAW_VERSION,
  CSA_CONTRACT_VERSION,
  CSA_COPY_SHA256,
  CSA_COPY_VERSION,
  CSA_PRIVACY_VERSION,
  CSA_ROUTE_VERSION,
  CSA_TERMS_VERSION,
  renderCsaCommerceLawPage,
  renderCsaPrepaymentPage,
  renderCsaPrivacyPage,
  renderCsaTermsPage,
} from './csa-prepayment.js';

const csa = new Hono<Env>();

const DEFAULT_CSA_PAYMENT_INTAKE_URL = 'https://csa-members-v2-csa2.vercel.app/api/webhooks/line-harness/payment-completed';

csa.get('/api/liff/csa-apply', async (c) => {
  setNoStore(c);
  const token = c.req.query('t') || '';
  const requestUrl = new URL(c.req.url);
  const localPreview = c.req.query('preview') === '1'
    && (requestUrl.hostname === '127.0.0.1' || requestUrl.hostname === 'localhost');
  const tokenPayload = token
    ? await verifyCsaFormToken(token, c.env.API_KEY)
    : null;
  const liffId = extractLiffId(c.env.LIFF_URL);
  return c.html(renderCsaPrepaymentPage({
    liffId,
    formToken: token,
    tokenLineUserId: tokenPayload?.line_user_id || (localPreview ? 'qa-line-user' : ''),
    tokenLineDisplayName: tokenPayload?.line_display_name || (localPreview ? 'QA Preview' : ''),
    localPreview,
  }));
});

csa.get('/api/liff/csa-terms', (c) => {
  setNoStore(c);
  return c.html(renderCsaTermsPage());
});
csa.get('/api/liff/csa-commerce-law', (c) => {
  setNoStore(c);
  return c.html(renderCsaCommerceLawPage());
});
csa.get('/api/liff/csa-privacy', (c) => {
  setNoStore(c);
  return c.html(renderCsaPrivacyPage());
});

csa.post('/api/liff/csa-application', async (c) => {
  const payload = (await c.req.json().catch(() => null)) as {
    consentEventId?: string;
    lineUserId?: string;
    lineDisplayName?: string;
    applicantName?: string;
    applicantKana?: string;
    email?: string;
    phone?: string;
    paymentMethod?: string;
    contractVersion?: string;
    displayedCopyVersion?: string;
    displayedCopySha256?: string;
    termsVersion?: string;
    commerceLawVersion?: string;
    privacyPolicyVersion?: string;
    agreedTerms?: boolean;
    agreedPrivacy?: boolean;
    agreedEducationNoResult?: boolean;
    contractAgreedAt?: string;
    userAgent?: string;
    formToken?: string;
  } | null;

  if (!payload) {
    return c.json({ ok: false, message: '入力内容を確認できませんでした。フォームを再読み込みしてもう一度送信してください。' }, 400);
  }

  const tokenPayload = payload.formToken
    ? await verifyCsaFormToken(payload.formToken, c.env.API_KEY)
    : null;
  const lineUserId = clean(payload.lineUserId || tokenPayload?.line_user_id, 120);
  const lineDisplayName = clean(payload.lineDisplayName || tokenPayload?.line_display_name, 120);
  const applicantName = clean(payload.applicantName, 80);
  const email = clean(payload.email, 200).toLowerCase();
  const paymentMethod = normalizePaymentMethod(payload.paymentMethod);
  const contractAgreedAt = normalizeIsoDate(clean(payload.contractAgreedAt, 80));
  const consentEventId = clean(payload.consentEventId, 80);
  const displayedCopyVersion = clean(payload.displayedCopyVersion, 100);
  const displayedCopySha256 = clean(payload.displayedCopySha256, 100);
  const termsVersion = clean(payload.termsVersion, 100);
  const commerceLawVersion = clean(payload.commerceLawVersion, 100);
  const privacyPolicyVersion = clean(payload.privacyPolicyVersion, 100);
  const agreementComplete = payload.agreedTerms === true
    && payload.agreedPrivacy === true
    && payload.agreedEducationNoResult === true;

  const missing = [
    !lineUserId ? 'LINE認証' : null,
    !applicantName ? '氏名' : null,
    !email ? 'メールアドレス' : null,
    !paymentMethod ? '決済方法' : null,
    !contractAgreedAt ? '契約同意' : null,
    !consentEventId ? '同意イベント' : null,
    !agreementComplete ? '3項目の同意' : null,
    displayedCopyVersion !== CSA_COPY_VERSION ? '表示本文版' : null,
    displayedCopySha256 !== CSA_COPY_SHA256 ? '表示本文ハッシュ' : null,
    termsVersion !== CSA_TERMS_VERSION ? '利用規約版' : null,
    commerceLawVersion !== CSA_COMMERCE_LAW_VERSION ? '特商法表記版' : null,
    privacyPolicyVersion !== CSA_PRIVACY_VERSION ? 'プライバシーポリシー版' : null,
  ].filter(Boolean);

  if (missing.length > 0) {
    return c.json({
      ok: false,
      message: `未入力があります: ${missing.join('、')}`,
    }, 400);
  }

  const intakeUrl = c.env.CSA_PAYMENT_INTAKE_URL || DEFAULT_CSA_PAYMENT_INTAKE_URL;
  const secret = c.env.CSA_PAYMENT_INTAKE_SECRET || c.env.API_KEY;
  const response = await fetch(intakeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({
      line_user_id: lineUserId,
      line_display_name: lineDisplayName,
      applicant_name: applicantName,
      applicant_kana: clean(payload.applicantKana, 80),
      email,
      phone: clean(payload.phone, 30) || null,
      payment_method: paymentMethod,
      contract_version: clean(payload.contractVersion, 80) || CSA_CONTRACT_VERSION,
      contract_agreed_at: contractAgreedAt,
      user_agent: clean(payload.userAgent, 500) || c.req.header('user-agent') || '',
      event_type: 'line_liff_contract_application',
    }),
  });

  const result = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    message?: string;
    error?: string;
    application_id?: string;
    duplicate?: boolean;
  };

  if (!response.ok || !result.ok) {
    return c.json({
      ok: false,
      message: result.message || result.error || '送信に失敗しました。時間をおいてもう一度お試しください。',
    }, response.ok ? 400 : 502);
  }

  const confirmedPaymentMethod = paymentMethod as 'card' | 'bank_transfer';
  try {
    await saveContractConsent(c.env.DB, {
      id: consentEventId,
      lineUserId,
      lineDisplayName,
      applicationId: result.application_id,
      contractVersion: clean(payload.contractVersion, 80) || CSA_CONTRACT_VERSION,
      displayedCopyVersion,
      displayedCopySha256,
      termsVersion,
      commerceLawVersion,
      privacyPolicyVersion,
      contractAgreedAt,
      paymentMethod: confirmedPaymentMethod,
      userAgent: clean(payload.userAgent, 500) || c.req.header('user-agent') || '',
    });
  } catch (error) {
    console.error('CSA contract consent save failed', error);
    return c.json({
      ok: false,
      message: '申込情報は受け付けましたが、同意記録を安全に保存できませんでした。お支払いへ進まず、運営へお知らせください。',
    }, 503);
  }

  await markFriendApplicationSubmitted(c.env.DB, {
    lineUserId,
    applicantName,
    email,
    paymentMethod: confirmedPaymentMethod,
    applicationId: result.application_id,
    duplicate: Boolean(result.duplicate),
  });

  return c.json({
    ok: true,
    duplicate: Boolean(result.duplicate),
    applicationId: result.application_id,
    message: result.message || '申込情報を受け付けました。',
  });
});

csa.post('/api/liff/csa-bank-transfer-complete', async (c) => {
  const payload = (await c.req.json().catch(() => null)) as {
    completionEventId?: string;
    lineUserId?: string;
    applicationId?: string;
    formToken?: string;
    reportedAt?: string;
    userAgent?: string;
  } | null;
  if (!payload) {
    return c.json({ ok: false, message: '完了通知を確認できませんでした。' }, 400);
  }

  if (!payload.formToken) {
    return c.json({ ok: false, message: 'LINEから発行された申込リンクを開き直してください。' }, 401);
  }
  const tokenPayload = await verifyCsaFormToken(payload.formToken, c.env.API_KEY);
  if (!tokenPayload) {
    return c.json({ ok: false, message: '申込リンクの有効期限が切れています。LINEで再度「決済」と送ってください。' }, 401);
  }

  const lineUserId = clean(payload.lineUserId || tokenPayload?.line_user_id, 120);
  const applicationId = clean(payload.applicationId, 100);
  const completionEventId = clean(payload.completionEventId, 80);
  const reportedAt = normalizeIsoDate(clean(payload.reportedAt, 80));
  const userAgent = clean(payload.userAgent, 500) || c.req.header('user-agent') || '';
  if (lineUserId !== tokenPayload.line_user_id) {
    return c.json({ ok: false, message: 'LINE本人情報が一致しません。' }, 403);
  }
  if (!lineUserId || !applicationId || !completionEventId || !reportedAt || !userAgent) {
    return c.json({ ok: false, message: '完了通知の必須情報が不足しています。' }, 400);
  }

  const consent = await c.env.DB.prepare(
    `SELECT id FROM csa_contract_consents
     WHERE line_user_id = ? AND application_id = ? AND payment_method = 'bank_transfer'
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(lineUserId, applicationId).first<{ id: string }>();
  if (!consent) {
    return c.json({
      ok: false,
      message: '銀行振込の申込記録を確認できませんでした。銀行振込を選び直してください。',
    }, 409);
  }

  const result = await recordBankTransferCompletion(c.env.DB, {
    id: completionEventId,
    lineUserId,
    applicationId,
    reportedAt,
    userAgent,
  });

  let lineMessageSent = Boolean(result.confirmationSentAt);
  if (!result.confirmationSentAt) {
    try {
      const confirmationText = bankTransferCompletionMessage();
      await new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN).pushMessage(
        lineUserId,
        [{ type: 'text', text: confirmationText }],
      );
      lineMessageSent = true;
      const confirmationSentAt = jstNow();
      await c.env.DB.prepare(
        `UPDATE csa_payment_completion_notices
         SET confirmation_sent_at = ?
         WHERE id = ? AND confirmation_sent_at IS NULL`,
      ).bind(confirmationSentAt, result.noticeId).run();
      if (result.friend) {
        await c.env.DB.prepare(
          `INSERT OR IGNORE INTO messages_log
           (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, created_at)
           VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'csa_bank_completion', ?)`,
        ).bind(`csa-bank-confirmation:${result.noticeId}`, result.friend.id, confirmationText, confirmationSentAt).run();
      }
    } catch (error) {
      console.error('CSA bank completion LINE push failed', error);
    }
  }

  return c.json({
    ok: true,
    noticeSaved: true,
    duplicate: !result.created,
    lineMessageSent,
    noticeId: result.noticeId,
  });
});

async function markFriendApplicationSubmitted(
  db: D1Database,
  input: {
    lineUserId: string;
    applicantName: string;
    email: string;
    paymentMethod: 'card' | 'bank_transfer';
    applicationId?: string;
    duplicate: boolean;
  },
) {
  const friend = await db
    .prepare('SELECT id, metadata FROM friends WHERE line_user_id = ?')
    .bind(input.lineUserId)
    .first<{ id: string; metadata: string | null }>();
  if (!friend) return;

  const metadata = safeJson(friend.metadata);
  metadata.csa_application_submitted_at = jstNow();
  metadata.csa_application_id = input.applicationId ?? metadata.csa_application_id ?? null;
  metadata.csa_application_duplicate = input.duplicate;
  metadata.csa_application_name = input.applicantName;
  metadata.csa_application_email = input.email;
  metadata.csa_payment_method = input.paymentMethod;
  metadata.csa_contract_version = CSA_CONTRACT_VERSION;

  await db
    .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(metadata), jstNow(), friend.id)
    .run();
}

async function recordBankTransferCompletion(
  db: D1Database,
  input: {
    id: string;
    lineUserId: string;
    applicationId: string;
    reportedAt: string;
    userAgent: string;
  },
): Promise<{
  created: boolean;
  noticeId: string;
  confirmationSentAt: string | null;
  friend: { id: string } | null;
}> {
  const insert = await db.prepare(
    `INSERT INTO csa_payment_completion_notices
      (id, line_user_id, application_id, payment_method, reported_at, user_agent)
     VALUES (?, ?, ?, 'bank_transfer', ?, ?)
     ON CONFLICT DO NOTHING`,
  ).bind(input.id, input.lineUserId, input.applicationId, input.reportedAt, input.userAgent).run();
  const created = Number(insert.meta.changes ?? 0) > 0;

  const saved = await db.prepare(
    `SELECT id, line_user_id, application_id, payment_method, reported_at, user_agent, confirmation_sent_at
     FROM csa_payment_completion_notices
     WHERE application_id = ? AND payment_method = 'bank_transfer'`,
  ).bind(input.applicationId).first<{
    id: string;
    line_user_id: string;
    application_id: string;
    payment_method: string;
    reported_at: string;
    user_agent: string;
    confirmation_sent_at: string | null;
  }>();
  if (
    !saved
    || saved.line_user_id !== input.lineUserId
    || saved.application_id !== input.applicationId
    || saved.payment_method !== 'bank_transfer'
  ) {
    throw new Error('bank transfer completion readback mismatch');
  }

  const friend = await db.prepare(
    'SELECT id, metadata FROM friends WHERE line_user_id = ?',
  ).bind(input.lineUserId).first<{ id: string; metadata: string | null }>();
  if (friend) {
    const metadata = safeJson(friend.metadata);
    metadata.csa_bank_transfer_reported_at = saved.reported_at;
    metadata.csa_bank_transfer_application_id = saved.application_id;
    metadata.csa_bank_transfer_notice_id = saved.id;
    await db.prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(metadata), jstNow(), friend.id)
      .run();
    await db.prepare(
      `INSERT OR IGNORE INTO messages_log
       (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, created_at)
       VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, 'csa_bank_completion', ?)`,
    ).bind(
      `csa-bank-notice:${saved.id}`,
      friend.id,
      `銀行振込の手続き完了を申告しました（申込ID: ${saved.application_id}）`,
      jstNow(),
    ).run();
  }

  return {
    created,
    noticeId: saved.id,
    confirmationSentAt: saved.confirmation_sent_at,
    friend: friend ? { id: friend.id } : null,
  };
}

function bankTransferCompletionMessage(): string {
  return [
    'お手続きありがとうございます。',
    '',
    '銀行振込の完了通知を受け付けました。',
    '運営がご入金を確認しています。',
    '確認でき次第、あなた専用のDiscord招待と会員開始のご案内を、このLINEへお送りします。',
    '',
    '3営業日を過ぎてもご案内が届かない場合は、このLINEに「ヘルプ」とご返信ください。',
  ].join('\n');
}

async function saveContractConsent(
  db: D1Database,
  input: {
    id: string;
    lineUserId: string;
    lineDisplayName: string;
    applicationId?: string;
    contractVersion: string;
    displayedCopyVersion: string;
    displayedCopySha256: string;
    termsVersion: string;
    commerceLawVersion: string;
    privacyPolicyVersion: string;
    contractAgreedAt: string;
    paymentMethod: 'card' | 'bank_transfer';
    userAgent: string;
  },
) {
  await db.prepare(
    `INSERT INTO csa_contract_consents (
      id, line_user_id, line_display_name, application_id, contract_version,
      displayed_copy_version, displayed_copy_sha256, terms_version,
      commerce_law_version, privacy_policy_version, agreed_terms,
      agreed_privacy, agreed_education_no_result, agreed_at, payment_method,
      user_agent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING`,
  ).bind(
    input.id,
    input.lineUserId,
    input.lineDisplayName || null,
    input.applicationId || null,
    input.contractVersion,
    input.displayedCopyVersion,
    input.displayedCopySha256,
    input.termsVersion,
    input.commerceLawVersion,
    input.privacyPolicyVersion,
    input.contractAgreedAt,
    input.paymentMethod,
    input.userAgent,
  ).run();

  const saved = await db.prepare(
    `SELECT line_user_id, application_id, contract_version, displayed_copy_version,
      displayed_copy_sha256, agreed_terms, agreed_privacy,
      agreed_education_no_result, agreed_at, payment_method, user_agent
    FROM csa_contract_consents WHERE id = ?`,
  ).bind(input.id).first<{
    line_user_id: string;
    application_id: string | null;
    contract_version: string;
    displayed_copy_version: string;
    displayed_copy_sha256: string;
    agreed_terms: number;
    agreed_privacy: number;
    agreed_education_no_result: number;
    agreed_at: string;
    payment_method: string;
    user_agent: string;
  }>();

  if (
    !saved
    || saved.line_user_id !== input.lineUserId
    || saved.application_id !== (input.applicationId || null)
    || saved.contract_version !== input.contractVersion
    || saved.displayed_copy_version !== input.displayedCopyVersion
    || saved.displayed_copy_sha256 !== input.displayedCopySha256
    || saved.agreed_terms !== 1
    || saved.agreed_privacy !== 1
    || saved.agreed_education_no_result !== 1
    || saved.agreed_at !== input.contractAgreedAt
    || saved.payment_method !== input.paymentMethod
    || saved.user_agent !== input.userAgent
  ) {
    throw new Error('contract consent readback mismatch');
  }
}

function renderApplyPage({
  liffId,
  contractVersion,
  formToken,
  tokenLineUserId,
  tokenLineDisplayName,
}: {
  liffId: string;
  contractVersion: string;
  formToken: string;
  tokenLineUserId: string;
  tokenLineDisplayName: string;
}) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CSA 申込フォーム</title>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <style>
    :root {
      color-scheme: dark;
      --bg: #071225;
      --panel: #0e1a31;
      --panel-2: #14223c;
      --line: rgba(221, 170, 62, 0.34);
      --gold: #d9a83a;
      --gold-2: #f3c766;
      --ink: #fff8e6;
      --muted: #b8c2d8;
      --danger: #ff7676;
      --ok: #80d89b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at top, #102246 0, var(--bg) 46%, #030813 100%);
      color: var(--ink);
    }
    main { width: min(720px, calc(100% - 28px)); margin: 0 auto; padding: 28px 0 44px; }
    .eyebrow { color: var(--gold-2); font-size: 12px; font-weight: 800; letter-spacing: .18em; }
    h1 { margin: 8px 0 10px; font-size: clamp(28px, 8vw, 44px); line-height: 1.1; letter-spacing: 0; }
    p { color: var(--muted); line-height: 1.8; }
    form, .complete {
      margin-top: 22px;
      border: 1px solid var(--line);
      background: rgba(14, 26, 49, .94);
      border-radius: 8px;
      padding: 18px;
      box-shadow: 0 18px 50px rgba(0, 0, 0, .28);
    }
    label { display: block; margin-top: 16px; font-size: 13px; font-weight: 800; color: var(--gold-2); }
    input, select {
      width: 100%;
      margin-top: 7px;
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 6px;
      background: #081226;
      color: var(--ink);
      font: inherit;
      padding: 12px;
      outline: none;
    }
    input:focus, select:focus { border-color: var(--gold); box-shadow: 0 0 0 3px rgba(217,168,58,.18); }
    .contract {
      margin-top: 18px;
      max-height: 240px;
      overflow: auto;
      border: 1px solid rgba(255,255,255,.13);
      background: #09152a;
      border-radius: 6px;
      padding: 14px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.75;
    }
    .check {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      margin-top: 16px;
      color: var(--ink);
      font-size: 14px;
      line-height: 1.7;
    }
    .check input { width: 18px; height: 18px; margin: 3px 0 0; flex: 0 0 auto; }
    button {
      width: 100%;
      margin-top: 18px;
      border: 0;
      border-radius: 6px;
      background: linear-gradient(135deg, var(--gold), var(--gold-2));
      color: #1a1203;
      font-weight: 900;
      padding: 13px 16px;
      cursor: pointer;
    }
    button:disabled { opacity: .58; cursor: not-allowed; }
    .error { margin-top: 12px; color: var(--danger); font-size: 13px; line-height: 1.7; }
    .complete { border-color: rgba(128,216,155,.5); }
    .complete h2 { color: var(--ok); margin: 0 0 8px; }
    .hidden { display: none; }
    .subtle { font-size: 12px; color: #8794ad; }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">CANDLE SMART ACADEMY</div>
    <h1>CSA 申込フォーム</h1>
    <p>契約内容を確認し、申込情報を1回で送信してください。送信後は運営が入金確認を行い、確認完了後にこのLINEへご本人専用のDiscord招待URLをお送りします。</p>

    <form id="form">
      <label>氏名
        <input id="name" autocomplete="name" required placeholder="例: 山田 太郎" />
      </label>
      <label>メールアドレス
        <input id="email" autocomplete="email" type="email" required placeholder="購入時に申告するメールアドレス" />
      </label>
      <label>決済方法
        <select id="paymentMethod" required>
          <option value="">選択してください</option>
          <option value="card">カード</option>
          <option value="bank_transfer">銀行振込</option>
        </select>
      </label>
      <label>電話番号（任意）
        <input id="phone" autocomplete="tel" placeholder="緊急時の連絡先として任意" />
      </label>

      <div class="contract">
        <strong>契約・受講前確認</strong><br />
        CSAは、ローソク足・相場構造・リスク管理を学ぶ教育サービスです。特定の金融商品の購入、売却、利益を保証するものではありません。受講者は自己責任で学習・検証・取引判断を行います。受講期間、支払方法、Discordおよび会員サイト利用ルール、禁止事項、返金や停止条件は運営案内に従います。本人確認や入金確認が完了するまで、学習チャンネルと会員サイトの利用は開始されません。
      </div>
      <label class="check">
        <input id="agree" type="checkbox" required />
        <span>上記の契約・受講前確認を読み、CSAが教育サービスであること、投資判断は自己責任であること、本人専用の情報で申し込むことに同意します。</span>
      </label>
      <p class="subtle">契約バージョン: ${escapeHtml(contractVersion)}</p>
      <button id="submit" type="submit">申込情報を送信する</button>
      <div id="error" class="error hidden"></div>
    </form>

    <section id="complete" class="complete hidden">
      <h2>受け付けました</h2>
      <p id="completeMessage"></p>
    </section>
  </main>
  <script>
    const LIFF_ID = ${JSON.stringify(liffId)};
    const CONTRACT_VERSION = ${JSON.stringify(contractVersion)};
    const FORM_TOKEN = ${JSON.stringify(formToken)};
    const TOKEN_LINE_USER_ID = ${JSON.stringify(tokenLineUserId)};
    const TOKEN_LINE_DISPLAY_NAME = ${JSON.stringify(tokenLineDisplayName)};
    let lineProfile = null;

    async function init() {
      const error = document.getElementById('error');
      try {
        if (TOKEN_LINE_USER_ID) {
          lineProfile = { userId: TOKEN_LINE_USER_ID, displayName: TOKEN_LINE_DISPLAY_NAME };
          return;
        }
        if (!LIFF_ID) throw new Error('LINEの申込リンクが正しくありません。LINEで再度「決済」と送って、届いたフォームから開いてください。');
        await liff.init({ liffId: LIFF_ID });
        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: location.href });
          return;
        }
        lineProfile = await liff.getProfile();
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : 'LINE認証に失敗しました。';
        error.classList.remove('hidden');
      }
    }

    document.getElementById('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const error = document.getElementById('error');
      const button = document.getElementById('submit');
      error.classList.add('hidden');
      error.textContent = '';
      if (!lineProfile?.userId) {
        error.textContent = 'LINE認証が完了していません。ページを再読み込みしてください。';
        error.classList.remove('hidden');
        return;
      }
      button.disabled = true;
      button.textContent = '送信中...';
      try {
        const res = await fetch('/api/liff/csa-application', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lineUserId: lineProfile.userId,
            lineDisplayName: lineProfile.displayName || '',
            formToken: FORM_TOKEN,
            applicantName: document.getElementById('name').value,
            email: document.getElementById('email').value,
            paymentMethod: document.getElementById('paymentMethod').value,
            phone: document.getElementById('phone').value,
            contractVersion: CONTRACT_VERSION,
            contractAgreedAt: new Date().toISOString(),
            userAgent: navigator.userAgent,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.message || '送信に失敗しました。');
        document.getElementById('form').classList.add('hidden');
        document.getElementById('completeMessage').textContent = data.message || '申込情報を受け付けました。';
        document.getElementById('complete').classList.remove('hidden');
      } catch (err) {
        button.disabled = false;
        button.textContent = '申込情報を送信する';
        error.textContent = err instanceof Error ? err.message : '送信に失敗しました。';
        error.classList.remove('hidden');
      }
    });

    init();
  </script>
</body>
</html>`;
}

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function setNoStore(c: { header(name: string, value: string): void }) {
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');
  c.header('X-CSA-Route-Version', CSA_ROUTE_VERSION);
}

function normalizePaymentMethod(value: unknown): 'card' | 'bank_transfer' | '' {
  const text = clean(value, 80);
  if (text === 'card' || text === 'bank_transfer') return text;
  return '';
}

function normalizeIsoDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function extractLiffId(liffUrl: unknown): string {
  return typeof liffUrl === 'string'
    ? liffUrl.match(/liff\.line\.me\/([0-9]+-[A-Za-z0-9]+)/)?.[1] ?? ''
    : '';
}

function safeJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function verifyCsaFormToken(token: string, secret: string): Promise<{
  line_user_id: string;
  line_display_name?: string;
  exp: number;
} | null> {
  const [payloadPart, signaturePart] = token.split('.');
  if (!payloadPart || !signaturePart || !secret) return null;

  const expected = await hmacSha256(payloadPart, secret);
  if (expected !== signaturePart) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadPart))) as {
      line_user_id?: string;
      line_display_name?: string;
      exp?: number;
    };
    if (!payload.line_user_id || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return {
      line_user_id: payload.line_user_id,
      line_display_name: payload.line_display_name,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

async function hmacSha256(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return base64UrlEncode(new Uint8Array(signature));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export { csa };
