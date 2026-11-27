import { describe, expect, it } from 'vitest'
import { blocksToMarkdown, fileToBlocks, type Block } from '../src/content'

describe('inline Markdown export', () => {
  const link = { href: 'https://example.com/article' }
  const bold = { bold: {} }
  const italic = { italic: {} }
  const strike = { strike: {} }
  const code = { code: {} }

  it.each<{ name: string; delta: Block['delta']; markdown?: string }>([
    {
      name: 'bold text continuing into a bold link',
      delta: [{ insert: 'Good ', attributes: bold }, { insert: 'article', attributes: { ...bold, link } }],
      markdown: '**Good [article](https://example.com/article)**\n',
    },
    {
      name: 'bold text extending beyond the start of a link',
      delta: [{ insert: 'Good ', attributes: { link } }, { insert: 'article', attributes: { ...bold, link } }],
      markdown: '[Good **article**](https://example.com/article)\n',
    },
    {
      name: 'crossing bold and italic spans',
      delta: [{ insert: 'First ', attributes: bold }, { insert: 'second', attributes: { ...bold, ...italic } }, { insert: ' third', attributes: italic }],
    },
    {
      name: 'code and a link nested in strikethrough',
      delta: [{ insert: 'Old ', attributes: strike }, { insert: 'a`b', attributes: { ...strike, ...code, link } }, { insert: ' docs', attributes: strike }],
      markdown: '~~Old [``a`b``](https://example.com/article) docs~~\n',
    },
    {
      name: 'emphasis inside a shared code span',
      delta: [{ insert: '$a*b$ ', attributes: code }, { insert: 'code', attributes: { ...code, ...bold } }],
    },
    {
      name: 'a bold link ending mid-word',
      delta: [{ insert: 'Good ', attributes: bold }, { insert: 'article', attributes: { ...bold, link } }, { insert: 's' }],
    },
  ])('round-trips $name', async ({ delta, markdown }) => {
    const blocks: Block[] = [{ type: 'paragraph', attrs: {}, delta }]
    const exported = blocksToMarkdown(blocks)
    if (markdown) expect(exported).toBe(markdown)
    expect(await fileToBlocks('export.md', new TextEncoder().encode(exported))).toEqual(blocks)
  })
})
