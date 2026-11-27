import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { RichBlock } from '../api'
import { alignBlocks, DiffView, rowChanged, type DiffRow } from './DiffView'

const block: RichBlock = { blockId: 'one', type: 'paragraph', text: 'A whole line', attrs: {}, delta: [{ insert: 'A whole line' }] }

it.each([[false, true], [true, false]])('shows each side’s task state: %s → %s', (before, after) => {
  const task = { ...block, type: 'taskItem' }
  const rows = alignBlocks([{ ...task, attrs: { checked: before } }], [{ ...task, attrs: { checked: after } }])
  const html = renderToStaticMarkup(<DiffView rows={rows} leftTitle="Before" rightTitle="After" onlyChanged />)
  expect(html.match(/<span class="kind">(.*?)<\/span>/g)).toEqual([
    `<span class="kind">${before ? '☑' : '☐'}</span>`,
    `<span class="kind">${after ? '☑' : '☐'}</span>`,
  ])
  expect(html).toContain('data-diff-changed="true"')
})

it.each([undefined, {}, { checked: false }, { checked: true }])('shows added and removed tasks with attributes %j', (attrs) => {
  const task = { ...block, type: 'taskItem', text: '', delta: undefined, attrs }
  for (const rows of [[{ id: 'added', right: task }], [{ id: 'removed', left: task }]]) {
    const html = renderToStaticMarkup(<DiffView rows={rows} leftTitle="Before" rightTitle="After" />)
    expect(html.match(/<span class="kind">(.*?)<\/span>/g)).toEqual([
      `<span class="kind">${attrs?.checked ? '☑' : '☐'}</span>`,
    ])
  }
})

it.each([
  [{ bold: true }, '<strong>A whole line</strong>'],
  [{ italic: true }, '<em>A whole line</em>'],
  [{ underline: true }, '<u>A whole line</u>'],
  [{ strike: true }, '<s>A whole line</s>'],
  [{ code: true }, '<code>A whole line</code>'],
  [{ highlight: {} }, '<mark>A whole line</mark>'],
  [{ link: { href: 'https://example.com' } }, 'href="https://example.com"'],
] as const)('shows a formatting-only change: %j', (attributes, formatted) => {
  const rows = alignBlocks([block], [{ ...block, delta: [{ insert: block.text, attributes }] }])
  expect(rowChanged(rows[0]!)).toBe(true)
  const html = renderToStaticMarkup(<DiffView rows={rows} leftTitle="Before" rightTitle="After" onlyChanged />)
  expect(html).toContain('data-diff-changed="true"')
  expect(html).toContain(block.text)
  expect(html).toContain(formatted)
  expect(html).toContain('仅格式变化')
  expect(html).not.toContain('两边内容相同。')
})

it('preserves formatting on both sides and review actions', () => {
  const html = renderToStaticMarkup(<DiffView rows={[{ id: 'review', left: { ...block, delta: [{ insert: block.text, attributes: { bold: true } }] }, right: { ...block, delta: [{ insert: block.text, attributes: { italic: true } }] }, actions: <button>Accept</button> }]} leftTitle="Original" rightTitle="Revised" />)
  expect(html).toContain('<strong>A whole line</strong>')
  expect(html).toContain('<em>A whole line</em>')
  expect(html).toContain('<button>Accept</button>')
})

it('falls back to plain text without delta and keeps text changes as word diffs', () => {
  const row = { id: 'review', left: { type: 'paragraph', text: block.text }, right: { type: 'heading', text: block.text } }
  const html = renderToStaticMarkup(<DiffView rows={[row]} leftTitle="Original" rightTitle="Revised" />)
  expect(html).toContain(block.text)
  expect(html).toContain('仅格式变化')
  const edited = renderToStaticMarkup(<DiffView rows={alignBlocks([block], [{ ...block, text: 'A different line' }])} leftTitle="Before" rightTitle="After" />)
  expect(edited).toContain('<del>')
  expect(edited).toContain('<ins>')
  expect(edited).not.toContain('仅格式变化')
})

it('does not render unsafe links or interpret text as HTML', () => {
  const html = renderToStaticMarkup(<DiffView rows={alignBlocks([block], [{ ...block, delta: [{ insert: '<script>bad</script>', attributes: { link: { href: 'javascript:alert(1)' } } }] }])} leftTitle="Before" rightTitle="After" />)
  expect(html).not.toContain('href=')
  expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;')
})

it('detects block attribute changes', () => {
  expect(rowChanged(alignBlocks([block], [{ ...block, attrs: { textAlign: 'center' } }])[0]!)).toBe(true)
})

