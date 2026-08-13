import type { LogoDesign } from './dsl'

const PHI = (1 + Math.sqrt(5)) / 2

/**
 * LLM なしで動かせる手書きサンプル。
 * 「正規化 → ブーリアン → 2 種の SVG」が成立することを確認するための最小教材でもある。
 */

const vesicaEye: LogoDesign = {
  name: 'Vesica Eye',
  concept:
    '同じ半径の 2 円を上下にずらして重ね、その交差（ヴェシカ・ピスキス）を目の輪郭にする。瞳は中心の小円を抜いて作る。',
  module: 64,
  grid: 'golden',
  palette: { primary: '#111111', secondary: '#8A8A8A', accent: '#C2410C', background: '#FFFFFF' },
  shapes: [
    { kind: 'circle', id: 'top', cx: 0, cy: -PHI / 2, r: PHI },
    { kind: 'circle', id: 'bottom', cx: 0, cy: PHI / 2, r: PHI },
    { kind: 'circle', id: 'pupil', cx: 0, cy: 0, r: 0.5, pinned: true },
  ],
  constraints: [],
  groups: [],
  parts: [
    {
      id: 'eye',
      fill: 'primary',
      mirror: 'none',
      steps: [
        { op: 'add', ref: 'top' },
        { op: 'intersect', ref: 'bottom' },
        { op: 'sub', ref: 'pupil' },
      ],
    },
  ],
}

const crescent: LogoDesign = {
  name: 'Crescent & Star',
  concept:
    '大円から同径の円を斜めにずらして差し引いた三日月。星の小円は大円に外接する位置へ制約で押し出す。',
  module: 64,
  grid: 'golden',
  palette: { primary: '#111111', secondary: '#8A8A8A', accent: '#C2410C', background: '#FFFFFF' },
  shapes: [
    { kind: 'circle', id: 'disc', cx: 0, cy: 0, r: PHI * PHI, pinned: true },
    { kind: 'circle', id: 'cut', cx: 1, cy: -1, r: PHI * PHI },
    { kind: 'circle', id: 'star', cx: 2.3, cy: -1.7, r: 0.5 },
  ],
  constraints: [{ type: 'tangent', a: 'disc', b: 'star', mode: 'external' }],
  groups: [],
  parts: [
    {
      id: 'moon',
      fill: 'primary',
      mirror: 'none',
      steps: [
        { op: 'add', ref: 'disc' },
        { op: 'sub', ref: 'cut' },
      ],
    },
    {
      id: 'star',
      fill: 'accent',
      mirror: 'none',
      steps: [{ op: 'add', ref: 'star' }],
    },
  ],
}

const monogramG: LogoDesign = {
  name: 'Monogram G',
  concept:
    'φ² を外半径とするリングから扇形を切り欠き、同じ円板でクリップした横棒を足して G を構成する。すべての寸法が φ と 1/2 モジュールから導かれる。',
  module: 64,
  grid: 'golden',
  palette: { primary: '#111111', secondary: '#8A8A8A', accent: '#C2410C', background: '#FFFFFF' },
  shapes: [
    { kind: 'ring', id: 'ring', cx: 0, cy: 0, r: PHI * PHI, w: PHI / 2, pinned: true },
    { kind: 'wedge', id: 'notch', cx: 0, cy: 0, r: PHI * PHI + 1, a0: -26, a1: 26, pinned: true },
    { kind: 'circle', id: 'disc', cx: 0, cy: 0, r: PHI * PHI, pinned: true },
    { kind: 'bar', id: 'crossbar', x1: 0.5, y1: 0, x2: PHI * PHI + 1, y2: 0, w: PHI / 2, cap: 'butt' },
  ],
  constraints: [],
  groups: [
    {
      id: 'gRing',
      steps: [
        { op: 'add', ref: 'ring' },
        { op: 'sub', ref: 'notch' },
      ],
    },
    {
      id: 'gBar',
      steps: [
        { op: 'add', ref: 'crossbar' },
        { op: 'intersect', ref: 'disc' },
      ],
    },
  ],
  parts: [
    {
      id: 'mark',
      fill: 'primary',
      mirror: 'none',
      steps: [
        { op: 'add', ref: 'gRing' },
        { op: 'add', ref: 'gBar' },
      ],
    },
  ],
}

export const samples: LogoDesign[] = [vesicaEye, crescent, monogramG]

export function sampleByName(name: string): LogoDesign | undefined {
  return samples.find((s) => s.name === name)
}
