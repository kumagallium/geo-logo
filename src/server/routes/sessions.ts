// 会話履歴 API
// GET    /api/sessions      — 一覧（新しい順）と保存先フォルダ
// PUT    /api/sessions/:id  — 1 会話を丸ごと保存（作成・更新とも）
// DELETE /api/sessions/:id  — 削除

import { Hono } from 'hono'
import {
  deleteSession,
  getWorkspaceDir,
  isSafeId,
  listSessions,
  saveSession,
  type StoredSession,
} from '../config/sessions.js'

const app = new Hono()

app.get('/', (c) => c.json({ dir: getWorkspaceDir(), sessions: listSessions() }))

app.put('/:id', async (c) => {
  const id = c.req.param('id')
  if (!isSafeId(id)) return c.json({ error: 'id が不正です' }, 400)
  const body = await c.req.json<Partial<StoredSession>>().catch(() => null)
  if (!body || body.id !== id || !Array.isArray(body.messages)) {
    return c.json({ error: 'body が不正です（id 不一致か messages 欠落）' }, 400)
  }
  try {
    saveSession({
      id,
      title: typeof body.title === 'string' ? body.title : '',
      updatedAt: typeof body.updatedAt === 'number' ? body.updatedAt : Date.now(),
      messages: body.messages,
      design: body.design ?? null,
    })
    return c.json({ ok: true })
  } catch (err) {
    console.error('[sessions] save', err)
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

app.delete('/:id', (c) => {
  const id = c.req.param('id')
  if (!isSafeId(id)) return c.json({ error: 'id が不正です' }, 400)
  return c.json({ ok: deleteSession(id) })
})

export default app
