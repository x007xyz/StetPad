import fc from 'fast-check'
import { expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  blockText, blocks, cloneDoc, compact, decide, decideAndLog, insertBlock, listChanges, listDecided,
  physicalBlockTextLookup, projectBlocks, proposeReplace, readBlock, trackedDelete, trackedDeleteBlock,
  trackedInsert, trackedInsertBlock, type DecidedChange,
} from '../src'

it('matches full physical projection for previews and sequential decision logging', () => {
  const meta = { author: 'AI', runId: 'run', reason: 'Rewrite' }
  const oldText = (doc: Y.Doc, id: string) => projectBlocks(doc, 'physical').find((b) => b.blockId === id)?.text
  fc.assert(fc.property(
    fc.array(fc.record({ target: fc.nat(10), kind: fc.nat(3), weight: fc.nat(99) }), { maxLength: 25 }),
    fc.boolean(),
    (ops, accept) => {
      const doc = new Y.Doc()
      const duplicate = insertBlock(doc, 0, 'same', '第一段😀')
      insertBlock(doc, 1, 'same', 'fallback')
      insertBlock(doc, 2, 'blank')
      insertBlock(doc, 3, 'replace', 'the original sentence')
      trackedDeleteBlock(doc, duplicate, meta, { changeId: 'first' })
      trackedInsertBlock(doc, 4, 'new', '', meta, {
        changeId: 'new', delta: [{ insert: 'A😀', attributes: { bold: {} } }, { insert: '中B' }],
      })
      const replacement = proposeReplace(doc, readBlock(doc, 'replace')!, 'the revised sentence', meta)
      expect(replacement.applied.length).toBeGreaterThan(0)
      for (const [i, o] of ops.entries()) {
        const all = blocks(doc)
        const el = all[o.target % all.length]!
        const id = `op-${i}`
        const author = i % 2 ? 'AI' : 'Other'
        const text = blockText(el)
        const chars = [...text.toString()]
        const at = o.weight % (chars.length + 1)
        const offset = chars.slice(0, at).join('').length
        if (o.kind === 0) trackedInsert(doc, text, offset, '文x', { author }, { changeId: id })
        if (o.kind === 1) trackedDelete(doc, text, offset, chars.slice(at, at + 2).join('').length, { author }, { changeId: id })
        if (o.kind === 2) trackedInsertBlock(doc, o.target, `b-${i}`, 'added', { author }, { changeId: id })
        if (o.kind === 3) trackedDeleteBlock(doc, el, { author }, { changeId: id })
      }
      const pending = listChanges(doc)
      const text = physicalBlockTextLookup(doc)
      for (const id of ['same', 'blank', 'new', 'missing', ...pending.flatMap((c) => [...c.insertedBlocks, ...c.deletedBlocks])]) {
        expect(text(id)).toEqual(oldText(doc, id))
      }
      const decision = accept ? 'accept' : 'reject'
      const ids = [...pending].sort((a, b) => weight(a.id) - weight(b.id)).map((c) => c.id)
      ids.push('missing', 'new')
      function weight(id: string): number {
        return id === 'first' ? 101 : (ops[Number(id.slice(3))]?.weight ?? 100)
      }
      const old = cloneDoc(doc)
      const log = old.getMap<DecidedChange>('decidedLog')
      const byId = new Map(pending.map((c) => [c.id, c]))
      old.transact(() => {
        for (const id of ids) {
          if (!decide(old, id, decision)) continue
          const c = byId.get(id)
          if (!c) continue
          const snapshot = (bid: string) => oldText(old, bid) ?? ''
          const { author, runId, reason, inserted, deleted, insertedBlocks, deletedBlocks } = c
          log.set(id, { id, author, inserted, deleted, insertedBlocks: insertedBlocks.map(snapshot),
            deletedBlocks: deletedBlocks.map(snapshot), decision, at: Date.now(),
            ...(runId ? { runId } : {}), ...(reason ? { reason } : {}) })
        }
      })
      decideAndLog(doc, pending, ids, decision)
      const entries = (d: Y.Doc) =>
        listDecided(d).map(({ at: _at, ...c }) => c).sort((a, b) => a.id.localeCompare(b.id))
      expect(entries(doc)).toEqual(entries(old))
      expect(listChanges(doc)).toEqual(listChanges(old))
      compact(doc)
      compact(old)
      expect(projectBlocks(doc, 'physical')).toEqual(projectBlocks(old, 'physical'))
      expect(projectBlocks(doc, 'revised')).toEqual(projectBlocks(old, 'revised'))
      doc.destroy()
      old.destroy()
    },
  ), { seed: 0x57e7, numRuns: 100 })
})
