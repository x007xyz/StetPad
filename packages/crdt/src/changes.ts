import * as Y from 'yjs'
import {
  blockIdOf,
  blocks,
  blockText,
  blockTexts,
  changes,
  content,
  elementId,
  idKey,
  rawChars,
  type ChangeRecord,
  type CharId,
} from './doc'

/**
 * Tracked changes as id sets.
 *
 * A change record lists the Yjs item ids it inserted (`ins`) and the ids it
 * proposes to delete (`del`). Text proposed for deletion stays in the document
 * until the change is accepted, so it keeps its identity. Nothing is stored as
 * a text format: a range format would also cover text that someone else
 * inserts into the range concurrently, and overlapping formats overwrite each
 * other (both verified against Yjs 13.6, see test/yjs-formats.test.ts).
 *
 * Accepting or rejecting only writes `decision` on the record. Physical
 * removal is done by `compact`, which must run on a single replica per
 * document (the server). Without that split, one replica accepting a
 * replacement while another rejects it deletes both the old and the new text.
 */

export type Decision = 'accept' | 'reject'
export type Status = 'pending' | Decision
type Range = [client: number, clock: number, len: number]

export interface Meta {
  author: string
  runId?: string
  reason?: string
}

export const newChangeId = (): string => globalThis.crypto.randomUUID()

export function ensureRecord(doc: Y.Doc, id: string, meta: Meta): ChangeRecord {
  const all = changes(doc)
  const existing = all.get(id)
  if (existing) return existing
  const rec: ChangeRecord = new Y.Map()
  all.set(id, rec)
  rec.set('author', meta.author)
  if (meta.runId) rec.set('runId', meta.runId)
  if (meta.reason) rec.set('reason', meta.reason)
  rec.set('createdAt', Date.now())
  rec.set('ins', new Y.Array<Range>())
  rec.set('del', new Y.Array<Range>())
  return rec
}

function addRange(rec: ChangeRecord, side: 'ins' | 'del', range: Range): void {
  ;(rec.get(side) as Y.Array<Range>).push([range])
}

/** Collapse a list of ids into ranges of consecutive clocks. */
function toRanges(ids: CharId[]): Range[] {
  const out: Range[] = []
  for (const id of ids) {
    const last = out[out.length - 1]
    if (last && last[0] === id.client && last[1] + last[2] === id.clock) last[2]++
    else out.push([id.client, id.clock, 1])
  }
  return out
}

const statusOf = (rec: ChangeRecord, settledOnly: boolean): Status =>
  ((settledOnly ? rec.get('settled') : (rec.get('settled') ?? rec.get('decision'))) as
    | Decision
    | undefined) ?? 'pending'

export interface Index {
  ins: Map<string, string[]>
  del: Map<string, string[]>
  status: Map<string, Status>
}

/**
 * Per-item lookup of the changes that touch it.
 * Prototype implementation: expands every range to single ids.
 */
export function buildIndex(doc: Y.Doc, settledOnly = false): Index {
  const idx: Index = { ins: new Map(), del: new Map(), status: new Map() }
  changes(doc).forEach((rec, id) => {
    idx.status.set(id, statusOf(rec, settledOnly))
    for (const side of ['ins', 'del'] as const) {
      const arr = rec.get(side) as Y.Array<Range> | undefined
      if (!arr) continue
      for (const [client, clock, len] of arr.toArray()) {
        for (let i = 0; i < len; i++) {
          const k = idKey(client, clock + i)
          const list = idx[side].get(k)
          if (list) list.push(id)
          else idx[side].set(k, [id])
        }
      }
    }
  })
  return idx
}

export interface Classified {
  /** Hidden in every view: a rejected insertion or an accepted deletion. */
  removed: boolean
  /** Pending changes that inserted this item. */
  ins: string[]
  /** Pending changes that propose deleting this item. */
  del: string[]
}

