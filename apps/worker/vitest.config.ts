import { defineConfig } from 'vitest/config';

// 単体テスト専用の設定。
// apps/worker/vite.config.ts は @cloudflare/vite-plugin を使うが、
// vitest の Node 実行環境ではこのプラグインが Workers ランタイム前提の
// バリデーションで例外を投げるため、テスト実行時は素の vite 設定を使う。
export default defineConfig({
  test: {
    environment: 'node',
    // 2026-07-29 修理: src/services/csa-reminder-delivery.test.ts が
    // "@line-crm/line-sdk" のパッケージ解決エラーで落ちる原因は、
    // packages/line-sdk と packages/shared の dist/ が .gitignore 対象で
    // リポジトリに含まれておらず、fresh clone + pnpm install だけでは
    // ビルドされないため(package.json に prepare/postinstall がない)。
    // apps/worker/package.json の pretest/prebuild で
    // `pnpm run build:deps` (line-sdk + shared の tsc ビルド) を先に
    // 実行するようにしたため、除外は不要になった。
    exclude: ['**/node_modules/**'],
  },
});
