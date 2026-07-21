import { Hono } from 'hono';
import { verifySignature, LineClient } from '@line-crm/line-sdk';
import type { WebhookRequestBody, WebhookEvent, TextEventMessage } from '@line-crm/line-sdk';
import {
  upsertFriend,
  updateFriendFollowStatus,
  getFriendByLineUserId,
  addTagToFriend,
  getScenarios,
  enrollFriendInScenario,
  getScenarioSteps,
  advanceFriendScenario,
  completeFriendScenario,
  upsertChatOnMessage,
  getLineAccounts,
  jstNow,
} from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { buildMessage, expandVariables } from '../services/step-delivery.js';
import type { Env } from '../index.js';
import { recordCsaFunnelEventSafely } from './csa-funnel.js';

const webhook = new Hono<Env>();

const CSA_INTEREST_PREFIX = 'csa_interest:';
const CSA_INTEREST_SEGMENTS: Record<string, { label: string; tag: string; color: string; reply: string }> = {
  learn_candles: {
    label: 'ローソク足・相場分析を学びたい',
    tag: '興味: ローソク足',
    color: '#f59e0b',
    reply: 'ありがとうございます。\nローソク足・相場分析に関するご案内を優先してお届けします。',
  },
  seminar: {
    label: '無料セミナーや勉強会の案内がほしい',
    tag: '興味: 無料セミナー',
    color: '#3b82f6',
    reply: 'ありがとうございます。\n無料セミナーや勉強会のご案内を優先してお届けします。',
  },
  member_support: {
    label: 'CSA受講中・購入済みなのでサポート案内がほしい',
    tag: '区分: CSA受講・購入済み申告',
    color: '#22c55e',
    reply: 'ありがとうございます。\nCSA受講・購入済みの方向け案内として確認しました。必要に応じて個別に確認します。',
  },
  opt_out: {
    label: '今後の案内は不要',
    tag: '配信停止希望',
    color: '#64748b',
    reply: '承知しました。\n今後のご案内を控えさせていただきます。',
  },
};
const CSA_INTEREST_TAG_NAMES = Object.values(CSA_INTEREST_SEGMENTS).map((segment) => segment.tag);

webhook.post('/webhook', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('X-Line-Signature') ?? '';
  const db = c.env.DB;

  let body: WebhookRequestBody;
  try {
    body = JSON.parse(rawBody) as WebhookRequestBody;
  } catch {
    console.error('Failed to parse webhook body');
    return c.json({ status: 'ok' }, 200);
  }

  // Multi-account: resolve credentials from DB by destination (channel user ID)
  // or fall back to environment variables (default account)
  let channelSecret = c.env.LINE_CHANNEL_SECRET;
  let channelAccessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
  let matchedAccountId: string | null = null;

  if ((body as { destination?: string }).destination) {
    const accounts = await getLineAccounts(db);
    for (const account of accounts) {
      if (!account.is_active) continue;
      const isValid = await verifySignature(account.channel_secret, rawBody, signature);
      if (isValid) {
        channelSecret = account.channel_secret;
        channelAccessToken = account.channel_access_token;
        matchedAccountId = account.id;
        break;
      }
    }
  }

  // Verify with resolved secret
  const valid = await verifySignature(channelSecret, rawBody, signature);
  if (!valid) {
    console.error('Invalid LINE signature');
    return c.json({ status: 'ok' }, 200);
  }

  const lineClient = new LineClient(channelAccessToken);

  // 非同期処理 — LINE は ~1s 以内のレスポンスを要求
  const processingPromise = (async () => {
    for (const event of body.events) {
      try {
        await handleEvent(
          db,
          lineClient,
          event,
          channelAccessToken,
          matchedAccountId,
          c.env.WORKER_URL || new URL(c.req.url).origin,
          c.env.API_KEY,
          c.env.LIFF_URL,
        );
      } catch (err) {
        console.error('Error handling webhook event:', err);
      }
    }
  })();

  c.executionCtx.waitUntil(processingPromise);

  return c.json({ status: 'ok' }, 200);
});

