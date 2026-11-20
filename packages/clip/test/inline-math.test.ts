import { describe, expect, it } from 'vitest'
import { blocksToMarkdown } from '../src'

describe('@stetpad/clip inline math', () => {
  it('writes a math run as $...$ and applies no other formatting inside it', () => {
    const md = blocksToMarkdown([
      { type: 'paragraph', attrs: {}, delta: [{ insert: '能量 ' }, { insert: 'E=mc^2', attributes: { math: true } }, { insert: ' 。' }] },
    ])
    expect(md).toBe('能量 $E=mc^2$ 。\n')
  })
})
