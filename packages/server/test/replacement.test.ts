import { blockText, changes, cloneDoc, commentOnBlock, compact, decide, findBlock, insertBlock, listChanges, listComments, projectBlocks, resolveComment, sync, trackedDelete, trackedInsert } from '@stetpad/crdt'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { DocTools } from '../src/tools'

describe.each([
  { type: 'heading', attrs: { level: 1 }, content: '## Sales rose.', next: { level: 2 } },
  { type: 'taskItem', attrs: { checked: false }, content: '- [x] Sales rose.', next: { checked: true } },
  { type: 'paragraph', attrs: {}, content: '> Sales rose.', next: {} },
])('$type replacement', ({ type, attrs, content, next }) => {
  it.each(['append', 'delete', 'replace', 'empty'] as const)('preserves a pending human %s on acceptance', (edit) => {
    const doc = new Y.Doc()
    insertBlock(doc, 0, 'b', 'Sales rose.', type, attrs)
    const r = new DocTools(doc, { author: 'AI' }).replaceBlock('b', content)
    if (!r.ok) throw new Error(r.error)
    const t = blockText(findBlock(doc, 'b')!)
    if (edit === 'append') t.insert(t.length, ' In June.', { bold: true })
    if (edit === 'delete') t.delete(5, 5)
    if (edit === 'replace') { t.delete(0, 5); t.insert(0, 'Revenue') }
    if (edit === 'empty') t.delete(0, t.length)
    const expected = t.toDelta().map((run: { insert: string }) => run.insert).join('')
    decide(doc, r.change_ids[0]!, 'accept')
    expect(projectBlocks(doc, 'original')[0]!.text).toBe(expected)
    compact(doc)
    expect(projectBlocks(doc, 'original')[0]).toMatchObject({ text: expected, attrs: next })
    if (edit === 'append') expect(projectBlocks(doc, 'original')[0]!.delta.at(-1)).toEqual({ insert: ' In June.', attributes: { bold: true } })
  })

  it('rebases a persisted proposal when a remote decision is compacted', () => {
    const doc = new Y.Doc()
    insertBlock(doc, 0, 'b', 'Sales rose.', type, attrs)
    const r = new DocTools(doc, { author: 'AI' }).replaceBlock('b', content)
    if (!r.ok) throw new Error(r.error)
    const restored = cloneDoc(doc)
    blockText(findBlock(restored, 'b')!).insert(0, 'June: ')
    changes(restored).get(r.change_ids[0]!)!.set('decision', 'accept')
    compact(restored)
    compact(restored)
    expect(projectBlocks(restored, 'original')[0]!.text).toBe('June: Sales rose.')
  })

  it('leaves human edits and comment anchors on the original when rejected', () => {
    const doc = new Y.Doc()
    insertBlock(doc, 0, 'b', 'Sales rose.', type, attrs)
    const id = commentOnBlock(doc, 'b', 'Sales', 'Me', 'Source?')!
    resolveComment(doc, id)
    const r = new DocTools(doc, { author: 'AI' }).replaceBlock('b', content)
    if (!r.ok) throw new Error(r.error)
    blockText(findBlock(doc, 'b')!).insert(0, 'June: ')
    decide(doc, r.change_ids[0]!, 'reject')
    compact(doc)
    expect(projectBlocks(doc, 'original')[0]).toMatchObject({ blockId: 'b', text: 'June: Sales rose.', attrs })
    expect(listComments(doc)[0]).toMatchObject({ blockId: 'b', orphaned: false, resolved: true })
  })

  it.each([false, true])('keeps comment anchors (resolved: %s)', (resolved) => {
    const doc = new Y.Doc()
    insertBlock(doc, 0, 'b', 'Sales rose.', type, attrs)
    const id = commentOnBlock(doc, 'b', 'Sales', 'Me', 'Source?')!
    resolveComment(doc, id, resolved)
    const r = new DocTools(doc, { author: 'AI' }).replaceBlock('b', content)
    if (!r.ok || !('new_block_id' in r)) throw new Error('expected replacement')
    decide(doc, r.change_ids[0]!, 'accept')
    compact(doc)
    resolveComment(doc, id, false)
    expect(listComments(doc)[0]).toMatchObject({ blockId: r.new_block_id, orphaned: false, resolved: false })
  })
})

