import { listChanges, projectBlocks } from '@stetpad/crdt'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { startServer } from '../src/index'
const s = await startServer({ mode: 'local', dataDir: mkdtempSync(join(tmpdir(), 'aiw-')), port: 0 })
const base = `http://127.0.0.1:${s.port}`
const H = { authorization: 'Bearer ' + s.token, 'content-type': 'application/json' }
const j = async (p: string, init: RequestInit = {}) => (await fetch(base + p, { ...init, headers: H })).json()
console.log('models', (await j('/api/models')).models.map((m: any) => m.id).join(', '))
const blocks = ['# 周末计划', '我们今天去公园散步,天气很好,大家都很开心。', '然后我们回家吃了饭,饭很好吃。', '最后看了一个电影,电影还行吧。'].map((t) => t.startsWith('# ') ? { type: 'heading', attrs: { level: 1 }, delta: [{ insert: t.slice(2) }] } : { type: 'paragraph', attrs: {}, delta: [{ insert: t }] })
const doc = await j('/api/import/create', { method: 'POST', body: JSON.stringify({ title: '周末', blocks }) })
const y = new Y.Doc()
const prov = new HocuspocusProvider({ url: `ws://127.0.0.1:${s.port}/collab`, name: doc.id, document: y, token: s.token! })
const model = process.argv[2] ?? 'deepseek:deepseek-flash'
const run = async (body: any) => {
  const { runId, error } = await j(`/api/docs/${doc.id}/runs`, { method: 'POST', body: JSON.stringify({ modelId: model, ...body }) })
  if (error) throw new Error(error)
  const res = await fetch(`${base}/api/runs/${runId}/events`, { headers: H })
  const dec = new TextDecoder(); let buf = ''
  for await (const chunk of res.body as any) {
    buf += dec.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const ev = buf.slice(0, i); buf = buf.slice(i + 2)
      const type = ev.match(/^event: (.*)$/m)?.[1]; const data = ev.match(/^data: (.*)$/m)?.[1] ?? ''
      if (type === 'text.delta') process.stdout.write(JSON.parse(data).text)
      else if (type !== 'ping') console.log(`\n<${type}> ${data.slice(0, 160)}`)
    }
  }
}
await new Promise((r) => setTimeout(r, 600))
const t0 = Date.now()
const ids = projectBlocks(y, 'revised').map((b) => b.blockId)
await run({ preset: 'formal', selection: { blockIds: [ids[1]] } })
console.log('\n--- quick action took', Date.now() - t0, 'ms')
await run({ instruction: '把后两段合并成一段，并在文末加一句总结。' })
console.log('\n--- server revised md:\n' + await (await fetch(`${base}/api/docs/${doc.id}/export?format=md`, { headers: H })).text())
console.log('client clientsynced?', prov.isSynced, prov.status)
await new Promise((r) => setTimeout(r, 300))
console.log('\n--- changes'); for (const c of listChanges(y)) console.log(` ${c.author} | -${c.deleted} | +${c.inserted} | +blocks ${c.insertedBlocks} -blocks ${c.deletedBlocks}`)
console.log('--- original'); projectBlocks(y, 'original').forEach((b) => console.log(' ', b.type, b.text))
console.log('--- revised'); projectBlocks(y, 'revised').forEach((b) => console.log(' ', b.type, b.text))
console.log('--- versions', (await j(`/api/docs/${doc.id}/versions`)).map((v: any) => v.trigger).join(','))
prov.destroy(); await s.close(); process.exit(0)
