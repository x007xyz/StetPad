import { addComment, commentOnBlock, comments, insertBlock, listComments } from '@stetpad/crdt'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { DocTools } from '../src/tools'

const AI = 'AI · test-model'
const setup = () => {
  const doc = new Y.Doc()
  insertBlock(doc, 0, 'b1', 'The quick brown fox')
  const human = commentOnBlock(doc, 'b1', 'quick', 'Ann', 'Is this accurate?')!
  const tools = new DocTools(doc, { author: AI, runId: 'r1' })
  return { doc, human, tools }
}
const snapshot = (doc: Y.Doc) => JSON.stringify(comments(doc).toJSON())

describe('agent comment tools', () => {
  it('creates a comment on a block and on a quote, signed as the agent', () => {
    const { doc, tools } = setup()
    const a = tools.addComment('b1', undefined, 'whole block')
    const b = tools.addComment('b1', 'brown fox', 'phrase')
    expect(a.ok && b.ok).toBe(true)
    const all = listComments(doc)
    expect(all.filter((c) => c.author === AI).map((c) => c.quote)).toEqual(expect.arrayContaining(['brown fox']))
    expect(tools.addComment('b1', 'nope', 'x').ok).toBe(false)
  })

  it('replies to and resolves a comment without touching its text or earlier replies', () => {
    const { doc, human, tools } = setup()
    expect(tools.replyToComment(human, 'Checked, it is.')).toEqual({ ok: true })
    const c = listComments(doc).find((x) => x.id === human)!
    expect(c.text).toBe('Is this accurate?')
    expect(c.author).toBe('Ann')
    expect(c.replies).toMatchObject([{ author: AI, text: 'Checked, it is.' }])
    expect(tools.resolveComment(human)).toEqual({ ok: true })
    expect(listComments(doc).find((x) => x.id === human)!.resolved).toBe(true)
    expect(tools.readComments()).toHaveLength(0)
    expect(tools.readComments(true)).toHaveLength(1)
    expect(tools.replyToComment('missing', 'x').ok).toBe(false)
    expect(tools.resolveComment('missing').ok).toBe(false)
  })

  it('exposes no way to edit, delete or reopen comments', () => {
    const { doc, human, tools } = setup()
    const before = JSON.parse(snapshot(doc))[human]
    const methods = Object.getOwnPropertyNames(DocTools.prototype)
    expect(methods.filter((m) => /comment/i.test(m)).sort()).toEqual(['addComment', 'readComments', 'replyToComment', 'resolveComment'])
    tools.replyToComment(human, 'r')
    const after = JSON.parse(snapshot(doc))[human]
    expect({ ...after, replies: undefined, resolved: undefined }).toEqual({ ...before, replies: undefined, resolved: undefined })
    expect(after.replies.slice(0, before.replies.length)).toEqual(before.replies)
    expect(Object.keys(comments(doc).toJSON())).toContain(human)
    void addComment
  })
})
