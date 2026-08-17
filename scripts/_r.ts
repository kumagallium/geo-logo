import { readFileSync, writeFileSync } from 'node:fs'
import { compile } from '../src/core/index.js'
import { rasterize } from '../src/core/png.js'
import { toDesign } from './plan.js'
const r = compile(toDesign(JSON.parse(readFileSync(process.argv[2], 'utf8'))))
writeFileSync(process.argv[3], rasterize(r.built, { size: Number(process.argv[4] ?? 240) }))