export function classify(idx: Index, id: CharId): Classified {
  const k = idKey(id.client, id.clock)
  const out: Classified = { removed: false, ins: [], del: [] }
  for (const c of idx.ins.get(k) ?? []) {
    const s = idx.status.get(c)
    if (s === 'reject') out.removed = true
    else if (s === 'pending') out.ins.push(c)
  }
  for (const c of idx.del.get(k) ?? []) {
    const s = idx.status.get(c)
    if (s === 'accept') out.removed = true
    else if (s === 'pending') out.del.push(c)
  }
  return out
}

export interface CharView extends CharId, Classified {
  ch: string
  /** Where the character is right now. */
  text: Y.Text
  index: number
}

export function viewText(doc: Y.Doc, text: Y.Text, idx = buildIndex(doc)): CharView[] {
  return rawChars(text).map((c, index) => ({ ...c, ...classify(idx, c), text, index }))
}

/** Every character of a block, across all of its text nodes. */
export function viewBlock(doc: Y.Doc, el: Y.XmlElement, idx = buildIndex(doc)): CharView[] {
  return blockTexts(el).flatMap((t) => viewText(doc, t, idx))
}

const inRevised = (c: Classified): boolean => !c.removed && c.del.length === 0
const inOriginal = (c: Classified): boolean => !c.removed && c.ins.length === 0

export const revisedText = (doc: Y.Doc, text: Y.Text, idx = buildIndex(doc)): string =>
  viewText(doc, text, idx).filter(inRevised).map((c) => c.ch).join('')

export const originalText = (doc: Y.Doc, text: Y.Text, idx = buildIndex(doc)): string =>
  viewText(doc, text, idx).filter(inOriginal).map((c) => c.ch).join('')

export interface BlockProjection {
  blockId: string
  text: string
}

function projectDoc(doc: Y.Doc, keep: (c: Classified) => boolean): BlockProjection[] {
  const idx = buildIndex(doc)
  const out: BlockProjection[] = []
  for (const el of blocks(doc)) {
    if (!keep(classify(idx, elementId(el)))) continue
    const text = viewBlock(doc, el, idx).filter(keep).map((c) => c.ch).join('')
    out.push({ blockId: blockIdOf(el), text })
  }
  return out
}

/** The document with every pending change accepted. */
export const revisedDoc = (doc: Y.Doc): BlockProjection[] => projectDoc(doc, inRevised)
/** The document with every pending change rejected. */
export const originalDoc = (doc: Y.Doc): BlockProjection[] => projectDoc(doc, inOriginal)

export interface PendingChange {
  id: string
  author: string
  runId?: string
  reason?: string
  inserted: string
  deleted: string
  insertedBlocks: string[]
  deletedBlocks: string[]
}

/**
 * Pending changes, derived from the items that still exist. A record whose
 * items are all gone does not appear, so the list never needs repairing.
 */
export function listChanges(doc: Y.Doc): PendingChange[] {
  const idx = buildIndex(doc)
  const found = new Map<string, PendingChange>()
  const get = (id: string): PendingChange => {
    let c = found.get(id)
    if (!c) {
      const rec = changes(doc).get(id)!
      c = {
        id,
        author: rec.get('author') as string,
        runId: rec.get('runId') as string | undefined,
        reason: rec.get('reason') as string | undefined,
        inserted: '',
        deleted: '',
        insertedBlocks: [],
        deletedBlocks: [],
      }
      found.set(id, c)
    }
    return c
  }
  for (const el of blocks(doc)) {
    const b = classify(idx, elementId(el))
    if (b.removed) continue
    for (const id of b.ins) get(id).insertedBlocks.push(blockIdOf(el))
    for (const id of b.del) get(id).deletedBlocks.push(blockIdOf(el))
    for (const c of viewBlock(doc, el, idx)) {
      if (c.removed) continue
      for (const id of c.ins) get(id).inserted += c.ch
      for (const id of c.del) get(id).deleted += c.ch
    }
  }
  return [...found.values()]
}

/** Delete the characters at the given Y.Text indices (any order). */
function deleteIndices(text: Y.Text, indices: number[]): void {
  const sorted = [...new Set(indices)].sort((a, b) => b - a)
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! - 1) j++
    text.delete(sorted[j]!, j - i + 1)
    i = j + 1
  }
}

