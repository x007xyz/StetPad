import { findBlock, insertBlock, listChanges, projectBlocks } from '@stetpad/crdt'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { DocTools, deltaToNotation, notationToText } from '../src/tools'

const AI = 'AI'
const meta = { author: AI, runId: 'r1' }

/** A document with one paragraph; the given ranges of its text are inline math. */
function docWithMath(text: string, math: Array<[number, number]>): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => insertBlock(doc, 0, 'p1', text, 'paragraph', {}))
  const el = findBlock(doc, 'p1')!
  const t = el.toArray().find((n): n is Y.XmlText => n instanceof Y.XmlText)!
  doc.transact(() => {
    for (const [a, b] of math) t.format(a, b - a, { math: true })
  })
  return doc
}

/** The revised delta of the paragraph: math runs as they read after the suggestions. */
function revisedMath(doc: Y.Doc): string[] {
  const b = projectBlocks(doc, 'revised').find((x) => x.blockId === 'p1')!
  return b.delta.filter((d) => d.attributes?.math).map((d) => d.insert)
}

describe('inline math notation: codec', () => {
  it('deltaToNotation wraps math in $ and escapes literal dollars', () => {
    const delta = [{ insert: 'costs ' }, { insert: 'x^2', attributes: { math: true } }, { insert: ' and $5' }]
    expect(deltaToNotation(delta)).toBe('costs $x^2$ and \\$5')
  })

  it('notationToText returns the plain text and the math ranges', () => {
    expect(notationToText('costs $x^2$ and \\$5')).toEqual({ text: 'costs x^2 and $5', math: [[6, 9]] })
  })

  it('round trips delta, notation and back', () => {
    const delta = [
      { insert: 'price \\$5 and ' },
      { insert: 'a\\b', attributes: { math: true } },
      { insert: ' end\\' },
      { insert: '$' },
    ]
    const back = notationToText(deltaToNotation(delta))
    expect(back.text).toBe(delta.map((d) => d.insert).join(''))
    expect(back.math).toEqual([[14, 17]])
  })

  it('an unclosed dollar sign is plain text', () => {
    expect(notationToText('a $ b')).toEqual({ text: 'a $ b', math: [] })
    expect(notationToText('\\$5')).toEqual({ text: '$5', math: [] })
  })

  it('a backslash before a formula is kept', () => {
    const delta = [{ insert: 'path\\' }, { insert: 'x', attributes: { math: true } }]
    expect(notationToText(deltaToNotation(delta))).toEqual({ text: 'path\\x', math: [[5, 6]] })
  })
})

describe('inline math notation: reads and writes through DocTools', () => {
  it('readBlocks shows an inline formula as $…$', () => {
    const doc = docWithMath('a x^2 b', [[2, 5]])
    expect(new DocTools(doc, meta).readBlocks({})).toBe('[p1] a $x^2$ b')
  })

  it('replaceBlock that keeps the formula and changes other words leaves the formula untouched', () => {
    const doc = docWithMath('a x^2 b', [[2, 5]])
    const r = new DocTools(doc, meta).replaceBlock('p1', 'a $x^2$ c')
    expect(r).toMatchObject({ ok: true })
    const changes = listChanges(doc)
    expect(changes.map((c) => c.deleted).join('')).toBe('b')
    expect(changes.map((c) => c.inserted).join('')).toBe('c')
    expect(revisedMath(doc)).toEqual(['x^2'])
  })

  it('replaceBlock that adds $y$ makes the new characters math', () => {
    const doc = docWithMath('a b', [])
    const r = new DocTools(doc, meta).replaceBlock('p1', 'a $y$ b')
    expect(r).toMatchObject({ ok: true })
    expect(listChanges(doc).map((c) => c.inserted).join('')).toContain('y')
    expect(revisedMath(doc)).toEqual(['y'])
  })

  it('editText matches an old text written with $…$ and formats the new formula', () => {
    const doc = docWithMath('Let x^2 be big', [[4, 7]])
    const r = new DocTools(doc, meta).editText('p1', '$x^2$', '$x^3$', 'fix exponent')
    expect(r).toMatchObject({ ok: true })
    expect(projectBlocks(doc, 'revised').find((x) => x.blockId === 'p1')!.text).toBe('Let x^3 be big')
    expect(revisedMath(doc)).toEqual(['x^3'])
  })

  it('insertBlocks formats a formula in a new block', () => {
    const doc = docWithMath('a', [])
    const r = new DocTools(doc, meta).insertBlocks('p1', ['price \\$5 and $z$'])
    expect(r).toMatchObject({ ok: true })
    const id = (r as { new_block_ids: string[] }).new_block_ids[0]!
    const nb = projectBlocks(doc, 'revised').find((x) => x.blockId === id)!
    expect(nb.text).toBe('price $5 and z')
    expect(nb.delta.filter((d) => d.attributes?.math).map((d) => d.insert)).toEqual(['z'])
  })
})

describe('unescaped dollars the AI may write', () => {
  it('keeps prices as text and still finds a formula after them', () => {
    expect(notationToText('costs $5 and $6 today')).toEqual({ text: 'costs $5 and $6 today', math: [] })
    expect(notationToText('$5 and $x^2$')).toEqual({ text: '$5 and x^2', math: [[7, 10]] })
    expect(notationToText('pay $10$20')).toEqual({ text: 'pay $10$20', math: [] })
  })

  it('puts the edge spaces of a formula outside the dollars, so it reads back the same', () => {
    const n = deltaToNotation([{ insert: 'a ' }, { insert: ' x ', attributes: { math: true } }, { insert: 'b' }])
    expect(n).toBe('a  $x$ b')
    expect(notationToText(n).text).toBe('a  x b')
  })
})