it('ignores object key order in marks, nested link attributes and block attributes', () => {
  const left = { ...block, attrs: { level: 1, options: { align: 'left', indent: 0 } }, delta: [{ insert: block.text, attributes: { bold: true, italic: true, link: { href: 'https://example.com', target: '_blank' } } }] }
  const right = { ...block, attrs: { options: { indent: 0, align: 'left' }, level: 1 }, delta: [{ attributes: { link: { target: '_blank', href: 'https://example.com' }, italic: true, bold: true }, insert: block.text }] }
  expect(rowChanged(alignBlocks([left], [right])[0]!)).toBe(false)
  expect(rowChanged(alignBlocks([left], [{ ...right, attrs: { ...right.attrs, level: 2 } }])[0]!)).toBe(true)
  expect(rowChanged(alignBlocks([left], [{ ...right, delta: [{ insert: block.text, attributes: { bold: true } }] }])[0]!)).toBe(true)
})

it('preserves array order and distinguishes null and missing attributes', () => {
  for (const attrs of [{ values: [2, 1] }, { values: [1] }, { values: null }, {}]) {
    expect(rowChanged(alignBlocks([{ ...block, attrs: { values: [1, 2] } }], [{ ...block, attrs }])[0]!)).toBe(true)
  }
  expect(rowChanged(alignBlocks([{ ...block, attrs: { value: null } }], [block])[0]!)).toBe(true)
})

it('keeps identical content unchanged and handles empty documents', () => {
  expect(rowChanged(alignBlocks([block], [structuredClone(block)])[0]!)).toBe(false)
  expect(alignBlocks([], [])).toEqual([])
  expect(renderToStaticMarkup(<DiffView rows={[]} leftTitle="Before" rightTitle="After" onlyChanged />)).toContain('两边内容相同。')
})

it('detects added, removed, text and type changes', () => {
  for (const rows of [alignBlocks([], [block]), alignBlocks([block], []), alignBlocks([block], [{ ...block, text: 'Edited' }]), alignBlocks([block], [{ ...block, type: 'heading' }])]) {
    expect(rowChanged(rows[0]!)).toBe(true)
  }
})

function referenceAlignment(a: RichBlock[], b: RichBlock[]): DiffRow[] {
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i]!.blockId === b[j]!.blockId ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i]!.blockId === b[j]!.blockId) {
      rows.push({ id: a[i]!.blockId, left: a[i], right: b[j] })
      i++
      j++
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      rows.push({ id: 'r' + b[j]!.blockId, right: b[j] })
      j++
    } else {
      rows.push({ id: 'l' + a[i]!.blockId, left: a[i] })
      i++
    }
  }
  return rows
}

const blocks = (ids: string[], side: string): RichBlock[] =>
  ids.map((blockId, i) => ({ ...block, blockId, text: `${side} ${i}` }))

it('pairs equal IDs immediately and otherwise emits right-side rows first on LCS ties', () => {
  const left = blocks(['prefix', 'a', 'b', 'left'], 'left')
  const right = blocks(['prefix', 'b', 'a', 'right'], 'right')
  expect(alignBlocks(left, right)).toEqual([
    { id: 'prefix', left: left[0], right: right[0] },
    { id: 'rb', right: right[1] },
    { id: 'a', left: left[1], right: right[2] },
    { id: 'rright', right: right[3] },
    { id: 'lb', left: left[2] },
    { id: 'lleft', left: left[3] },
  ])
})

it('does not force a common suffix to align when an earlier duplicate matches', () => {
  const left = blocks(['left', 'a'], 'left')
  const right = blocks(['right', 'left', 'a', 'a'], 'right')
  expect(alignBlocks(left, right)).toEqual([
    { id: 'rright', right: right[0] },
    { id: 'left', left: left[0], right: right[1] },
    { id: 'a', left: left[1], right: right[2] },
    { id: 'ra', right: right[3] },
  ])
})

it.each([false, true])('matches the reference for seeded random inputs (repeated IDs: %s)', (repeated) => {
  let seed = 0xe5091
  function random(max: number): number {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return Math.floor((seed / 2 ** 32) * max)
  }
  function sample(): string[] {
    const pool = Array.from({ length: repeated ? 5 : 32 }, (_, i) => String(i))
    return Array.from({ length: random(33) }, () => {
      const index = random(pool.length)
      return repeated ? pool[index]! : pool.splice(index, 1)[0]!
    })
  }
  for (let run = 0; run < 1000; run++) {
    const a = blocks(sample(), 'left')
    const b = blocks(sample(), 'right')
    expect(alignBlocks(a, b)).toEqual(referenceAlignment(a, b))
  }
})
