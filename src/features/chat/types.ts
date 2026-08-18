import type { LogoDesign } from '../../core/index'

/**
 * 会話の 1 往復。
 *
 * 設計を添えられるようにしてあるのは、履歴から任意の時点へ戻せるようにするため。
 * 一発で作って終わりではなく、行き来しながら詰める道具にしたい。
 */
export type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** その発言で出来上がった設計。戻るときの復元点になる */
  design?: LogoDesign
  /** 参照した素材の名前。作図の出どころを残す */
  reference?: string
}

export type Session = {
  id: string
  title: string
  updatedAt: number
  messages: Message[]
  design: LogoDesign | null
  /**
   * 直近に並べた候補。
   *
   * 会話ごとに持たせる。画面の状態として持つと、別の会話へ移って戻った
   * だけで消え、選び直せなくなる（実測: 4 案を出しても、新しい設計へ移って
   * 戻ると 1 案になった）。候補は「選ぶために並べたもの」なので、選び終える
   * まで——つまり次に作図するまで——残っていないと用を成さない。
   */
  candidates?: LogoDesign[]
}

let counter = 0
/** 実行ごとに一意なら十分。Date.now だけだと同じミリ秒で衝突する */
export const nextId = (prefix: string): string => `${prefix}-${Date.now()}-${counter++}`

export const titleOf = (session: Session): string =>
  session.title || session.messages.find((m) => m.role === 'user')?.text.slice(0, 24) || '新しい設計'