async function handleEvent(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  lineAccessToken: string,
  lineAccountId: string | null = null,
  workerUrl?: string,
  apiKey?: string,
  liffUrl?: string,
): Promise<void> {
  if (event.type === 'follow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    console.log(`[follow] userId=${userId} lineAccountId=${lineAccountId}`);

    // プロフィール取得 & 友だち登録/更新
    let profile;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      console.error('Failed to get profile for', userId, err);
    }

    console.log(`[follow] profile=${profile?.displayName ?? 'null'}`);

    const friend = await upsertFriend(db, {
      lineUserId: userId,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
    });

    console.log(`[follow] friend.id=${friend.id} friend.line_account_id=${(friend as any).line_account_id}`);

    // Set line_account_id for multi-account tracking (always update on follow)
    if (lineAccountId) {
      await db.prepare('UPDATE friends SET line_account_id = ?, updated_at = ? WHERE id = ?')
        .bind(lineAccountId, jstNow(), friend.id).run();
      console.log(`[follow] line_account_id set to ${lineAccountId} for friend ${friend.id}`);
    }

    // friend_add シナリオに登録（このアカウントのシナリオのみ）
    const scenarios = await getScenarios(db);
    for (const scenario of scenarios) {
      // Only trigger scenarios belonging to this account (or unassigned for backward compat)
      const scenarioAccountMatch = !scenario.line_account_id || !lineAccountId || scenario.line_account_id === lineAccountId;
      if (scenario.trigger_type === 'friend_add' && scenario.is_active && scenarioAccountMatch) {
        try {
          // INSERT OR IGNORE handles dedup via UNIQUE(friend_id, scenario_id)
          const friendScenario = await enrollFriendInScenario(db, friend.id, scenario.id);
          if (!friendScenario) continue; // already enrolled

            // Immediate delivery: if the first step has delay=0, send it now via replyMessage (free)
            const steps = await getScenarioSteps(db, scenario.id);
            const firstStep = steps[0];
            if (firstStep && firstStep.delay_minutes === 0 && friendScenario.status === 'active') {
              try {
                const { resolveMetadata } = await import('../services/step-delivery.js');
                const resolvedMeta = await resolveMetadata(db, { user_id: (friend as unknown as Record<string, string | null>).user_id, metadata: (friend as unknown as Record<string, string | null>).metadata });
                const expandedContent = expandVariables(firstStep.message_content, { ...friend, metadata: resolvedMeta } as Parameters<typeof expandVariables>[1]);
                const message = buildMessage(firstStep.message_type, expandedContent);
                await lineClient.replyMessage(event.replyToken, [message]);
                console.log(`Immediate delivery: sent step ${firstStep.id} to ${userId}`);

                // Log outgoing message (replyMessage = 無料)
                const logId = crypto.randomUUID();
                await db
                  .prepare(
                    `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, created_at)
                     VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, 'reply', 'scenario', ?)`,
                  )
                  .bind(logId, friend.id, firstStep.message_type, firstStep.message_content, firstStep.id, jstNow())
                  .run();

                // Advance or complete the friend_scenario
                const secondStep = steps[1] ?? null;
                if (secondStep) {
                  const nextDeliveryDate = new Date(Date.now() + 9 * 60 * 60_000);
                  nextDeliveryDate.setMinutes(nextDeliveryDate.getMinutes() + secondStep.delay_minutes);
                  // Enforce 9:00-21:00 JST delivery window
                  const h = nextDeliveryDate.getUTCHours();
                  if (h < 9 || h >= 21) {
                    if (h >= 21) nextDeliveryDate.setUTCDate(nextDeliveryDate.getUTCDate() + 1);
                    nextDeliveryDate.setUTCHours(9, 0, 0, 0);
                  }
                  await advanceFriendScenario(db, friendScenario.id, firstStep.step_order, nextDeliveryDate.toISOString().slice(0, -1) + '+09:00');
                } else {
                  await completeFriendScenario(db, friendScenario.id);
                }
              } catch (err) {
                console.error('Failed immediate delivery for scenario', scenario.id, err);
              }
            }
        } catch (err) {
          console.error('Failed to enroll friend in scenario', scenario.id, err);
        }
      }
    }

    // イベントバス発火: friend_add（replyToken は Step 0 で使用済みの可能性あり）
    await fireEvent(db, 'friend_add', { friendId: friend.id, eventData: { displayName: friend.display_name } }, lineAccessToken, lineAccountId);
    return;
  }

  if (event.type === 'unfollow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    await updateFriendFollowStatus(db, userId, false);
    return;
  }

  // Postback events — triggered by Flex buttons with action.type: "postback"
  // Uses the same auto_replies matching but without displaying text in chat
  if (event.type === 'postback') {
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await ensureFriendForIncomingMessage(db, lineClient, event, lineAccountId, 'postback');
    if (!friend) return;

    const postbackData = (event as unknown as { postback: { data: string } }).postback.data;

    if (postbackData.startsWith(CSA_INTEREST_PREFIX)) {
      await handleCsaInterestPostback(db, lineClient, event, friend, postbackData);
      return;
    }

    // Match postback data against auto_replies (exact match on keyword)
    const autoReplyQuery = lineAccountId
      ? `SELECT * FROM auto_replies WHERE is_active = 1 AND (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at ASC`
      : `SELECT * FROM auto_replies WHERE is_active = 1 AND line_account_id IS NULL ORDER BY created_at ASC`;
    const autoReplyStmt = db.prepare(autoReplyQuery);
    const autoReplies = await (lineAccountId ? autoReplyStmt.bind(lineAccountId) : autoReplyStmt)
      .all<{
        id: string;
        keyword: string;
        match_type: 'exact' | 'contains';
        response_type: string;
        response_content: string;
      }>();

    for (const rule of autoReplies.results) {
      const isMatch = rule.match_type === 'exact'
        ? postbackData === rule.keyword
        : postbackData.includes(rule.keyword);

      if (isMatch) {
        try {
          const { resolveMetadata } = await import('../services/step-delivery.js');
          const resolvedMeta = await resolveMetadata(db, { user_id: (friend as unknown as Record<string, string | null>).user_id, metadata: (friend as unknown as Record<string, string | null>).metadata });
          const expandedContent = expandVariables(rule.response_content, { ...friend, metadata: resolvedMeta } as Parameters<typeof expandVariables>[1], workerUrl);
          const replyMsg = buildMessage(rule.response_type, expandedContent);
          await lineClient.replyMessage(event.replyToken, [replyMsg]);
        } catch (err) {
          console.error('Failed to send postback reply', err);
        }
        break;
      }
    }
    return;
  }

  // 非テキストの受信メッセージ（スタンプ/画像/音声/動画/ファイル/位置情報等）もログに残す。
  // ここで早期 return することで、テキスト用の auto_reply / scenario 判定には進まない
  // （スタンプ単体に対するキーワードマッチは意味を持たないため）。inbox 抜けだけ防ぐ。
  if (event.type === 'message' && event.message.type !== 'text') {
    const friend = await ensureFriendForIncomingMessage(db, lineClient, event, lineAccountId, 'non_text_message');
    if (!friend) return;

    const msg = event.message as { type: string; fileName?: string; title?: string };
    const labels: Record<string, string> = {
      sticker: '[スタンプ]',
      image: '[画像]',
      audio: '[音声]',
      video: '[動画]',
      file: msg.fileName ? `[ファイル: ${msg.fileName}]` : '[ファイル]',
      location: msg.title ? `[位置情報: ${msg.title}]` : '[位置情報]',
    };
    const content = labels[msg.type] ?? `[${msg.type}]`;

    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, created_at)
         VALUES (?, ?, 'incoming', ?, ?, NULL, NULL, 'user', ?)`,
      )
      .bind(crypto.randomUUID(), friend.id, msg.type, content, jstNow())
      .run();
    return;
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const textMessage = event.message as TextEventMessage;
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await ensureFriendForIncomingMessage(db, lineClient, event, lineAccountId, 'message');
    if (!friend) return;

    const incomingText = textMessage.text;
    const now = jstNow();
    const logId = crypto.randomUUID();

    // 受信メッセージをログに記録
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, created_at)
         VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, 'user', ?)`,
      )
      .bind(logId, friend.id, incomingText, now)
      .run();

    const csaPaymentIntake = await handleCsaPaymentIntake(
      db,
      lineClient,
      event,
      friend,
      incomingText,
      logId,
      now,
      workerUrl,
      apiKey,
    );
    if (csaPaymentIntake.replyTokenConsumed) {
      return;
    }

    // チャット unread 判定は auto_replies マッチ結果 (matched) を使う。
    // ハードコードキーワードリストは廃止 — auto_replies テーブルが single source of truth。
    const isTimeCommand = /(?:配信時間|配信|届けて|通知)[はを]?\s*\d{1,2}\s*時/.test(incomingText);

    // 配信時間設定: 「配信時間は○時」「○時に届けて」等のパターンを検出
    const timeMatch = incomingText.match(/(?:配信時間|配信|届けて|通知)[はを]?\s*(\d{1,2})\s*時/);
    if (timeMatch) {
      const hour = parseInt(timeMatch[1], 10);
      if (hour >= 6 && hour <= 22) {
        // Save preferred_hour to friend metadata
        const existing = await db.prepare('SELECT metadata FROM friends WHERE id = ?').bind(friend.id).first<{ metadata: string }>();
        const meta = JSON.parse(existing?.metadata || '{}');
        meta.preferred_hour = hour;
        await db.prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify(meta), jstNow(), friend.id).run();

        // Reply with confirmation
        try {
          const period = hour < 12 ? '午前' : '午後';
          const displayHour = hour <= 12 ? hour : hour - 12;
          await lineClient.replyMessage(event.replyToken, [
            buildMessage('flex', JSON.stringify({
              type: 'bubble',
              body: { type: 'box', layout: 'vertical', contents: [
                { type: 'text', text: '配信時間を設定しました', size: 'lg', weight: 'bold', color: '#1e293b' },
                { type: 'box', layout: 'vertical', contents: [
                  { type: 'text', text: `${period} ${displayHour}:00`, size: 'xxl', weight: 'bold', color: '#f59e0b', align: 'center' },
                  { type: 'text', text: `（${hour}:00〜）`, size: 'sm', color: '#64748b', align: 'center', margin: 'sm' },
                ], backgroundColor: '#fffbeb', cornerRadius: 'md', paddingAll: '20px', margin: 'lg' },
                { type: 'text', text: '今後のステップ配信はこの時間以降にお届けします。', size: 'xs', color: '#64748b', wrap: true, margin: 'lg' },
              ], paddingAll: '20px' },
            })),
          ]);
        } catch (err) {
          console.error('Failed to reply for time setting', err);
        }
        return;
      }
    }

    // Cross-account trigger: send message from another account via UUID
    if (incomingText === '体験を完了する' && lineAccountId) {
      try {
        const friendRecord = await db.prepare('SELECT user_id FROM friends WHERE id = ?').bind(friend.id).first<{ user_id: string | null }>();
        if (friendRecord?.user_id) {
          // Find the same user on other accounts
          const otherFriends = await db.prepare(
            'SELECT f.line_user_id, la.channel_access_token FROM friends f INNER JOIN line_accounts la ON la.id = f.line_account_id WHERE f.user_id = ? AND f.line_account_id != ? AND f.is_following = 1'
          ).bind(friendRecord.user_id, lineAccountId).all<{ line_user_id: string; channel_access_token: string }>();

          for (const other of otherFriends.results) {
            const otherClient = new LineClient(other.channel_access_token);
            const { buildMessage: bm } = await import('../services/step-delivery.js');
            await otherClient.pushMessage(other.line_user_id, [bm('flex', JSON.stringify({
              type: 'bubble', size: 'giga',
              header: { type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: '#fffbeb',
                contents: [{ type: 'text', text: `${friend.display_name || ''}さんへ`, size: 'lg', weight: 'bold', color: '#1e293b' }],
              },
              body: { type: 'box', layout: 'vertical', paddingAll: '20px',
                contents: [
                  { type: 'text', text: '別アカウントからのアクションを検知しました。', size: 'sm', color: '#06C755', weight: 'bold', wrap: true },
                  { type: 'text', text: 'アカウント連携が正常に動作しています。体験ありがとうございました。', size: 'sm', color: '#1e293b', wrap: true, margin: 'md' },
                  { type: 'separator', margin: 'lg' },
                  { type: 'text', text: 'ステップ配信・フォーム即返信・アカウント連携・リッチメニュー・自動返信 — 全て無料、全てOSS。', size: 'xs', color: '#64748b', wrap: true, margin: 'lg' },
                ],
              },
              footer: { type: 'box', layout: 'vertical', paddingAll: '16px',
                contents: [
                  { type: 'button', action: { type: 'message', label: '導入について相談する', text: '導入支援を希望します' }, style: 'primary', color: '#06C755' },
                  ...(liffUrl ? [{ type: 'button', action: { type: 'uri', label: 'フィードバックを送る', uri: `${liffUrl}?page=form` }, style: 'secondary', margin: 'sm' }] : []),
                ],
              },
            }))]);
          }

          // Reply on Account ② confirming
          await lineClient.replyMessage(event.replyToken, [buildMessage('flex', JSON.stringify({
            type: 'bubble',
            body: { type: 'box', layout: 'vertical', paddingAll: '20px',
              contents: [
                { type: 'text', text: 'Account ① にメッセージを送りました', size: 'sm', color: '#06C755', weight: 'bold', align: 'center' },
                { type: 'text', text: 'Account ① のトーク画面を確認してください', size: 'xs', color: '#64748b', align: 'center', margin: 'md' },
              ],
            },
          }))]);
          return;
        }
      } catch (err) {
        console.error('Cross-account trigger error:', err);
      }
    }

    // 自動返信チェック（このアカウントのルール + グローバルルールのみ）
    // NOTE: Auto-replies use replyMessage (free, no quota) instead of pushMessage
    // The replyToken is only valid for ~1 minute after the message event
    const autoReplyQuery = lineAccountId
      ? `SELECT * FROM auto_replies WHERE is_active = 1 AND (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at ASC`
      : `SELECT * FROM auto_replies WHERE is_active = 1 AND line_account_id IS NULL ORDER BY created_at ASC`;
    const autoReplyStmt = db.prepare(autoReplyQuery);
    const autoReplies = await (lineAccountId ? autoReplyStmt.bind(lineAccountId) : autoReplyStmt)
      .all<{
        id: string;
        keyword: string;
        match_type: 'exact' | 'contains';
        response_type: string;
        response_content: string;
        is_active: number;
        created_at: string;
      }>();

    let matched = false;
    let replyTokenConsumed = false;
    for (const rule of autoReplies.results) {
      const isMatch =
        rule.match_type === 'exact'
          ? incomingText === rule.keyword
          : incomingText.includes(rule.keyword);

      if (isMatch) {
        // silent タイプ: 返信しないが matched=true にして unread / push を抑止する
        if (rule.response_type === 'silent') {
          matched = true;
          break;
        }

        try {
          const { resolveMetadata: resolveMeta2 } = await import('../services/step-delivery.js');
          const resolvedMeta2 = await resolveMeta2(db, { user_id: (friend as unknown as Record<string, string | null>).user_id, metadata: (friend as unknown as Record<string, string | null>).metadata });
          const expandedContent = expandVariables(rule.response_content, { ...friend, metadata: resolvedMeta2 } as Parameters<typeof expandVariables>[1], workerUrl);
          const replyMsg = buildMessage(rule.response_type, expandedContent);
          await lineClient.replyMessage(event.replyToken, [replyMsg]);
          replyTokenConsumed = true;

          // 送信ログ（replyMessage = 無料）
          const outLogId = crypto.randomUUID();
          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'auto_reply', ?)`,
            )
            .bind(outLogId, friend.id, rule.response_type, rule.response_content, jstNow())
            .run();
        } catch (err) {
          console.error('Failed to send auto-reply', err);
        }

        matched = true;
        break;
      }
    }

    // auto_replies にマッチしなかった & 配信時間コマンドでもない = 自発メッセージ → unread にする
    if (!matched && !isTimeCommand) {
      await upsertChatOnMessage(db, friend.id);
    }

    // イベントバス発火: message_received
    // Pass replyToken only when auto_reply didn't actually consume it
    await fireEvent(db, 'message_received', {
      friendId: friend.id,
      eventData: { text: incomingText, matched },
      replyToken: replyTokenConsumed ? undefined : event.replyToken,
    }, lineAccessToken, lineAccountId);

    return;
  }
}

function shouldHandleCsaPaymentIntake(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (/^(\u6c7a\u6e08|\u652f\u6255\u3044\u5b8c\u4e86|\u7533\u8fbc|\u7533\u3057\u8fbc\u307f|\u5165\u4f1a|CSA\u7533\u8fbc|CSA\u7533\u3057\u8fbc\u307f)$/i.test(normalized)) return true;

  const hasEmail = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(normalized);
  const hasPaymentSignal = /(\u30ab\u30fc\u30c9|\u30af\u30ec\u30ab|\u9280\u884c|\u632f\u8fbc|\u9280\u632f|\u3086\u3046\u3061\u3087|\u5165\u91d1|\u6c7a\u6e08)/.test(normalized);
  return hasEmail && hasPaymentSignal;
}

async function handleCsaPaymentIntake(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  friend: Awaited<ReturnType<typeof ensureFriendForIncomingMessage>>,
  incomingText: string,
  incomingMessageId: string,
  receivedAt: string,
  workerUrl?: string,
  apiKey?: string,
): Promise<{ handled: boolean; replyTokenConsumed: boolean }> {
  if (event.type !== 'message' || !friend || !shouldHandleCsaPaymentIntake(incomingText)) {
    return { handled: false, replyTokenConsumed: false };
  }

  try {
    const normalized = incomingText.trim();
    const isPaymentGuide = /^(\u6c7a\u6e08|\u7533\u8fbc|\u7533\u3057\u8fbc\u307f|\u5165\u4f1a|CSA\u7533\u8fbc|CSA\u7533\u3057\u8fbc\u307f)$/i.test(normalized);
    const baseUrl = (workerUrl || 'https://csa-line-harness.paison0357.workers.dev').replace(/\/$/, '');
    let messageContent: string;
    let altText: string;

    if (isPaymentGuide) {
      await recordCsaFunnelEventSafely(db, {
        friendId: friend.id,
        lineUserId: friend.line_user_id,
        eventType: 'keyword_received',
        source: 'messages_log',
        sourceRef: incomingMessageId,
        occurredAt: receivedAt,
        metadata: { content: normalized },
        dedupeKey: `messages_log:${incomingMessageId}:keyword_received`,
      }, 'keyword received');
      const formToken = apiKey
        ? await createCsaFormToken({
          lineUserId: friend.line_user_id,
          lineDisplayName: friend.display_name || '',
          secret: apiKey,
        })
        : '';
      const formUrl = baseUrl + '/api/liff/csa-apply?v=20260716-2'
        + (formToken ? `&t=${encodeURIComponent(formToken)}` : '');
      messageContent = JSON.stringify(buildCsaApplicationFormFlex(formUrl));
      altText = 'CSAのお申込み前の最終確認です。';
    } else {
      const paymentMethod = inferCsaPaymentMethod(normalized);
      await recordCsaFunnelEventSafely(db, {
        friendId: friend.id,
        lineUserId: friend.line_user_id,
        eventType: 'payment_reported',
        paymentMethod,
        source: 'messages_log',
        sourceRef: incomingMessageId,
        occurredAt: receivedAt,
        metadata: { content: normalized, legacy: true },
        dedupeKey: `messages_log:${incomingMessageId}:payment_reported`,
      }, 'legacy payment reported');
      messageContent = JSON.stringify(buildCsaPostPaymentFlex());
      altText = 'CSAのお支払い後のご案内です。';
    }
    const message = buildMessage('flex', messageContent, altText);

    await lineClient.replyMessage(event.replyToken, [message]);

    const outgoingMessageId = crypto.randomUUID();
    const outgoingAt = jstNow();
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, created_at)
         VALUES (?, ?, 'outgoing', 'flex', ?, NULL, NULL, 'reply', 'csa_payment_intake', ?)`,
      )
      .bind(outgoingMessageId, friend.id, messageContent, outgoingAt)
      .run();

    if (isPaymentGuide) {
      await recordCsaFunnelEventSafely(db, {
          friendId: friend.id,
          lineUserId: friend.line_user_id,
          eventType: 'form_issued',
          source: 'messages_log',
          sourceRef: outgoingMessageId,
          occurredAt: outgoingAt,
          dedupeKey: `messages_log:${outgoingMessageId}:form_issued`,
        }, 'form issued');
    }

    return { handled: true, replyTokenConsumed: true };
  } catch (err) {
    console.error('CSA payment intake form reply error:', err);
    try {
      await lineClient.replyMessage(event.replyToken, [buildMessage('text', [
        '申込フォームを発行できませんでした。',
        '少し時間をおいて、もう一度「決済」と送ってください。',
      ].join('\n'))]);
      return { handled: true, replyTokenConsumed: true };
    } catch (replyError) {
      console.error('CSA payment intake failure reply error:', replyError);
      return { handled: true, replyTokenConsumed: false };
    }
  }
}