export interface TrackOptions {
  /** Reuse a record, e.g. to make a deletion and an insertion one replacement. */
  changeId?: string
}

/** Insert text and record it as a pending insertion. Returns the change id. */
export function trackedInsert(
  doc: Y.Doc,
  text: Y.Text,
  index: number,
  str: string,
  meta: Meta,
  opts: TrackOptions = {},
): string | null {
  if (!str) return null
  const id = opts.changeId ?? newChangeId()
  doc.transact(() => {
    const clock = Y.getState(doc.store, doc.clientID)
    text.insert(index, str)
    addRange(ensureRecord(doc, id, meta), 'ins', [doc.clientID, clock, str.length])
  })
  return id
}

/**
 * Propose deleting the given characters.
 * - the author's own pending insertions are simply removed (the suggestion shrinks)
 * - text that is already pending deletion is left as it is
 * - everything else stays in the document and is listed in the record
 */
export function trackDeleteChars(
  doc: Y.Doc,
  chars: CharView[],
  meta: Meta,
  opts: TrackOptions = {},
): string | null {
  if (chars.length === 0) return opts.changeId ?? null
  const id = opts.changeId ?? newChangeId()
  let used = false
  doc.transact(() => {
    const own = new Map<Y.Text, number[]>()
    const mark: CharId[] = []
    for (const c of chars) {
      if (c.removed || c.del.length > 0) continue
      const ownInsert = c.ins.some((ch) => changes(doc).get(ch)?.get('author') === meta.author)
      if (ownInsert) own.set(c.text, [...(own.get(c.text) ?? []), c.index])
      else mark.push({ client: c.client, clock: c.clock })
    }
    if (mark.length > 0) {
      const rec = ensureRecord(doc, id, meta)
      for (const r of toRanges(mark)) addRange(rec, 'del', r)
      used = true
    }
    for (const [text, indices] of own) deleteIndices(text, indices)
  })
  return used || opts.changeId ? id : null
}

/** Propose deleting `len` characters at `index` of one text node. */
export function trackedDelete(
  doc: Y.Doc,
  text: Y.Text,
  index: number,
  len: number,
  meta: Meta,
  opts: TrackOptions = {},
): string | null {
  if (len <= 0) return null
  return trackDeleteChars(doc, viewText(doc, text).slice(index, index + len), meta, opts)
}

/** A deletion and an insertion that are accepted or rejected together. */
export function trackedReplace(
  doc: Y.Doc,
  text: Y.Text,
  index: number,
  len: number,
  str: string,
  meta: Meta,
): string {
  const id = newChangeId()
  doc.transact(() => {
    // Insert first: it sits after the range, so the range indices stay valid.
    trackedInsert(doc, text, index + len, str, meta, { changeId: id })
    trackedDelete(doc, text, index, len, meta, { changeId: id })
  })
  return id
}

export interface TypingContext {
  author: string
  /** True when this author's edits are recorded as suggestions. */
  tracking: boolean
}

/**
 * What the editor does when a person types.
 * Tracking on: extends the author's own pending insertion to the left, or starts one.
 * Tracking off: text typed strictly inside a pending insertion joins it; otherwise plain.
 */
export function typeText(
  doc: Y.Doc,
  text: Y.Text,
  index: number,
  str: string,
  ctx: TypingContext,
): void {
  if (!str) return
  doc.transact(() => {
    const view = viewText(doc, text)
    const left = view[index - 1]
    const right = view[index]
    const recs = changes(doc)
    let join: string | undefined
    if (ctx.tracking) {
      join = left?.ins.find((c) => recs.get(c)?.get('author') === ctx.author)
    } else if (left && right) {
      join = left.ins.find((c) => right.ins.includes(c))
    }
    if (join || ctx.tracking) {
      trackedInsert(doc, text, index, str, { author: ctx.author }, { changeId: join })
    } else {
      text.insert(index, str)
    }
  })
}

