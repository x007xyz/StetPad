import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { blocksToDocx, blocksToHtml, blocksToMarkdown, fileToBlocks, htmlToBlocks, protectInlineMath, restoreInlineMath, type Block } from '../src/content'
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
  it('round-trips code containing backtick fences and blank lines', async () => {
    const blocks: Block[] = [{ type: 'codeBlock', attrs: { language: 'ts' }, delta: [{ insert: 'first\n\n\n```\n\nlast' }] }]
    expect(await fileToBlocks('code.md', enc(blocksToMarkdown(blocks)))).toEqual(blocks)
  })

  it('writes the source as $...$ in Markdown', () => {
    const md = blocksToMarkdown([para([{ insert: '面积 ' }, math('x^2')])])
    expect(md).toContain('面积 $x^2$')
  })

  it('round-trips TeX extracted from HTML through Markdown without escaping it', async () => {
    const tex = String.raw`x_1 + \alpha`
    const blocks = htmlToBlocks(`<p>Formula <span data-math="${tex}"></span> intact.</p>`)
    expect(await fileToBlocks('inline.md', enc(blocksToMarkdown(blocks)))).toEqual([
      para([{ insert: 'Formula ' }, math(tex), { insert: ' intact.' }]),
    ])
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

  it('turns $…$ into math on a line with a link', async () => {
    const [b] = await fileToBlocks('notes.md', enc('式子 $a+b$ 见[文档](https://example.com/a)'))
    expect(b!.delta).toEqual([
      { insert: '式子 ' },
      math('a+b'),
      { insert: ' 见' },
      { insert: '文档', attributes: { link: { href: 'https://example.com/a' } } },
    ])
  })

  it('leaves dollars inside link and image destinations alone', () => {
    const { body, tex } = protectInlineMath('[a](https://e.com/?q=$x$) ![b]($p$.png) <https://e.com/$w$> $y$\n[r]: https://e.com/$z$')
    expect(tex).toEqual(['y'])
    expect(body).toContain('[a](https://e.com/?q=$x$)')
    expect(body).toContain('![b]($p$.png)')
    expect(body).toContain('<https://e.com/$w$>')
    expect(body).toContain('[r]: https://e.com/$z$')
  })

  it('leaves dollars inside escaped or bracketed destinations, bare URLs and reference links alone', () => {
    const src = String.raw`[a](u\)$x$) [b](<u)$p$>) https://e.com/?q=$w$ [c $v$][r] $y$` + '\n\n[r]: https://e.com'
    const { body, tex } = protectInlineMath(src)
    expect(tex).toEqual(['y'])
    expect(body).toBe(src.replace('$y$', `\u{e000}0\u{e001}`))
  })

  it('keeps a formula with brackets or a URL whole beside a link', () => {
    const { tex } = protectInlineMath(String.raw`$A[i][j]$ and $\text{see https://e.com}$ [l](u) [a][b](mailto:x$y$@e.com)`)
    expect(tex).toEqual(['A[i][j]', String.raw`\text{see https://e.com}`])
  })

  it('does not pair a price with a dollar inside a link, a code-labelled link or a titled link', () => {
    const src = 'Costs $5, see [a](https://e.com/?p=$y) [`c`](a$x$b.png) [t](<https://e.com/)$w$v> "t(1)") $k$'
    const { body, tex } = protectInlineMath(src)
    expect(tex).toEqual(['k'])
    expect(body).toBe(src.replace('$k$', `\u{e000}0\u{e001}`))
  })

  it('keeps a URL formula before punctuation whole, and code after a link lookalike verbatim', () => {
    const { body, tex } = protectInlineMath(String.raw`$\text{see https://e.com}$. [` + '`](x) $y$` $z$')
    expect(tex).toEqual([String.raw`\text{see https://e.com}`, 'z'])
    expect(body).toContain('`](x) $y$`')
  })

  it('reads links the way marked does: balanced URL parens, code in link text', () => {
    const src = 'Costs $5, see https://e.com/A_(b$) [``a`b``](mailto:x?subject=$y$) $a [`]`](u) b$ $k$'
    const { body, tex } = protectInlineMath(src)
    expect(tex).toEqual(['k'])
    expect(body).toBe(src.replace('$k$', `\u{e000}0\u{e001}`))
  })

  it('keeps a formula with an HTML-like tag whole beside a link', () => {
    expect(protectInlineMath('$<u>_i$ [l](u)').tex).toEqual(['<u>_i'])
  })

  it('reads each line afresh after an anchor that closes on a skipped line', () => {
    const src = '<a href="u">$x$\nend</a>\n\nsee https://e.com/$a$b'
    expect(protectInlineMath(src).tex).toEqual(['x'])
  })

  it('reads URLs inside a multiline anchor as marked does', () => {
    expect(protectInlineMath('<a name="n">\n$a https://e.com/$b c\n</a>').tex).toEqual(['a https://e.com/'])
  })

  it('scans many formula lines with many link definitions in linear time', () => {
    const md = '$x$ [a](u)\n'.repeat(5000) + '\n' + Array.from({ length: 5000 }, (_, i) => `[r${i}]: https://e.com/${i}`).join('\n')
    const start = performance.now()
    expect(protectInlineMath(md).tex).toHaveLength(5000)
    expect(performance.now() - start).toBeLessThan(1000)
  })

  it('scans a line of many formulas in linear time', () => {
    const start = performance.now()
    const { tex } = protectInlineMath('$x$ '.repeat(20000))
    expect(tex).toHaveLength(20000)
    expect(performance.now() - start).toBeLessThan(200)
  })

  it('scans a link with many angle brackets and no closing paren in linear time', () => {
    const start = performance.now()
    protectInlineMath(`[a](${'<b>'.repeat(5000)} "( $x$`)
    expect(performance.now() - start).toBeLessThan(200)
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
