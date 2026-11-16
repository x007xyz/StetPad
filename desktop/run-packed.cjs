// Runs the packaged app's executable, passing through arguments and exit code.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const release = path.join(__dirname, 'release')
const dirs = fs.existsSync(release) ? fs.readdirSync(release) : []
let exe
if (process.platform === 'win32') {
  if (dirs.includes('win-unpacked')) exe = path.join(release, 'win-unpacked', 'Stetpad.exe')
} else {
  const dir = dirs.find((d) => d.startsWith('mac'))
  if (dir) exe = path.join(release, dir, 'Stetpad.app', 'Contents', 'MacOS', 'Stetpad')
}
if (!exe) { console.error('no packaged build found; run `npm run pack` first'); process.exit(1) }
const r = spawnSync(exe, process.argv.slice(2), { stdio: 'inherit', timeout: 60000 })
process.exit(r.status ?? 1)