/**
 * What the editor does when a person deletes.
 * Tracking off: removes the text, except text that is pending deletion or
 * already decided, which is not editable.
 */
export function removeText(
  doc: Y.Doc,
  text: Y.Text,
  index: number,
  len: number,
  ctx: TypingContext,
): void {
  if (len <= 0) return
  if (ctx.tracking) {
    trackedDelete(doc, text, index, len, { author: ctx.author })
    return
  }
  doc.transact(() => {
    const view = viewText(doc, text).slice(index, index + len)
    const victims: number[] = []
    view.forEach((c, i) => {
      if (!c.removed && c.del.length === 0) victims.push(index + i)
    })
    deleteIndices(text, victims)
  })
}

/** Propose a new block. */
export function trackedInsertBlock(
  doc: Y.Doc,
  index: number,
  blockId: string,
  str: string,
  meta: Meta,
  opts: TrackOptions & { type?: string; attrs?: Record<string, unknown> } = {},
): string {
  const id = opts.changeId ?? newChangeId()
  doc.transact(() => {
    const frag = content(doc)
    const el = new Y.XmlElement(opts.type ?? 'paragraph')
    frag.insert(Math.min(index, frag.length), [el])
    el.setAttribute('blockId', blockId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const [k, v] of Object.entries(opts.attrs ?? {})) el.setAttribute(k, v as any)
    const t = new Y.XmlText()
    el.insert(0, [t])
    if (str) t.insert(0, str)
    const e = elementId(el)
    addRange(ensureRecord(doc, id, meta), 'ins', [e.client, e.clock, 1])
  })
  return id
}

/** Propose deleting a block. The block stays editable until the change is accepted. */
export function trackedDeleteBlock(
  doc: Y.Doc,
  el: Y.XmlElement,
  meta: Meta,
  opts: TrackOptions = {},
): string | null {
  const idx = buildIndex(doc)
  const c = classify(idx, elementId(el))
  if (c.removed || c.del.length > 0) return null
  const id = opts.changeId ?? newChangeId()
  doc.transact(() => {
    const e = elementId(el)
    addRange(ensureRecord(doc, id, meta), 'del', [e.client, e.clock, 1])
  })
  return id
}

/**
 * Accept or reject a change. Only records the decision; the document text is
 * untouched until `compact` runs. Every view honours the decision at once.
 */
export function decide(doc: Y.Doc, changeId: string, decision: Decision): boolean {
  const rec = changes(doc).get(changeId)
  if (!rec || rec.get('settled')) return false
  rec.set('decision', decision)
  return true
}

/** What a change looked like when it was decided. Kept because compaction deletes the text. */
export interface DecidedChange {
  id: string
  author: string
  runId?: string
  reason?: string
  inserted: string
  deleted: string
  insertedBlocks: string[]
  deletedBlocks: string[]
  decision: Decision
  at: number
}

const decidedLog = (doc: Y.Doc): Y.Map<DecidedChange> => doc.getMap('decidedLog')

export function listDecided(doc: Y.Doc): DecidedChange[] {
  return [...decidedLog(doc).values()].sort((a, b) => a.at - b.at)
}

/** Decide the given pending changes and keep a readable snapshot of each in the log. */
export function decideAndLog(
  doc: Y.Doc,
  pending: PendingChange[],
  ids: string[],
  decision: Decision,
  blockText: (blockId: string) => string,
): void {
  const byId = new Map(pending.map((c) => [c.id, c]))
  doc.transact(() => {
    for (const id of ids) {
      if (!decide(doc, id, decision)) continue
      const c = byId.get(id)
      if (!c) continue
      const entry: DecidedChange = {
        id,
        author: c.author,
        inserted: c.inserted,
        deleted: c.deleted,
        insertedBlocks: c.insertedBlocks.map(blockText),
        deletedBlocks: c.deletedBlocks.map(blockText),
        decision,
        at: Date.now(),
      }
      if (c.runId) entry.runId = c.runId
      if (c.reason) entry.reason = c.reason
      decidedLog(doc).set(id, entry)
    }
  })
}

