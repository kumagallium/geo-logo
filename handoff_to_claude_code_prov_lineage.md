# PROV による画像派生グラフ — 新方向の引き継ぎ

## 0. ゴール
1. **PROVision** という新リポジトリを立て、**チャットを通じた画像の派生を PROV グラフとして記録・追跡する道具**の骨格を作る。
2. geo-logo で作った再利用可能な部品（画像生成・コンセプト分割・デスクトップ配布・会話保存）を移植する。
3. 「履歴一覧では出せない何が、グラフだと出せるのか」に**実装で答える**最小の機能を 1 つ通す。

geo-logo 本体は v0.1.22 で「元の絵 ＋ 作図シート」の道具として**完結済み**。触らない（§9）。

---

## 1. 背景・前提

### なぜ方向を変えたか
geo-logo は「生成画像を円と直線の作図に起こし直す」道具だった。2026-08-20 に
素直なベクタ化（potrace）との比較検証を行い、**復元は元の絵を超えない**ことが数字で出た。

| 題材 | potrace | geo-logo |
|---|---|---|
| ゴリラ（頭部） | 99.3% | 96.6% |
| 鍵 | 99.5% | 97.7% |
| 星と点 | 99.8% | 98.0% |
| 筆致の円相 | 98.6% | 73.2% |

（元画像との一致率。墨の外接矩形を揃えて比較）

さらに、形を規則へ寄せる処理が効くのは幾何的な題材だけで、**有機的な題材では
6〜8 図形のうち円と呼べるものが 0 件**だった。数 % の忠実度を払って何も得ていない。

そこで geo-logo は「絵を動かさず、測って言う」道具として畳んだ。
残った問いは「**では、生成画像まわりで本当に価値が出るのはどこか**」である。

### 新方向の仮説
チャットで絵を作り、指示で派生させていく過程そのものが資産になる。
その系譜を **W3C PROV**（Entity / Activity / Agent, wasDerivedFrom）のグラフとして持ち、
**派生の辺に自然言語の意図を載せる**。Graphium / Asterism のオントロジー基盤と地続きにする。

### 競合認識と、こちらの立ち位置
既存:
- **C2PA / Content Credentials**（Adobe・Microsoft 等）— ただしこれは**ファイル 1 個に
  署名付きメタデータを埋める**仕組みであって、横断的に問い合わせできるグラフではない
- Midjourney のジョブツリー / ComfyUI のワークフロー / A1111 の PNG メタデータ —
  いずれもツール内に閉じた履歴

**「履歴が残る」だけでは差別化にならない。** 差別化は次の一点:

> **系譜が領域（ノート・データ・画像）をまたいで 1 つの PROV グラフになり、
> AI が SPARQL / MCP でクエリできること**

これは所有者の既存資産があって初めて成立する構成であり、C2PA が狙っていない場所である。
§8 の受け入れ条件は、この一点に実装で答えられているかで判定する。

---

## 2. 制約・前提

| 項目 | 値 |
|---|---|
| リポジトリ | **PROVision**（新規） |
| ブランチ | main から feature ブランチを切る |
| 言語 / パッケージマネージャ | TypeScript / pnpm 9.12.0（Node 24 系） |
| Lint / 型検査 | `pnpm typecheck`（tsc --noEmit）+ vitest |
| コミット規約 | **`github-flow` スキルの §0 で判定してから書く**（geo-logo の規約を無条件に持ち込まない） |
| リリース | tagpr + Tauri updater（geo-logo から移植可。`release-tagpr` スキル参照） |
| 変更が必要な項目 | 無し（§2.1 で確定済み） |

### 2.1 確定済みの決定（2026-08-20）

**スコープ**: 研究・技術資料に載せる**図版**（概念図・グラフィカルアブストラクト・
スライド図版）の系譜。機構自体は題材に依存させない——**最初の利用者を所有者自身に
固定する**ためのスコープである。

  - 所有者が利用者 1 号になれる（使わないスコープは死ぬ）
  - 痛みが実在する。概念図は何十回も作り直され、どの版が論文に載ったか再現できない
  - 外圧がある。学術誌の AI 生成物の開示要求が強まっている
  - 既存資産と噛み合う。図版は Graphium のノートに貼られ、元データは asterism にある

**永続化**: **PROV-JSONLD をローカルのファイルに書く。** DB もサーバも要らない。
`matprov-schema` と同じ `@context` の積み方に揃え、画像生成固有の語（model / seed /
prompt）は `provision` 名前空間の拡張として足す。

