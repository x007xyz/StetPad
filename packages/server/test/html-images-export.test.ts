import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../src'

let server: RunningServer
let dir: string
let base: string
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64')
const call = (path: string, init: RequestInit = {}) => fetch(base + path, {
  ...init, headers: { authorization: `Bearer ${server.token}`, ...init.headers },
})
const create = async (blocks: unknown[]) => {
  const res = await call('/api/import/create', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Images', blocks }),
  })
  expect(res.status).toBe(200)
  return (await res.json()).id as string
}
const image = (src: string) => ({ type: 'image', attrs: { src, alt: 'Example' }, delta: [] })

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aiw-html-images-'))
  server = await startServer({ dataDir: dir, port: 0 })
  base = `http://127.0.0.1:${server.port}`
})
afterAll(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

it('embeds uploaded images in GET and POST HTML exports without changing Markdown or external URLs', async () => {
  const owner = await create([])
  const uploaded = await call(`/api/docs/${owner}/assets`, {
    method: 'POST', headers: { 'content-type': 'image/png' }, body: png,
  })
  expect(uploaded.status).toBe(200)
  const { url } = await uploaded.json()
  const external = 'https://example.com/image.png'
  const id = await create([image(url), image(external)])
  for (const method of ['GET', 'POST']) {
    const res = await call(`/api/docs/${id}/export?format=html`, method === 'GET' ? {} : {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format: 'html' }),
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).not.toContain('src="/files/')
    expect(html).toContain(`src="data:image/png;base64,${png.toString('base64')}"`)
    expect(html).toContain(`src="${external}"`)
  }
  expect(await (await call(`/api/docs/${id}/export?format=md`)).text()).toContain(url)
})

it('exports documents without images and tolerates missing uploaded images', async () => {
  for (const blocks of [[], [image('/files/missing')]]) {
    const id = await create(blocks)
    const res = await call(`/api/docs/${id}/export?format=html`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<!doctype html>')
  }
})
