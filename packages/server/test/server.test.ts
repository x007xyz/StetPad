import { blockText, decide, findBlock, listChanges, projectBlocks, trackedReplace } from '@stetpad/crdt'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { startServer, type RunningServer } from '../src'
import { postgresSql } from '../src/db'

const until = async (check: () => boolean, what: string, ms = 8000) => {
  const t = Date.now()
  while (!check()) {
    if (Date.now() - t > ms) throw new Error('timed out: ' + what)
    await new Promise((r) => setTimeout(r, 15))
  }
}

const FLAVORS = [
  { name: 'local, sqlite', mode: 'local', pg: false },
  { name: 'web, sqlite', mode: 'web', pg: false },
  { name: 'web, postgres', mode: 'web', pg: true },
] as const

for (const { name: flavor, mode, pg } of FLAVORS) {
  describe(`server (${flavor})`, () => {
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
      // The PostgreSQL flavour runs the same suite against an in-process Postgres.
      const sql = pg ? postgresSql(new (await import('@electric-sql/pglite')).PGlite() as never) : undefined
      server = await startServer({
        mode, dataDir: dir, port: 0, sql,
        mcpCommand: { command: join(__dirname, '../node_modules/.bin/tsx'), args: [join(__dirname, '../src/mcp.ts')] },
      })
      base = `http://127.0.0.1:${server.port}`
      if (mode === 'local') token = server.token!
      else {
        const r = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', password: 'password1' }) })
        token = (await r.json()).token
      }
    })
    afterAll(async () => {
      providers.forEach((p) => p.destroy())
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    })

    it('rejects callers without a valid token', async () => {
      expect((await call('/api/docs', {}, 'nope')).status).toBe(401)
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

    it('imports a Word document', async () => {
      // A minimal .docx, assembled here: a heading, a paragraph with bold text, and a list item.
      const file = join(dir, 'sample.docx')
      const py = `
import zipfile, sys
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
doc = f'''<?xml version="1.0" encoding="UTF-8"?><w:document {W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Report Title</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Plain and </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r><w:r><w:t xml:space="preserve"> text.</w:t></w:r></w:p>
<w:p><w:r><w:t>Second paragraph.</w:t></w:r></w:p>
</w:body></w:document>'''
styles = f'''<?xml version="1.0" encoding="UTF-8"?><w:styles {W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>'''
z = zipfile.ZipFile(sys.argv[1], 'w')
z.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>')
z.writestr('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
z.writestr('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="s1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
z.writestr('word/document.xml', doc)
z.writestr('word/styles.xml', styles)
z.close()`
      execFileSync('python3', ['-c', py, file])
      const form = new FormData()
      form.append('file', new File([readFileSync(file)], 'sample.docx'))
      const r = await call('/api/import/preview', { method: 'POST', body: form })
      expect(r.status).toBe(200)
      expect(r.body.title).toBe('Report Title')
      expect(r.body.blocks.map((b: { type: string }) => b.type)).toEqual(['heading', 'paragraph', 'paragraph'])
      expect(r.body.blocks[1].delta).toEqual([{ insert: 'Plain and ' }, { insert: 'bold', attributes: { bold: {} } }, { insert: ' text.' }])
    })

    it('an external agent over MCP reads the document and proposes suggestions', async () => {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
      const id = (await call('/api/import/create', { method: 'POST', body: JSON.stringify({ title: 'mcp', blocks: [{ type: 'paragraph', attrs: {}, delta: [{ insert: 'The quick brown fox.' }] }] }) })).body.id as string
      const owner = open(id)
      await until(() => projectBlocks(owner.doc, 'physical').length === 1, 'owner synced')
      const blockId = projectBlocks(owner.doc, 'physical')[0]!.blockId

      const transport = new StdioClientTransport({
        command: join(__dirname, '../node_modules/.bin/tsx'),
        args: [join(__dirname, '../src/mcp.ts'), '--url', base, '--token', token, '--doc', id, '--author', 'Pi'],
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

    it('a suggest-only link cannot delete, cannot decide, and its text always needs review', async () => {
      const id = (await call('/api/import/create', { method: 'POST', body: JSON.stringify({ title: 's', blocks: [{ type: 'paragraph', attrs: {}, delta: [{ insert: 'keep this text' }] }] }) })).body.id as string
      const owner = open(id)
      await until(() => projectBlocks(owner.doc, 'physical').length === 1, 'owner synced')
      const bid = projectBlocks(owner.doc, 'physical')[0]!.blockId
      const link = (await call(`/api/docs/${id}/shares`, { method: 'POST', body: JSON.stringify({ role: 'suggest' }) })).body.token as string

      // A well-behaved guest: its tracked suggestion arrives.
      const good = open(id, 'share:' + link)
      await until(() => projectBlocks(good.doc, 'physical').length === 1, 'guest synced')
      const change = trackedReplace(good.doc, blockText(findBlock(good.doc, bid)!), 0, 4, 'retain', { author: 'guest' })
      await until(() => listChanges(owner.doc).length === 1, 'tracked suggestion arrives')

      // A guest that tries to accept its own suggestion is refused.
      decide(good.doc, change, 'accept')
      await new Promise((r) => setTimeout(r, 400))
      expect(listChanges(owner.doc)).toHaveLength(1)
      expect(projectBlocks(owner.doc, 'original')[0]!.text).toBe('keep this text')

      // A guest that bypasses the editor: plain deletion is refused, plain typing becomes a suggestion.
      const rogue = open(id, 'share:' + link)
      await until(() => projectBlocks(rogue.doc, 'physical').length === 1, 'rogue synced')
      blockText(findBlock(rogue.doc, bid)!).delete(0, 4)
      await new Promise((r) => setTimeout(r, 400))
      expect(projectBlocks(owner.doc, 'original')[0]!.text).toBe('keep this text')

      const typer = open(id, 'share:' + link)
      await until(() => projectBlocks(typer.doc, 'physical').length === 1, 'typer synced')
      const t = blockText(findBlock(typer.doc, bid)!)
      t.insert(t.length, ' SNEAKED')
      await until(() => listChanges(owner.doc).some((c) => c.inserted === ' SNEAKED'), 'untracked typing is turned into a suggestion', 6000)
      expect(projectBlocks(owner.doc, 'original')[0]!.text).toBe('keep this text')

      // A guest that reconnects with a full copy of the document does not get the old text attributed to it.
      const again = new Y.Doc()
      Y.applyUpdate(again, Y.encodeStateAsUpdate(typer.doc))
      providers.push(new HocuspocusProvider({ url: base.replace('http', 'ws') + '/collab', name: id, document: again, token: 'share:' + link }))
      await new Promise((r) => setTimeout(r, 2000))
      expect(projectBlocks(owner.doc, 'original')[0]!.text).toBe('keep this text')
    }, 20_000)

    it('share links grant exactly their role', async () => {
      const id = (await call('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'shared' }) })).body.id as string
      const owner = open(id)
      await until(() => projectBlocks(owner.doc, 'physical').length === 1, 'owner synced')
      const edit = (await call(`/api/docs/${id}/shares`, { method: 'POST', body: JSON.stringify({ role: 'edit' }) })).body.token as string
      const view = (await call(`/api/docs/${id}/shares`, { method: 'POST', body: JSON.stringify({ role: 'view' }) })).body.token as string
      expect((await (await fetch(`${base}/api/share/${view}`)).json()).role).toBe('view')

      const editor = open(id, 'share:' + edit)
      const viewer = open(id, 'share:' + view)
      const blockId = () => projectBlocks(owner.doc, 'physical')[0]!.blockId
      await until(() => projectBlocks(editor.doc, 'physical').length === 1 && projectBlocks(viewer.doc, 'physical').length === 1, 'guests synced')

      blockText(findBlock(editor.doc, blockId())!).insert(0, 'from editor')
      await until(() => projectBlocks(owner.doc, 'physical')[0]!.text === 'from editor', 'edit link can write')
      blockText(findBlock(viewer.doc, blockId())!).insert(0, 'from viewer ')
      await new Promise((r) => setTimeout(r, 300))
      expect(projectBlocks(owner.doc, 'physical')[0]!.text).toBe('from editor') // the server dropped the viewer's write

      // A share link is not an account: it cannot call the owner's API.
      expect((await call(`/api/docs/${id}`, {}, 'share:' + edit)).status).toBe(401)
      // Revoking closes the door.
      await call(`/api/shares/${edit}`, { method: 'DELETE' })
      expect((await fetch(`${base}/api/share/${edit}`)).status).toBe(404)
    })

    if (mode === 'web') {
      it('team spaces give members their role and nothing more', async () => {
        const reg = async (email: string) => {
          const r = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'password9' }) })
          return (await r.json()).token as string
        }
        const editorTok = await reg(`ed-${Date.now()}@example.com`)
        const viewerTok = await reg(`vw-${Date.now()}@example.com`)
        const outsider = await reg(`out-${Date.now()}@example.com`)
        const emailOf = async (t: string) => (await call('/api/me', {}, t)).body.user.email as string
        const space = (await call('/api/spaces', { method: 'POST', body: JSON.stringify({ name: 'Team' }) })).body.id as string
        expect((await call(`/api/spaces/${space}/members`, { method: 'POST', body: JSON.stringify({ email: await emailOf(editorTok), role: 'editor' }) })).status).toBe(200)
        expect((await call(`/api/spaces/${space}/members`, { method: 'POST', body: JSON.stringify({ email: await emailOf(viewerTok), role: 'viewer' }) })).status).toBe(200)
        expect((await call(`/api/spaces/${space}/members`, { method: 'POST', body: JSON.stringify({ email: 'nobody@example.com', role: 'editor' }) })).status).toBe(404)

        const id = (await call('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'team doc', spaceId: space }) })).body.id as string
        // Members see it in the space; it is not in anyone's personal list.
        expect(((await call(`/api/docs?space=${space}`, {}, viewerTok)).body as { id: string }[]).map((d) => d.id)).toEqual([id])
        expect((await call('/api/docs', {}, editorTok)).body).toEqual([])
        expect((await call(`/api/docs?space=${space}`, {}, outsider)).status).toBe(404)
        expect((await call(`/api/docs/${id}`, {}, outsider)).status).toBe(404)
        expect((await call(`/api/docs/${id}`, {}, viewerTok)).body.access).toBe('viewer')

        // Editor may rename; viewer may not; only the owner may delete.
        expect((await call(`/api/docs/${id}`, { method: 'PATCH', body: JSON.stringify({ title: 'renamed' }) }, editorTok)).status).toBe(200)
        expect((await call(`/api/docs/${id}`, { method: 'PATCH', body: JSON.stringify({ title: 'nope' }) }, viewerTok)).status).toBe(404)
        expect((await call(`/api/docs/${id}`, { method: 'DELETE' }, editorTok)).status).toBe(404)
        expect((await call(`/api/spaces/${space}/members`, { method: 'POST', body: JSON.stringify({ email: 'x@example.com', role: 'editor' }) }, editorTok)).status).toBe(404)

        // In the document itself: the editor's typing arrives, the viewer's is dropped by the server.
        const owner = open(id)
        const ed = open(id, editorTok)
        const vw = open(id, viewerTok)
        await until(() => [owner, ed, vw].every((x) => projectBlocks(x.doc, 'physical').length === 1), 'all synced')
        const bid = projectBlocks(owner.doc, 'physical')[0]!.blockId
        blockText(findBlock(ed.doc, bid)!).insert(0, 'editor')
        await until(() => projectBlocks(owner.doc, 'physical')[0]!.text === 'editor', 'editor can write')
        blockText(findBlock(vw.doc, bid)!).insert(0, 'viewer ')
        await new Promise((r) => setTimeout(r, 300))
        expect(projectBlocks(owner.doc, 'physical')[0]!.text).toBe('editor')
      })

      it('keeps one account out of another account\'s documents', async () => {
        const mine = (await call('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'private' }) })).body.id as string
        const r = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'b@example.com', password: 'password2' }) })
        const other = (await r.json()).token as string
        expect((await call(`/api/docs/${mine}`, {}, other)).status).toBe(404)
        expect((await call('/api/docs', {}, other)).body).toEqual([])
        const { doc, provider } = open(mine, other)
        let denied = false
        provider.on('authenticationFailed', () => (denied = true))
        await until(() => denied, 'collab connection refused')
        expect(projectBlocks(doc, 'physical')).toEqual([])
      })
    } else {
      it('syncs a document with a cloud server in both directions', async () => {
        const cloudDir = mkdtempSync(join(tmpdir(), 'aiw-cloud-'))
        const cloud = await startServer({ mode: 'web', dataDir: cloudDir, port: 0 })
        const cloudBase = `http://127.0.0.1:${cloud.port}`
        try {
          await fetch(cloudBase + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'me@example.com', password: 'password1' }) })
          expect((await call('/api/cloud/login', { method: 'POST', body: JSON.stringify({ url: cloudBase, email: 'me@example.com', password: 'wrong-password' }) })).status).toBe(401)
          expect((await call('/api/cloud/login', { method: 'POST', body: JSON.stringify({ url: cloudBase, email: 'me@example.com', password: 'password1' }) })).status).toBe(200)

          const id = (await call('/api/import/create', { method: 'POST', body: JSON.stringify({ title: 'synced', blocks: [{ type: 'paragraph', attrs: {}, delta: [{ insert: 'a cat sat' }] }] }) })).body.id as string
          const desk = open(id)
          await until(() => projectBlocks(desk.doc, 'physical').length === 1, 'desktop synced')
          const linked = await call(`/api/docs/${id}/sync`, { method: 'POST' })
          expect(linked.status).toBe(200)

          // The same document, opened in the cloud.
          const login = await (await fetch(cloudBase + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'me@example.com', password: 'password1' }) })).json()
          const web = new Y.Doc()
          providers.push(new HocuspocusProvider({ url: cloudBase.replace('http', 'ws') + '/collab', name: linked.body.cloudDocId, document: web, token: login.token }))
          await until(() => projectBlocks(web, 'physical')[0]?.text === 'a cat sat', 'content reaches the cloud')
          expect(projectBlocks(web, 'physical')).toHaveLength(1)

          const bid = projectBlocks(web, 'physical')[0]!.blockId
          blockText(findBlock(web, bid)!).insert(9, ' on the mat')
          await until(() => projectBlocks(desk.doc, 'physical')[0]!.text === 'a cat sat on the mat', 'cloud edit reaches the desktop')

          // A suggestion made on the desktop and accepted in the cloud is settled by the cloud only.
          const change = trackedReplace(desk.doc, blockText(findBlock(desk.doc, bid)!), 2, 3, 'tabby', { author: 'me' })
          await until(() => listChanges(web).length === 1, 'suggestion reaches the cloud')
          decide(web, change, 'accept')
          await until(() => blockText(findBlock(desk.doc, bid)!).toString() === 'a tabby sat on the mat', 'settlement reaches the desktop')
          expect(blockText(findBlock(web, bid)!).toString()).toBe('a tabby sat on the mat')
          expect((await call(`/api/docs/${id}`)).body.sync).toBe('synced')
        } finally {
          await call('/api/cloud/logout', { method: 'POST' })
          await cloud.close()
          rmSync(cloudDir, { recursive: true, force: true })
        }
      }, 20_000)

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
    }
  })
}
