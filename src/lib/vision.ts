/**
 * 完成形を視覚モデルに見せて講評をもらう。
 *
 * ここまで一貫して欠けていたのは「モデルが一度も自分の描いたものを見ていない」
 * ことだった。目隠しで座標を書いているのと同じで、配置の判断が働く場面が
 * 存在しなかった。デザイナーは引いては見て直す。その輪を閉じるための片側。
 *
 * Node 専用。画像化に node:zlib を使うため、ブラウザからは呼べない。
 * デスクトップ版（同梱サーバー）とスクリプトから使う。
 */

export type Critique = {
  /** 率直に何に見えるか */
  reads: string
  /** 主題として読めるか（0〜10） */
  score: number
  /** 次に直す 1 点 */
  fix: string
  /** 解析できなかったときの生の応答 */
  raw?: string
}

export type VisionConfig = {
  apiBase: string
  apiKey: string
  model: string
}

/** 応答から JSON を取り出す。前後に説明文が付くことが多い。 */
function extractJson(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}

const clampScore = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : 0
}

export function buildCritiquePrompt(subject: string): string {
  return [
    `白黒のマークです。「${subject}」を表そうとしたものです。`,
    '',
    'デザイナーとして率直に評価してください。忖度は不要です。',
    '次の JSON だけを返してください。説明文は不要です。',
    '',
    '{',
    '  "reads": "率直に何に見えるか（20 文字程度）",',
    `  "score": 「${subject}」として読めるかを 0〜10 の数値で,`,
    '  "fix": "次に直す 1 点。どの部分をどう動かすかを具体的に（60 文字程度）"',
    '}',
  ].join('\n')
}

/**
 * 画像を見せて講評をもらう。
 *
 * 視覚モデルは OpenAI 互換の chat/completions に画像を載せる形で呼ぶ。
 * Vercel AI SDK 経由でも書けるが、プロバイダーごとの画像の扱いの差を
 * 吸収する手間に対して得るものが少ないので、素直に叩く。
 */
export async function critique(
  png: Buffer,
  subject: string,
  config: VisionConfig,
  signal?: AbortSignal,
): Promise<Critique> {
  const res = await fetch(`${config.apiBase.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    signal,
    body: JSON.stringify({
      model: config.model,
      max_tokens: 400,
      temperature: 0.2,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: buildCritiquePrompt(subject) },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${png.toString('base64')}` },
            },
          ],
        },
      ],
    }),
  })

  if (!res.ok) {
    throw new Error(`視覚モデルの呼び出しに失敗しました（HTTP ${res.status}）`)
  }

  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const text = body.choices?.[0]?.message?.content ?? ''
  const parsed = extractJson(text) as Partial<Critique> | null

  if (!parsed) {
    // 講評は落とさない。読めなかったことを点数 0 として次へ進める
    return { reads: '(解析できず)', score: 0, fix: '', raw: text.slice(0, 400) }
  }
  return {
    reads: String(parsed.reads ?? '').slice(0, 120),
    score: clampScore(parsed.score),
    fix: String(parsed.fix ?? '').slice(0, 300),
  }
}

/**
 * 2 枚を並べて、どちらが主題として読めるかを選ばせる。
 *
 * 「0〜10 で採点」は判別しなかった。焼いた 29 枚を 8 通りの聞き方で 443 回
 * 試した実測では、1〜5 の採点だと 29 枚中 27 枚が同じ 3 で、頭を丸ごと外した
 * 版が全部入りと 1 点差、欠落 8 種すべてで基準を下回らず 0/8 だった。
 *
 * 一方「2 枚のうちどちらが読めるか」は、正解既知の 13 組で 26 回中 24 回
 * 当てた（92%、A/B の偏りなし）。**採点ではなく順位付けなら使える。**
 *
 * 左右の偏りを消すため、呼ぶ側で 2 回（入れ替えて）聞くこと。
 */
export type Duel = { winner: 'A' | 'B' | null; why: string }

export async function compare(
  a: Buffer,
  b: Buffer,
  subject: string,
  config: VisionConfig,
  signal?: AbortSignal,
): Promise<Duel> {
  const prompt = [
    `2 つの白黒のマークを見せます。どちらも「${subject}」を表そうとしたものです。`,
    '',
    '**どちらがより「その題材だ」と一目で分かるか**を選んでください。',
    '好みではなく、題材が読めるかどうかで選びます。',
    '',
    '次の JSON だけを返してください。',
    '{ "winner": "A" または "B", "why": "選んだ理由を 30 文字程度で" }',
  ].join('\n')

  const res = await fetch(`${config.apiBase.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    signal,
    body: JSON.stringify({
      model: config.model,
      max_tokens: 200,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'text', text: 'A:' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${a.toString('base64')}` } },
            { type: 'text', text: 'B:' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${b.toString('base64')}` } },
          ],
        },
      ],
    }),
  })
  if (!res.ok) throw new Error(`視覚モデルの呼び出しに失敗しました（HTTP ${res.status}）`)

  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const parsed = extractJson(body.choices?.[0]?.message?.content ?? '') as {
    winner?: string
    why?: string
  } | null
  const w = String(parsed?.winner ?? '').trim().toUpperCase()
  return {
    winner: w === 'A' || w === 'B' ? (w as 'A' | 'B') : null,
    why: String(parsed?.why ?? '').slice(0, 120),
  }
}
