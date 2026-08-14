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

## 実測メモ（さくら AI Engine / gpt-oss-120b）

`pnpm smoke "<ブリーフ>"` で 1 件生成し、パイプライン全体を通せます。

### 構造化出力は有効にしない方が良い

OpenAI 互換の `response_format: json_schema` は、さくら側が `pattern` まで含めて
正しく強制します。しかし**有効にすると設計の質が落ちました**。同一プロンプト各 5 回:

| | 警告なし | 一発成功 | 総試行 |
|---|---|---|---|
| 構造化出力 ON | 2/5 | 2/5 | 11 |
| 構造化出力 OFF | 5/5 | 5/5 | 5 |

制約付きデコードは JSON の「形」は保証しますが、この DSL のように参照整合性
（`steps.ref` が実在 id を指す）が要る構造では、形に合わせるために意味の通らない値を
埋めてしまいます。形の担保はスキーマ検証＋修復リトライに任せ、意味はプロンプトで
作らせる方が結果が良い、というのが実測の結論です。既定は OFF。
モデルによっては逆転しうるので `structuredOutputs` / `GEOLOGO_STRUCTURED_OUTPUTS` で
切り替えられます。

### 古典的な作図法をパイプラインに組み込む

Twitter の鳥（2012）・Apple・Google の G といった幾何ロゴを分析すると、
共通する 4 つの原理が出てきます。これをプロンプトと機械判定の両方に入れています。

1. **すべての曲率は円から来る** — 輪郭の曲がった部分は必ずどこかの円の弧。
   自由曲線は使わない。だから拡大しても半径が説明できる
2. **円同士は必ず関係を持つ** — 接する（tangent）／中心が相手の円周上（onCircle、
   ヴェシカ）／同心（concentric）。数値を手計算せず制約で宣言し、ソルバーに解かせる
3. **union で塊を作り sub で食い込ませる** — Apple の「かじり跡」型。
   少ない要素で強い形が出る
4. **輪郭は一続きの閉じた形** — 離れて浮いた部品の寄せ集めにしない

4 番は最も守られにくく、プロンプトだけでは不十分だったので機械判定を入れました
（`build()` の `unrelated`）。「実際に重なっている」か「constraints で関係が宣言
されている」かでグラフを作り、非連結なら孤立要素として指摘して再生成させます。
宣言も辺に数えるのは、同心の帯のように**重ならないが正しい**構成を誤検出しないためです
（手描きサンプル 4 件すべてで誤検出ゼロを確認）。

これに合わせて `arc`（円弧の帯）プリミティブを追加しました。円弧は `ring ∩ wedge` で
書けますが、2 段の合成が必要だと DSL 上のコストが直線より高くなり、モデルは常に
直線を選んでしまいます。実際、追加前は全出力が直線の寄せ集めでした。

### 効いたプロンプト改善

1. **完全な JSON の実例を 1 つ載せる** — 抽象的な仕様説明だけでは `steps` の構造を
   外していました
2. **参照の規則を明示** — 「"mountain" のような意味を表す名前を ref に書かない。
   実在する id を一字一句そのまま書く」。これが最頻の失敗でした
3. **構図の作法を書く** — 「外形でクリップする」「棒をはみ出したまま残さない」。
   これを入れる前は要素が円から突き出した寄せ集めになり、入れた後は 3/3 で
   `intersect` を使うようになりました

### 検出を追加した失敗

「基準円を add → 要素を add → 同じ基準円で intersect」をやると、結果が基準円
そのものに戻ります。幾何としては正常（面積も縦横比も妥当）なので他の判定を
素通りしますが、出力はただの黒い円です。`build()` が対称差でこれを検出します
（面積と外形寸法の比較では足りません。リングの切り欠きと横棒が相殺して
一致する例が実際にありました）。

## 既知の未検証点

- **Keychain 保存（`GEOLOGO_USE_KEYCHAIN=1`）は未実行です。** 実行すると利用者の
  ログインキーチェーンに書き込むため。コードは Graphium からの逐語移植です
- **Anthropic / OpenAI / Google プロバイダー経由の生成は未実行**です（さくら AI Engine
  でのみ確認）。プロバイダー生成のコードは共通なので大きな差は無いはずですが、
  構造化出力の挙動はモデルごとに異なります
- 生成される構図が「三角の稜線＋下の横棒」に収束しがちで、**多様性は乏しい**です。
  円弧の使い方（`wedge` / `ring`）を引き出すプロンプトはまだ調整の余地があります
