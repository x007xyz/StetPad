import * as Y from 'yjs'
import { buildIndex, viewBlock, type Classified } from './changes'
import { blockIdOf, blocks, findBlock, idKey, type CharId } from './doc'

/**
 * Comments. A comment is anchored to the item ids of the text it was made on,
 * so it follows that text through any editing. When the text is gone the
 * comment says so instead of pointing somewhere else.
 */
type Range = [client: number, clock: number, len: number]
export const comments = (doc: Y.Doc): Y.Map<Y.Map<unknown>> => doc.getMap('comments')

export interface CommentView {
  id: string
  author: string
  text: string
  createdAt: number
  resolved: boolean
  /** The text commented on, as written at the time. */
  quote: string
  blockId: string | null
  /** True when none of the anchored text exists any more. */
  orphaned: boolean
  replies: { author: string; text: string; createdAt: number }[]
}

const toRanges = (ids: CharId[]): Range[] => {
  const out: Range[] = []
  for (const id of ids) {
    const last = out[out.length - 1]
    if (last && last[0] === id.client && last[1] + last[2] === id.clock) last[2]++
    else out.push([id.client, id.clock, 1])
  }
  return out
}
const live = (c: Classified): boolean => !c.removed && c.del.length === 0

export function addComment(
  doc: Y.Doc,
  anchor: { ids: CharId[]; quote: string; blockId: string | null },
  author: string,
  text: string,
): string {
  const id = globalThis.crypto.randomUUID()
  doc.transact(() => {
    const c = new Y.Map<unknown>()
    comments(doc).set(id, c)
    c.set('author', author)
    c.set('text', text)
    c.set('createdAt', Date.now())
    c.set('quote', anchor.quote)
    c.set('blockId', anchor.blockId)
    const arr = new Y.Array<Range>()
    c.set('anchor', arr)
    arr.push(toRanges(anchor.ids))
    c.set('replies', new Y.Array())
  })
  return id
}

/** Comment on a block, or on a phrase inside it (first occurrence in the revised text). */
export function commentOnBlock(doc: Y.Doc, blockId: string, quote: string | undefined, author: string, text: string): string | null {
  const el = findBlock(doc, blockId)
  if (!el) return null
  const chars = viewBlock(doc, el).filter(live)
  const full = chars.map((c) => c.ch).join('')
  let picked = chars
  let q = full
  if (quote) {
    const at = full.indexOf(quote)
    if (at < 0) return null
    picked = chars.slice(at, at + quote.length)
    q = quote
  }
  return addComment(doc, { ids: picked, quote: q.slice(0, 300), blockId }, author, text)
}

/** Add items to a comment's anchor: used when the anchored text is moved and gets new ids. */
export function extendCommentAnchor(doc: Y.Doc, id: string, ids: CharId[]): void {
  const arr = comments(doc).get(id)?.get('anchor') as Y.Array<Range> | undefined
  if (arr && ids.length) arr.push(toRanges(ids))
}

export function replyToComment(doc: Y.Doc, id: string, author: string, text: string): boolean {
  const c = comments(doc).get(id)
  if (!c) return false
  ;(c.get('replies') as Y.Array<unknown>).push([{ author, text, createdAt: Date.now() }])
  return true
}
export const resolveComment = (doc: Y.Doc, id: string, resolved = true): void => {
  comments(doc).get(id)?.set('resolved', resolved)
}
export const deleteComment = (doc: Y.Doc, id: string): void => {
  comments(doc).delete(id)
}

/** Ids that open comments are anchored to: `client:clock` -> comment ids. */
export function commentIndex(doc: Y.Doc): Map<string, string[]> {
  const out = new Map<string, string[]>()
  comments(doc).forEach((c, id) => {
    if (c.get('resolved')) return
    for (const [client, clock, len] of (c.get('anchor') as Y.Array<Range>).toArray()) {
      for (let i = 0; i < len; i++) {
        const k = idKey(client, clock + i)
        out.set(k, [...(out.get(k) ?? []), id])
      }
    }
  })
  return out
}

export function listComments(doc: Y.Doc): CommentView[] {
  const idx = buildIndex(doc)
  const alive = new Map<string, string>() // id key -> block id
  for (const el of blocks(doc)) {
    for (const c of viewBlock(doc, el, idx)) if (!c.removed) alive.set(idKey(c.client, c.clock), blockIdOf(el))
  }
  const out: CommentView[] = []
  comments(doc).forEach((c, id) => {
    let blockId: string | null = null
    for (const [client, clock, len] of (c.get('anchor') as Y.Array<Range>).toArray()) {
      for (let i = 0; i < len && !blockId; i++) blockId = alive.get(idKey(client, clock + i)) ?? null
    }
    out.push({
      id,
      author: String(c.get('author')),
      text: String(c.get('text')),
      createdAt: Number(c.get('createdAt')),
      resolved: !!c.get('resolved'),
      quote: String(c.get('quote') ?? ''),
      blockId,
      orphaned: blockId === null,
      replies: (c.get('replies') as Y.Array<{ author: string; text: string; createdAt: number }>).toArray(),
    })
  })
  return out.sort((a, b) => a.createdAt - b.createdAt)
}
