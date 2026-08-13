# geo-logo

円と直線だけでロゴを **構成的に** 設計する Web アプリ。

「完成ロゴ」と「設計図」を**同一の幾何データから**出力するのが中核。設計図は生成画像に後から重ねたグリッドではなく、実際にブーリアン演算に使われた円・直線そのものです。

```
① LLM が構成プランを DSL(JSON) で出力
       ↓
② 正規化 — 寸法をモジュール系へスナップし、幾何制約をソルバーで解く   ← ここが肝
       ↓
③ paper.js のブーリアン演算で最終パスを導出
       ↓
④ 同じデータから logo.svg と blueprint.svg を出力
```

## 2 つの実行モード

| | サーバーモード | 静的モード |
|---|---|---|
| 使う場面 | ローカル `pnpm dev` / セルフホスト | GitHub Pages などの静的配信 |
| API キーの保管 | サーバー側 `data/models.json`（macOS は Keychain へ移行可） | ブラウザの localStorage |
| LLM 呼び出し | Hono サーバー経由 | ブラウザからプロバイダーへ直接 |
| 判定方法 | `/api/health` が JSON を返すか（`src/lib/runtime-mode.ts`） | |

Graphium の `ServerMode: "node" | "vercel"` と同じ考え方です。設計エージェント本体
（`src/lib/design-agent.ts`）はどちらのモードでも同一のコードを使います。

## セキュリティ

このアプリは **API キーを保持し、ワンクリックで課金リクエストを発行する**ので、
そこを起点に設計しています。

### 静的モードでキーを保存しない理由

`<user>.github.io` は、**その利用者のすべての Pages プロジェクトでオリジンが共通**です。
localStorage はオリジン単位なので、同じアカウントの別リポジトリのページからも読めます。

そのため既定では **API キーを保存しません**（タブを閉じるまでのメモリ保持）。
保存は設定画面のチェックボックスで明示的に選ぶ形にし、「保存済みキーを localStorage
から削除」する導線も置いています。サーバーモードならキーはブラウザに一切載りません。

### LLM 出力を信頼境界として扱う

生成された SVG は `dangerouslySetInnerHTML` でページへ注入されます。つまり
**LLM の出力が markup に到達する**ため、ここが最大の攻撃面です。実際、初期実装には
`palette` が任意文字列で `fill="${...}"` に補間される注入経路がありました
（`src/core/security.test.ts` に再現テストがあります）。

対策は 3 層:

1. **スキーマで形を限定**（`src/core/dsl.ts`）— 色は 16 進表記のみ、id は
   `[A-Za-z0-9_-]` のみ、座標・寸法は有限かつ範囲内、配列は要素数上限つき
2. **レンダラでエスケープ**（`src/core/render.ts`）— 色は再検証して不正なら黒へ落とし、
   属性値は `& " ' < >` をエスケープ
3. **CSP `script-src 'self'`** — インライン script も `onload=` 等のイベント属性も禁止。
   1・2 が破られても実行されない

数値の範囲制限は DoS 対策も兼ねています（`r: 1e9` でソルバーが発散し、
巨大な SVG でブラウザが固まるのを防ぐ）。

### ローカル API サーバー

`pnpm dev` のサーバーは API キーを持つので、利用者が開いている**無関係なサイト**から
叩かれないようにしています。

- **CORS を張らない** — ブラウザからは Vite の proxy 経由で同一オリジンとして届くので不要。
  開けると任意のサイトから叩けるようになる
- **送信元を検査**（`src/server/security.ts`）— `Sec-Fetch-Site` が same-origin / none
  以外なら拒否。CORS を開けていなくても、単純リクエストは*レスポンスが読めないだけで
  副作用は発生する*ため、これが実際の CSRF 対策になる
- **`127.0.0.1` にのみバインド** — 既定の `0.0.0.0` だと同一 LAN の他端末から叩ける
- **`data/` は 0700、`models.json` は 0600** — Keychain 無効時はこのファイルが
  キーの実体になる
- `X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy` / `Cache-Control: no-store`

外部ホストから使う場合は `GEOLOGO_ALLOWED_ORIGINS` で明示します。

### 配信側

- **CSP** を本番ビルドにのみ meta で注入（`vite.config.ts`）。dev に入れると HMR が
  壊れるため build 限定
- `frame-ancestors` は meta では仕様上無視されるので、**埋め込み検出は実行時**に行う
  （`src/main.tsx`）。GitHub Pages は HTTP ヘッダーを設定できないため
- `referrer: no-referrer`
- **GitHub Actions はタグではなく commit SHA で固定**。タグは可変で、上書きされると
  デプロイ成果物へ任意コードを混ぜられる。更新は Dependabot が PR で提案する
- CI は `pnpm install --frozen-lockfile --ignore-scripts`（依存の postinstall を走らせない）
- ワークフローの `permissions` は既定 `{}` で、ジョブ単位に最小権限を付与

### 残っている制約

