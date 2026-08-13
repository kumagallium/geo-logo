// vite.config.ts とは分離する。vitest 2 が同梱する vite の型が
// アプリ側の vite 6 と衝突するため、テスト設定だけ独立させる。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