```json
{
  "@context": [
    {"@vocab": "http://www.w3.org/ns/prov#"},
    "https://openprovenance.org/prov-jsonld/context.jsonld",
    "https://kumagallium.github.io/matprov-schema/context.jsonld",
    "https://kumagallium.github.io/provision-schema/context.jsonld"
  ],
  "@graph": [ /* Entity / Activity / Agent */ ]
}
```

**連携（変換なしで成立する）**:

| 既存リポジトリ | 繋がり方 |
|---|---|
| `asterism`（PROV-O first-class, SPARQL/MCP） | そのまま取り込める。AI が系譜を SPARQL で引ける |
| `prov-jsonld-viz` | そのまま可視化できる |
| `Graphium`（PROV-DM のノート） | 語彙が揃うので、ノートと画像の系譜が繋がる |
| `matprov-schema` | `@context` の拡張のしかたを踏襲する |

---

## 3. worktree / ブランチの確認【必須】

geo-logo では**複数セッションが同じ作業ツリーを共有**しており、他セッションの未コミット
変更を巻き込む事故が起きた。新リポジトリでも最初に確認する。

- [ ] `git status` がクリーン
- [ ] `git worktree list` に残骸が無い（あれば `git worktree prune`）
- [ ] 作業ブランチを切った
- [ ] コミット時は `git add -A` を使わず**ファイル名を指して** add する

---

## 4. Source of truth / 主要ファイル

読む順序:

| # | 資料 | パス | 確認すべき箇所 |
|---|---|---|---|
| 1 | geo-logo README | `~/develop/geo_logo/README.md` | 冒頭「なぜ絵を動かさないのか」。前提の共有 |
| 2 | 画像生成 | `src/lib/image-agent.ts` | `generateSymbolImage` / `symbolImagePrompt`。command プロバイダで mflux を叩く |
| 3 | コンセプト分割 | `src/lib/concept-agent.ts` | 案ごとに treatment / symmetry を**宣言させる**構造。派生の意図をどう持つかの先例 |
| 4 | 会話の保存 | `src/server/config/sessions.ts`, `src/features/chat/session-store.ts` | ファイル保存とローカル保存の突き合わせ |
| 5 | デスクトップ | `src-tauri/`, `src/lib/sidecar.ts`, `src/lib/api-base.ts` | サイドカー起動と `apiFetch`（§11 の落とし穴） |
| 6 | 配布 | `.tagpr`, `.github/workflows/desktop-build.yml` | 署名・公証・updater |
| 7 | **語彙の先例** | `github.com/kumagallium/matprov-schema` | `@context` の積み方。これに倣う |
| 8 | **取り込み先** | `github.com/kumagallium/asterism` | PROV-O first-class。CSV→RDF→SPARQL/MCP |
| 9 | **可視化** | `github.com/kumagallium/prov-jsonld-viz` | 既存のビューアに載るか確かめる |
| 10 | **ノート側** | `github.com/kumagallium/Graphium`, `prov-blocknote` | PROV-DM の使い方 |

---

## 5. 段階間の契約【必須】

実装に入る前に、次の 3 つを**先に確定させる**。未定義のまま進むと必ず破綻する。

1. **PROV エンティティの粒度**
   - 1 枚の画像 = 1 Entity か、1 セッション = 1 Entity か
   - 推奨: 画像 1 枚 = 1 Entity。派生は `wasDerivedFrom` で繋ぐ
2. **Activity に何を記録するか**
   - 最低限: プロンプト全文 / モデル識別子 / seed / パラメータ / 時刻
   - **再実行できること**が価値の源なので、再現に要る情報を漏らさない
3. **意図（自然言語の指示）をどこに置くか**
   - 辺の属性か、Activity の属性か
   - 推奨: Activity に置き、辺は `wasDerivedFrom` のまま素直に保つ（PROV の標準から外れない）

決めた内容は実装前に `docs/decisions.md` に書き残す。

---

## 6. 実装ステップ

### Step 1 — 骨格と契約
- 1.1 リポジトリ作成、pnpm + TypeScript + vitest
- 1.2 §5 の 3 点を決めて `docs/decisions.md` に記録
- 1.3 PROV の型定義（Entity / Activity / Agent / wasDerivedFrom）と、**PROV-JSONLD** の読み書き
- 1.4 `provision-schema` の `@context` を用意（matprov に倣う）
- 達成条件: 型と永続化のテストが通る。**書き出した JSON-LD が `prov-jsonld-viz` で開ける**

### Step 2 — 生成と記録をつなぐ
- 2.1 `image-agent.ts` を移植（mflux の command プロバイダ）
- 2.2 1 枚生成するたびに Entity + Activity を記録する
- 2.3 「この画像から派生」を指示できるようにし、`wasDerivedFrom` を張る
- 達成条件: チャット 3 往復ぶんの派生がグラフになり、ファイルに残る