- **静的モードでキーを「保存する」と選んだ場合**、同一オリジンの他 Pages から読めます。
  これはブラウザのオリジンモデル上、`*.github.io` では回避できません。恒久的に安全に
  したい場合は独自ドメインで配信するか、サーバーモードを使ってください
- `connect-src` はプロバイダーのエンドポイントがユーザー設定である以上 `https:` までしか
  絞れません。XSS が実行された場合の送信先制限としては弱く、実質的な防御は
  `script-src 'self'` です
- 静的モードでは API キーがブラウザからプロバイダーへ直接送られます（中継しない設計上必然）

## セットアップ

```bash
pnpm install
pnpm dev      # web: http://localhost:5173 / api: http://localhost:8787
```

起動したら右上のチップから **AI 設定** を開き、プロバイダーと API キーを登録します。
API キーがなくてもサンプル 3 種の閲覧・DSL 編集・SVG 書き出しは動きます。

| コマンド | 内容 |
| --- | --- |
| `pnpm dev` | Vite + Hono を同時起動 |
| `pnpm test` | コアのユニットテスト（Vitest） |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm build` | 型チェック＋本番ビルド |

## GitHub Pages

`main` への push で `.github/workflows/deploy.yml` がビルドして Pages へデプロイします。

- リポジトリ設定 → Pages → Source を **GitHub Actions** にしてください
- ワークフローが `GEOLOGO_BASE=/<repo>/` を渡すので、`vite.config.ts` の `base` が自動で合います
- Pages にはサーバーが無いため、アプリは自動的に静的モードで動きます
- 無料プランで Pages を使う場合、リポジトリは public である必要があります

## 技術スタック

[Graphium](https://github.com/kumagallium/Graphium) と揃えてあります。

- TypeScript / React / Vite / pnpm / Vitest
- Hono（API サーバー）
- Vercel AI SDK v6 — `@ai-sdk/anthropic` `@ai-sdk/openai` `@ai-sdk/google` `@ai-sdk/openai-compatible`
- paper.js — 円弧を保ったままブーリアン演算ができるため採用

## ディレクトリ

```
src/
  core/                 # ジオメトリエンジン（LLM 非依存・ブラウザ/Node 同型）
    dsl.ts              #   DSL 型定義 + zod スキーマ
    units.ts            #   モジュール系（φ 冪・フィボナッチ比・1/2 刻み）の候補テーブル
    normalize.ts        # ② スナップ + 制約ソルバー
    build.ts            # ③ paper.js ブーリアン → パス
    render.ts           # ④ logo.svg / blueprint.svg
    samples.ts          #   LLM なしで動く手書きサンプル
  lib/                  # クライアント・サーバー共有
    model-config.ts     #   ModelConfig / TokenRate / プロバイダー定義
    create-model.ts     #   ModelConfig → AI SDK の LanguageModel
    provider-models.ts  #   プロバイダー API からモデル一覧を取得
    model-pricing.ts    #   既知モデルの参考価格表
    ai-error-codes.ts   #   CodedError と機械可読コード
    ai-error.ts         #   クライアント側の日本語化・未設定ガード
    runtime-mode.ts     #   server / static の判定
    design-prompt.ts    # ① システムプロンプト（DSL の書き方を規定）
    design-agent.ts     #   生成 → コンパイル → 破綻したら 1 度だけ修復リトライ
  server/               # サーバーモードのみ
    config/keychain.ts  #   macOS Keychain ラッパー
    config/models.ts    #   models.json 永続化 + Keychain 移行
    config/resolve-model.ts  # X-LLM-API-Key ヘッダー / models.json / .env の解決
    routes/models.ts    #   モデル CRUD API
  features/
    settings/           # AI 設定（モデルレジストリ + UI）
    designer/           # プロンプト・プレビュー・インスペクタ
