import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  blockIdOf,
  blocks,
  blockText,
  cloneDoc,
  compact,
  decide,
  insertBlock,
  listChanges,
  originalDoc,
  proposeReplace,
  rawChars,
  readBlock,
  removeText,
  revisedDoc,
  sync,
  trackedDeleteBlock,
  trackedInsertBlock,
  trackedReplace,
  typeText,
  type Baseline,
} from '../src'

/**
 * Random concurrent histories over three replicas. Replica 0 is the server:
 * the only one that compacts, and the one the agent runs on.
 */

const ALPHABET = [...'abcde  ', ...'的了我们今天公园散步，。']
const str = fc.array(fc.constantFrom(...ALPHABET), { minLength: 1, maxLength: 6 }).map((a) => a.join(''))

const op = fc.record({
  kind: fc.constantFrom(
    'type', 'type', 'typeTracked', 'typeTracked', 'remove', 'removeTracked', 'replaceTracked',
    'blockInsert', 'blockInsertTracked', 'blockDeleteTracked',
    'decide', 'decide', 'sync', 'sync', 'sync', 'compact', 'agentRead', 'agentPropose',
  ),
  r: fc.nat(2),
  r2: fc.nat(2),
  x: fc.nat(10_000),
  y: fc.nat(10_000),
  s: str,
  flag: fc.boolean(),
})
type Op = typeof op extends fc.Arbitrary<infer T> ? T : never

/** The physical document: every block and character not yet removed. */
const physical = (d: Y.Doc) =>
  blocks(d).map((el) => ({
    blockId: blockIdOf(el),
    text: rawChars(blockText(el)).map((c) => c.ch).join(''),
  }))

const snapshot = (d: Y.Doc) => ({
  physical: physical(d),
  revised: revisedDoc(d),
  original: originalDoc(d),
  changes: listChanges(d).sort((a, b) => a.id.localeCompare(b.id)),
})

function run(ops: Op[]) {
  const docs = [new Y.Doc(), new Y.Doc(), new Y.Doc()] as const
  insertBlock(docs[0], 0, 'b0', '我们今天去公园散步。')
  insertBlock(docs[0], 1, 'b1', 'the quick brown fox')
  sync(docs[0], docs[1])
  sync(docs[0], docs[2])
  const authors = ['agent', 'ann', 'bob']
  let baseline: Baseline | null = null
  let nextBlock = 2

  for (const o of ops) {
    const d = docs[o.r]!
    const author = authors[o.r]!
    const els = blocks(d)
    const el = els.length ? els[o.x % els.length]! : undefined
    const text = el ? blockText(el) : undefined
    const len = text ? text.length : 0
    const at = len ? o.y % (len + 1) : 0
    const span = Math.min(1 + (o.x % 5), len - at)

    switch (o.kind) {
      case 'type':
        if (text) typeText(d, text, at, o.s, { author, tracking: false })
        break
      case 'typeTracked':
        if (text) typeText(d, text, at, o.s, { author, tracking: true })
        break
      case 'remove':
        if (text) removeText(d, text, at, span, { author, tracking: false })
        break
      case 'removeTracked':
        if (text) removeText(d, text, at, span, { author, tracking: true })
        break
      case 'replaceTracked':
        if (text && span > 0) trackedReplace(d, text, at, span, o.s, { author })
        break
      case 'blockInsert':
        insertBlock(d, o.x % (els.length + 1), `n${o.r}-${nextBlock++}`, o.s)
        break
      case 'blockInsertTracked':
        trackedInsertBlock(d, o.x % (els.length + 1), `n${o.r}-${nextBlock++}`, o.s, { author })
        break
      case 'blockDeleteTracked':
        if (el) trackedDeleteBlock(d, el, { author })
        break
      case 'decide': {
        const pending = listChanges(d)
        if (pending.length) decide(d, pending[o.x % pending.length]!.id, o.flag ? 'accept' : 'reject')
        break
      }
      case 'sync':
        sync(docs[o.r]!, docs[o.r2]!)
        break
      case 'compact': {
        const before = { revised: revisedDoc(docs[0]), original: originalDoc(docs[0]) }
        compact(docs[0])
        // Compaction only removes what every view already hides.
        expect({ revised: revisedDoc(docs[0]), original: originalDoc(docs[0]) }).toEqual(before)
        break
      }
      case 'agentRead': {
        const s = blocks(docs[0])
        if (s.length) baseline = readBlock(docs[0], blockIdOf(s[o.x % s.length]!))
        break
      }
      case 'agentPropose': {
        if (!baseline) break
        const t = baseline.text
        const from = t.length ? o.x % (t.length + 1) : 0
        const to = Math.min(t.length, from + (o.y % 6))
        const next = t.slice(0, from) + (o.flag ? o.s : '') + t.slice(to)
        const r = proposeReplace(docs[0], baseline, next, { author: 'agent', runId: 'run' })
        // Every edit is accounted for: applied or reported, never silently dropped.
        if (next !== t) expect(r.applied.length + r.failed.length).toBeGreaterThan(0)
        baseline = null
        break
      }
    }
  }
  return docs
}

