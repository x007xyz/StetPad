import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { RichBlock } from '../api'
import { alignBlocks, DiffView, rowChanged } from './DiffView'

const block: RichBlock = { blockId: 'one', type: 'paragraph', text: 'A whole line', attrs: {}, delta: [{ insert: 'A whole line' }] }

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
