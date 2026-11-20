import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  blockText,
  compact,
  decide,
  findBlock,
  insertBlock,
  listChanges,
  originalDoc,
  originalText,
  projectBlocks,
  proposeReplace,
  rawChars,
  readBlock,
  removeText,
  revisedDoc,
  revisedText,
  sync,
  trackedDelete,
  trackedDeleteBlock,
  trackedInsert,
  trackedInsertBlock,
  trackedReplace,
  typeText,
} from '../src'

const AI = { author: 'agent:test', runId: 'run-1' }
const ANN = { author: 'ann' }
const BOB = { author: 'bob' }

/** A server replica plus two clients, all holding one paragraph `b1`. */
function setup(initial: string) {
  const server = new Y.Doc()
  insertBlock(server, 0, 'b1', initial)
  const a = new Y.Doc()
  const b = new Y.Doc()
  sync(server, a)
  sync(server, b)
  const t = (d: Y.Doc) => blockText(findBlock(d, 'b1')!)
  const syncAll = () => {
    for (let i = 0; i < 2; i++) {
      sync(server, a)
      sync(server, b)
    }
  }
  const raw = (d: Y.Doc) => rawChars(t(d)).map((c) => c.ch).join('')
  return { server, a, b, t, syncAll, raw }
}

describe('basic tracked changes', () => {
  it('a replacement shows old text in the original and new text in the revision', () => {
    const { server, t } = setup('a cat sat')
    const id = trackedReplace(server, t(server), 2, 3, 'tabby', ANN)
    expect(originalText(server, t(server))).toBe('a cat sat')
    expect(revisedText(server, t(server))).toBe('a tabby sat')
    expect(listChanges(server)).toMatchObject([{ id, author: 'ann', deleted: 'cat', inserted: 'tabby' }])
  })

  it('accept keeps the new text, reject restores the old', () => {
    for (const [decision, expected] of [['accept', 'a tabby sat'], ['reject', 'a cat sat']] as const) {
      const { server, t, raw } = setup('a cat sat')
      const id = trackedReplace(server, t(server), 2, 3, 'tabby', ANN)
      decide(server, id, decision)
      // Views honour the decision before any physical cleanup.
      expect(revisedText(server, t(server))).toBe(expected)
      expect(originalText(server, t(server))).toBe(expected)
      compact(server)
      expect(raw(server)).toBe(expected)
      expect(listChanges(server)).toEqual([])
    }
  })

  it('deleting your own pending insertion just shrinks it', () => {
    const { server, t, raw } = setup('hello')
    trackedInsert(server, t(server), 5, ' world', ANN)
    trackedDelete(server, t(server), 5, 6, ANN)
    expect(raw(server)).toBe('hello')
    expect(listChanges(server)).toEqual([])
  })

  it("deleting someone else's pending insertion is itself a suggestion", () => {
    const { server, t, raw } = setup('hello')
    const ins = trackedInsert(server, t(server), 5, ' world', ANN)!
    const del = trackedDelete(server, t(server), 5, 6, BOB)!
    expect(raw(server)).toBe('hello world')
    expect(originalText(server, t(server))).toBe('hello')
    expect(revisedText(server, t(server))).toBe('hello')
    decide(server, ins, 'accept')
    decide(server, del, 'reject')
    compact(server)
    expect(raw(server)).toBe('hello world')
  })

  it('typing inside a pending insertion joins it; typing beside it does not', () => {
    const { server, t } = setup('ab')
    const id = trackedInsert(server, t(server), 1, 'XY', ANN)!
    typeText(server, t(server), 2, '-', { author: 'bob', tracking: false }) // between X and Y
    typeText(server, t(server), 0, '>', { author: 'bob', tracking: false })
    expect(listChanges(server)).toMatchObject([{ id, inserted: 'X-Y' }])
    expect(originalText(server, t(server))).toBe('>ab')
  })

  it('with tracking on, consecutive typing extends one suggestion', () => {
    const { server, t } = setup('ab')
    const ctx = { author: 'ann', tracking: true }
    typeText(server, t(server), 1, 'x', ctx)
    typeText(server, t(server), 2, 'y', ctx)
    typeText(server, t(server), 3, 'z', ctx)
    expect(listChanges(server)).toMatchObject([{ inserted: 'xyz' }])
  })

  it('text pending deletion cannot be removed by a plain delete', () => {
    const { server, t, raw } = setup('a cat sat')
    trackedDelete(server, t(server), 2, 3, ANN)
    removeText(server, t(server), 0, 9, { author: 'bob', tracking: false })
    expect(raw(server)).toBe('cat')
    expect(originalText(server, t(server))).toBe('cat')
  })
})