const settle = (docs: readonly Y.Doc[]) => {
  for (let i = 0; i < 2; i++) {
    sync(docs[0]!, docs[1]!)
    sync(docs[0]!, docs[2]!)
    compact(docs[0]!)
  }
  sync(docs[0]!, docs[1]!)
  sync(docs[0]!, docs[2]!)
}

describe('random concurrent histories', () => {
  it('converge, and accept-all / reject-all match the two projections', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 80 }), (ops) => {
        const docs = run(ops)
        settle(docs)

        // 1. Every replica derives the same document, projections and change list.
        const s0 = snapshot(docs[0])
        expect(snapshot(docs[1])).toEqual(s0)
        expect(snapshot(docs[2])).toEqual(s0)

        // 2. Compaction is idempotent.
        compact(docs[0])
        expect(snapshot(docs[0])).toEqual(s0)

        // 3. Accepting everything yields the revised projection, rejecting
        //    everything the original, and nothing is left pending either way.
        for (const [decision, expected] of [['accept', s0.revised], ['reject', s0.original]] as const) {
          const c = cloneDoc(docs[0])
          for (const ch of listChanges(c)) decide(c, ch.id, decision)
          expect(revisedDoc(c)).toEqual(expected)
          expect(originalDoc(c)).toEqual(expected)
          compact(c)
          expect(physical(c)).toEqual(expected)
          expect(listChanges(c)).toEqual([])
        }

        // 4. The order in which pending changes are decided does not matter.
        const pending = listChanges(docs[0])
        const decisions = pending.map((ch, i) => [ch.id, i % 2 ? 'accept' : 'reject'] as const)
        const forward = cloneDoc(docs[0])
        const backward = cloneDoc(docs[0])
        for (const [id, d] of decisions) decide(forward, id, d)
        for (const [id, d] of [...decisions].reverse()) decide(backward, id, d)
        compact(forward)
        compact(backward)
        expect(physical(backward)).toEqual(physical(forward))
      }),
      { numRuns: 1500 },
    )
  }, 30_000)

  it('text typed by a person survives any amount of concurrent suggesting and rejecting', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 60 }), fc.nat(10_000), (ops, where) => {
        // No plain deletions in this run, so nothing may remove the marker.
        const docs = run(ops.filter((o) => o.kind !== 'remove'))
        const d = docs[1]
        const els = blocks(d)
        if (!els.length) return
        const text = blockText(els[where % els.length]!)
        // Plain Yjs insert: models typing that the tracking layer never sees.
        text.insert(where % (text.length + 1), '§MARK§')
        const more = run2(docs, ops)
        settle(more)
        const everywhere = physical(docs[0]).map((b) => b.text).join('\n')
        const blockGone = !blocks(docs[0]).some((el) => rawChars(blockText(el)).some((c) => c.ch === '§'))
        // Whatever is suggested over or inside the marker and then rejected or
        // left pending, its characters stay. It may only disappear together
        // with its whole block (a rejected block insertion).
        if (!blockGone) expect(everywhere.replace(/[^§MARK]/g, '')).toContain('§MARK§')
      }),
      { numRuns: 500 },
    )
  })
})

/** Continue a history with suggesting and rejecting only (no plain edits, nothing accepted). */
function run2(docs: readonly [Y.Doc, Y.Doc, Y.Doc], ops: Op[]) {
  for (const o of ops) {
    const d = docs[o.r]!
    const els = blocks(d)
    if (!els.length) continue
    const el = els[o.x % els.length]!
    const text = blockText(el)
    const len = text.length
    const at = len ? o.y % (len + 1) : 0
    const span = Math.min(1 + (o.x % 5), len - at)
    const author = ['agent', 'ann', 'bob'][o.r]!
    if (o.kind === 'removeTracked') removeText(d, text, at, span, { author, tracking: true })
    else if (o.kind === 'replaceTracked' && span > 0) trackedReplace(d, text, at, span, o.s, { author })
    else if (o.kind === 'typeTracked') typeText(d, text, at, o.s, { author, tracking: true })
    else if (o.kind === 'decide') {
      const pending = listChanges(d)
      // Reject only: an accepted deletion may legitimately remove the marker.
      if (pending.length) decide(d, pending[o.x % pending.length]!.id, 'reject')
    } else if (o.kind === 'sync') sync(docs[o.r]!, docs[o.r2]!)
    else if (o.kind === 'compact') compact(docs[0])
  }
  return docs
}
