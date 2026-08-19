import { generateObject, type LanguageModel } from 'ai'
import { z } from 'zod'

/**
 * ブリーフから「コンセプト仮説」を複数作る。
 *
 * 画像経路の候補はこれまで seed（乱数）を変えるだけだった。構図の当たり外れは
 * 出るが**解釈が 1 つしかない**ので、「知的な熊」の「知的」がどの案でも同じ
 * 扱いになり、候補を並べる意味が薄い（実測: 4 案がほぼ同じ絵になった）。
 *
 * デザイナーの実務は逆で、先に**比喩の選択**（何で表すか）を数案に割ってから
 * 各案を描く。その工程を言語モデルにやらせる。絵の上手さは要らず、解釈の
 * 引き出しだけが要るので、ここは言語モデルの得意側にある。
 */

export type ImageConcept = {
  /** 候補の下に出す短い案名（日本語） */
  title: string
  /** 画像モデルへ渡す視覚記述（英語。構図・モチーフ・塗りか線かまで具体的に） */
  visual: string
  /** ブリーフをどう表現したかの説明（日本語 1 文。選択の理由が読めるように） */
  rationale: string
  /**
   * 描法。flat は輪郭のはっきりした平面的なマーク、brush は筆で一息に引いた線。
   *
   * 復元は絵を忠実になぞるので、輪郭のゆらぎは絵から来る。偶然のゆらぎ（画素の
   * residue）は制御できず、強めることも弱めることもできないので様式にはならない。
   * **画像モデルに筆致で描かせれば**、ゆらぎは線の勢いと圧の変化を伴う——
   * 意図した描法になる。4 案のうち 1 案をこれに充て、残りは平面的に保つ。
   */
  treatment: 'flat' | 'brush'
  /**
   * 左右対称であるべきか。
   *
   * 対称かどうかは**題材の意味**で決まるのであって、画素から測って当てる話では
   * ない。正面から見た顔・鍵・盾・紋章は左右が揃っていないと落ち着かないし、
   * 走る動物や筆の一撃は揃えたら死ぬ。生成画像は素で数 % ずれるので、測るだけに
   * 任せると「揃えるべきものが中途半端に非対称」で止まる（実測: 熊の顔で
   * 片目だけ大きい案が出た）。意味を知っているのは言語モデルなので、そこに
   * 言わせる。
   */
  symmetry: 'mirror' | 'free'
}

export const imageConceptsSchema = z.object({
  concepts: z
    .array(
      z.object({
        title: z.string().min(1).max(20),
        visual: z.string().min(20).max(500),
        rationale: z.string().min(8).max(160),
        treatment: z.enum(['flat', 'brush']).default('flat'),
        symmetry: z.enum(['mirror', 'free']).default('free'),
      }),
    )
    .min(2),
})

/**
 * 解釈の軸で割らせる。ポーズ違い・角度違いは seed でも出せるので、
 * ここで欲しいのは「何をモチーフに選ぶか」の分岐だけ。
 */
function conceptsPrompt(brief: string, count: number): string {
  return `あなたはブランドアイデンティティのデザイナーです。次のブリーフから、ロゴマークのコンセプト案を ${count} 案作ってください。

ブリーフ: ${brief}

要件:
- ${count} 案は**解釈（何をモチーフに、どんな比喩で表すか）が大きく異なる**こと。
  同じモチーフのポーズ違い・角度違いは 1 案と数える。
- ただし**全案で主題がひと目でそれと分かる**こと。抽象化・幾何分解・負の空間を
  使う案でも、主題のシルエットか特徴的な部位が読めること。主題が画面から
  消える案（比喩だけが残る案）は作らない（実測: 「知的な熊」で熊が消えて
  何のマークか分からない案が混ざった）。
- ブリーフに性格・抽象語（知的、信頼、俊敏など）があれば、各案がそれを
  **目に見える形**（持ち物、構図、負の空間の使い方、線の性質）へ翻訳すること。
- visual は画像生成モデルへそのまま渡す英語の視覚記述。主題・構図・
  白の抜きの使い方・「solid silhouette か bold line construction か」まで
  具体的に書く。色や質感は書かない（黒 1 色のマークになる）。
- 造形は大きな塊で。小さすぎるディテールを visual に入れない。
- treatment は描法。**ちょうど 1 案だけ "brush"、残りは "flat"** にすること。
  - flat: 輪郭のはっきりした平面的なマーク。線幅は一定。
  - brush: 筆や墨で一息に引いた線。始筆と終筆で太さが変わり、線に勢いがある。
    円相（一筆で描く円）のような表現がこれ。visual にも筆致であることと、
    どこで太くどこで細くなるかを書く。ゆらぎが**意図されたもの**だと分かるように。
- symmetry は左右対称にすべきかどうか。**題材の意味で決める**こと。
  - mirror: 正面から見た顔、鍵、盾、紋章、円環など、左右が揃っていないと
    落ち着かないもの。
  - free: 横向きの姿、走る動物、筆の一撃、意図的に崩した構図など、揃えると
    死ぬもの。brush の案は必ず free。
- title は日本語で 12 文字以内。rationale は日本語 1 文。

JSON で返してください。`
}

export async function generateImageConcepts(
  brief: string,
  model: LanguageModel,
  count: number,
): Promise<ImageConcept[]> {
  const { object } = await generateObject({
    model,
    schema: imageConceptsSchema,
    prompt: conceptsPrompt(brief, count),
  })
  return object.concepts.slice(0, count)
}
