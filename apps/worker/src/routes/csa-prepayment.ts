export const CSA_CONTRACT_VERSION = 'CSA_CONTRACT_2026_07_16';
export const CSA_COPY_VERSION = 'FABLE_PREPAYMENT_FINAL_2026_07_16';
export const CSA_COPY_SHA256 = 'A1C989D8AE97F6AF45931A18DB0326DB2D70C09767FC8A53121659C20244584D';
export const CSA_TERMS_VERSION = 'CSA_TERMS_2026_07_16_DRAFT';
export const CSA_COMMERCE_LAW_VERSION = 'CSA_COMMERCE_LAW_2026_07_16_DRAFT';
export const CSA_PRIVACY_VERSION = 'CSA_PRIVACY_2026_07_16_DRAFT';
export const CSA_ROUTE_VERSION = '20260716-2';
export const CSA_CARD_PAYMENT_URL = 'https://fincs.jp/plan/8030521697119276466/join/personalinfo?planPriceId=742';

export const CSA_BANK_DETAILS = {
  amount: '330,000円',
  bank: 'ゆうちょ銀行',
  branch: '〇九八支店',
  accountType: '普通',
  accountNumber: '1843444',
  accountName: 'コクサイセイキトケイキヨウカイ',
} as const;

type ApplyPageInput = {
  liffId: string;
  formToken: string;
  tokenLineUserId: string;
  tokenLineDisplayName: string;
  localPreview: boolean;
};