function inferCsaPaymentMethod(text: string): 'card' | 'bank_transfer' | null {
  if (/(\u9280\u884c|\u632f\u8fbc|\u9280\u632f|\u3086\u3046\u3061\u3087)/.test(text)) return 'bank_transfer';
  if (/(\u30ab\u30fc\u30c9|\u30af\u30ec\u30ab)/.test(text)) return 'card';
  return null;
}

function buildCsaPaymentGuideFlex() {
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: '#0B1428', paddingAll: '18px',
      contents: [
        { type: 'text', text: 'Candle Smart Academy', color: '#D7A63D', size: 'xs', weight: 'bold' },
        { type: 'text', text: 'お支払い案内', color: '#FFFFFF', size: 'xl', weight: 'bold', margin: 'sm' },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: '18px', spacing: 'md',
      contents: [
        { type: 'text', text: 'カード払い', size: 'md', weight: 'bold', color: '#0B1428' },
        { type: 'text', text: '下の「カードで支払う」からお手続きください。', size: 'sm', color: '#4B5563', wrap: true },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '銀行振込', size: 'md', weight: 'bold', color: '#0B1428', margin: 'md' },
        { type: 'text', text: '金額: 330,000円\n銀行: ゆうちょ銀行\n支店: 〇九八支店\n種別: 普通\n口座番号: 1843444\n口座名義: コクサイセイキトケイキヨウカイ', size: 'sm', color: '#374151', wrap: true },
        { type: 'text', text: 'お支払い後に「支払い完了後はこちら」を押してください。', size: 'sm', color: '#9A6A16', weight: 'bold', wrap: true, margin: 'md' },
      ],
    },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
      contents: [
        { type: 'button', style: 'primary', color: '#0B1428', action: { type: 'uri', label: 'カードで支払う', uri: 'https://fincs.jp/plan/8030521697119276466/join/personalinfo?planPriceId=742' } },
        { type: 'button', style: 'secondary', action: { type: 'message', label: '支払い完了後はこちら', text: '支払い完了' } },
      ],
    },
  };
}