### Step 3 — グラフでしかできないことを 1 つ通す
候補（**1 つ選んで実装する**。全部やらない）:
- **再実行**: 任意のノードを選び、その Activity を再現して同じ絵を出す
- **説明**: あるノードについて「どの指示の連なりでこうなったか」を辿って言う
- **監査**: 「この要求を満たした版はどれか」を問い合わせる
- **横断**: asterism へ流し込み、**元データの版まで遡って** SPARQL で引く（差別化の本命）
- 達成条件: 履歴一覧では答えられない問いに、実際に答えられる

### Step 4 — 画面
- 4.1 派生グラフの可視化（枝分かれが見えること）
- 4.2 ノードを選んで Step 3 の機能を呼べる
- 達成条件: 実機で 3 世代以上の枝分かれを操作できる

### Step 5 — 配布（任意）
- geo-logo の tagpr + Tauri 一式を移植。`release-tagpr` スキルに従う

---

## 7. 不変条件（破らない）

- **元の絵を加工しない。** geo-logo で得た最大の教訓。派生は必ず新しい Entity を作る。
  既存 Entity の中身を書き換えると来歴が嘘になる
- **再現に要る情報を落とさない。** seed / モデル識別子 / プロンプト全文。
  1 つでも欠けると「再実行できる」という価値の柱が折れる
- **PROV の標準語彙から勝手に外れない。** 独自拡張は `provision` 名前空間を分けて足す。
  ここを崩すと asterism / prov-jsonld-viz / Graphium との連携が全部切れる——
  **連携できることが差別化の本体**なので、語彙の独自化は製品価値の毀損に直結する
- **弱いモデルに DSL を直接書かせない。** 存在しない述語を発明する。
  中間表現を出させて決定論的に変換する（geo-logo の実測）

---

## 8. Acceptance criteria

- [ ] §5 の 3 契約が `docs/decisions.md` に書かれている
- [ ] 画像を 3 世代以上派生させ、グラフがファイルに残る
- [ ] **Step 3 で選んだ「グラフでしかできないこと」が実際に動く**
- [ ] `pnpm typecheck` と vitest が green
- [ ] 書き出した JSON-LD が `prov-jsonld-viz` で開ける
- [ ] README の冒頭に「これは何か」と「C2PA 等と何が違うか」が書いてある
      （＝ファイル単位の署名ではなく、領域をまたぐクエリ可能なグラフ）
- [ ] 実機で操作を確認した（画面の主張ではなく、動いているところを見た）

---

## 9. Out of scope（このセッションでは触らない）

- **geo-logo リポジトリ**。v0.1.22 で完結済み。バグが見つかっても別セッションで扱う
- 幾何の復元・作図シート。新方向では使わない
- C2PA との相互運用（将来の課題。まず自分のグラフが成立してから）
- ロゴという題材への限定（**機構は汎用でよい。ただし §12 でスコープを詰める**）

---

## 10. 進め方の提案

Step 1 → 2 → 3 は直列。Step 4（画面）は Step 3 と並行できる。

**Step 3 を早めに通すこと。** ここが仮説の生死を分ける。
画面（Step 4）を先に作り込むと、「凝った履歴 UI」で終わる危険が高い。

---

## 11. Tips・運用メモ

geo-logo で実害が出たもの。移植するなら一通り目を通す。

### 画像生成（mflux）
- 量子化済みモデルを使う。フル精度は読み込みだけで 27GB でマシンが固まる
  （`~/.cache/geologo/z-image-turbo-4bit` に `mflux-save -q 4` で保存済み）
- サイドカーは Finder 起動だと PATH が `/usr/bin:/bin` 程度しかない。**絶対パスで呼ぶ**
- 生成は**直列**に捌く。並行させるとピークメモリで落ちる

### デスクトップ（Tauri）
- **WebView から `http://127.0.0.1` への素の fetch は mixed content でブロックされる**。
  `@tauri-apps/plugin-http` 経由（geo-logo の `apiFetch`）にする
- サイドカーの保存先は `GEOLOGO_DATA_DIR` 相当を必ず受け取る。
  `.app` 起動時の cwd は `/` なので、既定の `cwd/data` は作れない
- updater の endpoint は**順に試される**。先頭（gh-pages）が古いと更新が出ない

### 検証の作法
- **自作の検証データは、まず目で見る。** 「星」を描いたつもりが花で、
  パイプラインのバグと誤診して調査を空転させた（2026-08-18）
- 観測しづらい不具合は、実機を計装してから「直った」と言う

---

## 12. 終了時に伝えること

- 新リポジトリの URL
- §5 で決めた 3 契約
- Step 3 で選んだ「グラフでしかできないこと」と、動いた証拠
- 次セッションの着手点
