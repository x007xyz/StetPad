import { createCanvas } from '@napi-rs/canvas'
import { blockText, compact, decide, findBlock, insertBlock, listChanges, listComments, projectBlocks, trackedInsert } from '@stetpad/crdt'
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
    expect(parseBlock('[Draft] words')).toEqual({ type: 'paragraph', attrs: {}, text: '[Draft] words' })
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

  it.each(['accept', 'reject'] as const)('footnote replacement requires approval: %s', (decision) => {
    const doc = docWith([{ id: 'b1', type: 'paragraph', text: 'A human claim.' }])
    const human = { id: 'human', note: 'Human source' }
    blockText(findBlock(doc, 'b1')!).format(2, 5, { footnote: human })
    const original = projectBlocks(doc, 'original')[0]!.delta
    const result = new DocTools(doc, meta).addFootnote('b1', 'human', 'AI source')
    expect(result.ok).toBe(true)
    expect(projectBlocks(doc, 'original')[0]!.delta).toEqual(original)
    const pending = listChanges(doc)
    expect(pending).toHaveLength(1)
    expect(projectBlocks(doc, 'revised')[0]!.delta[1]!.attributes?.footnote).toMatchObject({ note: 'AI source' })
    decide(doc, pending[0]!.id, decision)
    compact(doc)
    expect(listChanges(doc)).toHaveLength(0)
    expect(projectBlocks(doc, 'original')).toHaveLength(1)
    if (decision === 'accept') {
      expect(projectBlocks(doc, 'original')[0]!.delta[1]!.attributes?.footnote).toMatchObject({ note: 'AI source' })
    } else {
      expect(projectBlocks(doc, 'original')[0]!.delta).toEqual(original)
    }
  })

  it('footnote replacement preserves other marks and comment anchors', () => {
    const doc = docWith([{ id: 'b1', type: 'heading', attrs: { level: 2 }, text: 'A human claim.' }])
    const text = blockText(findBlock(doc, 'b1')!)
    text.format(2, 3, { link: { href: 'https://example.com' }, math: true })
    const tools = new DocTools(doc, meta)
    tools.addComment('b1', 'human', 'Keep this')
    const result = tools.addFootnote('b1', 'human', 'Source')
    if (!result.ok) throw new Error(result.error)
    decide(doc, result.change_ids[0]!, 'accept')
    compact(doc)
    const block = projectBlocks(doc, 'original')[0]!
    expect(block).toMatchObject({ type: 'heading', attrs: { level: 2 }, text: 'A human claim.' })
    expect(block.delta[1]).toMatchObject({ insert: 'hum', attributes: { link: { href: 'https://example.com' }, math: true, footnote: { note: 'Source' } } })
    expect(listComments(doc)[0]).toMatchObject({ quote: 'human', orphaned: false, blockId: result.new_block_id })
  })

  it('footnote replacement refuses pending revisions without changing the document', () => {
    const doc = docWith([{ id: 'b1', type: 'paragraph', text: 'A human claim.' }])
    trackedInsert(doc, blockText(findBlock(doc, 'b1')!), 14, ' pending', meta)
    const before = Y.encodeStateAsUpdate(doc)
    expect(new DocTools(doc, meta).addFootnote('b1', 'human', 'Source')).toEqual({ ok: false, error: 'block has pending changes; resolve them before changing its footnotes' })
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })

  it('refuses attribute changes while another text revision is pending', () => {
    const doc = docWith([{ id: 'h1', type: 'heading', attrs: { level: 1 }, text: 'Title' }])
    const tools = new DocTools(doc, meta)
    tools.readAll()
    const changeId = trackedInsert(doc, blockText(findBlock(doc, 'h1')!), 5, ' pending', { author: 'Other' })
    if (!changeId) throw new Error('expected a pending insertion')
    const before = listChanges(doc)
    expect(tools.replaceBlock('h1', '## Title')).toEqual({ ok: false, error: 'block has pending changes; resolve them before changing its attributes' })
    expect(listChanges(doc)).toEqual(before)
    expect(projectBlocks(doc, 'physical')).toHaveLength(1)
    expect(findBlock(doc, 'h1')!.getAttribute('level')).toBe(1)
    decide(doc, changeId, 'reject')
    compact(doc)
    expect(projectBlocks(doc, 'original')[0]!.text).toBe('Title')
  })

  it('an attribute replacement applies requested inline math', () => {
    const doc = docWith([{ id: 'h1', type: 'heading', attrs: { level: 1 }, text: 'Area x' }])
    const r = new DocTools(doc, meta).replaceBlock('h1', '## Area $x$')
    if (!r.ok) throw new Error(r.error)
    decide(doc, r.change_ids[0]!, 'accept')
    compact(doc)
    expect(projectBlocks(doc, 'original')[0]).toMatchObject({ attrs: { level: 2 }, delta: [{ insert: 'Area ' }, { insert: 'x', attributes: { math: true } }] })
  })

  it('refuses baseline math offsets after an untracked user edit', () => {
    const doc = docWith([{ id: 'h1', type: 'heading', attrs: { level: 1 }, text: 'Area x' }])
    const tools = new DocTools(doc, meta)
    tools.readAll()
    const text = blockText(findBlock(doc, 'h1')!)
    text.delete(0, 6)
    text.insert(0, 'Big area x')
    expect(tools.replaceBlock('h1', '## Area $x$')).toEqual({ ok: false, error: 'block changed since it was read; read it again before adding math' })
    expect(listChanges(doc)).toHaveLength(0)
    expect(projectBlocks(doc, 'physical')).toHaveLength(1)
    expect(projectBlocks(doc, 'original')[0]).toMatchObject({ attrs: { level: 1 }, delta: [{ insert: 'Big area x' }] })
  })

  it('an attribute replacement preserves links, footnotes and inline math after acceptance', () => {
    const doc = docWith([{ id: 'h1', type: 'heading', attrs: { level: 1 }, text: 'Link note x' }])
    const text = blockText(findBlock(doc, 'h1')!)
    text.format(0, 4, { link: { href: 'https://example.com' } })
    text.format(5, 4, { footnote: { id: 'fn1', note: 'Source' } })
    text.format(10, 1, { math: true })
    const delta = projectBlocks(doc, 'revised')[0]!.delta
    const r = new DocTools(doc, meta).replaceBlock('h1', '## Link note $x$')
    if (!r.ok) throw new Error(r.error)
    decide(doc, r.change_ids[0]!, 'accept')
    compact(doc)
    expect(projectBlocks(doc, 'original')[0]!.delta).toEqual(delta)
  })

  it('an attribute replacement preserves a user edit made after the agent read', () => {
    const doc = docWith([{ id: 'h1', type: 'heading', attrs: { level: 1 }, text: 'Title' }])
    const tools = new DocTools(doc, meta)
    tools.readAll()
    blockText(findBlock(doc, 'h1')!).insert(5, ' updated by user')
    const r = tools.replaceBlock('h1', '## Title')
    if (!r.ok) throw new Error(r.error)
    decide(doc, r.change_ids[0]!, 'accept')
    compact(doc)
    expect(projectBlocks(doc, 'original')[0]).toMatchObject({ attrs: { level: 2 }, text: 'Title updated by user' })
  })

  it('an attribute replacement keeps comment anchors after acceptance and compaction', () => {
    const doc = docWith([{ id: 'h1', type: 'heading', attrs: { level: 1 }, text: 'Title' }])
    const tools = new DocTools(doc, meta)
    const comment = tools.addComment('h1', 'Title', 'Keep this')
    const r = tools.replaceBlock('h1', '## Title')
    if (!r.ok || !('new_block_id' in r)) throw new Error('expected a replacement')
    decide(doc, r.change_ids[0]!, 'accept')
    compact(doc)
    expect(listComments(doc)).toEqual([expect.objectContaining({ id: comment.comment_id, blockId: r.new_block_id, orphaned: false })])
  })

  it('rejects a combined text and attribute edit without changing the document', () => {
    const doc = docWith([{ id: 'h1', type: 'heading', attrs: { level: 1 }, text: 'Title' }])
    const r = new DocTools(doc, meta).replaceBlock('h1', '## New title')
    expect(r).toEqual({ ok: false, error: 'make text edits and attribute changes in separate calls' })
    expect(listChanges(doc)).toHaveLength(0)
    expect(projectBlocks(doc, 'original')[0]).toMatchObject({ attrs: { level: 1 }, text: 'Title' })
  })

  describe.each([
    { type: 'heading', attrs: { level: 1 }, next: { level: 2 }, content: '## Title', text: 'Title' },
    { type: 'taskItem', attrs: { checked: false }, next: { checked: true }, content: '- [x] Task', text: 'Task' },
  ])('$type attribute approval', ({ type, attrs, next, content, text }) => {
    it.each(['accept', 'reject'] as const)('keeps the original until %s', (decision) => {
      const doc = docWith([{ id: 'b1', type, attrs, text }])
      const original = projectBlocks(doc, 'original')
      const r = new DocTools(doc, meta).replaceBlock('b1', content)
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error(r.error)
      expect(r.change_ids).toHaveLength(1)
      expect(projectBlocks(doc, 'original')).toEqual(original.map((b) => ({ ...b, state: 'del' })))
      expect(findBlock(doc, 'b1')!.getAttributes()).toMatchObject(attrs)
      expect(projectBlocks(doc, 'revised')[0]).toMatchObject({ type, attrs: next, text })
      expect(listChanges(doc)).toHaveLength(1)
      decide(doc, r.change_ids[0]!, decision)
      compact(doc)
      expect(projectBlocks(doc, 'original')[0]).toMatchObject({ type, attrs: decision === 'accept' ? next : attrs, text })
      expect(listChanges(doc)).toHaveLength(0)
    })

    it('does not propose an unchanged attribute', () => {
      const doc = docWith([{ id: 'b1', type, attrs: next, text }])
      expect(new DocTools(doc, meta).replaceBlock('b1', content)).toMatchObject({ ok: true, change_ids: [] })
      expect(listChanges(doc)).toHaveLength(0)
    })

    it('does not replace a block pending deletion', () => {
      const doc = docWith([{ id: 'b1', type, attrs, text }])
      const tools = new DocTools(doc, meta)
      tools.deleteBlock('b1')
      expect(tools.replaceBlock('b1', content)).toMatchObject({ ok: false, error: 'block b1 is pending deletion' })
      expect(findBlock(doc, 'b1')!.getAttributes()).toMatchObject(attrs)
    })
  })

  const richDelta = [
    { insert: 'bold', attributes: { bold: true } },
    { insert: ' link', attributes: { link: 'https://example.com' } },
    { insert: ' note', attributes: { footnote: { id: 'fn1', note: 'A note' } } },
    { insert: ' x', attributes: { math: true } },
  ]
  const richDoc = (type = 'paragraph') => {
    const doc = docWith([{ id: 'p1', type, attrs: type === 'codeBlock' ? { language: 'js' } : {}, text: ' ' }])
    const t = findBlock(doc, 'p1')!.toArray()[0] as Y.XmlText
    t.delete(0, 1)
    t.applyDelta(richDelta)
    return doc
  }

  const expectAcceptedDelta = (
    doc: Y.Doc,
    r: ReturnType<DocTools['replaceBlock']> | ReturnType<DocTools['moveBlock']>,
    expected: Block['delta'] = richDelta,
  ) => {
    expect(r.ok).toBe(true)
    if (!r.ok || !('new_block_id' in r)) throw new Error('expected a replacement')
    expect(projectBlocks(doc, 'revised')[0]!.delta).toEqual(expected)
    for (const id of r.change_ids) expect(decide(doc, id, 'accept')).toBe(true)
    expect(projectBlocks(doc, 'revised')[0]!.delta).toEqual(expected)
  }

  it('moving a block preserves its inline marks after acceptance', () => {
    const doc = richDoc()
    const r = new DocTools(doc, meta).moveBlock('p1', null)
    expectAcceptedDelta(doc, r)
  })

  it('paragraph to heading conversion preserves inline marks after acceptance', () => {
    const doc = richDoc()
    const r = new DocTools(doc, meta).replaceBlock('p1', '# bold link note $x$')
    expectAcceptedDelta(doc, r)
  })

  it('a codeBlock language change preserves carried inline marks after acceptance', () => {
    const doc = richDoc('codeBlock')
    const r = new DocTools(doc, meta).replaceBlock('p1', '```ts\nbold link note x\n```')
    expectAcceptedDelta(doc, r)
  })

  it('heading conversion preserves existing marks and leaves added text plain after acceptance', () => {
    const doc = richDoc()
    const r = new DocTools(doc, meta).replaceBlock('p1', '# bold link note $x$ added')
    expectAcceptedDelta(doc, r, [...richDelta, { insert: ' added' }])
  })

  it('conversion treats inline Markdown as literal text, not new marks', () => {
    const doc = richDoc()
    const r = new DocTools(doc, meta).replaceBlock('p1', '# **new** [label](https://example.org)')
    expectAcceptedDelta(doc, r, [{ insert: '**new** [label](https://example.org)' }])
  })

  it('moving handles empty and missing blocks', () => {
    const doc = docWith([{ id: 'p1', type: 'paragraph', text: '' }])
    const tools = new DocTools(doc, meta)
    expect(tools.moveBlock('missing', null)).toMatchObject({ ok: false })
    expectAcceptedDelta(doc, tools.moveBlock('p1', null), [])
  })

  it('conversion handles empty and missing blocks', () => {
    const doc = docWith([{ id: 'p1', type: 'paragraph', text: '' }])
    const tools = new DocTools(doc, meta)
    expect(tools.replaceBlock('missing', '# ')).toMatchObject({ ok: false })
    expectAcceptedDelta(doc, tools.replaceBlock('p1', '# '), [])
  })

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

  it('replaceBlock keeps leading bracket text that is not a block id', () => {
    const doc = docWith([{ id: 'p1', type: 'paragraph', text: '[Draft] Keep this' }])
    const tools = new DocTools(doc, meta)
    expect(tools.replaceBlock('p1', '[Draft] Keep this')).toMatchObject({ ok: true, change_ids: [] })
    expect(tools.replaceBlock('p1', '[p1] [Draft] Keep this')).toMatchObject({ ok: true, change_ids: [] })
    expect(listChanges(doc)).toHaveLength(0)
  })

  it('insertBlocks drops only a block-id prefix', () => {
    const doc = docWith([{ id: 'p1', type: 'paragraph', text: 'First' }])
    const r = new DocTools(doc, meta).insertBlocks('p1', ['[TODO] Write intro', '[p1] # Echoed'])
    if (!r.ok) throw new Error(r.error)
    decide(doc, r.change_ids[0]!, 'accept')
    compact(doc)
    expect(projectBlocks(doc, 'original').map((b) => [b.type, b.text])).toEqual([
      ['paragraph', 'First'],
      ['paragraph', '[TODO] Write intro'],
      ['heading', 'Echoed'],
    ])
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

  it('keeps display math delimiters literal in indented code', async () => {
    const md = '    $$NAME$$\n\n\t$$\n\tx\n\t$$\n\n   $$y$$\n'
    const blocks = await fileToBlocks('a.md', enc(md))
    expect(blocks).toEqual([
      { type: 'codeBlock', attrs: { language: '' }, delta: [{ insert: '$$NAME$$\n\n$$\nx\n$$' }] },
      { type: 'codeBlock', attrs: { language: 'math' }, delta: [{ insert: 'y' }] },
    ])
  })

  it('keeps inline dollars literal alongside display math delimiters in indented code', async () => {
    const blocks = await fileToBlocks('a.md', enc('    $$NAME$$\n    echo $name$\n'))
    expect(blocks).toEqual([
      { type: 'codeBlock', attrs: { language: '' }, delta: [{ insert: '$$NAME$$\necho $name$' }] },
    ])
  })

  it.each([
    ['- item\n\n    $$\n    x\n    $$\n', 'bulletItem', '    x'],
    ['1. item\n\n    $$a+b$$\n', 'orderedItem', 'a+b'],
  ])('imports display math on an indented list continuation: %j', async (md, type, tex) => {
    const blocks = await fileToBlocks('a.md', enc(md))
    expect(blocks).toEqual([
      { type, attrs: { indent: 0 }, delta: [{ insert: 'item' }] },
      { type: 'codeBlock', attrs: { language: 'math' }, delta: [{ insert: tex }] },
    ])
  })

  it('keeps deeper list continuation code literal next to display math', async () => {
    const md = '- item\n\n      $$code$$\n\n    $$a+b$$\n'
    const blocks = await fileToBlocks('a.md', enc(md))
    expect(blocks).toEqual([
      { type: 'bulletItem', attrs: { indent: 0 }, delta: [{ insert: 'item ' }, { insert: '$$code$$\n', attributes: { code: {} } }] },
      { type: 'codeBlock', attrs: { language: 'math' }, delta: [{ insert: 'a+b' }] },
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
  it.each(['a`b', '`edge``', ' padded ', '   '])('round-trips inline code containing %j through Markdown', async (code) => {
    const block: Block = { ...para(''), delta: [{ insert: 'Code: ' }, { insert: code, attributes: { code: {} } }] }
    expect(await fileToBlocks('inline.md', enc(blocksToMarkdown([block])))).toEqual([block])
  })

  it.each([
    '[draft](https://example.invalid)',
    'Literal *asterisks*, _underscores_, `backticks`, [brackets] and \\backslashes.',
  ])('round-trips literal Markdown text %j without adding marks', async (text) => {
    const block = para(text)
    expect(await fileToBlocks('inline.md', enc(blocksToMarkdown([block])))).toEqual([block])
  })

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

  it('imports escaped table pipes without splitting cells', async () => {
    const back = await fileToBlocks('table.md', enc('| A\\|B | tail |\n| --- | --- |\n| C\\|D | tail |\n'))
    expect(back).toEqual([{ type: 'table', attrs: { rows: JSON.stringify([['A|B', 'tail'], ['C|D', 'tail']]) }, delta: [] }])
  })

  it.each(['A|B', 'A\\|B', '', 'plain'])('round-trips table cells containing %j through Markdown', async (cell) => {
    const table: Block = { type: 'table', attrs: { rows: JSON.stringify([[cell, 'tail'], [cell, 'tail']]) }, delta: [] }
    const back = await fileToBlocks('table.md', enc(blocksToMarkdown([table])))
    expect(back).toEqual([table])
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
