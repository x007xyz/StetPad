import * as Y from 'yjs'

/**
 * Document layout inside one Y.Doc. The `content` fragment has the same shape
 * y-prosemirror produces (block elements holding one XmlText), so the editor
 * binding and this package read and write the same structure.
 */
export const content = (doc: Y.Doc): Y.XmlFragment => doc.getXmlFragment('content')

/** Every block type a document may hold. The server keeps only these, and both editors must render each one. */
export const BLOCK_TYPES = [
  'paragraph', 'heading', 'bulletItem', 'orderedItem', 'taskItem',
  'quote', 'callout', 'codeBlock', 'divider', 'image', 'video', 'drawio', 'table', 'file', 'linkCard',
] as const
/** Block types without text content. */
export const ATOM_BLOCK_TYPES: ReadonlySet<string> = new Set(['divider', 'image', 'video', 'drawio', 'table', 'file', 'linkCard'])

export type ChangeRecord = Y.Map<unknown>
export const changes = (doc: Y.Doc): Y.Map<ChangeRecord> => doc.getMap('changes')

export interface CharId {
  client: number
  clock: number
}

export interface RawChar extends CharId {
  ch: string
}

export const idKey = (client: number, clock: number): string => `${client}:${clock}`

/**
 * Every character of a Y.Text that has not been physically deleted, with the
 * Yjs item id of that character. Array position equals the Y.Text index.
 *
 * Reads Yjs item internals (`_start`, `right`, `id`, `content.str`), the same
 * fields y-prosemirror relies on. Ids are per UTF-16 code unit and never change.
 */
export function rawChars(text: Y.Text): RawChar[] {
  const out: RawChar[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let item: any = (text as any)._start
  while (item) {
    if (!item.deleted && typeof item.content?.str === 'string') {
      const s: string = item.content.str
      for (let i = 0; i < s.length; i++) {
        out.push({ ch: s[i]!, client: item.id.client, clock: item.id.clock + i })
      }
    }
    item = item.right
  }
  return out
}

/** Item id of a block element (its identity for block-level changes). */
export function elementId(el: Y.XmlElement): CharId {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const id = (el as any)._item.id
  return { client: id.client, clock: id.clock }
}

export function blocks(doc: Y.Doc): Y.XmlElement[] {
  return content(doc)
    .toArray()
    .filter((n): n is Y.XmlElement => n instanceof Y.XmlElement)
}

/** The text nodes of a block. An empty paragraph made by the editor has none. */
export function blockTexts(el: Y.XmlElement): Y.XmlText[] {
  return el.toArray().filter((n): n is Y.XmlText => n instanceof Y.XmlText)
}

/** The first text node of a block, created if the block has none. */
export function blockText(el: Y.XmlElement): Y.XmlText {
  const existing = blockTexts(el)[0]
  if (existing) return existing
  const t = new Y.XmlText()
  el.insert(0, [t])
  return t
}

export const blockIdOf = (el: Y.XmlElement): string => String(el.getAttribute('blockId'))

export function findBlock(doc: Y.Doc, blockId: string): Y.XmlElement | undefined {
  return blocks(doc).find((el) => blockIdOf(el) === blockId)
}

/** Plain (untracked) block insertion. Returns the new element. */
export function insertBlock(
  doc: Y.Doc,
  index: number,
  blockId: string,
  text = '',
  type = 'paragraph',
  attrs: Record<string, unknown> = {},
  marks?: { insert: string; attributes?: Record<string, unknown> }[],
): Y.XmlElement {
  const frag = content(doc)
  const el = new Y.XmlElement(type)
  doc.transact(() => {
    frag.insert(Math.min(index, frag.length), [el])
    el.setAttribute('blockId', blockId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v as any)
    if (!text && !marks?.length) return
    const t = new Y.XmlText()
    el.insert(0, [t])
    if (marks?.length) t.applyDelta(marks)
    else t.insert(0, text)
  })
  return el
}

/** Exchange all missing updates between two replicas. */
export function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}

export function cloneDoc(doc: Y.Doc): Y.Doc {
  const c = new Y.Doc()
  Y.applyUpdate(c, Y.encodeStateAsUpdate(doc))
  return c
}

export const newBlockId = (): string => 'b_' + Math.random().toString(36).slice(2, 10)

export const blockIndex = (doc: Y.Doc, el: Y.XmlElement): number => content(doc).toArray().indexOf(el)