describe('replacement review regressions', () => {
  it.each([
    { before: 'Sales rose', proposal: 'Sales grew', expected: 'Sales grew!' },
    { before: 'Sales rose', proposal: 'Revenue grew', expected: 'Revenue grew!' },
    { before: 'Sales rose', proposal: 'Sales ', expected: 'Sales !' },
  ])('places human suffixes after converted text: $proposal', ({ before, proposal, expected }) => {
    const doc = new Y.Doc()
    insertBlock(doc, 0, 'b', before)
    const r = new DocTools(doc, { author: 'AI' }).replaceBlock('b', '## ' + proposal)
    if (!r.ok) throw new Error(r.error)
    const t = blockText(findBlock(doc, 'b')!)
    t.insert(t.length, '!')
    decide(doc, r.change_ids[0]!, 'accept')
    compact(doc)
    expect(projectBlocks(doc, 'original')[0]!.text).toBe(expected)
  })

  it('merges human text only once when two replicas accept concurrently', () => {
    const server = new Y.Doc()
    insertBlock(server, 0, 'b', 'Sales rose.')
    const r = new DocTools(server, { author: 'AI' }).replaceBlock('b', '## Sales rose.')
    if (!r.ok) throw new Error(r.error)
    blockText(findBlock(server, 'b')!).insert(11, ' In June.')
    const a = cloneDoc(server)
    const b = cloneDoc(server)
    decide(a, r.change_ids[0]!, 'accept')
    decide(b, r.change_ids[0]!, 'accept')
    expect(projectBlocks(a, 'original')[0]).toMatchObject({ blockId: 'b', text: 'Sales rose. In June.' })
    expect(listChanges(a)).toHaveLength(1)
    sync(server, a)
    sync(server, b)
    compact(server)
    expect(projectBlocks(server, 'original')[0]!.text).toBe('Sales rose. In June.')
    sync(server, a)
    sync(server, b)
    expect(projectBlocks(a, 'original')).toEqual(projectBlocks(server, 'original'))
    expect(projectBlocks(b, 'original')).toEqual(projectBlocks(server, 'original'))
  })

  it.each(['insert', 'delete'] as const)('keeps a human tracked %s pending after accepting only formatting', (kind) => {
    const doc = new Y.Doc()
    insertBlock(doc, 0, 'b', 'Sales rose.', 'heading', { level: 1 })
    const r = new DocTools(doc, { author: 'AI' }).replaceBlock('b', '## Sales rose.')
    if (!r.ok) throw new Error(r.error)
    const t = blockText(findBlock(doc, 'b')!)
    const meta = { author: 'Human', reason: 'Still under review', runId: 'human-edit' }
    const human = kind === 'insert' ? trackedInsert(doc, t, t.length, ' In June.', meta)! : trackedDelete(doc, t, 6, 4, meta)!
    decide(doc, r.change_ids[0]!, 'accept')
    compact(doc)
    expect(listChanges(doc)).toEqual([expect.objectContaining({ id: human, ...meta })])
    expect(projectBlocks(doc, 'original')[0]!.text).toBe('Sales rose.')
    expect(projectBlocks(doc, 'revised')[0]!.text).toBe(kind === 'insert' ? 'Sales rose. In June.' : 'Sales .')
    for (const decision of ['accept', 'reject'] as const) {
      const replica = cloneDoc(doc)
      decide(replica, human, decision)
      compact(replica)
      expect(projectBlocks(replica, 'original')[0]!.text).toBe(decision === 'reject' ? 'Sales rose.' : kind === 'insert' ? 'Sales rose. In June.' : 'Sales .')
    }
  })
})
