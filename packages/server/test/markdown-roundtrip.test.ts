import { describe, expect, it } from 'vitest'
import { blocksToMarkdown, fileToBlocks, type Block } from '../src/content'

type Run = Block['delta'][number]

const text = (insert: string, attributes?: Run['attributes']): Run => ({ insert, ...(attributes ? { attributes } : {}) })
const block = (type: string, attrs: Block['attrs'] = {}, ...delta: Run[]): Block => ({ type, attrs, delta })
const paragraph = (...delta: Run[]) => block('paragraph', {}, ...delta)
const image = (alt: string, caption: string, src = 'https://example.invalid/snap)shot.png') => block('image', { src, alt, caption })
const table = (cell: string) => block('table', { rows: JSON.stringify([[cell, '尾'], ['列', cell]]) })
const link = (href: string) => ({ link: { href } })
const bold = { bold: {} }
const italic = { italic: {} }
const strike = { strike: {} }
const code = { code: {} }
const math = { math: true }
const href = 'https://example.invalid/pa)th(2)?a=$x$&b=2'
const footnote = (note: string) => ({ footnote: { id: 'fn_generated', note } })

function canonical(doc: Block[]): Block[] {
  const footnoteIds = new Map<string, number>()
  return doc.map(({ type, attrs, delta }) => {
    const runs: Run[] = []
    for (const { insert, attributes } of delta) {
      const marks = Object.fromEntries(Object.entries(attributes ?? {}).sort(([a], [b]) => a.localeCompare(b)))
      // Markdown assigns fresh IDs to footnotes on import.
      if (marks.footnote) {
        const { id, note } = marks.footnote as { id: string; note: string }
        if (!footnoteIds.has(id)) footnoteIds.set(id, footnoteIds.size)
        marks.footnote = { id: footnoteIds.get(id), note }
      }
      const last = runs.at(-1)
      const next = text(insert, Object.keys(marks).length ? marks : undefined)
      if (last && JSON.stringify(last.attributes) === JSON.stringify(next.attributes)) last.insert += insert
      else runs.push(next)
    }
    return block(type, attrs, ...runs)
  })
}

async function readMarkdown(markdown: string) {
  return canonical(await fileToBlocks('roundtrip.md', new TextEncoder().encode(markdown)))
}

const examples: [string, Block[]][] = [
  ['leading spaces', [paragraph(text('    字'))]],
  ['repeated interior and trailing spaces', [paragraph(text('a  b '))]],
  ['literal standalone dollar syntax', [paragraph(text('$$NAME$$'))]],
  ['GFM autolinks in plain text', [paragraph(text('www.example.invalid user@example.invalid'))]],
  ['list marker inside a list item', [block('bulletItem', { indent: 0 }, text('- a'))]],
  ['deep lists up to editor indent six', Array.from({ length: 7 }, (_, indent) => block('bulletItem', { indent }, text('node')))],
  ['a literal heading-closing hash', [block('heading', { level: 2 }, text('C #'))]],
  ['literal callout marker in a quote', [block('quote', {}, text('[!NOTE] x'))]],
  ['callout across inline marks', [block('callout', {}, text('A', bold), text(' B'))]],
  ['intra-word linked emphasis', [paragraph(text('a'), text('x', { ...bold, ...link(href) }), text('b'))]],
  ['literal image syntax inside a link label', [paragraph(text('![alt](https://example.invalid)', { ...bold, ...link(href) }))]],
  ['literal footnote syntax inside a link label', [paragraph(text('[^n]', link(href)))]],
  ['adjacent differently marked text', [paragraph(text('a', bold), text('b', italic))]],
  ['marked punctuation mid-word', [paragraph(text('a'), text('*', italic), text('b'))]],
  ['touching inline code with distinct marks', [paragraph(text('a', code), text('b', { ...code, ...bold }))]],
  ['underline and highlight', [paragraph(text('line', { underline: {} }), text(' and '), text('highlight', { highlight: {} }))]],
  ['adjacent inline formulas and following digit', [paragraph(text('x', math), text('y', math), text('2'))]],
  ['literal Unicode that looks like a math placeholder', [paragraph(text('\ue0000\ue001 '), text('x', math))]],
  ['Markdown normalizing literal URLs', [
    paragraph(text('link', link('https://example.invalid/字?what=&copy;'))),
    image('picture', 'caption', 'https://example.invalid/字?what=&copy;'),
  ]],
  ['image alt markup and caption punctuation', [image('[cat] *_&copy;\\', 'He said "meow"\\.')]],
  ['table pipe and markdown-heavy cell', [table('a\\| **b** [^x] &copy; $c$')]],
  ['fences and footnote definitions inside code', [block('codeBlock', { language: 'ts' }, text('    $$NAME$$\n\n\n```\n[^x]: literal'))]],
  ['trailing blank lines in code', [block('codeBlock', { language: '' }, text('a\n\n'))]],
  ['backticks in display math', [block('codeBlock', { language: 'math' }, text('x\n```\ny'))]],
  ['footnote after an emoji that also has bold', [paragraph(text('🌱leaf', { ...footnote('note'), ...bold }), text(' [^1]'))]],
]

function random(seed: number) {
  let state = seed
  return (max: number) => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) % max
  }
}

