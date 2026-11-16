import * as Y from 'yjs'
import {
  buildIndex,
  newChangeId,
  trackDeleteChars,
  trackedInsert,
  viewBlock,
  type CharView,
  type Meta,
} from './changes'
import { diffWords, toEdits, type Edit } from './diff'
import { blockText, findBlock, idKey, type CharId } from './doc'

/**
 * What an agent saw when it read a block: the revised text, and the item id
 * behind every character of it. Proposals are anchored to these ids, so they
 * follow the text through any concurrent editing.
 */
export interface Baseline {
  blockId: string
  text: string
  ids: CharId[]
}

export function readBlock(doc: Y.Doc, blockId: string): Baseline | null {
  const el = findBlock(doc, blockId)
  if (!el) return null
  const visible = viewBlock(doc, el).filter((c) => !c.removed && c.del.length === 0)
  return {
    blockId,
    text: visible.map((c) => c.ch).join(''),
    ids: visible.map(({ client, clock }) => ({ client, clock })),
  }
}

export interface ProposalResult {
  applied: { changeId: string; edit: Edit }[]
  /** Edits that were not applied because the text they target has changed. */
  failed: { edit: Edit; reason: string }[]
  /** The block as it reads now, for the agent to retry against. */
  currentText: string
}

/**
 * Propose new content for a block the agent read earlier.
 *
 * The difference between what the agent read and what it now proposes is
 * split into small edits. Each edit is applied only if the exact characters
 * it replaces are still there, untouched and uninterrupted; edits elsewhere in
 * the block by other people do not matter. A person's text is never overwritten.
 */
export function proposeReplace(
  doc: Y.Doc,
  base: Baseline,
  newText: string,
  meta: Meta,
): ProposalResult {
  const result: ProposalResult = { applied: [], failed: [], currentText: '' }
  const el = findBlock(doc, base.blockId)
  if (!el) {
    result.failed.push({ edit: { start: 0, end: base.text.length, insert: newText }, reason: 'block no longer exists' })
    return result
  }
  const edits = toEdits(diffWords(base.text, newText))

  doc.transact(() => {
    // Later edits first, so the positions of earlier ones stay valid.
    for (const edit of [...edits].reverse()) {
      const view = viewBlock(doc, el, buildIndex(doc))
      const at = locate(view, base, edit)
      if (typeof at === 'string') {
        result.failed.push({ edit, reason: at })
        continue
      }
      const changeId = newChangeId()
      // Insert first: it goes after the target characters, so their indices hold.
      if (edit.insert) {
        const anchor = at.anchor ?? { text: blockText(el), index: 0 }
        trackedInsert(doc, anchor.text, anchor.index, edit.insert, meta, { changeId })
      }
      trackDeleteChars(doc, at.chars, meta, { changeId })
      result.applied.push({ changeId, edit })
    }
  })
  result.applied.reverse()
  result.failed.reverse()
  result.currentText = viewBlock(doc, el)
    .filter(live)
    .map((c) => c.ch)
    .join('')
  return result
}

const live = (c: CharView | undefined): c is CharView => !!c && !c.removed && c.del.length === 0

interface Landing {
  /** The characters the edit replaces, as they are now. */
  chars: CharView[]
  /** Where new text goes. Absent only when the block has no text node yet. */
  anchor?: { text: Y.Text; index: number }
}

/** Where an edit lands in the current text, or the reason it cannot be applied. */
function locate(view: CharView[], base: Baseline, edit: Edit): Landing | string {
  const pos = new Map<string, number>()
  view.forEach((c, i) => pos.set(idKey(c.client, c.clock), i))
  const indexOf = (offset: number): number | undefined => {
    const id = base.ids[offset]
    return id ? pos.get(idKey(id.client, id.clock)) : undefined
  }
  const after = (c: CharView) => ({ text: c.text, index: c.index + 1 })
  const before = (c: CharView) => ({ text: c.text, index: c.index })

  if (edit.end > edit.start) {
    const first = indexOf(edit.start)
    const last = indexOf(edit.end - 1)
    if (first === undefined || last === undefined) return 'the text to replace was deleted'
    // Between the first and last target character, the live characters must
    // be exactly the targets, in order: nothing removed, nothing typed inside.
    let expect = edit.start
    for (let i = first; i <= last; i++) {
      const c = view[i]!
      if (!live(c)) continue
      const want = base.ids[expect]
      if (expect >= edit.end || !want || want.client !== c.client || want.clock !== c.clock) {
        return 'the text to replace was edited'
      }
      expect++
    }
    if (expect !== edit.end) return 'the text to replace was edited'
    return { chars: view.slice(first, last + 1), anchor: after(view[last]!) }
  }

  // Pure insertion: anchor to a surviving neighbour.
  const left = edit.start > 0 ? indexOf(edit.start - 1) : undefined
  if (left !== undefined && live(view[left])) return { chars: [], anchor: after(view[left]!) }
  const right = indexOf(edit.start)
  if (right !== undefined && live(view[right])) return { chars: [], anchor: before(view[right]!) }
  if (base.ids.length === 0) {
    const end = view[view.length - 1]
    return { chars: [], anchor: end ? after(end) : undefined }
  }
  return 'the surrounding text was deleted'
}
