/**
 * Footnotes are a text format: a run of characters carries
 * `footnote: { id, note }`. Nothing is stored about numbers. The number of a
 * footnote is its position among the footnotes of the document, in reading
 * order, counted once per id. Every reader (editor, exports, agent) uses this
 * module so that they agree.
 */

export interface FootnoteAttr {
  id: string
  note: string
}

export interface FootnoteRunLike {
  insert: string
  attributes?: Record<string, unknown>
}

export interface FootnoteBlockLike {
  delta: FootnoteRunLike[]
}

export interface FootnoteInfo {
  id: string
  note: string
  /** 1-based, in order of first occurrence. */
  number: number
  /** The annotated text, all runs of this id joined. */
  phrase: string
}

/** The footnote attribute of a run, if it is well formed. */
export function footnoteAttr(attributes: Record<string, unknown> | undefined): FootnoteAttr | null {
  const v = attributes?.footnote as { id?: unknown; note?: unknown } | undefined
  if (!v || typeof v !== 'object') return null
  if (typeof v.id !== 'string' || !v.id) return null
  return { id: v.id, note: typeof v.note === 'string' ? v.note : '' }
}

/** Every footnote of a document, in reading order. Works on any block list with deltas. */
export function footnotesOf(blocks: FootnoteBlockLike[]): FootnoteInfo[] {
  const out = new Map<string, FootnoteInfo>()
  for (const b of blocks) {
    for (const run of b.delta) {
      const f = footnoteAttr(run.attributes)
      if (!f) continue
      const known = out.get(f.id)
      if (known) known.phrase += run.insert
      else out.set(f.id, { id: f.id, note: f.note, number: out.size + 1, phrase: run.insert })
    }
  }
  return [...out.values()]
}
