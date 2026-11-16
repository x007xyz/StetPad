import DiffMatchPatch from 'diff-match-patch'

export type DiffOp = { type: 'equal' | 'delete' | 'insert'; text: string }

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })

export const tokenize = (s: string): string[] =>
  Array.from(segmenter.segment(s), (x) => x.segment)

/**
 * Word-level diff. Chinese has no spaces, so a character diff shreds a
 * sentence into single-character edits; segmenting first keeps words whole.
 * Each distinct token is mapped to one code unit, diffed, then mapped back.
 */
export function diffWords(a: string, b: string): DiffOp[] {
  const table = new Map<string, string>()
  const back: string[] = []
  let next = 0x100
  const encode = (s: string): string =>
    tokenize(s)
      .map((tok) => {
        let code = table.get(tok)
        if (!code) {
          if (next === 0xd800) next = 0xe000 // skip surrogates
          if (next > 0xffff) throw new Error('too many distinct tokens to diff')
          code = String.fromCharCode(next++)
          table.set(tok, code)
          back[code.charCodeAt(0)] = tok
        }
        return code
      })
      .join('')

  const dmp = new DiffMatchPatch()
  const diffs = dmp.diff_main(encode(a), encode(b), false)
  dmp.diff_cleanupSemantic(diffs)
  const decode = (s: string): string =>
    Array.from(s, (ch) => back[ch.charCodeAt(0)]!).join('')

  const names = { [-1]: 'delete', [0]: 'equal', [1]: 'insert' } as const
  return diffs
    .map(([op, text]) => ({ type: names[op as -1 | 0 | 1], text: decode(text) }))
    .filter((d) => d.text.length > 0)
}

/** An edit against the baseline text: replace `[start, end)` with `insert`. */
export interface Edit {
  start: number
  end: number
  insert: string
}

/** Fold a diff into edits; an adjacent deletion and insertion become one replacement. */
export function toEdits(ops: DiffOp[]): Edit[] {
  const edits: Edit[] = []
  let pos = 0
  let cur: Edit | null = null
  for (const op of ops) {
    if (op.type === 'equal') {
      if (cur) edits.push(cur)
      cur = null
      pos += op.text.length
    } else {
      cur ??= { start: pos, end: pos, insert: '' }
      if (op.type === 'delete') {
        cur.end += op.text.length
        pos += op.text.length
      } else {
        cur.insert += op.text
      }
    }
  }
  if (cur) edits.push(cur)
  return edits
}