/**
 * Make decisions permanent and physically remove what they hide.
 * Must run on exactly one replica per document. Idempotent, so it also cleans
 * up items that reach the server after their change was settled.
 */
export function compact(doc: Y.Doc): void {
  doc.transact(() => {
    changes(doc).forEach((rec) => {
      const d = rec.get('decision')
      if (d && !rec.get('settled')) rec.set('settled', d)
    })
    const idx = buildIndex(doc, true)
    const frag = content(doc)
    const els = blocks(doc)
    for (let i = frag.length - 1; i >= 0; i--) {
      const node = frag.get(i)
      if (!(node instanceof Y.XmlElement) || !els.includes(node)) continue
      if (classify(idx, elementId(node)).removed) {
        frag.delete(i, 1)
        continue
      }
      for (const text of blockTexts(node)) {
        const victims: number[] = []
        rawChars(text).forEach((c, k) => {
          if (classify(idx, c).removed) victims.push(k)
        })
        deleteIndices(text, victims)
      }
    }
  }, 'compactor')
}

/** Add items to a change. Used by the editor binding, which learns ids after the fact. */
export function addToChange(
  doc: Y.Doc,
  changeId: string,
  side: 'ins' | 'del',
  ids: CharId[],
  meta: Meta,
): void {
  if (ids.length === 0) return
  doc.transact(() => {
    const rec = ensureRecord(doc, changeId, meta)
    for (const r of toRanges(ids)) addRange(rec, side, r)
  })
}

export interface RichBlock {
  blockId: string
  type: string
  attrs: Record<string, unknown>
  text: string
  /** Rich text runs (text plus formatting marks) for the same projection. */
  delta: { insert: string; attributes?: Record<string, unknown> }[]
  /** Pending state of the block itself. */
  state: 'plain' | 'ins' | 'del'
}

export type Projection = 'revised' | 'original' | 'physical'

/** Blocks of one projection, with type, attributes and formatting. */
export function projectBlocks(doc: Y.Doc, mode: Projection): RichBlock[] {
  const idx = buildIndex(doc)
  const keep = (c: Classified): boolean =>
    mode === 'revised' ? inRevised(c) : mode === 'original' ? inOriginal(c) : !c.removed
  const out: RichBlock[] = []
  for (const el of blocks(doc)) {
    const bc = classify(idx, elementId(el))
    if (!keep(bc)) continue
    const delta: RichBlock['delta'] = []
    for (const t of blockTexts(el)) {
      const view = viewText(doc, t, idx)
      let i = 0
      for (const op of t.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
        if (typeof op.insert !== 'string') continue
        let run = ''
        for (const ch of op.insert) {
          for (let k = 0; k < ch.length; k++) {
            const c = view[i++]
            if (c && keep(c)) run += ch[k]
          }
        }
        if (!run) continue
        const last = delta[delta.length - 1]
        if (last && JSON.stringify(last.attributes ?? {}) === JSON.stringify(op.attributes ?? {})) last.insert += run
        else delta.push(op.attributes ? { insert: run, attributes: op.attributes } : { insert: run })
      }
    }
    const { blockId: _b, ...attrs } = el.getAttributes() as Record<string, unknown>
    out.push({
      blockId: blockIdOf(el),
      type: el.nodeName,
      attrs,
      text: delta.map((d) => d.insert).join(''),
      delta,
      state: bc.del.length ? 'del' : bc.ins.length ? 'ins' : 'plain',
    })
  }
  return out
}

/** Pending change ids that touch a block (its text or the block itself). */
export function changesInBlock(doc: Y.Doc, el: Y.XmlElement): string[] {
  const idx = buildIndex(doc)
  const ids = new Set<string>()
  const b = classify(idx, elementId(el))
  for (const id of [...b.ins, ...b.del]) ids.add(id)
  for (const c of viewBlock(doc, el, idx)) {
    if (c.removed) continue
    for (const id of [...c.ins, ...c.del]) ids.add(id)
  }
  return [...ids]
}
