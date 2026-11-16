import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { sync } from '../src'

/**
 * Why tracked changes are NOT stored as Yjs text formats (the ProseMirror-mark
 * approach). These tests pin the Yjs behaviour that rules it out. If a Yjs
 * upgrade makes one of them fail, the decision can be revisited.
 */
describe('Yjs range formats are unsuitable for tracked changes', () => {
  const pair = (initial: string) => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    a.getText('t').insert(0, initial)
    sync(a, b)
    return { a, b, ta: a.getText('t'), tb: b.getText('t') }
  }

  it('text typed concurrently inside a range marked "deleted" becomes marked deleted too', () => {
    const { a, b, ta, tb } = pair('the quick brown fox')
    ta.format(4, 11, { del: { id: 'd1' } }) // A proposes deleting "quick brown"
    tb.insert(9, '<NEW>') // B, not having seen that, types inside it
    sync(a, b)
    expect(ta.toDelta()).toEqual([
      { insert: 'the ' },
      { insert: 'quick<NEW> brown', attributes: { del: { id: 'd1' } } },
      { insert: ' fox' },
    ])
  })

  it('overlapping concurrent marks leave part of one range unmarked', () => {
    const { a, b, ta, tb } = pair('0123456789')
    ta.format(2, 5, { del: { id: 'A' } }) // 2..6
    tb.format(4, 5, { del: { id: 'B' } }) // 4..8
    sync(a, b)
    const marked = (ta.toDelta() as { insert: string; attributes?: object }[])
      .filter((d) => d.attributes)
      .map((d) => d.insert)
      .join('')
    expect(marked).not.toBe('2345678') // "78" was marked by B and has lost its mark
  })

  it('accepting on one replica while rejecting on another loses both old and new text', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    const ta = a.getText('t')
    const tb = b.getText('t')
    ta.insert(0, 'a cat sat')
    ta.format(2, 3, { del: { id: 'r' } })
    ta.insert(5, 'tabby', { ins: { id: 'r' }, del: null })
    sync(a, b)
    ta.delete(2, 3) // A accepts: drop "cat" ...
    ta.format(2, 5, { ins: null }) // ... keep "tabby"
    tb.delete(5, 5) // B rejects: drop "tabby" ...
    tb.format(2, 3, { del: null }) // ... keep "cat"
    sync(a, b)
    expect(ta.toString()).toBe('a  sat')
  })
})