function generate(next: (max: number) => number): Block[] {
  const pick = <T>(values: readonly T[]): T => values[next(values.length)]!
  const literal = () => pick([
    '汉字 e\u0301 😀', '© &copy; &#169; & y', '* _ ` # > - + [ ] ( ) ! | \\ $ ~ < > &',
    '<b>not HTML</b>', '1. not a list', '42) also not a list', '# heading', '> quote', '- dash', '+ plus',
    '---', '[^x]: not a footnote', '![alt](https://example.invalid)', 'https://example.invalid/a',
    'WWW.example.invalid user@example.invalid', 'prefix | suffix', '  leading', 'two  spaces', '$$standalone$$', '\ue0000\ue001',
    'one dollar $5', 'backslash \\', '***', '[!NOTE] literal',
  ])
  const decorated = () => {
    const s = pick(['A', 'x', '文字', '✽', 'one word', literal()])
    return pick([
      [text(s)],
      [text(s + ' ', bold), text('link', { ...bold, ...link(href) })],
      [text(s, italic), text('shared', { ...italic, ...strike }), text('crosses', strike)],
      [text('a'), text(s, { ...bold, ...link(href) }), text('b')],
      [text('left'), text(pick([' a ', '`inline``', '$a_b$ [^1]', '   ']), code), text('end')],
      [text('x', bold), text('y', italic), text('z', strike)],
      [text('under', { underline: {} }), text(s, { highlight: {} })],
      [text('TeX '), text(pick(['x', 'y^2', '\\frac{a_b}{c*d}']), math), text(' and '), text('link', link(href))],
      [text('🌱note', { ...footnote('注 ' + next(100)), ...bold }), text(' [^1]')],
    ])
  }
  const listTypes = ['orderedItem', 'bulletItem', 'taskItem'] as const
  const item = (type: typeof listTypes[number], indent: number) =>
    block(type, { indent, ...(type === 'taskItem' ? { checked: next(2) === 1 } : {}) }, text(pick([literal(), 'item'])))
  // Empty blocks, paragraph indentation and disconnected list indents have no Markdown representation.
  // Attachment/link cards, embedded video and draw.io previews intentionally export as links/images.
  // Plain $…$ from HTML clips is intentionally interpreted as math; footnotes preserve single-word anchors and single-line notes.
  const factories = [
    () => [paragraph(...decorated())],
    () => [block('heading', { level: next(3) + 1 }, ...decorated())],
    () => [block('quote', {}, ...decorated())],
    () => [block('callout', {}, ...decorated())],
    () => [
      ...Array.from({ length: 2 + next(6) }, (_, indent) => item(pick(listTypes), indent)),
      item(pick(listTypes), 0),
      paragraph(...decorated()),
    ],
    () => [block('divider')],
    () => [image(pick(['cat', '猫', literal()]), pick(['Caption', '图', 'He said "hi".']))],
    // GFM tables are rectangular and collapse cell whitespace; Markdown images omit layout metadata.
    () => [table(pick([literal().trim().replace(/\s+/g, ' '), 'A\\|B', '']))],
    () => [block('codeBlock', { language: pick(['', 'ts', 'mermaid']) }, text(pick(['    $$NAME$$\n[^1]: x', 'a\n\n\n```\nb', 'graph TD; A-->B', '  indent\n\n'])))],
    () => [block('codeBlock', { language: 'math' }, text(pick(['a_b*c', '\\frac{a}{b}\n+1', 'x\n```\ny'])))],
    () => [block('drawio', { xml: `<mxfile><diagram id="${next(100)}"/></mxfile>` })],
    // Uploaded video titles/posters/subtitles and standalone display captions are not carried as video metadata.
    () => [block('video', { src: '/files/video-' + next(100), kind: 'file', title: '', caption: '' })],
  ]
  return Array.from({ length: 1 + next(8) }, () => pick(factories)()).flat().map((b, i) =>
    ({ ...b, delta: b.delta.map((run) => run.attributes?.footnote
      ? text(run.insert, { ...run.attributes, footnote: { ...(run.attributes.footnote as object), id: 'fn_' + i } })
      : run) }))
}

async function check(doc: Block[]) {
  const markdown = blocksToMarkdown(doc)
  expect(await readMarkdown(markdown), markdown).toEqual(canonical(doc))
}

const isList = (b?: Block) => b && ['orderedItem', 'bulletItem', 'taskItem'].includes(b.type)
const isValid = (doc: Block[]) => doc.every((b, i) =>
  !isList(b) || Number(b.attrs.indent) <= (isList(doc[i - 1]) ? Number(doc[i - 1]!.attrs.indent) + 1 : 0))

describe('Markdown round-trip regressions', () => {
  it.each(examples)('%s', async (_, doc) => check(doc))
})

const seeds = [1, 0xabcdef, 0xc0ffee, 0x93_97_98, 0x101_103, 0x104_106, 0x12345678, 0xdeadbeef]
describe('seeded Markdown round trips', () => {
  it.each(seeds)('seed %i (64 documents)', async (seed) => {
    const next = random(seed)
    for (let index = 0; index < 64; index++) {
      const doc = generate(next)
      try {
        await check(doc)
      } catch {
        let minimal = doc
        const shrink = async (candidates: Block[][]) => {
          for (const candidate of candidates.filter(isValid)) {
            try {
              await check(candidate)
            } catch {
              minimal = candidate
              return true
            }
          }
          return false
        }
        while (await shrink(minimal.map((_, i) => minimal.filter((_b, j) => i !== j)))
          || await shrink(minimal.flatMap((b, i) => b.delta.length < 2 ? [] : b.delta.map((_run, j) => minimal.map((other, k) =>
            i === k ? { ...b, delta: b.delta.filter((_d, l) => j !== l) } : other))))) { /* locally minimal */ }
        const markdown = blocksToMarkdown(minimal)
        expect(await readMarkdown(markdown), `seed ${seed}, document ${index}, shrunk to ${JSON.stringify(minimal)}\n${markdown}`)
          .toEqual(canonical(minimal))
      }
    }
  })
})