function buildCsaApplicationFormFlex(formUrl: string) {
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: '#0B1428', paddingAll: '18px',
      contents: [
        { type: 'text', text: 'Candle Smart Academy', color: '#D7A63D', size: 'xs', weight: 'bold' },
        { type: 'text', text: 'お申込み前の最終確認', color: '#FFFFFF', size: 'xl', weight: 'bold', margin: 'sm' },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: '18px', spacing: 'md',
      contents: [
        { type: 'text', text: '価格・期間・提供内容・キャンセル条件をご確認ください。', size: 'md', weight: 'bold', color: '#0B1428', wrap: true },
        { type: 'text', text: '3つの確認項目に同意した後、カードまたは銀行振込を選べます。確認ボタンを押した時点では、お支払いは発生しません。', size: 'sm', color: '#4B5563', wrap: true },
      ],
    },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: '16px',
      contents: [
        { type: 'button', style: 'primary', color: '#0B1428', action: { type: 'uri', label: '申込条件を確認する', uri: formUrl } },
      ],
    },
  };
}

function buildCsaPostPaymentFlex() {
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: '#0B1428', paddingAll: '18px',
      contents: [
        { type: 'text', text: 'Candle Smart Academy', color: '#D7A63D', size: 'xs', weight: 'bold' },
        { type: 'text', text: 'お手続きありがとうございます', color: '#FFFFFF', size: 'xl', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: '18px', spacing: 'md',
      contents: [
        { type: 'text', text: '運営がご入金を確認しています。', size: 'md', weight: 'bold', color: '#0B1428', wrap: true },
        { type: 'text', text: '確認でき次第、あなた専用の Discord 招待と会員開始のご案内を、この LINE へお送りします。', size: 'sm', color: '#374151', wrap: true },
        { type: 'text', text: '確認までお時間をいただく場合があります。3営業日を過ぎてもご案内が届かない場合は、このLINEに「ヘルプ」とご返信ください。', size: 'xs', color: '#6B7280', wrap: true },
      ],
    },
  };
}

