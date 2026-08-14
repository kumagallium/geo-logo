/**
 * Hono サーバーを単一ファイルへバンドルして sidecar として同梱できるようにする。
 *
 * Graphium の scripts/bundle-server.mjs を移植。banner の中身は同アプリが
 * 実際に踏んだ不具合の対策なので、そのまま持ってくる価値がある。
 */
import { build } from 'esbuild'

/**
 * paper の Node ビルドは jsdom と canvas を require する経路を含む。
 *
 * geo-logo は `paper.setup(new Size(...))` しか使わず canvas を作らないので、
 * この経路は実行されない（現に jsdom を入れずにサーバーもテストも動いている）。
 * だがバンドラは実行の有無に関わらず解決しようとして失敗するため、空モジュール
 * へ寄せる。external にすると require がバンドルに残り、万一通ったときに
 * 実行時エラーになる。
 */
const stubOptionalNativeDeps = {
  name: 'stub-optional-native-deps',
  setup(b) {
    b.onResolve({ filter: /^(jsdom|canvas)(\/|$)/ }, (args) => ({
      path: args.path,
      namespace: 'stub',
    }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      // 空オブジェクトを返してはいけない。paper は require が通れば実体が
      // あるとみなして `new jsdom.JSDOM()` へ進み、TypeError で落ちる。
      // paper 側には読み込み失敗を握る catch が既にあるので、そこへ倒す。
      contents: `throw new Error("Cannot find module '${args.path}'");`,
      loader: 'js',
    }))
  },
}

await build({
  plugins: [stubOptionalNativeDeps],
  entryPoints: ['src/server/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'src-tauri/sidecar/server.mjs',
  external: ['node:*'],
  banner: {
    js: [
      // ESM バンドルには require が無い。CJS 由来の依存が同期 require を使う。
      "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      // ESM では __dirname / __filename がスコープに無い。CJS 由来の依存は
      // トップレベルで path.resolve(__dirname, ...) を読むことがあり、未定義だと
      // バンドル読み込み時に ReferenceError で無音終了する。
      "import { fileURLToPath as __toPath } from 'node:url'; import { dirname as __dir } from 'node:path'; const __filename = __toPath(import.meta.url); const __dirname = __dir(__filename);",
      // 起動直後に 1 行 stderr へ出す。「spawn は成功したがログが 0 行」という
      // 症状のとき、pipe が生きているかどうかの切り分けに要る。
      "process.stderr.write('[sidecar-probe] boot\\n');",
      // top-level import が同期的に throw したときの無音終了を防ぐ。
      "process.on('uncaughtException', (e) => { process.stderr.write('[uncaught] ' + (e && e.stack || e) + '\\n'); process.exit(99); });",
      "process.on('unhandledRejection', (e) => { process.stderr.write('[unhandled] ' + (e && e.stack || e) + '\\n'); });",
    ].join('\n'),
  },
})

console.log('[bundle-server] src-tauri/sidecar/server.mjs を書き出しました')
