import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const API_PORT = Number(process.env.GEOLOGO_PORT ?? 8787)

// GitHub Pages はリポジトリ名のサブパス配下（例 /geo_logo/）で配信されるため、
// ビルド時に base を差し替えられるようにしておく。CI が
// GEOLOGO_BASE=/<repo>/ を渡す。ローカル / 独自ドメインでは "/" のまま。
const base = process.env.GEOLOGO_BASE ?? '/'

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    // paper.js と AI SDK 一式でチャンクが大きくなるが、単一ページの
    // ツールなので分割しても初回描画は速くならない。警告だけ黙らせる。
    chunkSizeWarningLimit: 1500,
  },
})
