import { blockText, decide, findBlock, insertBlock, listChanges, projectBlocks, trackedReplace } from '@stetpad/crdt'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { Document, ImageRun, Packer, Paragraph } from 'docx'
import { strToU8, zipSync } from 'fflate'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { startServer, type RunningServer } from '../src'
import { textPdf } from './pdf-fixture'

const until = async (check: () => boolean, what: string, ms = 8000) => {
  const t = Date.now()
  while (!check()) {
    if (Date.now() - t > ms) throw new Error('timed out: ' + what)
    await new Promise((r) => setTimeout(r, 15))
  }
}

const smallGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const gifWithComments = (count: number) => {
  const comments = Buffer.alloc(count * 256, 65)
  for (let i = 0; i < comments.length; i += 256) comments[i] = 255
  return Buffer.concat([smallGif.subarray(0, -1), Buffer.from([0x21, 0xfe]), comments, Buffer.from([0, 0x3b])])
}
const largeGif = gifWithComments(1600)
const gifSrc = (data: Buffer) => `data:image/gif;base64,${data.toString('base64')}`
const wordWithImages = async (name: string, ...images: Buffer[]) => {
  const word = new Document({ sections: [{ children: [
    new Paragraph('Before the image.'),
    ...images.map((data) => new Paragraph({ children: [new ImageRun({ type: 'gif', data, transformation: { width: 100, height: 100 } })] })),
    new Paragraph('After the image.'),
  ] }] })
  const form = new FormData()
  form.append('file', new File([await Packer.toArrayBuffer(word)], name))
  return form
}

