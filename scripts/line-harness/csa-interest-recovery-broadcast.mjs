#!/usr/bin/env node

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (name, fallback = '') => {
  const prefix = `${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
};

const baseUrl = (process.env.LINE_HARNESS_URL || 'https://csa-line-harness.paison0357.workers.dev').replace(/\/$/, '');
const apiKey = process.env.LINE_HARNESS_API_KEY || process.env.API_KEY;
const title = valueOf('--title', `CSAご案内整理 ${new Date().toISOString().slice(0, 10)}`);
const createDraft = has('--create-draft');
const sendNow = has('--send-now');
const sendId = valueOf('--send-id', '');
const confirmSend = valueOf('--confirm-send', '');

const altText = 'Candle Smart Academyからご案内整理のお願いです。1つだけ選んでください。';

const flex = {
  type: 'bubble',
  size: 'mega',
  header: {
    type: 'box',
    layout: 'vertical',
    paddingAll: '20px',
    backgroundColor: '#0b1730',
    contents: [
      {
        type: 'text',
        text: 'Candle Smart Academy',
        size: 'sm',
        weight: 'bold',
        color: '#f8c15a',
      },
      {
        type: 'text',
        text: 'ご案内整理のお願いです',
        size: 'lg',
        weight: 'bold',
        color: '#ffffff',
        wrap: true,
        margin: 'md',
      },
      {
        type: 'text',
        text: '1タップで完了します',
        size: 'xs',
        color: '#cbd5e1',
        margin: 'sm',
      },
    ],
  },
  body: {
    type: 'box',
    layout: 'vertical',
    paddingAll: '18px',
    spacing: 'md',
    contents: [
      {
        type: 'text',
        text: 'こんにちは、Candle Smart Academyです。これまでセミナーや学習案内などでつながってくださった方へ、今後のご案内を整理しています。',
        size: 'sm',
        color: '#334155',
        wrap: true,
      },
      {
        type: 'text',
        text: '必要な内容だけお届けしたいので、今の状況に近いものを1つだけ選んでください。案内不要も選べます。',
        size: 'sm',
        color: '#334155',
        wrap: true,
        margin: 'sm',
      },
      {
        type: 'button',
        style: 'primary',
        color: '#d89a2b',
        action: {
          type: 'postback',
          label: 'ローソク足を学びたい',
          data: 'csa_interest:learn_candles',
          displayText: 'ローソク足を学びたい',
        },
      },
      {
        type: 'button',
        style: 'secondary',
        action: {
          type: 'postback',
          label: '無料セミナー希望',
          data: 'csa_interest:seminar',
          displayText: '無料セミナー希望',
        },
      },
      {
        type: 'button',
        style: 'secondary',
        action: {
          type: 'postback',
          label: 'CSA受講・購入済み',
          data: 'csa_interest:member_support',
          displayText: 'CSA受講・購入済み',
        },
      },
      {
        type: 'button',
        style: 'secondary',
        action: {
          type: 'postback',
          label: '案内は不要',
          data: 'csa_interest:opt_out',
          displayText: '案内は不要',
        },
      },
    ],
  },
};

async function request(path, options = {}) {
  if (!apiKey) throw new Error('Missing LINE_HARNESS_API_KEY or API_KEY.');
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok || data.success === false) {
    throw new Error(`${options.method || 'GET'} ${path} failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function createBroadcastDraft() {
  return request('/api/broadcasts', {
    method: 'POST',
    body: JSON.stringify({
      title,
      messageType: 'flex',
      messageContent: JSON.stringify(flex),
      targetType: 'all',
      altText,
    }),
  });
}

async function sendBroadcast(id) {
  if (confirmSend !== 'CSA_INTEREST_RECOVERY') {
    throw new Error('Refusing to send. Add --confirm-send=CSA_INTEREST_RECOVERY to broadcast to all LINE friends.');
  }
  return request(`/api/broadcasts/${id}/send`, { method: 'POST' });
}

async function main() {
  console.log(`title=${title}`);
  console.log(`altText=${altText}`);
  console.log(`flex=${JSON.stringify(flex, null, 2)}`);

  let broadcastId = sendId;
  if (createDraft || sendNow) {
    const created = await createBroadcastDraft();
    broadcastId = created.data.id;
    console.log(`created_broadcast_id=${broadcastId}`);
  }

  if (sendNow || sendId) {
    if (!broadcastId) throw new Error('Missing broadcast id.');
    const sent = await sendBroadcast(broadcastId);
    console.log(`sent=${JSON.stringify(sent.data)}`);
  } else {
    console.log('not_sent=true');
  }
}

main().catch((err) => {
  console.error(`error=${err.message}`);
  process.exitCode = 1;
});
