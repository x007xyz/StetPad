import { blockText, findBlock, insertBlock, projectBlocks, type RichBlock } from '@stetpad/crdt'
import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { blocksToDocx, blocksToHtml, blocksToMarkdown, fileToBlocks } from '../src/content'
import { DocTools } from '../src/tools'

const AI = 'AI · test-model'

/** Two paragraphs, two footnotes. The second footnote is created first, but the first in reading order is numbered 1. */
function twoFootnotes(): { doc: Y.Doc; blocks: RichBlock[] } {
  const doc = new Y.Doc()
  insertBlock(doc, 0, 'b1', 'The quick brown fox jumps.')
  insertBlock(doc, 1, 'b2', 'A second claim <here> & there.')
  blockText(findBlock(doc, 'b2')!).format(2, 6, { footnote: { id: 'fn_second', note: 'Second & <last> "note"' } })
  blockText(findBlock(doc, 'b1')!).format(4, 11, { footnote: { id: 'fn_first', note: 'First note.' } })
  return { doc, blocks: projectBlocks(doc, 'revised') }
}

/** Minimal zip reader (central directory + inflateRaw), so the test needs no extra dependency. */
function unzip(bytes: Uint8Array): Record<string, string> {
  const buf = Buffer.from(bytes)
  let eocd = buf.length - 22
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--
  expect(eocd).toBeGreaterThanOrEqual(0)
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out: Record<string, string> = {}
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50)
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(dataAt, dataAt + size)
    out[name] = (method === 8 ? inflateRawSync(raw) : raw).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

describe('footnote export', () => {
  it('markdown: numbers in reading order, reference after the phrase, definitions at the end', () => {
    const { blocks } = twoFootnotes()
    const md = blocksToMarkdown(blocks as never)
    expect(md).toContain('The quick brown[^1] fox jumps.')
    expect(md).toContain('A second[^2] claim')
    expect(md).toContain('[^1]: First note.')
    expect(md.indexOf('[^1]:')).toBeLessThan(md.indexOf('[^2]:'))
    expect(md).toContain('[^2]: Second & <last> "note"')
    expect(md.trimEnd().endsWith('[^2]: Second & <last> "note"')).toBe(true)
  })

  it('markdown: a footnote over several runs gets one reference, after the last run', () => {
    const doc = new Y.Doc()
    insertBlock(doc, 0, 'b1', 'alpha beta gamma')
    const t = blockText(findBlock(doc, 'b1')!)
    t.format(0, 5, { footnote: { id: 'x', note: 'N' } })
    t.format(6, 4, { footnote: { id: 'x', note: 'N' } })
    const md = blocksToMarkdown(projectBlocks(doc, 'revised') as never)
    expect(md.match(/\[\^1\]/g)).toHaveLength(2) // one reference, one definition
    expect(md).toContain('alpha beta[^1] gamma')
  })

  it('html: escaped notes, numbered references, footnote section with back links', () => {
    const { blocks } = twoFootnotes()
    const html = blocksToHtml(blocks as never, 'T & <Title>')
    expect(html).toContain('quick brown<sup><a href="#fn-1" id="fnref-1">1</a></sup>')
    expect(html).toContain('<section class="footnotes"><ol><li id="fn-1">First note. <a href="#fnref-1">↩</a></li>')
    expect(html).toContain('<li id="fn-2">Second &amp; &lt;last&gt; &quot;note&quot; <a href="#fnref-2">↩</a></li>')
    expect(html).toContain('<title>T &amp; &lt;Title&gt;</title>')
    expect(html).not.toContain('<last>')
    expect(html).toContain('&lt;here&gt; &amp; there')
  })

  it('html: no footnote section without footnotes', () => {
    const doc = new Y.Doc()
    insertBlock(doc, 0, 'b1', 'Plain text.')
    expect(blocksToHtml(projectBlocks(doc, 'revised') as never, 't')).not.toContain('footnotes')
  })

  it('docx: real footnotes part with both notes and references in the body', async () => {
    const { blocks } = twoFootnotes()
    const files = unzip(await blocksToDocx(blocks as never, 'Doc'))
    expect(files['word/footnotes.xml']).toBeDefined()
    const notes = files['word/footnotes.xml']!
    expect(notes).toContain('First note.')
    expect(notes).toContain('Second &amp; &lt;last&gt; &quot;note&quot;')
    const body = files['word/document.xml']!
    expect(body.match(/<w:footnoteReference w:id="1"\/>/g)).toHaveLength(1)
    expect(body.match(/<w:footnoteReference w:id="2"\/>/g)).toHaveLength(1)
    expect(body.indexOf('w:id="1"')).toBeLessThan(body.indexOf('w:id="2"'))
  })
})