export function renderCsaPrepaymentPage(input: ApplyPageInput): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CSA お申込み前の最終確認</title>
  <link rel="icon" href="data:," />
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <style>
    :root {
      color-scheme: dark;
      --bg: #071225;
      --panel: #0e1a31;
      --panel2: #14223c;
      --line: rgba(221,170,62,.34);
      --gold: #d9a83a;
      --gold2: #f3c766;
      --ink: #fff8e6;
      --muted: #b8c2d8;
      --danger: #ff8585;
      --ok: #86dda1;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at top, #102246 0, var(--bg) 46%, #030813 100%);
      color: var(--ink);
    }
    main { width: min(760px, calc(100% - 28px)); margin: 0 auto; padding: 28px 0 56px; }
    .eyebrow { color: var(--gold2); font-size: 12px; font-weight: 900; letter-spacing: .16em; }
    h1 { margin: 8px 0 10px; font-size: clamp(27px, 7vw, 42px); line-height: 1.16; }
    h2 { margin: 0 0 14px; font-size: 22px; }
    p, li { color: var(--muted); line-height: 1.75; }
    .lead { margin-bottom: 22px; }
    .panel {
      border: 1px solid var(--line);
      background: rgba(14,26,49,.96);
      border-radius: 12px;
      padding: clamp(18px, 4vw, 28px);
      box-shadow: 0 18px 50px rgba(0,0,0,.28);
    }
    .step { color: var(--gold2); font-size: 12px; font-weight: 900; letter-spacing: .12em; }
    .condition {
      padding: 16px 0;
      border-bottom: 1px solid rgba(255,255,255,.1);
    }
    .condition:last-child { border-bottom: 0; }
    .condition strong { display: block; color: var(--gold2); margin-bottom: 7px; }
    .condition p { margin: 0; }
    .condition ul { margin: 0; padding-left: 1.2rem; }
    .legal-links { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 20px 0; }
    .legal-links a {
      display: flex; align-items: center; justify-content: center; min-height: 48px;
      border: 1px solid var(--line); border-radius: 8px; color: var(--gold2);
      text-decoration: none; text-align: center; font-size: 13px; font-weight: 800; padding: 8px;
    }
    label.field { display: block; margin-top: 16px; color: var(--gold2); font-size: 13px; font-weight: 900; }
    input {
      width: 100%; margin-top: 7px; padding: 12px; border-radius: 7px;
      border: 1px solid rgba(255,255,255,.16); background: #081226; color: var(--ink); font: inherit;
    }
    input:focus { outline: none; border-color: var(--gold); box-shadow: 0 0 0 3px rgba(217,168,58,.18); }
    .check { display: flex; align-items: flex-start; gap: 10px; margin-top: 14px; color: var(--ink); line-height: 1.65; }
    .check input { width: 19px; height: 19px; margin: 3px 0 0; flex: 0 0 auto; }
    button, .button-link {
      width: 100%; display: block; margin-top: 18px; border: 0; border-radius: 8px;
      background: linear-gradient(135deg, var(--gold), var(--gold2)); color: #1a1203;
      font: inherit; font-weight: 900; padding: 14px 16px; cursor: pointer; text-align: center; text-decoration: none;
    }
    button.secondary { background: #e9eef8; color: #0b1428; }
    button:disabled { opacity: .52; cursor: not-allowed; }
    .notice { margin-top: 10px; color: #97a5bf; font-size: 12px; text-align: center; }
    .error { margin-top: 14px; color: var(--danger); font-size: 13px; line-height: 1.65; }
    .method-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .method { border: 1px solid var(--line); background: var(--panel2); border-radius: 10px; padding: 16px; }
    .method h3 { margin: 0 0 8px; }
    .method p { margin: 0; font-size: 13px; }
    .bank { margin-top: 18px; padding: 16px; border: 1px solid var(--line); border-radius: 9px; background: #09152a; }
    .bank dl { display: grid; grid-template-columns: 110px 1fr; gap: 8px; margin: 0; }
    .bank dt { color: var(--muted); }
    .bank dd { margin: 0; color: var(--ink); font-weight: 800; overflow-wrap: anywhere; }
    .complete { border-color: rgba(134,221,161,.52); }
    .complete h2 { color: var(--ok); }
    .hidden { display: none !important; }
    @media (max-width: 620px) {
      .legal-links, .method-grid { grid-template-columns: 1fr; }
      .bank dl { grid-template-columns: 90px 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">CANDLE SMART ACADEMY</div>
    <h1 id="pageTitle">お申込み前の、最終確認です</h1>
    <p id="pageLead" class="lead">下の内容をご確認のうえ、3 つのチェックを入れてお進みください。</p>

    <section id="step1" class="panel" aria-labelledby="step1-title">
      <div class="step">画面 1 / 3</div>
      <h2 id="step1-title">お申込み前の最終確認</h2>

      <div class="condition"><strong>■ 商品名</strong><p>Candle Smart Academy(CSA)本講座</p></div>
      <div class="condition"><strong>■ 提供内容</strong><ul>
        <li>会員サイトの教材(全 43 章)と理解度チェック</li>
        <li>週次の相場解説(一般的な解説です。個別の売買の推奨は行いません)</li>
        <li>グループ相談会(学習内容の質問の場です。個別の投資判断の指示は行いません)</li>
        <li>AI チューター(教材の内容にもとづいて回答します)</li>
        <li>会員専用 Discord コミュニティ</li>
        <li>認定試験(筆記・実技)と認定証</li>
      </ul></div>
      <div class="condition"><strong>■ 受講期間</strong><p>ご利用開始から 6 か月間</p></div>
      <div class="condition"><strong>■ 価格</strong><p>総額 330,000 円(税込)。上記以外に当社へお支払いいただく費用はありません。</p></div>
      <div class="condition"><strong>■ お支払い方法と時期</strong><ul>
        <li>クレジットカード: お手続き時にお支払いが確定します。分割払いは、お使いのカード会社の提供条件と手数料によります。</li>
        <li>銀行振込: 一括払いのみ。お申込み後にご案内する口座へ、募集期間内にお振込みください。振込手数料はご負担ください。</li>
      </ul></div>
      <div class="condition"><strong>■ サービスの提供開始時期</strong><p>ご入金の確認後、ただちに開始します(あなた専用のご案内を LINE へお送りします)。</p></div>
      <div class="condition"><strong>■ 募集期間</strong><p>2026 年 7 月 17 日(金)〜 7 月 21 日(火)</p></div>
      <div class="condition"><strong>■ キャンセル・返金について</strong><ul>
        <li><b>ご入金前は、お申込みの取り消しが可能です。ご入金後のキャンセル・返金・中途解約はいたしかねます。</b>ご入金の確認をもって、直ちにサービスの提供が開始されるためです。</li>
        <li>ただし、法令上認められる契約の解除、または当社の責めに帰すべき事由によりサービスが提供されない場合は、この限りではありません。</li>
        <li>ご連絡・お問い合わせは、公式 LINE または下記メールにて承ります。3 営業日以内にご返答いたします。</li>
      </ul></div>
      <div class="condition"><strong>■ 販売事業者</strong><p>
        販売事業者: 合同会社 GGC<br />
        運営責任者: 郡司 大資<br />
        所在地: 東京都中央区銀座 1-22-11-2F<br />
        電話番号: 050-3138-3671(お電話でのご対応は行っておりません。お問い合わせは公式 LINE またはメールにお願いします)<br />
        メール: 3challenge.bonji@gmail.com
      </p></div>
      <div class="condition"><strong>■ 個人情報の取扱い</strong><p>ご記入いただいた情報(氏名・連絡先・LINE の識別子など)は、受講のご案内・ご連絡・会員管理のために利用します。くわしくは下のプライバシーポリシーをご覧ください。</p></div>

      <nav class="legal-links" aria-label="契約文書">
        <a href="/api/liff/csa-terms?v=${CSA_ROUTE_VERSION}" target="_blank" rel="noreferrer">利用規約</a>
        <a href="/api/liff/csa-commerce-law?v=${CSA_ROUTE_VERSION}" target="_blank" rel="noreferrer">特定商取引法に基づく表記</a>
        <a href="/api/liff/csa-privacy?v=${CSA_ROUTE_VERSION}" target="_blank" rel="noreferrer">プライバシーポリシー</a>
      </nav>

      <label class="field">氏名<input id="name" autocomplete="name" required placeholder="例: 山田 太郎" /></label>
      <label class="field">メールアドレス<input id="email" autocomplete="email" type="email" required placeholder="購入時に申告するメールアドレス" /></label>
      <label class="field">電話番号（任意）<input id="phone" autocomplete="tel" placeholder="緊急時の連絡先として任意" /></label>

      <label class="check"><input id="agreeTerms" type="checkbox" /><span>申込条件と利用規約に同意します</span></label>
      <label class="check"><input id="agreePrivacy" type="checkbox" /><span>個人情報の取扱いを確認しました</span></label>
      <label class="check"><input id="agreeEducation" type="checkbox" /><span>CSA は教育サービスであり、利益や成果を保証しないことを確認しました</span></label>

      <button id="continue" type="button">上記を確認・同意して、支払い方法を選ぶ</button>
      <p class="notice">(ボタンを押した時点では、お支払いは発生しません)</p>
      <div id="step1Error" class="error hidden" role="alert"></div>
    </section>

    <section id="step2" class="panel hidden" aria-labelledby="step2-title">
      <div class="step">画面 2 / 3</div>
      <h2 id="step2-title">お支払い方法を選んでください</h2>
      <div class="method-grid">
        <article class="method"><h3>クレジットカード</h3><p>お手続き時にお支払いが確定します。</p><button id="card" type="button">クレジットカードで支払う</button></article>
        <article class="method"><h3>銀行振込</h3><p>銀行振込は一括払いのみです。</p><button id="bank" class="secondary" type="button">銀行振込を選ぶ</button></article>
      </div>
      <p>・銀行振込は一括払いのみです。<br />・カードの分割払いは、お使いのカード会社の提供条件と手数料によります。</p>
      <div id="step2Error" class="error hidden" role="alert"></div>
      <div id="bankDetails" class="bank hidden">
        <h3>銀行振込のご案内</h3>
        <dl>
          <dt>金額</dt><dd>${escapeHtml(CSA_BANK_DETAILS.amount)}</dd>
          <dt>銀行</dt><dd>${escapeHtml(CSA_BANK_DETAILS.bank)}</dd>
          <dt>支店</dt><dd>${escapeHtml(CSA_BANK_DETAILS.branch)}</dd>
          <dt>種別</dt><dd>${escapeHtml(CSA_BANK_DETAILS.accountType)}</dd>
          <dt>口座番号</dt><dd>${escapeHtml(CSA_BANK_DETAILS.accountNumber)}</dd>
          <dt>口座名義</dt><dd>${escapeHtml(CSA_BANK_DETAILS.accountName)}</dd>
        </dl>
        <p>振込手数料はご負担ください。お振込み後に、下のボタンから運営へお知らせください。</p>
        <button id="bankComplete" type="button">振込手続き完了を運営へ知らせる</button>
      </div>
    </section>

    <section id="step3" class="panel complete hidden" aria-labelledby="step3-title">
      <div class="step">画面 3 / 3</div>
      <h2 id="step3-title">お手続きありがとうございます</h2>
      <p>運営がご入金を確認しています。<br />確認でき次第、<b>あなた専用の Discord 招待と会員開始のご案内</b>を、この LINE へお送りします。<br />(確認までお時間をいただく場合があります。3 営業日を過ぎてもご案内が届かない場合は、この LINE に「ヘルプ」とご返信ください)</p>
    </section>
  </main>
  <script>
    const LIFF_ID = ${JSON.stringify(input.liffId)};
    const FORM_TOKEN = ${JSON.stringify(input.formToken)};
    const TOKEN_LINE_USER_ID = ${JSON.stringify(input.tokenLineUserId)};
    const TOKEN_LINE_DISPLAY_NAME = ${JSON.stringify(input.tokenLineDisplayName)};
    const CONTRACT_VERSION = ${JSON.stringify(CSA_CONTRACT_VERSION)};
    const COPY_VERSION = ${JSON.stringify(CSA_COPY_VERSION)};
    const COPY_SHA256 = ${JSON.stringify(CSA_COPY_SHA256)};
    const TERMS_VERSION = ${JSON.stringify(CSA_TERMS_VERSION)};
    const COMMERCE_LAW_VERSION = ${JSON.stringify(CSA_COMMERCE_LAW_VERSION)};
    const PRIVACY_VERSION = ${JSON.stringify(CSA_PRIVACY_VERSION)};
    const CARD_PAYMENT_URL = ${JSON.stringify(CSA_CARD_PAYMENT_URL)};
    const LOCAL_PREVIEW = ${JSON.stringify(input.localPreview)};
    let lineProfile = null;
    let consentEventId = null;
    let applicationId = null;
    let applicationSaved = false;

    const byId = (id) => document.getElementById(id);
    const showError = (id, message) => { const node = byId(id); node.textContent = message; node.classList.remove('hidden'); };
    const clearError = (id) => { const node = byId(id); node.textContent = ''; node.classList.add('hidden'); };
    const showStep = (step) => {
      ['step1', 'step2', 'step3'].forEach((id) => byId(id).classList.toggle('hidden', id !== step));
      const headings = {
        step1: ['お申込み前の、最終確認です', '下の内容をご確認のうえ、3 つのチェックを入れてお進みください。'],
        step2: ['お支払い方法を選んでください', 'カードまたは銀行振込を選択してください。'],
        step3: ['お手続きありがとうございます', '運営がご入金を確認しています。'],
      };
      byId('pageTitle').textContent = headings[step][0];
      byId('pageLead').textContent = headings[step][1];
      window.scrollTo({ top: 0, behavior: 'auto' });
    };

    async function init() {
      try {
        if (LIFF_ID) {
          await liff.init({ liffId: LIFF_ID });
        }
        if (TOKEN_LINE_USER_ID) {
          lineProfile = { userId: TOKEN_LINE_USER_ID, displayName: TOKEN_LINE_DISPLAY_NAME };
          return;
        }
        if (!LIFF_ID) throw new Error('LINEの申込リンクが正しくありません。LINEで再度「決済」と送って、届いたフォームから開いてください。');
        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: location.href });
          return;
        }
        lineProfile = await liff.getProfile();
      } catch (error) {
        showError('step1Error', error instanceof Error ? error.message : 'LINE認証に失敗しました。');
      }
    }

    function validateStep1() {
      if (!lineProfile || !lineProfile.userId) return 'LINE認証が完了していません。ページを再読み込みしてください。';
      if (!byId('name').value.trim()) return '氏名を入力してください。';
      if (!byId('email').value.trim() || !byId('email').checkValidity()) return '正しいメールアドレスを入力してください。';
      if (!byId('agreeTerms').checked || !byId('agreePrivacy').checked || !byId('agreeEducation').checked) return '3つの確認項目すべてにチェックを入れてください。';
      return '';
    }

    async function saveApplication(paymentMethod) {
      if (applicationSaved) return;
      consentEventId = consentEventId || crypto.randomUUID();
      if (LOCAL_PREVIEW) {
        applicationId = 'qa-application-preview';
        applicationSaved = true;
        return;
      }
      const response = await fetch('/api/liff/csa-application', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          consentEventId,
          lineUserId: lineProfile.userId,
          lineDisplayName: lineProfile.displayName || '',
          formToken: FORM_TOKEN,
          applicantName: byId('name').value,
          email: byId('email').value,
          phone: byId('phone').value,
          paymentMethod,
          contractVersion: CONTRACT_VERSION,
          displayedCopyVersion: COPY_VERSION,
          displayedCopySha256: COPY_SHA256,
          termsVersion: TERMS_VERSION,
          commerceLawVersion: COMMERCE_LAW_VERSION,
          privacyPolicyVersion: PRIVACY_VERSION,
          agreedTerms: byId('agreeTerms').checked,
          agreedPrivacy: byId('agreePrivacy').checked,
          agreedEducationNoResult: byId('agreeEducation').checked,
          contractAgreedAt: new Date().toISOString(),
          userAgent: navigator.userAgent,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.message || '申込情報と同意記録を保存できませんでした。');
      if (!data.applicationId) throw new Error('申込IDを確認できませんでした。お支払いへ進まず、運営へお知らせください。');
      applicationId = data.applicationId;
      applicationSaved = true;
    }

    byId('continue').addEventListener('click', () => {
      clearError('step1Error');
      const error = validateStep1();
      if (error) return showError('step1Error', error);
      showStep('step2');
    });

    byId('card').addEventListener('click', async () => {
      clearError('step2Error');
      byId('card').disabled = true;
      byId('bank').disabled = true;
      try {
        await saveApplication('card');
        location.href = CARD_PAYMENT_URL;
      } catch (error) {
        byId('card').disabled = false;
        byId('bank').disabled = false;
        showError('step2Error', error instanceof Error ? error.message : '保存に失敗しました。');
      }
    });

    byId('bank').addEventListener('click', async () => {
      clearError('step2Error');
      byId('card').disabled = true;
      byId('bank').disabled = true;
      try {
        await saveApplication('bank_transfer');
        byId('bankDetails').classList.remove('hidden');
      } catch (error) {
        byId('card').disabled = false;
        byId('bank').disabled = false;
        showError('step2Error', error instanceof Error ? error.message : '保存に失敗しました。');
      }
    });

    byId('bankComplete').addEventListener('click', async () => {
      const button = byId('bankComplete');
      try {
        clearError('step2Error');
        if (!applicationId || !lineProfile || !lineProfile.userId) {
          showError('step2Error', '申込情報を確認できませんでした。ページを再読み込みして、銀行振込を選び直してください。');
          return;
        }
        button.disabled = true;
        button.textContent = '運営へ通知中...';
        if (!LOCAL_PREVIEW) {
          const response = await fetch('/api/liff/csa-bank-transfer-complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              completionEventId: crypto.randomUUID(),
              lineUserId: lineProfile.userId,
              applicationId,
              formToken: FORM_TOKEN,
              reportedAt: new Date().toISOString(),
              userAgent: navigator.userAgent,
            }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.ok || !data.noticeSaved) {
            throw new Error(data.message || '完了通知を保存できませんでした。');
          }
        }
        showStep('step3');
      } catch (error) {
        button.disabled = false;
        button.textContent = '振込手続き完了を運営へ知らせる';
        showError('step2Error', error instanceof Error ? error.message : '完了通知を保存できませんでした。もう一度ボタンを押してください。');
      }
    });

    init();
  </script>
</body>
</html>`;
}

export function renderCsaTermsPage(): string {
  return renderLegalPage('利用規約', CSA_TERMS_VERSION, `
    <h2>1. 適用</h2><p>本規約は、合同会社GGCが提供するCandle Smart Academy(CSA)本講座の利用条件を定めます。</p>
    <h2>2. 提供内容と期間</h2><p>提供内容は、会員サイト教材、理解度チェック、週次の一般的な相場解説、学習内容のグループ相談、教材にもとづくAIチューター、Discordコミュニティ、認定試験および認定証です。利用期間は利用開始から6か月間です。</p>
    <h2>3. 教育サービスとしての性質</h2><p>本講座は教育サービスです。個別の金融商品の売買、投資判断、利益または成果を保証するものではありません。最終的な投資判断は受講者自身が行います。</p>
    <h2>4. 料金と支払い</h2><p>受講料は総額330,000円(税込)です。カード払いまたは銀行振込により支払います。銀行振込手数料は受講者負担です。</p>
    <h2>5. キャンセル・返金・中途解約</h2><p>ご入金前は申込みの取り消しが可能です。ご入金後のキャンセル・返金・中途解約はいたしかねます。ただし、法令上認められる契約の解除、または当社の責めに帰すべき事由によりサービスが提供されない場合は、この限りではありません。</p>
    <h2>6. アカウントと禁止事項</h2><p>本人専用のLINE、Discordおよび会員サイト情報を第三者へ共有、譲渡または貸与してはなりません。教材の無断転載、再配布、販売、録画・複製による第三者提供を禁止します。</p>
    <h2>7. 提供の停止</h2><p>規約違反、運営妨害、不正アクセスその他サービスの安全な提供を妨げる行為が確認された場合、必要な範囲で利用を停止することがあります。</p>
    <h2>8. 連絡</h2><p>お問い合わせは公式LINEまたは3challenge.bonji@gmail.comで承り、3営業日以内に返答します。</p>
  `);
}

export function renderCsaCommerceLawPage(): string {
  return renderLegalPage('特定商取引法に基づく表記', CSA_COMMERCE_LAW_VERSION, `
    <dl>
      <dt>販売事業者</dt><dd>合同会社GGC</dd>
      <dt>運営責任者</dt><dd>郡司 大資</dd>
      <dt>所在地</dt><dd>東京都中央区銀座1-22-11-2F</dd>
      <dt>電話番号</dt><dd>050-3138-3671<br />お電話でのご対応は行っておりません。お問い合わせは公式LINEまたはメールにお願いします。</dd>
      <dt>メール</dt><dd>3challenge.bonji@gmail.com</dd>
      <dt>商品名</dt><dd>Candle Smart Academy(CSA)本講座</dd>
      <dt>販売価格</dt><dd>総額330,000円(税込)</dd>
      <dt>商品代金以外の費用</dt><dd>銀行振込手数料。カード分割払いを利用する場合はカード会社所定の手数料。</dd>
      <dt>支払方法・時期</dt><dd>クレジットカードは手続き時に支払いが確定します。銀行振込は一括払いで、募集期間内にお振込みください。</dd>
      <dt>提供開始</dt><dd>入金確認後、ただちに開始します。</dd>
      <dt>利用期間</dt><dd>利用開始から6か月間</dd>
      <dt>申込期間</dt><dd>2026年7月17日(金)〜7月21日(火)</dd>
      <dt>キャンセル等</dt><dd>入金前は申込みの取り消しが可能です。入金後のキャンセル・返金・中途解約はいたしかねます。ただし、法令上認められる解除、または当社の責めに帰すべき事由によりサービスが提供されない場合を除きます。</dd>
    </dl>
  `);
}

export function renderCsaPrivacyPage(): string {
  return renderLegalPage('プライバシーポリシー', CSA_PRIVACY_VERSION, `
    <h2>1. 取得する情報</h2><p>氏名、メールアドレス、電話番号、LINEの識別子・表示名、支払方法、契約同意の内容・日時・表示文書版、端末のuser agent、受講・問い合わせ・会員管理に必要な情報を取得します。</p>
    <h2>2. 利用目的</h2><ul><li>申込み、契約同意および入金の確認</li><li>受講開始、Discord招待、会員サイト利用の案内</li><li>本人確認、会員管理、問い合わせ対応</li><li>不正利用、重複登録およびセキュリティ事故の防止</li><li>サービス運営と品質改善</li></ul>
    <h2>3. 第三者提供</h2><p>法令に基づく場合を除き、本人の同意なく個人データを第三者へ提供しません。決済、認証、配信、データ保管等の業務委託先には、必要な範囲で取り扱いを委託する場合があります。</p>
    <h2>4. 安全管理</h2><p>アクセス制御、認証、監査記録その他合理的な安全管理措置を講じます。</p>
    <h2>5. 開示等と問い合わせ</h2><p>保有個人データの開示、訂正、利用停止等のご相談は、公式LINEまたは3challenge.bonji@gmail.comへご連絡ください。</p>
  `);
}

function renderLegalPage(title: string, version: string, body: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${escapeHtml(title)} | CSA</title><link rel="icon" href="data:," /><style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#071225;color:#fff8e6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(760px,calc(100% - 28px));margin:0 auto;padding:30px 0 56px}h1{font-size:clamp(28px,7vw,42px)}h2{margin-top:30px;color:#f3c766}p,li,dd{color:#c3ccdc;line-height:1.8}dl{display:grid;grid-template-columns:180px 1fr;gap:0;border:1px solid rgba(221,170,62,.34)}dt,dd{margin:0;padding:13px;border-bottom:1px solid rgba(255,255,255,.1)}dt{font-weight:800;color:#f3c766}.version{font-size:12px;color:#8794ad}@media(max-width:600px){dl{grid-template-columns:1fr}dt{padding-bottom:4px}dd{padding-top:4px}}</style></head><body><main><p>CANDLE SMART ACADEMY</p><h1>${escapeHtml(title)}</h1>${body}<p class="version">文書バージョン: ${escapeHtml(version)}</p></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
