import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'
import { fileToBlocks } from '../src/content'

describe('text-layer PDF import', () => {
  let blocks: { type: string; attrs: Record<string, unknown>; text: string }[]

  beforeAll(async () => {
    // Chromium-printed HTML with embedded Arial-compatible and Noto CJK fonts.
    const pdf = await readFile(new URL('./fixtures/pdf-import-wraps.pdf', import.meta.url))
    blocks = (await fileToBlocks('pdf-import-wraps.pdf', new Uint8Array(pdf))).map(({ type, attrs, delta }) => ({
      type, attrs, text: delta.map((d) => d.insert).join(''),
    }))
  })

  it('joins wrapped heading lines without merging a separate heading of the same size', () => {
    expect(blocks.slice(0, blocks.findIndex((b) => b.type === 'orderedItem'))).toEqual([
      { type: 'heading', attrs: { level: 1 }, text: 'Quarterly report on the long running migration project status' },
      { type: 'heading', attrs: { level: 1 }, text: 'Next heading' },
    ])
  })

  it('joins hanging continuations without merging adjacent numbered or bulleted items', () => {
    const start = blocks.findIndex((b) => b.type === 'orderedItem')
    const end = blocks.findIndex((b) => b.text.startsWith('The migration project'))
    expect(blocks.slice(start, end)).toEqual([
      { type: 'orderedItem', attrs: { indent: 0 }, text: 'First numbered step that is deliberately long so that it wraps onto another line too.' },
      { type: 'orderedItem', attrs: { indent: 0 }, text: 'Second numbered step.' },
      { type: 'bulletItem', attrs: { indent: 0 }, text: 'First bullet step that is deliberately long so that it wraps onto another line too.' },
      { type: 'bulletItem', attrs: { indent: 0 }, text: 'Second bullet step.' },
    ])
  })

  it('keeps a same-margin numeric wrap in its paragraph but recognizes an actual year-numbered item', () => {
    const start = blocks.findIndex((b) => b.text.startsWith('The migration project'))
    expect(blocks.slice(start, -1)).toEqual([
      { type: 'paragraph', attrs: {}, text: 'The migration project took a long time to finish and ran until 2024. This number line is still part of the same paragraph.' },
      { type: 'orderedItem', attrs: { indent: 0 }, text: 'A real numbered item starting with a year.' },
    ])
  })

  it('imports unified Chinese characters and joins a wrap between Han characters without a space', () => {
    expect(blocks.at(-1)).toEqual({
      type: 'paragraph', attrs: {}, text: '中文段落测试，这一行足够长以便在打印出来的PDF中换行到第二行，看看是否会插入多余的空格。',
    })
  })
})
