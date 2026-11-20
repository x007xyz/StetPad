import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { blocksToDocx, blocksToHtml, blocksToMarkdown, fileToBlocks, protectInlineMath, restoreInlineMath, type Block } from '../src/content'
import { mathToSvg } from '../src/render'

const para = (delta: Block['delta']): Block => ({ type: 'paragraph', attrs: {}, delta })
const math = (insert: string): Block['delta'][number] => ({ insert, attributes: { math: true } })
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

/** Entry names and raw bytes of a zip file (central directory + inflateRaw), so the test needs no extra dependency. */
function unzipEntries(bytes: Uint8Array): Map<string, Buffer> {
  const buf = Buffer.from(bytes)
  let eocd = buf.length - 22
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--
  expect(eocd).toBeGreaterThanOrEqual(0)
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(dataAt, dataAt + size)
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw))
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

describe('inline math export', () => {
  it('writes the source as $...$ in Markdown', () => {
    const md = blocksToMarkdown([para([{ insert: '面积 ' }, math('x^2')])])
    expect(md).toContain('面积 $x^2$')
  })

  it('draws an inline svg in HTML, not the source', () => {
    const html = blocksToHtml([para([{ insert: 'a ' }, math('x^2')])], 'T')
    expect(html).toMatch(/<span class="math-inline"><svg[\s\S]*?<\/svg><\/span>/)
    expect(html).not.toContain('$x^2$')
  })

  it('carries the vertical alignment of an inline formula onto its svg', () => {
    const svg = mathToSvg('x_1', { display: false })
    expect(svg).not.toBeNull()
    expect(svg).toMatch(/^<svg[^>]*style="[^"]*vertical-align: -?[\d.]+ex/)
    expect(svg!.match(/vertical-align/g)).toHaveLength(1)
  })

  it('puts an inline formula in Word as a picture', async () => {
    const withMath = await blocksToDocx([para([{ insert: 'a ' }, math('x^2')])], 'T')
    const plain = await blocksToDocx([para([{ insert: 'a ' }, { insert: 'x^2' }])], 'T')
    const media = [...unzipEntries(withMath).keys()].filter((n) => n.startsWith('word/media/'))
    expect(media.length).toBe(1)
    expect([...unzipEntries(plain).keys()].filter((n) => n.startsWith('word/media/'))).toEqual([])
    expect(unzipEntries(withMath).get('word/document.xml')!.toString('utf8')).toContain('<pic:pic')
  })
})

describe('inline math import from Markdown', () => {
  it('does not turn prices into math', async () => {
    const [b] = await fileToBlocks('notes.md', enc('价格 $5 和 $6'))
    expect(b!.delta.some((d) => d.attributes?.math)).toBe(false)
    expect(b!.delta.map((d) => d.insert).join('')).toBe('价格 $5 和 $6')
  })

  it('turns $a+b$ into math', async () => {
    const [b] = await fileToBlocks('notes.md', enc('式子 $a+b$ 成立'))
    expect(b!.delta).toEqual([{ insert: '式子 ' }, { insert: 'a+b', attributes: { math: true } }, { insert: ' 成立' }])
  })

  it('keeps * and _ inside a formula out of emphasis', async () => {
    const [b] = await fileToBlocks('notes.md', enc('看 $a_1 * b_2$ 和 *x*'))
    const m = b!.delta.find((d) => d.attributes?.math)
    expect(m).toEqual({ insert: 'a_1 * b_2', attributes: { math: true } })
    expect(b!.delta.find((d) => d.insert === 'x')?.attributes?.italic).toBeTruthy()
  })

  it('leaves dollars inside a double- or triple-backtick code span alone', () => {
    const { body, tex } = protectInlineMath('```a `$x$` b``` and ``$y$`` and $z$')
    expect(tex).toEqual(['z'])
    expect(body).toContain('```a `$x$` b```')
    expect(body).toContain('``$y$``')
  })

  it('leaves code spans and fenced code alone', () => {
    const { body, tex } = protectInlineMath('`$x$` and $y$\n```\n$z$\n```')
    expect(tex).toEqual(['y'])
    expect(body).toContain('`$x$`')
    expect(body).toContain('$z$')
    const blocks = restoreInlineMath([para([{ insert: '0' }])], tex)
    expect(blocks[0]!.delta).toEqual([{ insert: 'y', attributes: { math: true } }])
  })
})
