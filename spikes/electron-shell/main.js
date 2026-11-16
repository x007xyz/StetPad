// Spike: an Electron app that runs its own HTTP service and SQLite in the main
// process. Proves the native module loads from a packaged build.
const { app, BrowserWindow, dialog } = require('electron')
const crypto = require('node:crypto')
const http = require('node:http')
const path = require('node:path')
const { Hono } = require('hono')
const { serve } = require('@hono/node-server')

const SMOKE = process.argv.includes('--smoke')
if (SMOKE) {
  // An uncaught error in the main process opens a modal dialog and waits.
  // In a headless check that is a hang, so print and exit instead.
  dialog.showErrorBox = (title, content) => console.error(`${title}\n${content}`)
  process.on('uncaughtException', (err) => { console.error(err); app.exit(1) })
}
const token = crypto.randomBytes(32).toString('hex')

function startService() {
  const Database = require('better-sqlite3')
  const db = new Database(path.join(app.getPath('userData'), 'spike.sqlite'))
  db.exec('create table if not exists kv(key text primary key, value text)')

  const api = new Hono()
  let port = 0
  // Refuse requests addressed to any other host name (DNS rebinding).
  api.use('*', async (c, next) => {
    if (c.req.header('host') !== `127.0.0.1:${port}`) return c.text('forbidden', 403)
    await next()
  })
  api.get('/health', (c) => c.json({ ok: true }))
  api.use('*', async (c, next) => {
    if (c.req.header('authorization') !== `Bearer ${token}`) return c.text('unauthorized', 401)
    await next()
  })
  api.post('/kv', async (c) => {
    const { key, value } = await c.req.json()
    db.prepare('insert into kv(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, value)
    return c.json({ ok: true })
  })
  api.get('/kv/:key', (c) => {
    const row = db.prepare('select value from kv where key = ?').get(c.req.param('key'))
    return row ? c.json(row) : c.json({ error: 'not found' }, 404)
  })

  return new Promise((resolve) => {
    serve({ fetch: api.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
      port = info.port
      resolve({ port, db })
    })
  })
}

function statusWithHost(port, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/health', headers: { Host: host } },
      (res) => { res.resume(); resolve(res.statusCode) },
    )
    req.on('error', reject)
    req.end()
  })
}

async function smoke(port, db) {
  const base = `http://127.0.0.1:${port}`
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const unauthorized = (await fetch(`${base}/kv/x`)).status
  const badHost = await statusWithHost(port, 'evil.example:80')
  const value = crypto.randomUUID()
  await fetch(`${base}/kv`, { method: 'POST', headers: auth, body: JSON.stringify({ key: 'x', value }) })
  const read = await (await fetch(`${base}/kv/x`, { headers: auth })).json()
  const checks = { unauthorized, badHost, roundtrip: read.value === value }
  const ok = unauthorized === 401 && badHost === 403 && checks.roundtrip
  console.log(JSON.stringify({
    ok,
    packaged: app.isPackaged,
    electron: process.versions.electron,
    node: process.versions.node,
    sqlite: db.prepare('select sqlite_version() as v').get().v,
    checks,
  }))
  return ok
}

app.whenReady().then(async () => {
  try {
    const { port, db } = await startService()
    if (SMOKE) return app.exit((await smoke(port, db)) ? 0 : 1)
    const win = new BrowserWindow({
      width: 720,
      height: 480,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'preload.js'),
        additionalArguments: [`--svc=${JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, token })}`],
      },
    })
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    await win.loadFile('index.html')
  } catch (err) {
    console.error(err)
    app.exit(1)
  }
})

app.on('window-all-closed', () => app.quit())
