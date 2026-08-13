import paperCore from 'paper/dist/paper-core'

/**
 * paper-core は PaperScript（実行時 JS パーサ）を含まない PaperScope。
 * 型は paper 本体の .d.ts が宣言しているものをそのまま使う。
 */
export type PaperCore = typeof paperCore

let initialised = false

/**
 * paper.js をヘッドレスで初期化して返す。
 * Size を渡す形の setup は canvas / DOM を要求しないので、
 * ブラウザでも Node（Vitest）でも同じコードが動く。
 */
export function getPaper(): PaperCore {
  if (!initialised) {
    paperCore.setup(new paperCore.Size(1024, 1024))
    initialised = true
  }
  return paperCore
}

/** ビルド 1 回ごとにプロジェクトを空にする（中間アイテムのリーク防止） */
export function resetProject(): void {
  getPaper().project.clear()
}
