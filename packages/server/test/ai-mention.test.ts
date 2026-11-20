import { HocuspocusProvider } from '@hocuspocus/provider'
import { commentOnBlock, insertBlock, listComments, projectBlocks, replyToComment } from '@stetpad/crdt'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { AgentRuntime, RunRequest } from '../src/agent'
import type { Collab } from '../src/collab'
import type { Store } from '../src/db'
import { AI_MENTION, handleAiMention } from '../src/mentions'
import { startServer, type RunningServer } from '../src'

/** A fake runtime: `behave` plays the model, then the run finishes with `summary`. */
function setup(opts: { behave?: (doc: Y.Doc, req: RunRequest) => void; summary?: string; startError?: string; model?: string | null } = {}) {
  const doc = new Y.Doc()
  insertBlock(doc, 0, 'b1', 'The quick brown fox')
  const cid = commentOnBlock(doc, 'b1', 'quick', 'ann@x.com', '@AI 把这句改得更生动')!
  const started: RunRequest[] = []
  const bus = new EventEmitter()
  let running = false
  const agent = {
    activeRun: () => null,
    isRunning: () => running,
    start: async (req: RunRequest) => {
      if (opts.startError) throw new Error(opts.startError)
      started.push(req)
      running = true
      setTimeout(() => {
        opts.behave?.(doc, req)
        running = false
        bus.emit('e', { seq: 1, type: 'run.finished', payload: { status: 'done', summary: opts.summary ?? '' } })
      }, 20)
      return 'run1'
    },
    subscribe: async (_id: string, _after: number, send: (e: unknown) => void) => {
      bus.on('e', send)
      return () => bus.off('e', send)
    },
  } as unknown as AgentRuntime
  const collab = { withDoc: async <T>(_id: string, fn: (d: Y.Doc) => T) => fn(doc) } as unknown as Collab
  const store = {
    createChat: async (documentId: string, title: string) => ({ id: 'chat1', document_id: documentId, title }),
  } as unknown as Store
  const run = () =>
    handleAiMention(
      { agent, store, collab, modelFor: async () => (opts.model === null ? undefined : (opts.model ?? 'deepseek:flash')) },
      { documentId: 'd1', userId: 'u1', actor: 'ann@x.com', commentId: cid, replyIndex: -1 },
    )
  const replies = () => listComments(doc).find((c) => c.id === cid)!.replies
  return { doc, cid, started, run, replies }
}

describe('@AI in comments', () => {
  it('recognises @AI only as a word of its own', () => {
    expect(AI_MENTION.test('@AI 看一下')).toBe(true)
    expect(AI_MENTION.test('请 @ai，看看')).toBe(true)
    expect(AI_MENTION.test('mail@AI.com')).toBe(false)
    expect(AI_MENTION.test('@AIR')).toBe(false)
  })

  it('starts a run with the request and the thread, and the AI replies in the thread', async () => {
    const t = setup({ behave: (doc, _req) => replyToComment(doc, t.cid, 'AI · flash', '已改为更生动的说法。') })
    await t.run()
    expect(t.started).toHaveLength(1)
    const req = t.started[0]!
    expect(req.instruction).toContain('@AI 把这句改得更生动')
    expect(req.instruction).toContain(`reply_to_comment (comment_id "${t.cid}")`)
    expect(req.context?.[0]).toMatchObject({ kind: 'comment', blockIds: ['b1'] })
    expect(req.context?.[0]?.text).toContain('quick')
    expect(t.replies()).toMatchObject([{ author: 'AI · flash', text: '已改为更生动的说法。' }])
  })

  it('writes the run summary into the thread when the model did not reply itself', async () => {
    const t = setup({ summary: '我把第一句改写了。' })
    await t.run()
    expect(t.replies()).toMatchObject([{ author: 'AI', text: '我把第一句改写了。' }])
  })

  it('answers in the thread when there is no model or the run cannot start', async () => {
    const a = setup({ model: null })
    await a.run()
    expect(a.started).toHaveLength(0)
    expect(a.replies()[0]?.text).toContain('没有可用的模型')

    const b = setup({ startError: '今天的 AI 用量已达上限' })
    await b.run()
    expect(b.replies()[0]?.text).toContain('今天的 AI 用量已达上限')
  })
})

