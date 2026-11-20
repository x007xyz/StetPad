import { describe, expect, it } from 'vitest'
import { formatBlock, parseBlock } from '../src/tools'

describe('table notation', () => {
  it('round-trips a pipe table back into a table block', () => {
    const rows = [['名称', 'a|b'], ['1', '']]
    const text = formatBlock({ type: 'table', attrs: { rows: JSON.stringify(rows) }, text: '' })
    const back = parseBlock(text)
    expect(back.type).toBe('table')
    expect(JSON.parse(String(back.attrs.rows))).toEqual(rows)
  })
  it('is a paragraph unless every line is a row', () => {
    expect(parseBlock('| a | b |\nnot a row').type).toBe('paragraph')
  })
})