async function createCsaFormToken({
  lineUserId,
  lineDisplayName,
  secret,
}: {
  lineUserId: string;
  lineDisplayName: string;
  secret: string;
}): Promise<string> {
  const payload = {
    line_user_id: lineUserId,
    line_display_name: lineDisplayName,
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  };
  const payloadPart = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signaturePart = await hmacSha256(payloadPart, secret);
  return `${payloadPart}.${signaturePart}`;
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

async function ensureFriendForIncomingMessage(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  lineAccountId: string | null,
  source: 'message' | 'non_text_message' | 'postback',
) {
  const userId = event.source.type === 'user' ? event.source.userId : undefined;
  if (!userId) return null;

  const existing = await getFriendByLineUserId(db, userId);
  const recoveredAt = jstNow();
  if (existing) {
    if (lineAccountId && !existing.line_account_id) {
      const metadata = JSON.parse(existing.metadata || '{}');
      metadata.line_existing_friend_seen_at = recoveredAt;
      metadata.line_existing_friend_seen_source = source;
      await db.prepare('UPDATE friends SET line_account_id = ?, metadata = ?, updated_at = ? WHERE id = ?')
        .bind(lineAccountId, JSON.stringify(metadata), recoveredAt, existing.id)
        .run();
      return (await getFriendByLineUserId(db, userId)) ?? existing;
    }
    return existing;
  }

  let profile;
  try {
    profile = await lineClient.getProfile(userId);
  } catch (err) {
    console.error('Failed to get profile while recovering existing friend', userId, err);
  }

  const friend = await upsertFriend(db, {
    lineUserId: userId,
    displayName: profile?.displayName ?? null,
    pictureUrl: profile?.pictureUrl ?? null,
    statusMessage: profile?.statusMessage ?? null,
  });

  const metadata = JSON.parse(friend.metadata || '{}');
  metadata.line_existing_friend_recovered_at = recoveredAt;
  metadata.line_existing_friend_recovered_source = source;

  if (lineAccountId) {
    await db.prepare('UPDATE friends SET line_account_id = ?, metadata = ?, updated_at = ? WHERE id = ?')
      .bind(lineAccountId, JSON.stringify(metadata), recoveredAt, friend.id)
      .run();
  } else {
    await db.prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(metadata), recoveredAt, friend.id)
      .run();
  }

  return (await getFriendByLineUserId(db, userId)) ?? friend;
}

