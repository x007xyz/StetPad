import { createCanvas } from '@napi-rs/canvas'
import { findBlock, insertBlock, listChanges, projectBlocks } from '@stetpad/crdt'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  blocksToDocx,
  blocksToHtml,
  blocksToMarkdown,
  fileToBlocks,
  htmlToBlocks,
  pictureSize,
  type Block,
} from '../src/content'
import { DocTools, formatBlock, parseBlock } from '../src/tools'

const AI = 'AI'
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const para = (s: string): Block => ({ type: 'paragraph', attrs: {}, delta: s ? [{ insert: s }] : [] })

/** A one-PNG canvas: a real PNG so the docx path reads a real header. */
const tinyPng = (w = 4, h = 3): Uint8Array => new Uint8Array(createCanvas(w, h).toBuffer('image/png'))

describe('block notation: parse and format round-trip', () => {
  const roundTrip = (line: string): ReturnType<typeof parseBlock> => {
    const b = parseBlock(line)
    const again = parseBlock(formatBlock(b))
    expect(again).toEqual(b)
    return b
  }

  it('keeps the existing notations as they were', () => {
    expect(parseBlock('# Title')).toEqual({ type: 'heading', attrs: { level: 1 }, text: 'Title' })
    expect(parseBlock('## Sub')).toEqual({ type: 'heading', attrs: { level: 2 }, text: 'Sub' })
    expect(parseBlock('- item')).toEqual({ type: 'bulletItem', attrs: {}, text: 'item' })
    expect(parseBlock('1. first')).toEqual({ type: 'orderedItem', attrs: {}, text: 'first' })
    expect(parseBlock('- [x] done')).toEqual({ type: 'taskItem', attrs: { checked: true }, text: 'done' })
    expect(parseBlock('> quoted')).toEqual({ type: 'quote', attrs: {}, text: 'quoted' })
    expect(parseBlock('> [!NOTE] careful')).toEqual({ type: 'callout', attrs: {}, text: 'careful' })
    expect(parseBlock('---')).toEqual({ type: 'divider', attrs: {}, text: '' })
    expect(parseBlock('plain words')).toEqual({ type: 'paragraph', attrs: {}, text: 'plain words' })
    expect(parseBlock('[b1] # Prefixed')).toEqual({ type: 'heading', attrs: { level: 1 }, text: 'Prefixed' })
    for (const l of ['# Title', '- [ ] open', '> quoted', '> [!NOTE] note', '---', 'plain']) roundTrip(l)
  })

  it('code blocks keep their language', () => {
    expect(parseBlock('```python\nprint(1)\n```')).toEqual({ type: 'codeBlock', attrs: { language: 'python' }, text: 'print(1)' })
    expect(parseBlock('```\nplain\n```')).toEqual({ type: 'codeBlock', attrs: { language: '' }, text: 'plain' })
    roundTrip('```python\nprint(1)\n```')
    roundTrip('```\nplain\n```')
  })

  it('mermaid is a code block with the mermaid language', () => {
    const b = roundTrip('```mermaid\nflowchart LR\nA --> B\n```')
    expect(b).toEqual({ type: 'codeBlock', attrs: { language: 'mermaid' }, text: 'flowchart LR\nA --> B' })
  })

  it('math is a code block with the math language, multi-line or on one line', () => {
    expect(parseBlock('$$\nE = mc^2\n$$')).toEqual({ type: 'codeBlock', attrs: { language: 'math' }, text: 'E = mc^2' })
    expect(parseBlock('$$x^2 + y^2$$')).toEqual({ type: 'codeBlock', attrs: { language: 'math' }, text: 'x^2 + y^2' })
    expect(parseBlock('```math\na+b\n```')).toEqual({ type: 'codeBlock', attrs: { language: 'math' }, text: 'a+b' })
    expect(formatBlock({ type: 'codeBlock', attrs: { language: 'math' }, text: 'a+b' })).toBe('$$\na+b\n$$')
    roundTrip('$$\nE = mc^2\n$$')
  })

  it('images with and without a caption', () => {
    expect(parseBlock('![A cat](/files/abc-1)')).toEqual({
      type: 'image',
      attrs: { src: '/files/abc-1', alt: 'A cat', caption: '' },
      text: '',
    })
    expect(parseBlock('![A cat](https://example.com/cat.png "Our cat")')).toEqual({
      type: 'image',
      attrs: { src: 'https://example.com/cat.png', alt: 'A cat', caption: 'Our cat' },
      text: '',
    })
    roundTrip('![A cat](/files/abc-1 "Our cat")')
    expect(formatBlock({ type: 'image', attrs: { src: '/files/x', alt: 'a', caption: 'c' }, text: '' })).toBe('![a](/files/x "c")')
  })

  it('an image with a source the notation does not accept is a paragraph', () => {
    expect(parseBlock('![x](javascript:alert(1))').type).toBe('paragraph')
    expect(parseBlock('![x](data:image/png;base64,AAAA)').type).toBe('paragraph')
  })

  it('videos: uploaded files and allowed embed hosts', () => {
    expect(parseBlock('!video[Demo](/files/v1)')).toEqual({
      type: 'video',
      attrs: { src: '/files/v1', kind: 'file', title: 'Demo', caption: '' },
      text: '',
    })
    expect(parseBlock('!video[Talk](https://www.youtube.com/embed/abc "The talk")')).toEqual({
      type: 'video',
      attrs: { src: 'https://www.youtube.com/embed/abc', kind: 'embed', title: 'Talk', caption: 'The talk' },
      text: '',
    })
    expect(parseBlock('!video[B](https://player.bilibili.com/player.html?bvid=x)').attrs.kind).toBe('embed')
    expect(parseBlock('!video[V](https://vimeo.com/123)').attrs.kind).toBe('embed')
    roundTrip('!video[Demo](/files/v1 "Caption")')
    roundTrip('!video[Talk](https://youtu.be/dQw4w9WgXcQ)')
  })

  it('a video from another host is a paragraph', () => {
    expect(parseBlock('!video[x](https://evil.example.com/v.mp4)').type).toBe('paragraph')
    expect(parseBlock('!video[x](http://youtube.com/embed/abc)').type).toBe('paragraph')
  })

  it('draw.io diagrams keep their XML', () => {
    const xml = '<mxfile><diagram>abc</diagram></mxfile>'
    expect(parseBlock('```drawio\n' + xml + '\n```')).toEqual({ type: 'drawio', attrs: { xml }, text: '' })
    roundTrip('```drawio\n' + xml + '\n```')
  })

  it('a draw.io placeholder carries no XML, so the stored XML is kept', () => {
    expect(parseBlock('```drawio\n[draw.io diagram, 40000 chars — not shown]\n```')).toEqual({ type: 'drawio', attrs: {}, text: '' })
  })

  it('draw.io XML over 30000 characters is shown as the placeholder', () => {
    const xml = '<mxfile>' + 'x'.repeat(30000) + '</mxfile>'
    expect(formatBlock({ type: 'drawio', attrs: { xml }, text: '' })).toBe(
      `\`\`\`drawio\n[draw.io diagram, ${xml.length} chars — not shown]\n\`\`\``,
    )
    const short = '<mxfile/>'
    expect(formatBlock({ type: 'drawio', attrs: { xml: short }, text: '' })).toBe('```drawio\n<mxfile/>\n```')
  })
})

