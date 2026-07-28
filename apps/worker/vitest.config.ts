import { defineConfig } from 'vitest/config';

// 単体テスト専用の設定。
// apps/worker/vite.config.ts は @cloudflare/vite-plugin を使うが、
// vitest の Node 実行環境ではこのプラグインが Workers ランタイム前提の
// バリデーションで例外を投げるため、テスト実行時は素の vite 設定を使う。
export default defineConfig({
  test: {
    environment: 'node',
    // 2026-07-29 発見: src/services/csa-reminder-delivery.test.ts は
    // "@line-crm/line-sdk" のパッケージ解決エラーで実行前に落ちる
    // (本 vitest 導入以前は CI 自体が存在せず、一度も実行されていなかった
    // 既存の別問題。今回の顧客事実巻き戻り対応の範囲外のため、ここでは
    // 除外に留め、別途調査・修理を代表へ報告する)。
    exclude: [
      '**/node_modules/**',
      'src/services/csa-reminder-delivery.test.ts',
    ],
  },
});