describe('server', () => {
  let server: RunningServer
  let dir: string
  let base: string
  let token = ''
  const providers: HocuspocusProvider[] = []
  const call = async (path: string, init: RequestInit = {}, t = token) => {
    const res = await fetch(base + path, {
      ...init,
      headers: { authorization: `Bearer ${t}`, ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...init.headers },
    })
    const ct = res.headers.get('content-type') ?? ''
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() }
  }
  const open = (id: string, t = token) => {
    const doc = new Y.Doc()
    const p = new HocuspocusProvider({ url: base.replace('http', 'ws') + '/collab', name: id, document: doc, token: t })
    providers.push(p)
    return { doc, provider: p }
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aiw-'))
    server = await startServer({
      dataDir: dir, port: 0,
      mcpCommand: { command: process.execPath, args: ['--import', 'tsx', join(__dirname, '../src/mcp.ts')] },
    })
    base = `http://127.0.0.1:${server.port}`
    token = server.token
  })
  afterAll(async () => {
    providers.forEach((p) => p.destroy())
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects callers without a valid token', async () => {
    expect((await call('/api/docs', {}, 'nope')).status).toBe(401)
  })

  it.each([
    { path: '/api/docs', defaults: { title: '未命名文档', folder_id: null } },
    { path: '/api/folders', defaults: { name: '新建文件夹' } },
  ])('creates a default item on $path with a null JSON body', async ({ path, defaults }) => {
    const result = await call(path, { method: 'POST', body: 'null' })
    expect(result).toMatchObject({ status: 200, body: { id: expect.any(String), ...defaults } })
  })

  it.each([42, false, {}, null])('rejects a non-string document title (%j)', async (title) => {
    const result = await call('/api/docs', { method: 'POST', body: JSON.stringify({ title }) })
    expect(result).toEqual({ status: 400, body: { error: expect.any(String) } })
  })

  it('creates a document, syncs edits, settles decisions and keeps versions', async () => {
    const created = await call('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'T' }) })
    const id = created.body.id as string
    const { doc } = open(id)
    await until(() => projectBlocks(doc, 'physical').length === 1, 'initial block')
    const blockId = projectBlocks(doc, 'physical')[0]!.blockId
    blockText(findBlock(doc, blockId)!).insert(0, 'a cat sat')
    await call(`/api/docs/${id}/versions`, { method: 'POST', body: JSON.stringify({ label: 'first' }) })

    // A suggestion made on the client is settled by the server once decided.
    const change = trackedReplace(doc, blockText(findBlock(doc, blockId)!), 2, 3, 'tabby', { author: 'me' })
    decide(doc, change, 'accept')
    await until(() => blockText(findBlock(doc, blockId)!).toString() === 'a tabby sat', 'server compaction reaches client')
    expect(listChanges(doc)).toEqual([])

    const versions = (await call(`/api/docs/${id}/versions`)).body as { id: string; label: string | null }[]
    const first = versions.find((v) => v.label === 'first')!
    expect((await call(`/api/versions/${first.id}`)).body.content.revised[0].text).toBe('a cat sat')

    // Restore writes the old text back as a new edit and keeps the current text as a version.
    expect((await call(`/api/versions/${first.id}/restore`, { method: 'POST' })).status).toBe(200)
    await until(() => projectBlocks(doc, 'revised')[0]?.text === 'a cat sat', 'restore reaches client')
    const after = (await call(`/api/docs/${id}/versions`)).body as { trigger: string }[]
    expect(after.map((v) => v.trigger)).toEqual(expect.arrayContaining(['before-restore', 'manual']))

    expect((await call(`/api/docs/${id}/export?format=md`)).body).toBe('a cat sat\n')
  })

  it('keeps pending suggestions on unselected blocks during partial restore', async () => {
    const id = (await call('/api/import/create', { method: 'POST', body: JSON.stringify({ title: 'partial restore', blocks: ['old A', 'settled B'].map((insert) => ({ type: 'paragraph', attrs: {}, delta: [{ insert }] })) }) })).body.id as string
    const { doc } = open(id)
    await until(() => projectBlocks(doc, 'physical').length === 2, 'blocks synced')
    const [a, b] = projectBlocks(doc, 'physical')
    const version = (await call(`/api/docs/${id}/versions`)).body[0].id
    blockText(findBlock(doc, a!.blockId)!).insert(0, 'new ')
    trackedReplace(doc, blockText(findBlock(doc, b!.blockId)!), 0, b!.text.length, 'suggested B', { author: 'AI', reason: 'rewrite' })
    const observer = open(id)
    await until(() => listChanges(observer.doc).length === 1 && projectBlocks(observer.doc, 'original')[0]?.text === 'new old A', 'edits reach server')
    const pending = listChanges(observer.doc)
    expect((await call(`/api/versions/${version}/restore`, { method: 'POST', body: JSON.stringify({ blockIds: [a!.blockId] }) })).status).toBe(200)
    await until(() => projectBlocks(observer.doc, 'original')[0]?.text === 'old A', 'partial restore reaches client')
    expect(listChanges(observer.doc)).toEqual(pending)
    expect(projectBlocks(observer.doc, 'original')[1]!.text).toBe('settled B')
    expect(projectBlocks(observer.doc, 'revised')[1]!.text).toBe('suggested B')
  })

  it('clears attributes added after a saved version on full restore', async () => {
    const id = (await call('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'attributes' }) })).body.id as string
    const { doc } = open(id)
    await until(() => projectBlocks(doc, 'revised').length === 1, 'initial block')
    const blockId = projectBlocks(doc, 'revised')[0]!.blockId
    const saved = await call(`/api/docs/${id}/versions`, { method: 'POST', body: '{}' })
    expect((await call(`/api/versions/${saved.body.id}`)).body.content.revised[0].attrs).toEqual({})
    findBlock(doc, blockId)!.setAttribute('indent', 3 as unknown as string)
    const observer = open(id)
    await until(() => projectBlocks(observer.doc, 'revised')[0]?.attrs.indent === 3, 'attribute reaches server')
    expect((await call(`/api/versions/${saved.body.id}/restore`, { method: 'POST' })).status).toBe(200)
    const restored = (await call(`/api/docs/${id}/export?format=json`)).body.blocks[0]
    expect(restored.blockId).toBe(blockId)
    expect(restored.attrs).toEqual({})
  })

  it('manages AI chats per document', async () => {
    const id = (await call('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'chats' }) })).body.id as string
    expect((await call(`/api/docs/${id}/chats`)).body.chats).toEqual([])
    const a = (await call(`/api/docs/${id}/chats`, { method: 'POST', body: '{}' })).body.chat
    const b = (await call(`/api/docs/${id}/chats`, { method: 'POST', body: JSON.stringify({ title: 'second' }) })).body.chat
    expect((await call(`/api/chats/${a.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'renamed' }) })).status).toBe(200)
    expect((await call(`/api/chats/${a.id}`, { method: 'PATCH', body: JSON.stringify({ title: ' ' }) })).status).toBe(400)
    const list = (await call(`/api/docs/${id}/chats`)).body.chats as { id: string; title: string }[]
    expect(list.map((c) => c.title).sort()).toEqual(['renamed', 'second'])
    expect((await call(`/api/docs/${id}/runs?chat=${a.id}`)).body.runs).toEqual([])
    expect((await call(`/api/docs/${id}/runs?chat=nope`)).status).toBe(404)
    expect((await call(`/api/chats/${a.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(((await call(`/api/docs/${id}/chats`)).body.chats as { id: string }[]).map((c) => c.id)).toEqual([b.id])
    expect((await call(`/api/docs/${id}`)).status).toBe(200) // the document stays
  })
  it('imports Markdown and HTML into the simple block format', async () => {
    const form = new FormData()
    form.append('file', new File(['# Title\n\nHello **bold** [x](javascript:alert(1)) [ok](https://a.b)\n\n- one\n- two\n\n1. first\n\n> quote\n\n```\ncode\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'], 'note.md'))
    const preview = await call('/api/import/preview', { method: 'POST', body: form })
    expect(preview.status).toBe(200)
    expect(preview.body.title).toBe('Title')
    expect(preview.body.blocks.map((b: { type: string }) => b.type)).toEqual(['heading', 'paragraph', 'bulletItem', 'bulletItem', 'orderedItem', 'quote', 'codeBlock', 'table'])
    const marks = JSON.stringify(preview.body.blocks[1].delta)
    expect(marks).toContain('"bold"')
    expect(marks).toContain('https://a.b')
    expect(marks).not.toContain('javascript')

    const html = new FormData()
    html.append('file', new File(['<html><head><title>Page</title><script>bad()</script></head><body><nav>menu</nav><article><h2>Sub</h2><p onclick="x()">Text <em>here</em> that is long enough to be picked up as the main content of the page by the extractor, repeated to add length. Text that is long enough to be picked up as the main content.</p></article></body></html>'], 'p.html'))
    const hp = await call('/api/import/preview', { method: 'POST', body: html })
    expect(JSON.stringify(hp.body.blocks)).not.toMatch(/bad\(\)|onclick|menu/)

    const made = await call('/api/import/create', { method: 'POST', body: JSON.stringify(preview.body) })
    const md = (await call(`/api/docs/${made.body.id}/export?format=md`)).body as string
    expect(md).toContain('# Title')
    expect(md).toContain('- one')
    expect(md).toContain('| a | b |')
  })

  it.each([500, 501, 503])('reports omitted PDF pages for %i pages before creating a document', async (pages) => {
    const form = new FormData()
    form.append('file', new File([Buffer.from(textPdf(pages))], 'long.pdf'))
    const preview = await call('/api/import/preview', { method: 'POST', body: form })
    expect(preview.status).toBe(200)
    expect(preview.body.omittedPageCount).toBe(pages > 500 ? pages - 500 : undefined)
    expect(preview.body.blocks).toHaveLength(500)
    const made = await call('/api/import/create', { method: 'POST', body: JSON.stringify(preview.body) })
    expect(made.status).toBe(200)
    const exported = await call(`/api/docs/${made.body.id}/export?format=md`)
    expect(exported.body).toContain('Page 500 line 1.')
    expect(exported.body).not.toContain('Page 501')
  })

  it('reports PDF page and block overflow together', async () => {
    const form = new FormData()
    form.append('file', new File([Buffer.from(textPdf(501, 5))], 'long.pdf'))
    const preview = await call('/api/import/preview', { method: 'POST', body: form })
    expect(preview.status).toBe(200)
    expect(preview.body.omittedPageCount).toBe(1)
    expect(preview.body.omittedBlockCount).toBe(500)
    expect(preview.body.blocks).toHaveLength(2000)
  })

  it('previews text and reports skipped pages when no vision model is configured', async () => {
    const form = new FormData()
    form.append('file', new File([Buffer.from(textPdf(2, 1, [2]))], 'mixed.pdf'))
    const result = await call('/api/import/preview', { method: 'POST', body: form })
    expect(result.status).toBe(200)
    expect(result.body.skippedPages).toEqual([2])
    expect(result.body.skippedPageReason).toBe('no-ocr')
    expect(result.body.blocks[0].delta).toEqual([{ insert: 'Page 1 line 1.' }])
  })

  it('rejects empty or invalid PDFs instead of returning a truncation preview', async () => {
    for (const data of [textPdf(501, 0), new TextEncoder().encode('not a PDF')]) {
      const form = new FormData()
      form.append('file', new File([Buffer.from(data)], 'empty.pdf'))
      const preview = await call('/api/import/preview', { method: 'POST', body: form })
      expect(preview.status).toBe(422)
      expect(preview.body.error).toEqual(expect.any(String))
      expect(preview.body.omittedPageCount).toBeUndefined()
    }
  })

  it('reports import overflow before creating a bounded document', async () => {
    const paragraphs = Array.from({ length: 2001 }, (_, i) => `Paragraph ${i + 1}`)
    const form = new FormData()
    form.append('file', new File([paragraphs.join('\n\n')], 'long.txt'))
    const preview = await call('/api/import/preview', { method: 'POST', body: form })
    expect(preview.status).toBe(200)
    expect(preview.body.omittedBlockCount).toBe(1)
    expect(preview.body.blocks).toHaveLength(2000)

    const before = await call('/api/docs')
    const overflow = await call('/api/import/create', {
      method: 'POST',
      body: JSON.stringify({ ...preview.body, blocks: [...preview.body.blocks, { type: 'paragraph', attrs: {}, delta: [{ insert: 'Paragraph 2001' }] }] }),
    })
    expect(overflow.status).toBe(413)
    const after = await call('/api/docs')
    expect(after.body.map((d: { id: string }) => d.id).sort()).toEqual(before.body.map((d: { id: string }) => d.id).sort())

    const made = await call('/api/import/create', { method: 'POST', body: JSON.stringify(preview.body) })
    expect(made.status).toBe(200)
    const exported = await call(`/api/docs/${made.body.id}/export?format=md`)
    expect(exported.status).toBe(200)
    const imported = (exported.body as string).trimEnd().split('\n\n')
    expect(imported).toEqual(paragraphs.slice(0, 2000))
  })

  it('keeps Markdown footnotes from preview when creating a document', async () => {
    const form = new FormData()
    form.append('file', new File(['A word[^1].\n\n[^1]: note text\n'], 'footnote.md'))
    const preview = await call('/api/import/preview', { method: 'POST', body: form })
    expect(preview.status).toBe(200)
    expect(preview.body.blocks[0].delta).toContainEqual({
      insert: 'word', attributes: { footnote: { id: expect.any(String), note: 'note text' } },
    })
    const made = await call('/api/import/create', { method: 'POST', body: JSON.stringify(preview.body) })
    expect(made.status).toBe(200)
    const { doc } = open(made.body.id)
    await until(() => projectBlocks(doc, 'revised').length > 0, 'imported blocks')
    expect(projectBlocks(doc, 'revised')[0]!.delta).toEqual(preview.body.blocks[0].delta)
    expect((await call(`/api/docs/${made.body.id}/export?format=md`)).body).toBe('A word[^1].\n\n[^1]: note text\n')
  })

  it('sanitizes imported footnote attributes', async () => {
    const notes = [
      { id: 'empty', note: '' }, { id: 'missing' }, { id: 'number', note: 42 },
      null, 'bad', {}, { id: '' }, { id: 42 },
    ]
    const made = await call('/api/import/create', {
      method: 'POST', body: JSON.stringify({ title: 'Footnotes', blocks: notes.map((footnote) => ({
        type: 'paragraph', attrs: {}, delta: [{ insert: 'word', attributes: { footnote } }],
      })) }),
    })
    expect(made.status).toBe(200)
    const { doc } = open(made.body.id)
    await until(() => projectBlocks(doc, 'revised').length === notes.length, 'sanitized blocks')
    expect(projectBlocks(doc, 'revised').map((b) => b.delta)).toEqual([
      ...['empty', 'missing', 'number'].map((id) => [{ insert: 'word', attributes: { footnote: { id, note: '' } } }]),
      ...Array.from({ length: 5 }, () => [{ insert: 'word' }]),
    ])
  })

  it('imports a Word document', async () => {
    // A minimal .docx: a heading and two paragraphs, one with bold text.
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    const doc = `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Report Title</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Plain and </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r><w:r><w:t xml:space="preserve"> text.</w:t></w:r></w:p>
<w:p><w:r><w:t>Second paragraph.</w:t></w:r></w:p>
</w:body></w:document>`
    const styles = `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`
    const file = zipSync({
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'),
      '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      'word/_rels/document.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="s1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
      'word/document.xml': strToU8(doc),
      'word/styles.xml': strToU8(styles),
    })
    const form = new FormData()
    form.append('file', new File([Buffer.from(file)], 'sample.docx'))
    const r = await call('/api/import/preview', { method: 'POST', body: form })
    expect(r.status).toBe(200)
    expect(r.body.title).toBe('Report Title')
    expect(r.body.blocks.map((b: { type: string }) => b.type)).toEqual(['heading', 'paragraph', 'paragraph'])
    expect(r.body.blocks[1].delta).toEqual([{ insert: 'Plain and ' }, { insert: 'bold', attributes: { bold: {} } }, { insert: ' text.' }])
  })

  it.each([['small', smallGif], ['large', largeGif]] as const)('imports a Word document with a %s embedded image', async (size, data) => {
    const form = await wordWithImages(`${size}-image.docx`, data)
    const preview = await call('/api/import/preview', { method: 'POST', body: form })
    expect(preview.status).toBe(200)
    expect(preview.body.blocks.map((b: { type: string }) => b.type)).toEqual(['paragraph', 'image', 'paragraph'])
    const src = preview.body.blocks[1].attrs.src as string
    if (size === 'large') expect(src).toMatch(/^\/files\/[\w-]+$/)
    const image = await fetch(new URL(src, base))
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/gif')
    expect(Buffer.from(await image.arrayBuffer()).equals(data)).toBe(true)

    const made = await call('/api/import/create', { method: 'POST', body: JSON.stringify(preview.body) })
    expect(made.status).toBe(200)
    const exported = await call(`/api/docs/${made.body.id}/export?format=md`)
    expect(exported.body.trim()).toBe(`Before the image.\n\n![](${src})\n\nAfter the image.`)
  })

  it('imports surrounding Word text when an image exceeds the asset upload limit', async () => {
    const form = await wordWithImages('over-upload-limit.docx', gifWithComments(20 * 1024 * 1024 / 256))
    const preview = await call('/api/import/preview', { method: 'POST', body: form })
    expect(preview.status).toBe(200)
    expect(preview.body.blocks.map((b: { type: string }) => b.type)).toEqual(['paragraph', 'paragraph'])
    expect(preview.body).not.toHaveProperty('omittedBlockCount')
    const made = await call('/api/import/create', { method: 'POST', body: JSON.stringify(preview.body) })
    expect(made.status).toBe(200)
    const exported = await call(`/api/docs/${made.body.id}/export?format=md`)
    expect(exported.body.trim()).toBe('Before the image.\n\nAfter the image.')
  })

  it('reuses one asset for repeated large Word images', async () => {
    const form = await wordWithImages('repeated-image.docx', largeGif, Buffer.from(largeGif))
    const preview = await call('/api/import/preview', { method: 'POST', body: form })
    expect(preview.status).toBe(200)
    const firstSrc = preview.body.blocks[1].attrs.src as string
    expect(firstSrc).toMatch(/^\/files\/[\w-]+$/)
    expect(preview.body.blocks).toMatchObject([
      { type: 'paragraph' },
      { type: 'image', attrs: { src: firstSrc } },
      { type: 'image', attrs: { src: firstSrc } },
      { type: 'paragraph' },
    ])
    const image = await fetch(base + firstSrc)
    expect(image.status).toBe(200)
    expect(Buffer.from(await image.arrayBuffer()).equals(largeGif)).toBe(true)
  })

  it('keeps small inline images but drops oversized inline images from web clips', async () => {
    const clipped = await call('/api/clipper/tokens', { method: 'POST', body: JSON.stringify({ name: 'Clip images' }) })
    const blocks = [smallGif, largeGif].map((data) => ({ type: 'image', attrs: { src: gifSrc(data) }, delta: [] }))
    const made = await call('/api/import/create', { method: 'POST', body: JSON.stringify({ blocks }) }, clipped.body.token)
    expect(made.status).toBe(200)
    const exported = await call(`/api/docs/${made.body.id}/export?format=md`)
    expect(exported.body.trim()).toBe(`![](${gifSrc(smallGif)})`)
  })

  it('an external agent over MCP reads the document and proposes suggestions', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    const id = (await call('/api/import/create', { method: 'POST', body: JSON.stringify({ title: 'mcp', blocks: [{ type: 'paragraph', attrs: {}, delta: [{ insert: 'The quick brown fox.' }] }] }) })).body.id as string
    const owner = open(id)
    await until(() => projectBlocks(owner.doc, 'physical').length === 1, 'owner synced')
    const blockId = projectBlocks(owner.doc, 'physical')[0]!.blockId

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', join(__dirname, '../src/mcp.ts'), '--url', base, '--token', token, '--doc', id, '--author', 'Pi'],
    })
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(transport)
    try {
      const names = (await client.listTools()).tools.map((t) => t.name)
      expect(names).toEqual(expect.arrayContaining(['document_read', 'document_replace_block', 'document_withdraw']))
      expect(names.some((n) => /accept|reject/.test(n))).toBe(false)

      const read = await client.callTool({ name: 'document_read', arguments: {} })
      expect(JSON.stringify(read.content)).toContain(`[${blockId}] The quick brown fox.`)
      await client.callTool({ name: 'document_replace_block', arguments: { block_id: blockId, content: 'The fast brown fox.', reason: 'shorter word' } })

      await until(() => listChanges(owner.doc).length === 1, 'suggestion reaches the owner')
      expect(listChanges(owner.doc)[0]).toMatchObject({ author: 'Pi', deleted: 'quick', inserted: 'fast', reason: 'shorter word' })
      expect(projectBlocks(owner.doc, 'original')[0]!.text).toBe('The quick brown fox.')
    } finally {
      await client.close()
    }
  }, 30_000)

  it('keeps changes that were made after the last snapshot', async () => {
    const id = (await call('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'log' }) })).body.id as string
    const a = open(id)
    await until(() => projectBlocks(a.doc, 'physical').length === 1, 'synced')
    blockText(findBlock(a.doc, projectBlocks(a.doc, 'physical')[0]!.blockId)!).insert(0, 'typed just now')
    await new Promise((r) => setTimeout(r, 150)) // well inside the snapshot debounce
    // The export reads the live document; what matters is that the update is already in the log.
    const b = open(id)
    await until(() => projectBlocks(b.doc, 'physical')[0]?.text === 'typed just now', 'second client sees it')
  })

  it('exports Word, stores images, and counts usage', async () => {
    const id = (await call('/api/import/create', { method: 'POST', body: JSON.stringify({ title: 'x', blocks: [{ type: 'heading', attrs: { level: 1 }, delta: [{ insert: 'Title' }] }, { type: 'paragraph', attrs: {}, delta: [{ insert: 'Body', attributes: { bold: {} } }] }] }) })).body.id as string
    const res = await fetch(`${base}/api/docs/${id}/export?format=docx`, { headers: { authorization: `Bearer ${token}` } })
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(res.status).toBe(200)
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe('PK') // a zip container
    // Round trip: what we export, we can import.
    const form = new FormData()
    form.append('file', new File([bytes], 'out.docx'))
    const back = await call('/api/import/preview', { method: 'POST', body: form })
    expect(back.body.blocks.map((b: { type: string }) => b.type)).toEqual(['heading', 'paragraph'])
    expect(back.body.blocks[1].delta).toEqual([{ insert: 'Body', attributes: { bold: {} } }])

    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
    const img = new FormData()
    img.append('file', new File([png], 'dot.png', { type: 'image/png' }))
    const up = await call(`/api/docs/${id}/assets`, { method: 'POST', body: img })
    expect(up.body.url).toMatch(/^\/files\//)
    const got = await fetch(base + up.body.url)
    expect(got.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(png)
    const bad = new FormData()
    bad.append('file', new File(['<script>'], 'x.html', { type: 'text/html' }))
    expect((await call(`/api/docs/${id}/assets`, { method: 'POST', body: bad })).status).toBe(415)

    expect((await call('/api/usage')).body).toMatchObject({ days: [], today: 0 })
  })

  it('runs an external agent over ACP and receives its edits as suggestions', async () => {
    process.env.AIW_ACP_AGENTS = JSON.stringify([{ id: 'fake', label: 'Fake Agent', command: process.execPath, args: [join(__dirname, 'fake-acp-agent.mjs')] }])
    try {
      expect((await call('/api/models')).body.externalAgents).toEqual(expect.arrayContaining([{ id: 'fake', label: 'Fake Agent' }]))
      const id = (await call('/api/import/create', { method: 'POST', body: JSON.stringify({ title: 'acp', blocks: [{ type: 'paragraph', attrs: {}, delta: [{ insert: 'The quick brown fox.' }] }] }) })).body.id as string
      const owner = open(id)
      await until(() => projectBlocks(owner.doc, 'physical').length === 1, 'owner synced')
      const started = await call(`/api/docs/${id}/external-runs`, { method: 'POST', body: JSON.stringify({ agent: 'fake', prompt: 'make it faster' }) })
      expect(started.status).toBe(200)
      let run: { status: string; text: string; steps: string[]; error?: string } = { status: 'running', text: '', steps: [] }
      await until(() => { void call(`/api/external-runs/${started.body.id}`).then((r) => (run = r.body)); return run.status !== 'running' }, 'external run ends', 20_000)
      expect(run).toMatchObject({ status: 'done', text: 'Replaced one word.' })
      expect(run.steps).toContain('document_replace_block')
      await until(() => listChanges(owner.doc).length === 1, 'suggestion reaches the owner')
      expect(listChanges(owner.doc)[0]).toMatchObject({ author: 'Fake Agent', deleted: 'quick', inserted: 'fast' })
      expect(projectBlocks(owner.doc, 'original')[0]!.text).toBe('The quick brown fox.')
    } finally {
      delete process.env.AIW_ACP_AGENTS
    }
  }, 30_000)

  it('refuses requests addressed to another host name', async () => {
    const http = await import('node:http')
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.port, path: '/api/config', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode!) })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(403)
  })
})
