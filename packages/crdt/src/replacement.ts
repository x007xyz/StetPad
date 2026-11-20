import type * as Y from 'yjs'
import { addToChange, viewBlock, type CharView } from './changes'
import { commentIndex, extendCommentAnchor } from './comments'
import { blockText, changes, findBlock, idKey, rawChars, type ChangeRecord } from './doc'
import { diffWords } from './diff'

interface Replacement {
  source: string
  target: string
  pairs: [string, string | null][]
  boundaries: [string, string | null][]
}

const key = (c: { client: number; clock: number }): string => idKey(c.client, c.clock)

/** Keep the identity correspondence so later human edits can be rebased at settlement. */
export function trackReplacement(doc: Y.Doc, changeId: string, source: string, target: string): void {
  const before = viewBlock(doc, findBlock(doc, source)!).filter((c) => !c.removed && !c.del.length)
  const after = viewBlock(doc, findBlock(doc, target)!)
  const pairs: Replacement['pairs'] = []
  const boundaries: Replacement['boundaries'] = []
  let deleted: string[] = []
  const anchors = commentIndex(doc, true)
  let a = 0
  let b = 0
  const finishDeletion = (): void => {
    const preceding = b ? key(after[b - 1]!) : null
    for (const id of deleted) boundaries.push([id, preceding])
    deleted = []
  }
  for (const op of diffWords(before.map((c) => c.ch).join(''), after.map((c) => c.ch).join(''))) {
    if (op.type === 'equal') finishDeletion()
    for (let i = 0; i < op.text.length; i++) {
      if (op.type === 'insert') { b++; continue }
      const old = before[a++]!
      const next = op.type === 'equal' ? after[b++]! : null
      pairs.push([key(old), next ? key(next) : null])
      if (!next) deleted.push(key(old))
      if (next) for (const id of anchors.get(key(old)) ?? []) extendCommentAnchor(doc, id, [next])
    }
  }
  finishDeletion()
  changes(doc).get(changeId)!.set('replacement', { source, target, pairs, boundaries } satisfies Replacement)
}

/** Transfer edits by identity, not by matching text that may occur more than once. */
export function mergeReplacement(doc: Y.Doc, rec: ChangeRecord): void {
  const replacement = rec.get('replacement') as Replacement | undefined
  if (!replacement) return
  const source = findBlock(doc, replacement.source)
  const target = findBlock(doc, replacement.target)
  if (!source || !target) return
  const current = viewBlock(doc, source).filter((c) => !c.removed)
  const alive = new Set(current.map(key))
  const mapping = new Map(replacement.pairs)
  const boundaries = new Map(replacement.boundaries)
  const text = blockText(target)
  const deleted = new Set(replacement.pairs.filter(([id]) => !alive.has(id)).map(([, id]) => id))
  const chars = rawChars(text)
  for (let i = chars.length - 1; i >= 0; i--) if (deleted.has(key(chars[i]!))) text.delete(i, 1)
  const anchors = commentIndex(doc, true)
  const carryChanges = (source: CharView, target: { client: number; clock: number }): void => {
    for (const side of ['ins', 'del'] as const) {
      for (const change of source[side]) {
        const existing = viewBlock(doc, targetBlock).find((c) => key(c) === key(target))
        if (!existing?.[side].includes(change)) {
          addToChange(doc, change, side, [target], { author: String(changes(doc).get(change)!.get('author')) })
        }
      }
    }
  }
  const targetBlock = target
  let at = 0
  for (let i = 0; i < current.length; i++) {
    const c = current[i]!
    const id = key(c)
    if (mapping.has(id)) {
      const pos = rawChars(text).findIndex((ch) => key(ch) === mapping.get(id))
      if (pos >= 0) {
        at = pos + 1
        carryChanges(c, rawChars(text)[pos]!)
      } else if (boundaries.has(id)) {
        const boundary = rawChars(text).findIndex((ch) => key(ch) === boundaries.get(id))
        at = Math.max(at, boundary + 1)
      }
      continue
    }
    // At the start, retain any proposal-only prefix before the next shared character.
    if (at === 0) {
      const next = current.slice(i + 1).map((ch) => mapping.get(key(ch))).find((k) => k != null)
      const pos = rawChars(text).findIndex((ch) => key(ch) === next)
      if (pos >= 0) at = pos
    }
    let offset = 0
    let attrs: Record<string, unknown> = {}
    for (const run of c.text.toDelta()) {
      const len = typeof run.insert === 'string' ? run.insert.length : 1
      if (c.index < offset + len) { attrs = run.attributes ?? {}; break }
      offset += len
    }
    text.insert(at, c.ch, attrs)
    const inserted = rawChars(text)[at++]!
    carryChanges(c, inserted)
    mapping.set(id, key(inserted))
    for (const comment of anchors.get(id) ?? []) extendCommentAnchor(doc, comment, [inserted])
  }
  rec.set('replacement', { ...replacement, pairs: [...mapping].filter(([id]) => alive.has(id)) } satisfies Replacement)
}