/** A document with the given blocks, built the way the server stores them. */
function docWith(blocks: { id: string; type: string; text?: string; attrs?: Record<string, unknown> }[]): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => {
    blocks.forEach((b, i) => insertBlock(doc, i, b.id, b.text ?? '', b.type, b.attrs ?? {}))
  })
  return doc
}

describe('DocTools on the new block types', () => {
  const meta = { author: AI, runId: 'r1' }

  it('a new caption on an image is a pending change, and the image keeps its attributes', () => {
    const doc = docWith([
      { id: 'p1', type: 'paragraph', text: 'Intro' },
      { id: 'img1', type: 'image', attrs: { src: '/files/abc', alt: 'cat', caption: '', width: 50 } },
    ])
    const tools = new DocTools(doc, meta)
    const r = tools.replaceBlock('img1', '![cat](/files/abc "A cat asleep")', 'add caption')
    expect(r.ok).toBe(true)
    if (!r.ok || !('new_block_id' in r)) throw new Error('expected a replacement')
    expect(r.change_ids).toHaveLength(1)
    // The original element is untouched: the edit is a suggestion, not a mutation.
    expect(findBlock(doc, 'img1')!.getAttribute('caption')).toBe('')
    expect(listChanges(doc).some((c) => c.id === r.change_ids[0])).toBe(true)

    const revised = projectBlocks(doc, 'revised')
    const replacement = revised.find((b) => b.blockId === r.new_block_id)!
    expect(replacement.type).toBe('image')
    expect(replacement.attrs).toMatchObject({ src: '/files/abc', alt: 'cat', caption: 'A cat asleep', width: 50 })
    expect(revised.some((b) => b.blockId === 'img1')).toBe(false)
    expect(projectBlocks(doc, 'original').find((b) => b.blockId === 'img1')!.attrs.caption).toBe('')
  })

  it('an image notation that changes nothing is ok with no change', () => {
    const doc = docWith([{ id: 'img1', type: 'image', attrs: { src: '/files/abc', alt: 'cat', caption: 'c' } }])
    const r = new DocTools(doc, meta).replaceBlock('img1', '![cat](/files/abc "c")')
    expect(r).toMatchObject({ ok: true, change_ids: [] })
    expect(listChanges(doc)).toHaveLength(0)
  })

  it('a draw.io placeholder keeps the stored XML and preview', () => {
    const doc = docWith([{ id: 'd1', type: 'drawio', attrs: { xml: '<mxfile/>', preview: '/files/png1', caption: 'old' } }])
    const tools = new DocTools(doc, meta)
    const same = tools.replaceBlock('d1', '```drawio\n[draw.io diagram, 9000 chars — not shown]\n```')
    expect(same).toMatchObject({ ok: true, change_ids: [] })
    const cap = tools.replaceBlock('d1', '```drawio\n[draw.io diagram, 9000 chars — not shown]\n```\n')
    expect(cap).toMatchObject({ ok: true, change_ids: [] })
  })

  it('a new draw.io XML is a pending replacement and drops the stale preview', () => {
    const doc = docWith([{ id: 'd1', type: 'drawio', attrs: { xml: '<mxfile/>', preview: '/files/png1' } }])
    const r = new DocTools(doc, meta).replaceBlock('d1', '```drawio\n<mxfile><diagram/></mxfile>\n```')
    expect(r.ok).toBe(true)
    if (!r.ok || !('new_block_id' in r)) throw new Error('expected a replacement')
    const nb = projectBlocks(doc, 'revised').find((b) => b.blockId === r.new_block_id)!
    // The preview PNG shows the old diagram, so it is cleared with the new XML.
    expect(nb.attrs).toEqual({ xml: '<mxfile><diagram/></mxfile>', preview: '' })
  })

  it('a code block language change is tracked, not silently applied', () => {
    const doc = docWith([{ id: 'c1', type: 'codeBlock', text: 'graph TD', attrs: { language: '' } }])
    const r = new DocTools(doc, meta).replaceBlock('c1', '```mermaid\ngraph TD\n```')
    expect(r.ok).toBe(true)
    if (!r.ok || !('new_block_id' in r)) throw new Error('expected a replacement')
    expect(findBlock(doc, 'c1')!.getAttribute('language')).toBe('')
    const nb = projectBlocks(doc, 'revised').find((b) => b.blockId === r.new_block_id)!
    expect(nb).toMatchObject({ type: 'codeBlock', text: 'graph TD', attrs: { language: 'mermaid' } })
    expect(listChanges(doc).some((c) => c.id === r.change_ids[0])).toBe(true)
  })

  it('readBlocks shows the notation of the new blocks to the agent', () => {
    const doc = docWith([
      { id: 'img1', type: 'image', attrs: { src: '/files/abc', alt: 'cat', caption: 'Cute' } },
      { id: 'c1', type: 'codeBlock', text: 'flowchart LR', attrs: { language: 'mermaid' } },
      { id: 'm1', type: 'codeBlock', text: 'x^2', attrs: { language: 'math' } },
    ])
    const out = new DocTools(doc, meta).readAll()
    expect(out).toContain('[img1] ![cat](/files/abc "Cute")')
    expect(out).toContain('[c1] ```mermaid\nflowchart LR\n```')
    expect(out).toContain('[m1] $$\nx^2\n$$')
  })

  it('insertBlocks keeps the attributes of new blocks', () => {
    const doc = docWith([{ id: 'p1', type: 'paragraph', text: 'Intro' }])
    const r = new DocTools(doc, meta).insertBlocks('p1', ['!video[Demo](/files/v1 "Cap")'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const nb = projectBlocks(doc, 'revised').find((b) => b.blockId === r.new_block_ids[0])!
    expect(nb).toMatchObject({ type: 'video', attrs: { src: '/files/v1', kind: 'file', title: 'Demo', caption: 'Cap' } })
  })
})

describe('import', () => {
  it('a markdown mermaid fence keeps its language', async () => {
    const blocks = await fileToBlocks('a.md', enc('```mermaid\nflowchart LR\nA-->B\n```\n'))
    expect(blocks).toEqual([{ type: 'codeBlock', attrs: { language: 'mermaid' }, delta: [{ insert: 'flowchart LR\nA-->B' }] }])
  })

  it('markdown display math becomes a math code block, multi-line and single-line', async () => {
    const md = 'Before\n\n$$\nE = mc^2\n$$\n\nBetween\n\n$$a+b$$\n'
    const blocks = await fileToBlocks('a.md', enc(md))
    const math = blocks.filter((b) => b.type === 'codeBlock')
    expect(math.map((b) => [b.attrs.language, b.delta.map((d) => d.insert).join('')])).toEqual([
      ['math', 'E = mc^2'],
      ['math', 'a+b'],
    ])
    expect(blocks.find((b) => b.type === 'paragraph' && b.delta[0]?.insert === 'Before')).toBeTruthy()
  })

  it('display math inside a fenced code block stays code', async () => {
    const md = '~~~text\n$$NAME$$\n~~~\n\n```\n$$\nx\n$$\n```\n'
    const blocks = await fileToBlocks('a.md', enc(md))
    expect(blocks.map((b) => [b.attrs.language, b.delta.map((d) => d.insert).join('')])).toEqual([
      ['text', '$$NAME$$'],
      ['', '$$\nx\n$$'],
    ])
  })

  it('display math is found in a file with CRLF line endings', async () => {
    const blocks = await fileToBlocks('a.md', enc('Before\r\n\r\n$$a+b$$\r\n'))
    expect(blocks.filter((b) => b.type === 'codeBlock').map((b) => [b.attrs.language, b.delta.map((d) => d.insert).join('')])).toEqual([['math', 'a+b']])
  })

  it('a code span on its own line does not hide later display math', async () => {
    const blocks = await fileToBlocks('a.md', enc('```foo```\n\n$$a+b$$\n'))
    expect(blocks.filter((b) => b.type === 'codeBlock').map((b) => [b.attrs.language, b.delta.map((d) => d.insert).join('')])).toEqual([['math', 'a+b']])
  })

  it('a markdown image with a title becomes an image with a caption', async () => {
    const blocks = await fileToBlocks('a.md', enc('![A cat](/files/abc "Asleep")\n'))
    expect(blocks).toEqual([{ type: 'image', attrs: { src: '/files/abc', alt: 'A cat', caption: 'Asleep' }, delta: [] }])
  })

  it('figure and figcaption become an image with a caption and a width', () => {
    const blocks = htmlToBlocks('<figure><img src="/files/abc" alt="cat" data-width="60"><figcaption>  A   cat </figcaption></figure>')
    expect(blocks).toEqual([{ type: 'image', attrs: { src: '/files/abc', alt: 'cat', caption: 'A cat', width: 60 }, delta: [] }])
  })

  it('pre code with a language class keeps the language', () => {
    const blocks = htmlToBlocks('<pre><code class="language-mermaid">graph TD</code></pre>')
    expect(blocks).toEqual([{ type: 'codeBlock', attrs: { language: 'mermaid' }, delta: [{ insert: 'graph TD' }] }])
  })

  it('video elements and allowed iframes are imported, others are dropped', () => {
    const blocks = htmlToBlocks(
      '<video src="/files/v1" title="Demo"></video>' +
        '<iframe src="https://www.youtube.com/embed/abc" title="Talk"></iframe>' +
        '<iframe src="https://evil.example.com/x"></iframe>' +
        '<video src="javascript:alert(1)"></video>',
    )
    expect(blocks).toEqual([
      { type: 'video', attrs: { src: '/files/v1', kind: 'file', title: 'Demo', caption: '' }, delta: [] },
      { type: 'video', attrs: { src: 'https://www.youtube.com/embed/abc', kind: 'embed', title: 'Talk', caption: '' }, delta: [] },
    ])
  })

  it('a figure with a video takes the figcaption as its caption', () => {
    const blocks = htmlToBlocks('<figure><video src="/files/v2"></video><figcaption>Clip</figcaption></figure>')
    expect(blocks).toEqual([{ type: 'video', attrs: { src: '/files/v2', kind: 'file', title: '', caption: 'Clip' }, delta: [] }])
  })
})

describe('export', () => {
  it.each([
    '1. a\n2. b\n\nend paragraph',
    '- a\n- b\n\n# Heading',
  ])('separates a list from the following block through Markdown round-trip: %s', async (md) => {
    const blocks = await fileToBlocks('list.md', enc(md))
    expect(await fileToBlocks('list.md', enc(blocksToMarkdown(blocks)))).toEqual(blocks)
    expect(blocksToMarkdown(blocks)).toBe(md + '\n')
  })

  it.each([
    ['ordered', '1. a\n   1. a1\n2. b', 'ol'],
    ['bullet', '- a\n  - a1\n- b', 'ul'],
    ['mixed', '1. a\n   - a1\n2. b', 'ol'],
  ])('preserves nested %s lists through Markdown round-trip', async (_, md) => {
    const blocks = await fileToBlocks('list.md', enc(md))
    expect(blocks.map((b) => b.attrs.indent)).toEqual([0, 1, 0])
    expect(await fileToBlocks('list.md', enc(blocksToMarkdown(blocks)))).toEqual(blocks)
  })

  it.each([
    ['ordered', '1. a\n   1. a1\n2. b', 'ol', 'ol'],
    ['bullet', '- a\n  - a1\n- b', 'ul', 'ul'],
    ['mixed', '1. a\n   - a1\n2. b', 'ol', 'ul'],
  ])('preserves nested %s lists in HTML export', async (_, md, outer, inner) => {
    const blocks = await fileToBlocks('list.md', enc(md))
    const html = blocksToHtml(blocks, 'Lists')
    expect(html.replace(/\n/g, '')).toContain(`<${outer}><li>a<${inner}><li>a1</li></${inner}></li><li>b</li></${outer}>`)
    expect(htmlToBlocks(html.split('<body>')[1]!.split('</body>')[0]!)).toEqual(blocks)
  })

  it.each([
    '',
    '1. a\n   1. a1\n      - deep\n   - other\n2. b\n\n# End\n\n1. restart',
    '- [ ] a\n  - [x] child\n- [ ] b',
    Array.from({ length: 11 }, (_, i) => `${i + 1}. item ${i}${i === 9 ? '\n    1. child' : ''}`).join('\n'),
  ])('round-trips list boundaries, tasks, and wide markers: %s', async (md) => {
    const blocks = await fileToBlocks('list.md', enc(md))
    expect(await fileToBlocks('list.md', enc(blocksToMarkdown(blocks)))).toEqual(blocks)
    const html = blocksToHtml(blocks, 'Lists')
    expect(htmlToBlocks(html.split('<body>')[1]!.split('</body>')[0]!)).toEqual(blocks)
  })

  const image: Block = { type: 'image', attrs: { src: '/files/abc', alt: 'cat', caption: 'A cat', width: 60 }, delta: [] }
  const mermaid: Block = { blockId: 'm1', type: 'codeBlock', attrs: { language: 'mermaid' }, delta: [{ insert: 'graph TD' }] }
  const math: Block = { blockId: 'x1', type: 'codeBlock', attrs: { language: 'math' }, delta: [{ insert: 'x^2' }] }
  const file: Block = { type: 'video', attrs: { src: '/files/v1', kind: 'file', title: 'Demo', caption: 'Clip' }, delta: [] }
  const embed: Block = { type: 'video', attrs: { src: 'https://youtu.be/dQw4w9WgXcQ', kind: 'embed', title: 'Talk', caption: '' }, delta: [] }
  const drawWithPreview: Block = { type: 'drawio', attrs: { xml: '<mxfile/>', preview: '/files/png1', caption: 'Flow' }, delta: [] }
  const drawNoPreview: Block = { type: 'drawio', attrs: { xml: '<mxfile><diagram/></mxfile>', preview: '' }, delta: [] }

  it('markdown writes each new block in its notation', () => {
    const md = blocksToMarkdown([image, mermaid, math, file, embed, drawWithPreview, drawNoPreview])
    expect(md).toContain('![cat](/files/abc "A cat")')
    expect(md).toContain('```mermaid\ngraph TD\n```')
    expect(md).toContain('$$\nx^2\n$$')
    expect(md).toContain('<video src="/files/v1" controls></video>')
    expect(md).toContain('*Clip*')
    expect(md).toContain('[▶ Talk](https://youtu.be/dQw4w9WgXcQ)')
    expect(md).toContain('![Flow](/files/png1)')
    expect(md).toContain('```drawio\n<mxfile><diagram/></mxfile>\n```')
  })

  it('markdown export imports back with the same captions and languages', async () => {
    const md = blocksToMarkdown([image, mermaid, math])
    const back = await fileToBlocks('a.md', enc(md))
    expect(back.find((b) => b.type === 'image')!.attrs).toMatchObject({ src: '/files/abc', alt: 'cat', caption: 'A cat' })
    expect(back.filter((b) => b.type === 'codeBlock').map((b) => b.attrs.language)).toEqual(['mermaid', 'math'])
  })

  it('html writes figures, video, iframe and escapes attributes', () => {
    const html = blocksToHtml(
      [image, file, embed, { type: 'image', attrs: { src: '/files/x"><script>', alt: '"', caption: '<b>' }, delta: [] }],
      'T',
    )
    expect(html).toContain('<figure><img src="/files/abc" alt="cat" style="width:60%"><figcaption>A cat</figcaption></figure>')
    expect(html).toContain('<video controls src="/files/v1" title="Demo"></video>')
    expect(html).toContain('<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" title="Talk" allowfullscreen></iframe>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;b&gt;')
  })

  it('html uses the browser render for mermaid and math when one is given', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>'
    const html = blocksToHtml([mermaid, math], 'T', { renders: { m1: svg } })
    expect(html).toContain(`<figure class="diagram">${svg}</figure>`)
    expect(html).toContain('<pre><code class="language-math">x^2</code></pre>')
    expect(html).not.toContain('language-mermaid')
  })

  it('html shows a draw.io preview, or a note when there is none', () => {
    const html = blocksToHtml([drawWithPreview, drawNoPreview], 'T')
    expect(html).toContain('<figure><img src="/files/png1" alt="Flow"><figcaption>Flow</figcaption></figure>')
    expect(html).toContain('[draw.io 图]')
  })

  it('html export imports back with the same captions and languages', () => {
    // Only the body: a full document's <title> would be read as text.
    const full = blocksToHtml([image, mermaid], 'T')
    const body = full.slice(full.indexOf('<body>') + 6, full.indexOf('</body>'))
    const back = htmlToBlocks(body)
    expect(back[0]).toMatchObject({ type: 'image', attrs: { src: '/files/abc', alt: 'cat', caption: 'A cat', width: 60 } })
    expect(back[1]).toMatchObject({ type: 'codeBlock', attrs: { language: 'mermaid' } })
  })

  it('reads the dimensions of a PNG, GIF and JPEG header', () => {
    expect(pictureSize(tinyPng(4, 3))).toMatchObject({ type: 'png', width: 4, height: 3 })
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x07, 0x00, 0x05, 0x00])
    expect(pictureSize(gif)).toMatchObject({ type: 'gif', width: 7, height: 5 })
    // A minimal JPEG: SOI, a 2-byte APP0 segment, then SOF0 for 9x6.
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x06, 0x00, 0x09, 0x01, 0x01, 0x11, 0x00])
    expect(pictureSize(jpg)).toMatchObject({ type: 'jpg', width: 9, height: 6 })
    expect(pictureSize(enc('not an image at all'))).toBeNull()
  })

  it('docx with a fake asset loader embeds the PNG and does not throw', async () => {
    const png = tinyPng(40, 30)
    const blocks: Block[] = [
      para('Intro'),
      image,
      { type: 'image', attrs: { src: '/files/missing', alt: 'gone', caption: '' }, delta: [] },
      mermaid,
      file,
      drawWithPreview,
    ]
    const bytes = await blocksToDocx(blocks, 'Doc', {
      loadAsset: async (src) => (src === '/files/missing' ? null : { mime: 'image/png', data: png }),
      renders: { m1: { png, width: 40, height: 30 } },
    })
    expect(bytes.byteLength).toBeGreaterThan(1000)
    // A zip archive, whose entry names are stored in clear text.
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe('PK')
    const text = Buffer.from(bytes).toString('latin1')
    // Entry names are stored in clear text; the document body itself is compressed.
    expect(text).toContain('word/media/')
    expect(text).toContain('word/document.xml')
  })

  it('docx without any options still builds, with text fallbacks', async () => {
    const bytes = await blocksToDocx([image, mermaid, math, file, drawNoPreview], 'Doc')
    expect(bytes.byteLength).toBeGreaterThan(1000)
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe('PK')
  })
})
