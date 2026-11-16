import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { blockText, commentOnBlock, findBlock, insertBlock, listComments, replyToComment, resolveComment, sync } from '../src'

describe('comments', () => {
  it('follow their text through concurrent edits and report when it is gone', () => {
    const a = new Y.Doc()
    insertBlock(a, 0, 'b1', 'The quick brown fox.')
    const b = new Y.Doc()
    sync(a, b)
    const id = commentOnBlock(a, 'b1', 'quick', 'ann', 'too informal?')!
    blockText(findBlock(b, 'b1')!).insert(0, 'Well, ') // concurrent edit before the anchor
    sync(a, b)
    expect(listComments(b)).toMatchObject([{ id, author: 'ann', quote: 'quick', blockId: 'b1', orphaned: false }])
    replyToComment(b, id, 'bob', 'agree')
    blockText(findBlock(b, 'b1')!).delete(10, 5) // "quick" is deleted
    sync(a, b)
    expect(listComments(a)).toMatchObject([{ orphaned: true, quote: 'quick', replies: [{ author: 'bob', text: 'agree' }] }])
    resolveComment(a, id)
    expect(listComments(a)[0]!.resolved).toBe(true)
  })
  it('refuses a quote that is not in the block', () => {
    const d = new Y.Doc()
    insertBlock(d, 0, 'b1', 'hello')
    expect(commentOnBlock(d, 'b1', 'absent', 'x', 'y')).toBeNull()
  })
})