async function handleCsaInterestPostback(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  friend: NonNullable<Awaited<ReturnType<typeof getFriendByLineUserId>>>,
  postbackData: string,
) {
  const segment = postbackData.slice(CSA_INTEREST_PREFIX.length);
  const config = CSA_INTEREST_SEGMENTS[segment];
  if (!config || event.type !== 'postback') return;

  const selectedAt = jstNow();
  const metadata = JSON.parse(friend.metadata || '{}');
  const previousHistory = Array.isArray(metadata.interest_segment_history)
    ? metadata.interest_segment_history
    : [];
  metadata.interest_segment_history = [
    ...previousHistory,
    {
      segment,
      label: config.label,
      selected_at: selectedAt,
      source: 'csa_interest_recovery_broadcast',
    },
  ].slice(-20);
  metadata.interest_segment = segment;
  metadata.interest_segment_label = config.label;
  metadata.interest_segment_selected_at = selectedAt;
  metadata.interest_segment_source = 'csa_interest_recovery_broadcast';
  if (segment === 'opt_out') {
    metadata.line_opt_out_requested = true;
    metadata.line_opt_out_requested_at = selectedAt;
  } else {
    metadata.line_opt_out_requested = false;
    metadata.line_opt_out_cleared_at = selectedAt;
  }

  await db.prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(metadata), selectedAt, friend.id)
    .run();

  await removeCsaInterestTags(db, friend.id);
  const tag = await getOrCreateTag(db, config.tag, config.color);
  await addTagToFriend(db, friend.id, tag.id);

  const logId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, created_at)
       VALUES (?, ?, 'incoming', 'postback', ?, NULL, NULL, 'csa_interest_recovery', ?)`,
    )
    .bind(logId, friend.id, config.label, selectedAt)
    .run();

  await lineClient.replyMessage(event.replyToken, [
    buildMessage('text', config.reply),
  ]);
}

async function removeCsaInterestTags(db: D1Database, friendId: string): Promise<void> {
  if (CSA_INTEREST_TAG_NAMES.length === 0) return;

  const placeholders = CSA_INTEREST_TAG_NAMES.map(() => '?').join(', ');
  await db
    .prepare(
      `DELETE FROM friend_tags
       WHERE friend_id = ?
       AND tag_id IN (SELECT id FROM tags WHERE name IN (${placeholders}))`,
    )
    .bind(friendId, ...CSA_INTEREST_TAG_NAMES)
    .run();
}

async function getOrCreateTag(
  db: D1Database,
  name: string,
  color: string,
): Promise<{ id: string; name: string; color: string }> {
  const existing = await db
    .prepare('SELECT id, name, color FROM tags WHERE name = ?')
    .bind(name)
    .first<{ id: string; name: string; color: string }>();
  if (existing) return existing;

  const id = crypto.randomUUID();
  await db
    .prepare('INSERT OR IGNORE INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, name, color, jstNow())
    .run();

  return (await db
    .prepare('SELECT id, name, color FROM tags WHERE name = ?')
    .bind(name)
    .first<{ id: string; name: string; color: string }>())!;
}

export { webhook };
