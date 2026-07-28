/**
 * CSA 申込フォーム後押しリマインド配信 — cron トリガーで定期実行
 *
 * 対象: 「決済」キーワード送信後、申込フォームを開いていない/送信していない会員
 *      (csa-funnel.ts の buildReminderCandidate が kind='form_not_opened' /
 *      'form_not_submitted' かつ state='due' かつ userMessageAllowed=true と
 *      判定した候補のみ)。
 *
 * 安全設計:
 * - CSA_REMINDER_AUTO_SEND が文字列 "true" でない限り、実送信・DB書き込みは
 *   一切行わず、対象件数のみログ出力するドライラン動作とする。
 * - 実送信時も、同一 line_user_id + reminder_type で既に status='sent' の行が
 *   あれば送らない(csa_application_reminders の UNIQUE(line_user_id,
 *   reminder_type, due_at) 制約に加え、due_at が再計算で変わるケースへの
 *   二重の重複送信防止)。
 * - CSA_REMINDER_EPOCH(ISO 日時)による今後限定ガード: 申込作成時刻
 *   (keywordReceivedAt、「決済」キーワード受信 = 申込プロセス開始時刻)が
 *   CSA_REMINDER_EPOCH より前の申込は、対象カインド・状態にかかわらず送信対象
 *   から構造的に除外する(2026-07-28 BONJI 裁定「今後のみに決まってるじゃん」
 *   = 本番有効化時点より前に始まった申込へは 1 通も送らない)。
 *   CSA_REMINDER_EPOCH が未設定または不正な日時文字列の場合は fail-closed とし、
 *   対象 0 件として扱う(既存申込への誤送信を防ぐための安全側デフォルト)。
 * - このジョブは csa_application_reminders.auto_send_enabled カラム(常に 0
 *   固定の CHECK 制約つき)を一切書き換えない。ここでの「自動送信」は本ファイル
 *   内の CSA_REMINDER_AUTO_SEND フラグのみで制御する。
 */

import { LineClient } from '@line-crm/line-sdk';
import { getFriendByLineUserId, getLineAccountById, jstNow } from '@line-crm/db';
import {
  loadApplicants,
  recordCsaFunnelEventSafely,
  type CsaApplicant,
  type CsaReminderCandidate,
} from '../routes/csa-funnel.js';

export type CsaReminderDeliveryEnv = {
  DB: D1Database;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  CSA_REMINDER_AUTO_SEND?: string;
  CSA_REMINDER_EPOCH?: string;
};

const TARGET_KINDS: ReadonlyArray<CsaReminderCandidate['kind']> = ['form_not_opened', 'form_not_submitted'];

// 文面ルール: 肯定形のみ・「受講生」不使用(「会員」を使う)・実績数値や希少性演出なし・
// 顔出し/実名を煽る表現なし。フォーム再送リンク方式(既存の「決済」キーワード応答を
// 再利用する設計)と form_not_submitted_final のトーン(言い切り禁止、柔らかい結び)は
// 2026-07-28 最高顧問(Fable)裁定で確定済み(理由: 秘密情報を新規ジョブへ持ち込まない/
// 「今回で最後」の言い切りは希少性・締切演出と同じ系統の圧になり得るため回避)。
const TEMPLATES: Record<string, (displayName: string | null) => string> = {
  form_not_opened_next_12: (name) => [
    `${greeting(name)}`,
    'CSAへのお申込みご案内、まだお手元でご確認いただけていないようでしたので、改めてご連絡いたします。',
    'このトーク画面で「決済」と送っていただくと、お申込みフォームのリンクを再度お届けします。',
    'ご質問があれば、このままメッセージでお気軽にお知らせください。',
  ].join('\n'),
  form_not_submitted_next_12: (name) => [
    `${greeting(name)}`,
    'お申込みフォームを開いていただいたようですが、送信が完了していない状態です。',
    '入力途中でお困りの点がありましたら、このトーク画面でいつでもお聞かせください。',
    '改めてフォームを受け取りたい場合は、「決済」と送っていただければ最新のリンクをお届けします。',
  ].join('\n'),
  form_not_submitted_final: (name) => [
    `${greeting(name)}`,
    '一旦このご案内はここまでとします。',
    'ご検討を続けたい場合は、このトーク画面で「決済」と送っていただければ、いつでもフォームを再度お届けします。',
    'ご不明点があれば、いつでもお声がけください。',
  ].join('\n'),
};

function greeting(name: string | null): string {
  return name ? `${name}さん、` : 'いつもありがとうございます。';
}