```

`core/` と `lib/` は DOM も Node API も使いません。UI から直接呼べるため、DSL の手編集は
サーバー往復なしで即時反映され、静的モードでも同じ設計エージェントが動きます。

## AI 設定（Graphium からの移植）

Graphium の AI 設定サブシステムを移植しています。

| Graphium | geo-logo | 内容 |
|---|---|---|
| `server/config/keychain.ts` | 同左 | macOS Keychain への API キー保存（`GEOLOGO_USE_KEYCHAIN=1`） |
| `server/config/models.ts` | 同左 | `models.json` 永続化、旧形式からの Keychain 移行、キー欠落検出 |
| `server/services/llm.ts` | `lib/create-model.ts` + `lib/provider-models.ts` | プロバイダー生成とモデル一覧取得。ブラウザ実行を追加 |
| `server/services/header-model.ts` | `server/config/resolve-model.ts` | `X-LLM-API-Key` ヘッダーからのモデル解決 |
| `server/routes/models.ts` | 同左 | モデル CRUD ＋ `POST /available` |
| `lib/ai-error-codes.ts` / `lib/ai-error.ts` | 同左 | `CodedError` と表示文言への変換 |
| `lib/model-pricing.ts` | 同左 | 既知モデルの参考価格（Claude の現行世代を追記） |
| `features/settings/store.ts` | 同左 | localStorage のモデルレジストリ |
| 設定モーダルの AI タブ | `features/settings/SettingsModal.tsx` | UI は geo-logo の CSS で書き直し |

移植していないもの:

- **copilot-subscription** — `@github/copilot-sdk` とローカル CLI の subprocess 起動が必要で、
  静的配信では原理的に動かないため
- **claude-subscription** — Anthropic の規約で撤去済み（Graphium 側でも purge 対象）
- **MCP / embedding / grounding / 使用量ダッシュボード** — geo-logo に対応機能がないため

Graphium からの意図的な差分:

- `POST /api/models` で `source_model_id` を指定したとき、provider も参照元から引く。
  Graphium は `body.provider` をそのまま使い、クライアントが詰め直す前提だった
- `design-agent.ts` を `server/` から `lib/` へ移し、`LanguageModel` を引数で受け取る形にした
  （ブラウザからも同じ実装を使うため）

## DSL

座標は **モジュール(M)** 単位。原点は構成の中心、y は下向き（SVG 準拠）、角度は度数法で時計回り。

**プリミティブ** — `circle` / `ring` / `bar`（太さのある直線）/ `wedge`（扇形）/ `rect` / `poly`

**制約** — 座標を手計算する代わりに関係として宣言する。ソルバーが解きます。

| 制約 | 意味 |
| --- | --- |
| `tangent(a, b, external\|internal)` | 2 円を接する位置へ補正 |
| `concentric(a, b)` | 同心 |
| `align(ids, x\|y)` | 指定軸の座標を揃える |
| `onCircle(point, circle)` | point の中心を circle の円周上に置く |

**組み立て** — `steps` は逐次適用（`add` / `sub` / `intersect`）。`groups` が 1 段の中間形状、
`parts` が最終形状。`part.mirror: "vertical"` で左半分だけ設計して反転できます。

```jsonc
{
  "name": "Vesica Eye",
  "shapes": [
    { "kind": "circle", "id": "top",    "cx": 0, "cy": -0.809, "r": 1.618 },
    { "kind": "circle", "id": "bottom", "cx": 0, "cy":  0.809, "r": 1.618 },
    { "kind": "circle", "id": "pupil",  "cx": 0, "cy": 0, "r": 0.5, "pinned": true }
  ],
  "parts": [{
    "id": "eye",
    "steps": [
      { "op": "add",       "ref": "top" },
      { "op": "intersect", "ref": "bottom" },
      { "op": "sub",       "ref": "pupil" }
    ]
  }]
}
```

## 正規化（② — なぜこれが要るのか）

LLM が返す数値はそのままでは `2.87` `1.43` のように汚く、それが「幾何学的に設計した感」を
殺します。`normalize.ts` は次の順で処理します。**順序が本質的**です。

1. **半径・太さのスナップ** — φ 冪 / フィボナッチ比 / 1/2 刻みの候補集合へ最近傍スナップ
   （相対許容差 9%）。遠い値は「意図された値」として温存
2. **座標の初期スナップ** — グリッド交点へ（許容差 7%）。`pinned: true` は対象外
3. **制約の緩和解法** — 違反量の半分ずつ両側を寄せる反復を 240 パス
   （Position Based Dynamics 相当）
4. **端数の再スナップ** — ただし 1 シェイプずつ「制約の総誤差が悪化しないか」を実測し、
   悪化するなら差し戻す

半径を先に確定してから中心を動かすのは、逆にすると接点が壊れた状態で丸められ
「ほぼ接している」ズレが残るためです。4 の差し戻しがないと、せっかく解いた接点を
グリッド丸めが壊します（実測で 0.009M のズレが出ました）。

正規化の全履歴は UI の「正規化レポート」に出ます。

## 生成の検証（①のリトライ）

`lib/design-agent.ts` は生成結果を「見た目が良いか」ではなく
**幾何として成立しているか**で機械判定します。

- 参照 id の解決失敗 / `steps` の先頭が `add` でない
- 制約が解けていない（残差 > 1e-3）
- 塗り形状が空、または `intersect` の結果がほぼ消えている
- 完成形の縦横比が極端（12:1 超）

問題が出た場合のみ、具体的な指摘を添えて 1 度だけ再生成します。判定が決定的なので
リトライが無限に回りません。

## 既知の未検証点

- **LLM によるロゴ生成そのものは未実行です。** 有効な API キーが無いため。
  検証できたのは、ブラウザからプロバイダーへ到達し（CORS 通過）、401 が
  `INVALID_API_KEY` として日本語化されるところまでです
- **Keychain 保存（`GEOLOGO_USE_KEYCHAIN=1`）は未実行です。** 実行するとユーザーの
  ログインキーチェーンに書き込むため。コードは Graphium からの逐語移植です
- プロンプトの品質（どの程度「主題に見える」形が出るか）は実際に叩いて調整が必要です
