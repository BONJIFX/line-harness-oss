import { getTrafficPoolBySlug, getRandomPoolAccount, getPoolAccounts } from '@line-crm/db';

/**
 * /r/:ref の遷移先 LIFF URL を解決する。
 *
 * 稟議#5 により LIFF_URL は BONJI が値を出すまで意図的未設定であり得る
 * (secret 追加は禁止)。この関数はどのソースからも LIFF URL が得られない
 * 場合に例外を投げず null を返す — 呼び出し側 (index.ts) はこれを見て
 * fail-graceful なレスポンス (404 案内) を返す。
 *
 * 解決順序 (元の index.ts /r/:ref 実装と同一、ロジック変更なし):
 * 1. トラフィックプール (poolSlug) にランダムアカウントが割り当てられて
 *    おり、そのアカウントに liff_id があればそれを使う
 * 2. プールにアカウントが1件も無く、プール自体に liff_id があればそれを使う
 * 3. 上記いずれにも該当しなければ envLiffUrl (c.env.LIFF_URL) を使う
 * 4. envLiffUrl も未設定なら null を返す (= 呼び出し側で 404 案内)
 */
export async function resolveBaseLiffUrl(
  db: D1Database,
  envLiffUrl: string | undefined,
  poolSlug: string,
): Promise<string | null> {
  let liffUrl: string | undefined = envLiffUrl;

  const pool = await getTrafficPoolBySlug(db, poolSlug);
  if (pool) {
    const account = await getRandomPoolAccount(db, pool.id);
    if (account) {
      if (account.liff_id) liffUrl = `https://liff.line.me/${account.liff_id}`;
    } else {
      const allAccounts = await getPoolAccounts(db, pool.id);
      if (allAccounts.length === 0) {
        if (pool.liff_id) liffUrl = `https://liff.line.me/${pool.liff_id}`;
      }
    }
  }

  return liffUrl ?? null;
}

/**
 * LIFF URL が一切解決できなかった場合の案内ページ (404)。
 * LIFF_URL の値を推測・発明しない (稟議#5 の意図的未設定を尊重)。
 */
export function shortLinkUnavailablePage(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>準備中です</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans','Helvetica Neue',system-ui,sans-serif;background:#f5f7f5;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:16px}
.card{background:#fff;border-radius:20px;box-shadow:0 2px 20px rgba(0,0,0,0.06);text-align:center;max-width:360px;width:100%;padding:36px 24px;border:1px solid rgba(0,0,0,0.04)}
.title{font-size:16px;color:#222;font-weight:700;margin-bottom:10px;line-height:1.6}
.msg{font-size:13px;color:#666;line-height:1.7}
</style>
</head>
<body>
<div class="card">
<p class="title">このリンクは現在準備中です</p>
<p class="msg">しばらく経ってから再度お試しください。</p>
</div>
</body>
</html>`;
}
