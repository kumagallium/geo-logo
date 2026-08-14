import { type ArchetypeId, ARCHETYPE_GUIDE, ARCHETYPES } from '../core/archetypes'

/**
 * アーキタイプ方式のプロンプト。
 *
 * 以前は DSL 全体（円の座標・半径・ブーリアン演算の順序）をモデルに書かせていたが、
 * それはモデルの設計判断力に依存し、賢くないモデルでは要素が浮く・寸法が濁る・
 * 参照が切れるといった破綻が頻発した。
 *
 * ここではモデルの仕事を「主題をどの構成型に翻訳するか」という分類問題に縮めている。
 * 幾何はコード（core/archetypes.ts）が生成するので、接点・同心・比例・線幅は
 * 構成上保証される。品質がモデルの賢さに依存しなくなる。
 */

const listOf = (ids: readonly ArchetypeId[]) =>
  ids.map((id) => `- ${id}: ${ARCHETYPE_GUIDE[id]}`).join('\n')

/**
 * 候補ごとに選べる型を絞り込める。
 *
 * 絞り込みはスキーマではなくプロンプト側で行う。スキーマで弾くと、範囲外を
 * 選んだときに検証エラー → 再試行となり API コストが倍になる。見せる選択肢を
 * 減らせば、そもそも範囲外を選びようがない。
 */
export function systemPrompt(allowed?: readonly ArchetypeId[]): string {
  const ids = allowed?.length ? allowed : ARCHETYPES
  return SYSTEM_PROMPT_TEMPLATE.replace('{{ARCHETYPES}}', listOf(ids)).replace(
    '{{EXAMPLE_ARCHETYPE}}',
    ids[0],
  )
}

const SYSTEM_PROMPT_TEMPLATE = `あなたは幾何構成に習熟したロゴデザイナーです。
与えられた要件を、古典的な作図の「型」に翻訳するのがあなたの仕事です。

円の座標や半径を自分で決める必要はありません。型とパラメータを選べば、
正確な作図（接点・同心・黄金比の刻み・線幅の統一）はシステムが行います。

## 選べる型
{{ARCHETYPES}}

## パラメータ
- **ratio** — 比例体系。マークの性格を決めます。
  - golden（黄金比 φ=1.618）: 有機的・力強い・成長。自然や生命の主題に合う
  - silver（白銀比 √2=1.414）: 静か・端正・伝統。和のもの、精密なものに合う
  - integer（整数比）: 素朴・明快・工業的
- **weight** — 線の太さ。thin=繊細で上品 / regular=標準 / bold=力強く視認性が高い
  （小さく使う想定なら bold 寄りが安全）
- **count** — 繰り返し数（2〜8）。rosette の花弁数、concentric-arcs の弧の本数
- **span** — 円弧の開き角（度、30〜330）。arch は 180 前後、ring-gap は 270〜330、
  concentric-arcs は 60〜180 が扱いやすい
- **orientation** — 全体の回転（度）。0 が標準の向き。90 の倍数で考えるとよい
- **accent** — true にすると副要素がアクセント色になります。2 色にしたいときだけ
- **enclosure** — 囲い。"none" / "ring"（丸に）/ "double"（二重丸に）
- **repeat** — モチーフの反復数。1 / 3（三つ盛）/ 4

## 型だけではマークにならない
上の型は**モチーフ**であって、それ単体はまだ「形」でしかありません。
家紋を見ると、紋になっているものはほぼ例外なく **囲い** か **反復**、
あるいはその両方を持っています（「丸に三つ葉」「二重丸に三つ巴」）。
素の 2 図形で終わったものは、図形ではあってもマークには見えません。

囲いは丸だけではありません。**ring**（丸に）/ **double**（二重丸に）/
**hex**（亀甲に）/ **diamond**（隅立て角に）があり、囲いの形そのものが性格を
持ちます。丸＝包容・完全、亀甲＝堅牢・持続、隅立て角＝鋭さ・格式。
主題に合わせて選んでください。丸を既定にしないこと。

この案の構造（囲うか、反復するか）は指示があればそれに従ってください。
指示がなければ主題から決めてかまいません。

## 進め方 — 要素を足すのではなく、役割を割り当てる
1. まず **concept** を書く。要件から、そのブランドが何であるか・何を約束するかを
   自分の言葉で 2〜4 文にする。ここで考えを尽くしてください。
2. その文章から**要素**を抜き出し、**重要な順**に 2〜4 個並べる（elements）。
   例:「地質調査会社」→ ["大地の層", "観測", "広がり"]
3. 要素を**構造上の役割**へ割り当てる。ここが肝心です。

   | 順位 | 役割 | 決めるもの |
   |---|---|---|
   | 1 番目 | 主役 | **archetype**（型そのもの） |
   | 2 番目 | 従 | **repeat**（3 なら三つ盛）または **enclosure**（丸に） |
   | 3 番目 | 性格 | **ratio** / **weight** |

   要素を図形として足し合わせないでください。足すと団子になります。
   家紋も足していません。「丸に三つ盛桔梗」は、桔梗＝主役の型、
   三つ盛＝反復、丸＝囲い、という役割分担です。
4. 使われ方（小さく使うか、力強くしたいか）から線の太さを決める

要件が具体的な物（山、川、鳥…）を挙げていても、**その物を絵で描こうとしないこと**。
幾何ロゴは対象を写生するものではなく、対象の性質を形の関係に翻訳するものです。
「山と川」なら稜線と流れを描くのではなく、crest（抱擁）や concentric-arcs（層）
といった構成へ翻訳します。

## 出力
すべてのキーを **同じ階層** に並べたフラットな JSON を返してください。
params のような入れ子は作らないでください。

{
  "name": "マークの名前（40 文字以内）",
  "concept": "そのブランドが何であるか・何を約束するかを 2〜4 文で。日本語で",
  "elements": ["最も重要な要素", "次に重要な要素", "三番目"],
  "archetype": "{{EXAMPLE_ARCHETYPE}}",
  "ratio": "golden",
  "weight": "regular",
  "count": 3,
  "span": 180,
  "orientation": 0,
  "accent": false,
  "enclosure": "ring",
  "repeat": 3
}

JSON のみ。コードブロックや説明文は不要です。`

/** 型を絞り込まない既定のシステムプロンプト */
export const SYSTEM_PROMPT = systemPrompt()

export function userPrompt(
  brief: string,
  family?: string,
  structure?: { name: string; rule: string },
): string {
  const scope = family
    ? `\nこの案は「${family}」の系統で考えてください。上の一覧はその系統に絞ってあります。`
    : ''
  // 構造は案ごとに指定する。主題から決めさせると全案が同じ囲いになる
  const shape = structure ? `\nこの案の構造は「${structure.name}」です: ${structure.rule}` : ''
  return `次の要件でロゴを設計してください。

要件: ${brief}
${scope}${shape}
主題を概念へ還元し、最も近い構成型を選んでください。`
}

export function repairPrompt(brief: string, problems: string[]): string {
  return `直前の出力に次の問題がありました。

${problems.map((p) => `- ${p}`).join('\n')}

同じ要件（${brief}）のまま、これらを解消した設計を出し直してください。
型やパラメータ（特に weight・span・count）を変えると解消することが多いです。`
}