describe('concurrency', () => {
  it('text typed concurrently inside a range proposed for deletion stays plain text', () => {
    const { a, b, t, syncAll } = setup('the quick brown fox')
    trackedDelete(a, t(a), 4, 11, ANN)
    t(b).insert(9, '<NEW>')
    syncAll()
    expect(revisedText(a, t(a))).toBe('the <NEW> fox')
    expect(originalText(a, t(a))).toBe('the quick<NEW> brown fox')
    expect(revisedText(b, t(b))).toBe(revisedText(a, t(a)))
  })

  it('overlapping concurrent deletions: every character stays pending until all are rejected', () => {
    const { server, a, b, t, syncAll, raw } = setup('0123456789')
    const da = trackedDelete(a, t(a), 2, 5, ANN)! // 2..6
    const db = trackedDelete(b, t(b), 4, 5, BOB)! // 4..8
    syncAll()
    expect(revisedText(server, t(server))).toBe('019')
    decide(server, da, 'reject')
    expect(revisedText(server, t(server))).toBe('01239') // 4..8 still pending under bob
    decide(server, db, 'reject')
    compact(server)
    expect(raw(server)).toBe('0123456789')
  })

  it('accepting on one replica while rejecting on another keeps exactly one side', () => {
    const { server, a, b, t, syncAll, raw } = setup('a cat sat')
    const id = trackedReplace(server, t(server), 2, 3, 'tabby', AI)
    syncAll()
    decide(a, id, 'accept')
    decide(b, id, 'reject')
    syncAll()
    compact(server)
    syncAll()
    expect(['a cat sat', 'a tabby sat']).toContain(raw(server))
    expect(raw(a)).toBe(raw(server))
    expect(raw(b)).toBe(raw(server))
  })

  it('a decision that arrives after the change was settled does not undo it', () => {
    for (const [first, late, expected] of [
      ['accept', 'reject', 'a tabby sat'],
      ['reject', 'accept', 'a cat sat'],
    ] as const) {
      const { server, a, b, t, syncAll, raw } = setup('a cat sat')
      const id = trackedReplace(server, t(server), 2, 3, 'tabby', AI)
      syncAll()
      decide(a, id, first)
      syncAll() // b has seen the decision, so its own decision below is the later write
      compact(server) // ... but b has not seen that the server settled it
      decide(b, id, late)
      expect(revisedText(b, t(b))).not.toBe(expected) // b's local view follows its own decision
      syncAll()
      compact(server)
      syncAll()
      for (const d of [server, a, b]) {
        expect(raw(d)).toBe(expected)
        expect(revisedText(d, t(d))).toBe(expected)
        expect(originalText(d, t(d))).toBe(expected)
      }
    }
  })

  it('two replicas rejecting the same deletion do not duplicate the text', () => {
    const { server, a, b, t, syncAll, raw } = setup('a cat sat')
    const id = trackedDelete(server, t(server), 2, 3, AI)!
    syncAll()
    decide(a, id, 'reject')
    decide(b, id, 'reject')
    syncAll()
    compact(server)
    expect(raw(server)).toBe('a cat sat')
  })

  it('text typed into an insertion after it was rejected is cleaned up when it arrives', () => {
    const { server, a, t, syncAll, raw } = setup('ab')
    const id = trackedInsert(server, t(server), 1, 'XY', AI)!
    syncAll()
    typeText(a, t(a), 2, '-', { author: 'ann', tracking: false })
    decide(server, id, 'reject')
    compact(server)
    syncAll()
    compact(server)
    syncAll()
    expect(raw(server)).toBe('ab')
    expect(raw(a)).toBe('ab')
  })
})

describe('blocks', () => {
  it('a proposed block exists only in the revision; a block proposed for deletion only in the original', () => {
    const { server } = setup('one')
    insertBlock(server, 1, 'b2', 'two')
    const ins = trackedInsertBlock(server, 2, 'b3', 'three', AI)
    const del = trackedDeleteBlock(server, findBlock(server, 'b2')!, AI)!
    expect(revisedDoc(server).map((b) => b.blockId)).toEqual(['b1', 'b3'])
    expect(originalDoc(server).map((b) => b.blockId)).toEqual(['b1', 'b2'])
    decide(server, ins, 'accept')
    decide(server, del, 'reject')
    compact(server)
    expect(revisedDoc(server).map((b) => b.text)).toEqual(['one', 'two', 'three'])
  })

  it('editing a block that someone concurrently proposed deleting keeps the edit', () => {
    const { server, a, b, syncAll } = setup('one')
    const del = trackedDeleteBlock(a, findBlock(a, 'b1')!, ANN)!
    blockText(findBlock(b, 'b1')!).insert(3, ' more')
    syncAll()
    expect(originalDoc(server)).toEqual([{ blockId: 'b1', text: 'one more' }])
    expect(revisedDoc(server)).toEqual([])
    decide(server, del, 'reject')
    compact(server)
    expect(revisedDoc(server)).toEqual([{ blockId: 'b1', text: 'one more' }])
  })

  it('proposes rich-text blocks with delta and atom blocks under one change id', () => {
    for (const [decision, expectedCount] of [['accept', 4], ['reject', 1]] as const) {
      const { server } = setup('intro')
      const delta = [
        { insert: 'Bold ', attributes: { bold: {} } },
        { insert: 'link', attributes: { link: { href: 'https://example.com' } } },
        { insert: ' code', attributes: { code: {} } },
      ]
      const cid = trackedInsertBlock(server, 1, 'd1', '', ANN, { type: 'divider' })
      trackedInsertBlock(server, 2, 'p2', '', ANN, { changeId: cid, type: 'paragraph', delta })
      trackedInsertBlock(server, 3, 'img1', '', ANN, { changeId: cid, type: 'image', attrs: { src: '/files/abc', alt: 'pic', caption: 'cap' } })

      expect(projectBlocks(server, 'original').map((b) => b.blockId)).toEqual(['b1'])
      const rev = projectBlocks(server, 'revised')
      expect(rev.map((b) => b.blockId)).toEqual(['b1', 'd1', 'p2', 'img1'])
      expect(rev[1]).toMatchObject({ type: 'divider', state: 'ins' })
      expect(rev[2]).toMatchObject({ type: 'paragraph', state: 'ins', delta })
      expect(rev[3]).toMatchObject({ type: 'image', state: 'ins', attrs: { src: '/files/abc', alt: 'pic', caption: 'cap' } })

      decide(server, cid, decision)
      compact(server)
      expect(projectBlocks(server, 'revised')).toHaveLength(expectedCount)
      expect(listChanges(server)).toEqual([])
      if (decision === 'accept') {
        expect(projectBlocks(server, 'revised')[2]!.delta).toEqual(delta)
      }
    }
  })
})

