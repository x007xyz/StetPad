import { app, BrowserWindow, dialog, Menu, safeStorage, shell } from 'electron'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { startServer, type RunningServer } from '../../packages/server/src/index'

/**
 * Desktop shell. The whole server runs inside this process, in local mode:
 * documents live in a SQLite file under the user data directory, the service
 * listens on loopback only, and the window is the only holder of its token.
 */
const SMOKE = process.argv.includes('--smoke')
if (SMOKE) {
  // An uncaught error would open a modal dialog and wait forever.
  dialog.showErrorBox = (title, content) => console.error(`${title}\n${content}`)
  process.on('uncaughtException', (err) => {
    console.error(err)
    app.exit(1)
  })
}

let server: RunningServer | null = null

const secrets = {
  encrypt: (plain: string): string =>
    safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(plain).toString('base64') : plain,
  decrypt: (stored: string): string =>
    stored.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64')) : stored,
}

function createWindow(): void {
  if (!server) return
  const origin = `http://127.0.0.1:${server.port}`
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: 'Stetpad',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.cjs'),
      additionalArguments: [`--aiw=${JSON.stringify({ token: server.token, platform: process.platform })}`],
    },
  })
  // The window only ever shows the local app; anything else opens in the browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) {
      e.preventDefault()
      if (/^https?:/.test(url)) void shell.openExternal(url)
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url) && !url.startsWith(origin)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  void win.loadURL(origin + '/')
}

/**
 * Auto-update. Only in a packaged build, and only when a release feed is
 * configured (AIW_UPDATE_URL). macOS additionally requires a signed build.
 */
async function checkForUpdates(): Promise<void> {
  const feed = process.env.AIW_UPDATE_URL
  if (!app.isPackaged || !feed) return
  try {
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.setFeedURL({ provider: 'generic', url: feed })
    autoUpdater.on('update-downloaded', (info) => {
      void dialog.showMessageBox({ message: `新版本 ${info.version} 已下载`, detail: '重启后生效。', buttons: ['现在重启', '稍后'] }).then((r) => {
        if (r.response === 0) autoUpdater.quitAndInstall()
      })
    })
    await autoUpdater.checkForUpdates()
  } catch (err) {
    console.error('update check failed', err)
  }
}

async function smoke(s: RunningServer): Promise<boolean> {
  const base = `http://127.0.0.1:${s.port}`
  const auth = { authorization: `Bearer ${s.token}` }
  const json = { ...auth, 'content-type': 'application/json' }
  const unauthorized = (await fetch(`${base}/api/docs`)).status
  const me = await (await fetch(`${base}/api/me`, { headers: auth })).json()
  const form = new FormData()
  form.append('file', new File(['# Smoke\n\nHello **world**.\n\n- a\n- b\n'], 'smoke.md'))
  const preview = await (await fetch(`${base}/api/import/preview`, { method: 'POST', headers: auth, body: form })).json()
  const doc = await (await fetch(`${base}/api/import/create`, { method: 'POST', headers: json, body: JSON.stringify(preview) })).json()
  const md = await (await fetch(`${base}/api/docs/${doc.id}/export?format=md`, { headers: auth })).text()
  const versions = await (await fetch(`${base}/api/docs/${doc.id}/versions`, { headers: auth })).json()
  const models = await (await fetch(`${base}/api/models`, { headers: auth })).json()
  const page = await (await fetch(`${base}/`)).text()
  // A real PDF, produced here, through the import pipeline: proves the PDF parser works inside the package.
  const printer = new BrowserWindow({ show: false })
  await printer.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<h1 style="font-size:32px">PDF Title</h1><p>First paragraph of the smoke document.</p><p>Second paragraph.</p>'))
  const pdf = await printer.webContents.printToPDF({})
  printer.destroy()
  const pdfForm = new FormData()
  pdfForm.append('file', new File([new Uint8Array(pdf)], 'smoke.pdf'))
  const pdfPreview = await (await fetch(`${base}/api/import/preview`, { method: 'POST', headers: auth, body: pdfForm })).json()
  const pdfText = JSON.stringify(pdfPreview.blocks ?? pdfPreview)
  const docx = await fetch(`${base}/api/docs/${doc.id}/export?format=docx`, { headers: auth })
  const docxBytes = new Uint8Array(await docx.arrayBuffer())
  // The bridge must at least load and explain itself when run the way an agent would run it.
  const bridge = spawnSync(process.execPath, [join(__dirname, 'mcp.mjs')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20_000 })
  await fetch(`${base}/api/docs/${doc.id}`, { method: 'DELETE', headers: auth })
  const checks = {
    unauthorized,
    localUser: me.user?.id === 'local' && me.mode === 'local',
    importExport: md.includes('# Smoke') && md.includes('**world**') && md.includes('- a'),
    versionOnImport: Array.isArray(versions) && versions.some((v: { trigger: string }) => v.trigger === 'import'),
    servesWebApp: page.includes('<div id="root">'),
    wordExport: docx.status === 200 && docxBytes[0] === 0x50 && docxBytes[1] === 0x4b,
    mcpBridge: bridge.status === 2 && bridge.stderr.includes('usage: mcp'),
    pdfImport: pdfText.includes('PDF Title') && pdfText.includes('First paragraph') && pdfText.includes('"heading"'),
    keychain: safeStorage.isEncryptionAvailable() ? secrets.decrypt(secrets.encrypt('k')) === 'k' : 'unavailable',
  }
  const ok = unauthorized === 401 && checks.localUser && checks.importExport && checks.versionOnImport && checks.servesWebApp && checks.wordExport && checks.mcpBridge && checks.pdfImport && checks.keychain !== false
  console.log(JSON.stringify({ ok, packaged: app.isPackaged, electron: process.versions.electron, models: models.models?.length ?? 0, checks }))
  return ok
}

if (!app.requestSingleInstanceLock() && !SMOKE) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    } else createWindow()
  })
  void app.whenReady().then(async () => {
    try {
      // The product was renamed from "AI Writer", which moved Electron's userData dir. Copy the old data over once; the old copy is kept.
      if (!SMOKE) {
        try {
          const oldData = join(app.getPath('appData'), 'AI Writer', 'data')
          const newData = join(app.getPath('userData'), 'data')
          if (!fs.existsSync(newData) && fs.existsSync(oldData)) fs.cpSync(oldData, newData, { recursive: true })
        } catch (err) {
          console.error('copying data from the AI Writer directory failed', err)
        }
      }
      server = await startServer({
        mode: 'local',
        dataDir: join(app.getPath('userData'), SMOKE ? 'smoke-data' : 'data'),
        port: 0,
        staticDir: join(__dirname, '..', 'web'),
        secrets,
        // External agents start this bridge themselves; Electron runs it as plain Node.
        mcpCommand: { command: process.execPath, args: [join(__dirname, 'mcp.mjs')], env: { ELECTRON_RUN_AS_NODE: '1' } },
      })
      if (SMOKE) {
        const ok = await smoke(server)
        await server.close()
        app.exit(ok ? 0 : 1)
        return
      }
      if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
      createWindow()
      void checkForUpdates()
    } catch (err) {
      console.error(err)
      if (!SMOKE) dialog.showErrorBox('Stetpad 无法启动', String(err))
      app.exit(1)
    }
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', () => void server?.close())
}
