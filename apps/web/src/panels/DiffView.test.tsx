import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { RichBlock } from '../api'
import { alignBlocks, DiffView, rowChanged } from './DiffView'

const block: RichBlock = { blockId: 'one', type: 'paragraph', text: 'A whole line', attrs: {}, delta: [{ insert: 'A whole line' }] }

it.each([
  { bold: true },
  { italic: true },
  { link: { href: 'https://example.com' } },
])('shows a formatting-only change: %j', (attributes) => {
  const rows = alignBlocks([block], [{ ...block, delta: [{ insert: block.text, attributes }] }])
  expect(rowChanged(rows[0]!)).toBe(true)
  const html = renderToStaticMarkup(<DiffView rows={rows} leftTitle="Before" rightTitle="After" onlyChanged />)
  expect(html).toContain('data-diff-changed="true"')
  expect(html).toContain(block.text)
  expect(html).not.toContain('两边内容相同。')
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