/** The notify route on a running local server: only the owner's own @AI text is answered. */
describe('@AI notify route', () => {
  let server: RunningServer
  let dir: string
  let base: string
  let token = ''
  const providers: HocuspocusProvider[] = []
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } })
    return { status: res.status, body: (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text() }
  }
  const until = async (check: () => boolean, what: string, ms = 8000) => {
    const t = Date.now()
    while (!check()) {
      if (Date.now() - t > ms) throw new Error('timed out: ' + what)
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  const notify = (docId: string, cid: string, reply?: number) =>
    call(`/api/docs/${docId}/comments/${cid}/notify`, { method: 'POST', body: JSON.stringify(reply === undefined ? {} : { reply }) })

  let docId = ''
  let doc: Y.Doc

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aiw-ai-notify-'))
    // No model keys from this machine: an @AI mention must not reach a real provider.
    for (const k of Object.keys(process.env)) if (/_API_KEY$|^AIW_COMPAT_/.test(k)) delete process.env[k]
    server = await startServer({ dataDir: dir, port: 0, assetGc: false })
    base = `http://127.0.0.1:${server.port}`
    token = server.token
    docId = (await call('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'AI' }) })).body.id as string
    doc = new Y.Doc()
    providers.push(new HocuspocusProvider({ url: base.replace('http', 'ws') + '/collab', name: docId, document: doc, token }))
    await until(() => projectBlocks(doc, 'physical').length === 1, 'synced')
    insertBlock(doc, 1, 'b2', 'The quick brown fox jumps')
    await until(() => projectBlocks(doc, 'physical').length === 2, 'block')
  })
  afterAll(async () => {
    providers.forEach((p) => p.destroy())
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('answers my own @AI comment in the thread and reports ai: true', async () => {
    const ask = commentOnBlock(doc, 'b2', 'fox', '我', '@AI 这句话通顺吗？')!
    const res = await notify(docId, ask)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ai: true })
    await until(() => (listComments(doc).find((c) => c.id === ask)?.replies.length ?? 0) > 0, 'AI reply')
    const reply = listComments(doc).find((c) => c.id === ask)!.replies[0]!
    // The reply is signed by the AI (with the model's name when a run was started).
    expect(reply.author).toMatch(/^AI/)
    expect(reply.text).toBeTruthy()
  })

  it('my own comment without @AI is not sent to the AI', async () => {
    const plain = commentOnBlock(doc, 'b2', 'brown', '我', 'write to me@AI.com')!
    expect(await notify(docId, plain)).toEqual({ status: 200, body: { ai: false } })
    expect(listComments(doc).find((c) => c.id === plain)!.replies).toEqual([])
  })

  it('a reply of mine with @AI is answered; a reply index that does not exist is not found', async () => {
    const thread = commentOnBlock(doc, 'b2', 'brown', '我', '看看这一段')!
    replyToComment(doc, thread, '我', '@AI 再看看')
    expect((await notify(docId, thread, 0)).body).toEqual({ ai: true })
    expect((await notify(docId, thread, 99)).status).toBe(404)
    expect((await call(`/api/docs/${docId}/comments/${thread}/notify`, { method: 'POST', body: JSON.stringify({ reply: -1 }) })).status).toBe(400)
  }, 15000)

  it('only the author of the text may ask the AI about it: someone else\'s comment is refused', async () => {
    const theirs = commentOnBlock(doc, 'b2', 'jumps', 'ann@x.com', '@AI 帮我改一下')!
    expect((await notify(docId, theirs)).status).toBe(403)
  })

  it('a comment that does not exist is not found', async () => {
    const started = Date.now()
    expect((await notify(docId, 'no-such-comment')).status).toBe(404)
    expect(Date.now() - started).toBeGreaterThanOrEqual(3500)
  }, 15000)
})