export async function processCsaReminderDeliveries(env: CsaReminderDeliveryEnv): Promise<void> {
  const db = env.DB;
  const autoSendEnabled = env.CSA_REMINDER_AUTO_SEND === 'true';
  const epochMs = parseReminderEpoch(env.CSA_REMINDER_EPOCH);
  if (epochMs === null) {
    console.log(
      `[csa-reminder-delivery] CSA_REMINDER_EPOCH is unset or invalid (value=${JSON.stringify(env.CSA_REMINDER_EPOCH ?? null)}); fail-closed, 0 candidate(s) due`,
    );
    return;
  }
  const applicants = await loadApplicants(db, null, null);
  const dueTargets = applicants.filter(
    (applicant) => isDueTarget(applicant.reminderCandidate) && isEpochEligible(applicant, epochMs),
  );

  if (!autoSendEnabled) {
    console.log(
      `[csa-reminder-delivery] dry-run (CSA_REMINDER_AUTO_SEND!=true): ${dueTargets.length} candidate(s) due`,
      JSON.stringify(dueTargets.map((applicant) => ({
        lineUserId: applicant.lineUserId,
        templateKey: applicant.reminderCandidate.templateKey,
        dueAt: applicant.reminderCandidate.dueAt,
      }))),
    );
    return;
  }

  const defaultClient = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);

  for (const applicant of dueTargets) {
    try {
      await sendOne(db, defaultClient, applicant);
    } catch (error) {
      console.error(`CSA reminder delivery error (${applicant.lineUserId}):`, error);
    }
  }
}

/**
 * CSA_REMINDER_EPOCH の ISO 日時文字列を epoch ミリ秒へ変換する。
 * 未設定・空文字・不正な日時文字列は null(= fail-closed 判定に委ねる)。
 */
export function parseReminderEpoch(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return null;
  return ms;
}

/**
 * 申込作成時刻(keywordReceivedAt = 「決済」キーワード受信時刻、申込プロセスの
 * 起点)が epoch 以降かどうかを判定する。keywordReceivedAt が取得できない
 * 申込は fail-closed で対象外とする(起点不明の申込へは送らない)。
 */
export function isEpochEligible(applicant: Pick<CsaApplicant, 'keywordReceivedAt'>, epochMs: number): boolean {
  const createdAt = applicant.keywordReceivedAt;
  if (!createdAt) return false;
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) return false;
  return createdMs >= epochMs;
}

export function isDueTarget(candidate: CsaReminderCandidate): boolean {
  return (
    TARGET_KINDS.includes(candidate.kind)
    && candidate.state === 'due'
    && candidate.userMessageAllowed === true
    && candidate.templateKey !== null
    && TEMPLATES[candidate.templateKey] !== undefined
  );
}

async function sendOne(db: D1Database, defaultClient: LineClient, applicant: CsaApplicant): Promise<void> {
  const candidate = applicant.reminderCandidate;
  const templateKey = candidate.templateKey;
  const dueAt = candidate.dueAt;
  const template = templateKey ? TEMPLATES[templateKey] : undefined;
  if (!templateKey || !dueAt || !template) return;

  // 二重送信防止: 同一 line_user_id + reminder_type で既に送信済みなら送らない
  // (due_at が再計算で変わっても、この確認は独立して効く)
  const alreadySent = await db.prepare(
    `SELECT 1 AS found FROM csa_application_reminders
     WHERE line_user_id = ? AND reminder_type = ? AND status = 'sent' LIMIT 1`,
  ).bind(applicant.lineUserId, templateKey).first<{ found: number }>();
  if (alreadySent) return;

  const friend = await getFriendByLineUserId(db, applicant.lineUserId);
  if (!friend || !friend.is_following) return;

  let deliveryClient = defaultClient;
  if (friend.line_account_id) {
    const account = await getLineAccountById(db, friend.line_account_id);
    if (account) deliveryClient = new LineClient(account.channel_access_token);
  }

  const text = template(applicant.displayName);
  await deliveryClient.pushMessage(applicant.lineUserId, [{ type: 'text', text }]);

  const now = jstNow();
  const messageLogId = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, created_at)
     VALUES (?, ?, 'outgoing', 'text', ?, 'csa_reminder_cron', ?)`,
  ).bind(messageLogId, friend.id, text, now).run();

  const reminderId = crypto.randomUUID();
  // INSERT OR IGNORE: UNIQUE(line_user_id, reminder_type, due_at) が
  // 同一 due_at への重複送信レコードを自然に防止する。
  await db.prepare(
    `INSERT OR IGNORE INTO csa_application_reminders (
       id, line_user_id, application_id, reminder_type, due_at, status,
       sent_at, message_log_id, attempt_count, created_by
     ) VALUES (?, ?, NULL, ?, ?, 'sent', ?, ?, 1, 'system:csa-reminder-cron')`,
  ).bind(reminderId, applicant.lineUserId, templateKey, dueAt, now, messageLogId).run();

  await recordCsaFunnelEventSafely(db, {
    friendId: friend.id,
    lineUserId: applicant.lineUserId,
    eventType: 'reminder_sent',
    source: 'csa_reminder_cron',
    sourceRef: reminderId,
    occurredAt: now,
    metadata: { templateKey },
    dedupeKey: `csa_reminder_cron:${reminderId}:reminder_sent`,
  }, 'csa reminder sent');
}