describe('markdown import of footnotes', () => {
  it('turns [^label] into a mark on the word before it and drops the definition', async () => {
    const src = 'Some claim here[^1] and more.\n\nAnother[^2] one.\n\n[^1]: Source note.\n[^2]: Second source.\n'
    const blocks = await fileToBlocks('notes.md', new TextEncoder().encode(src))
    const first = blocks.find((b) => b.delta.some((d) => d.attributes?.footnote))!
    expect(first.delta.map((d) => d.insert).join('')).toBe('Some claim here and more.')
    const marked = first.delta.filter((d) => d.attributes?.footnote)
    expect(marked).toEqual([{ insert: 'here', attributes: { footnote: { id: expect.any(String), note: 'Source note.' } } }])
    const notes = blocks.flatMap((b) => b.delta.map((d) => (d.attributes?.footnote as { note: string } | undefined)?.note)).filter(Boolean)
    expect(notes).toEqual(['Source note.', 'Second source.'])
    expect(blocks.some((b) => b.delta.some((d) => d.insert.includes('[^')))).toBe(false)
  })

  it('marks the right word after an emoji and survives a round trip', async () => {
    const src = 'Go 🚀word[^a] then 🎉 more[^b].\n\n[^a]: Rocket.\n[^b]: Party.\n'
    const imported = await fileToBlocks('notes.md', new TextEncoder().encode(src))
    expect(imported[0]!.delta).toEqual([
      { insert: 'Go ' },
      { insert: '🚀word', attributes: { footnote: { id: expect.any(String), note: 'Rocket.' } } },
      { insert: ' then 🎉 ' },
      { insert: 'more', attributes: { footnote: { id: expect.any(String), note: 'Party.' } } },
      { insert: '.' },
    ])
    const md = blocksToMarkdown(imported as never)
    expect(md).toContain('Go 🚀word[^1] then 🎉 more[^2].')
    const again = await fileToBlocks('notes.md', new TextEncoder().encode(md))
    expect(again[0]!.delta.map((d) => d.insert).join('')).toBe('Go 🚀word then 🎉 more.')
  })

  it('leaves footnote syntax inside fenced code as code', async () => {
    const src = 'A claim[^1].\n\n```\n[^ref]: x\nword[^ref]\n```\n\n~~~md\n[^1]: not this one\n~~~\n\n[^1]: Real note.\n'
    const blocks = await fileToBlocks('notes.md', new TextEncoder().encode(src))
    const code = blocks.filter((b) => b.type === 'codeBlock')
    expect(code.map((b) => b.delta)).toEqual([[{ insert: '[^ref]: x\nword[^ref]' }], [{ insert: '[^1]: not this one' }]])
    expect(blocks[0]!.delta).toEqual([{ insert: 'A ' }, { insert: 'claim', attributes: { footnote: { id: expect.any(String), note: 'Real note.' } } }, { insert: '.' }])
  })

  it('does not end a fence at a delimiter indented as code content', async () => {
    const src = 'A claim[^1].\n\n```\n    ```\n[^1]: in code\n```\n\nB claim[^2].\n\n[^1]: Real one.\n[^2]: Real two.\n'
    const blocks = await fileToBlocks('notes.md', new TextEncoder().encode(src))
    expect(blocks.find((b) => b.type === 'codeBlock')!.delta).toEqual([{ insert: '    ```\n[^1]: in code' }])
    const notes = blocks.flatMap((b) => b.delta.map((d) => (d.attributes?.footnote as { note: string } | undefined)?.note)).filter(Boolean)
    expect(notes).toEqual(['Real one.', 'Real two.'])
  })
})

describe('DocTools footnotes', () => {
  const setup = () => {
    const doc = new Y.Doc()
    insertBlock(doc, 0, 'b1', 'The quick brown fox jumps. The lazy dog sleeps.')
    return { doc, tools: new DocTools(doc, { author: AI, runId: 'r1' }) }
  }

  it('applies the footnote mark to the phrase, visible in projectBlocks', () => {
    const { doc, tools } = setup()
    const r = tools.addFootnote('b1', 'brown fox', 'Source: a book.')
    expect(r.ok).toBe(true)
    const b = projectBlocks(doc, 'revised')[0]!
    expect(b.delta).toEqual([
      { insert: 'The quick ' },
      { insert: 'brown fox', attributes: { footnote: { id: (r as { footnote_id: string }).footnote_id, note: 'Source: a book.' } } },
      { insert: ' jumps. The lazy dog sleeps.' },
    ])
    expect(b.text).toBe('The quick brown fox jumps. The lazy dog sleeps.')
  })

  it('errors on an ambiguous phrase, a missing phrase, and an empty note', () => {
    const { doc, tools } = setup()
    const amb = tools.addFootnote('b1', 'e', 'x')
    expect(amb.ok).toBe(false)
    expect((amb as { error: string }).error).toMatch(/more than once/)
    expect(tools.addFootnote('b1', 'cat', 'x').ok).toBe(false)
    expect(tools.addFootnote('b1', 'fox', '  ').ok).toBe(false)
    expect(tools.addFootnote('nope', 'fox', 'x').ok).toBe(false)
    expect(projectBlocks(doc, 'revised')[0]!.delta.some((d) => d.attributes?.footnote)).toBe(false)
  })

  it('lists footnotes after the blocks when reading, never inside the text', () => {
    const { tools } = setup()
    const result = tools.addFootnote('b1', 'lazy dog', 'Dogs sleep.')
    if (!result.ok) throw new Error(result.error)
    const read = tools.readBlocks({ block_ids: [result.new_block_id] })
    expect(read.startsWith(`[${result.new_block_id}] The quick brown fox jumps. The lazy dog sleeps.`)).toBe(true)
    expect(read).toContain(`\n\nFootnotes:\n[${result.new_block_id}] [^1] "lazy dog" → Dogs sleep.`)
  })
})

describe('footnote numbering agrees across packages', () => {
  it('@stetpad/clip and @stetpad/crdt number the same way', async () => {
    const { footnoteNotes } = await import('@stetpad/clip')
    const { footnotesOf } = await import('@stetpad/crdt')
    const run = (insert: string, id?: string, note = '') => (id ? { insert, attributes: { footnote: { id, note } } } : { insert })
    const blocks = [
      { delta: [run('a'), run('b', 'x', 'X'), run('c', 'y', 'Y')] },
      { delta: [run('d', 'x', 'X'), run('e', 'z', 'Z')] },
    ]
    expect(footnoteNotes(blocks).map((n) => [n.id, n.number])).toEqual(footnotesOf(blocks).map((n) => [n.id, n.number]))
  })
})