describe('agent proposals while people edit', () => {
  it('applies as word-level suggestions when nothing changed', () => {
    const { server, t } = setup('The quick brown fox jumps over the lazy dog.')
    const base = readBlock(server, 'b1')!
    const r = proposeReplace(server, base, 'The fast brown fox leaps over the lazy dog.', AI)
    expect(r.failed).toEqual([])
    expect(r.currentText).toBe('The fast brown fox leaps over the lazy dog.')
    expect(originalText(server, t(server))).toBe('The quick brown fox jumps over the lazy dog.')
    expect(listChanges(server).map((c) => [c.deleted, c.inserted])).toEqual([
      ['quick', 'fast'],
      ['jumps', 'leaps'],
    ])
  })

  it('segments Chinese by word instead of by character', () => {
    const { server } = setup('我们今天去公园散步。')
    const base = readBlock(server, 'b1')!
    proposeReplace(server, base, '我们明天去公园跑步。', AI)
    expect(listChanges(server).map((c) => [c.deleted, c.inserted])).toEqual([
      ['今天', '明天'],
      ['散步', '跑步'],
    ])
  })

  it('keeps a person’s edit made elsewhere in the block after the agent read it', () => {
    const { server, a, t } = setup('The quick brown fox jumps over the lazy dog.')
    const base = readBlock(server, 'b1')!
    typeText(a, t(a), 0, 'Yesterday: ', { author: 'ann', tracking: false })
    removeText(a, t(a), 11 + 35, 5, { author: 'ann', tracking: false }) // "lazy "
    sync(server, a)
    const r = proposeReplace(server, base, 'The fast brown fox jumps over the lazy dog.', AI)
    expect(r.failed).toEqual([])
    expect(r.currentText).toBe('Yesterday: The fast brown fox jumps over the dog.')
  })

  it('refuses an edit whose target a person has changed, and leaves their text alone', () => {
    const { server, a, t } = setup('The quick brown fox jumps over the lazy dog.')
    const base = readBlock(server, 'b1')!
    typeText(a, t(a), 6, 'ite qu', { author: 'ann', tracking: false }) // "quick" -> "quite quick"
    sync(server, a)
    const r = proposeReplace(server, base, 'The fast brown fox leaps over the lazy dog.', AI)
    expect(r.failed).toMatchObject([{ edit: { insert: 'fast' }, reason: 'the text to replace was edited' }])
    expect(r.applied.map((x) => x.edit.insert)).toEqual(['leaps'])
    expect(r.currentText).toBe('The quite quick brown fox leaps over the lazy dog.')
  })

  it('never loses text typed by someone who had not yet synced', () => {
    const { server, a, t, syncAll } = setup('The quick brown fox.')
    const base = readBlock(server, 'b1')!
    typeText(a, t(a), 9, ' and clever', { author: 'ann', tracking: false }) // after "quick", unsynced
    proposeReplace(server, base, 'The slow brown fox.', AI)
    syncAll()
    expect(revisedText(server, t(server))).toContain(' and clever')
    expect(originalText(server, t(server))).toBe('The quick and clever brown fox.')
  })

  it('a second proposal by the same agent replaces its first instead of stacking', () => {
    const { server, t, raw } = setup('The quick brown fox.')
    proposeReplace(server, readBlock(server, 'b1')!, 'The fast brown fox.', AI)
    proposeReplace(server, readBlock(server, 'b1')!, 'The swift brown fox.', AI)
    expect(raw(server)).toBe('The quickswift brown fox.')
    expect(revisedText(server, t(server))).toBe('The swift brown fox.')
    expect(originalText(server, t(server))).toBe('The quick brown fox.')
  })
})
