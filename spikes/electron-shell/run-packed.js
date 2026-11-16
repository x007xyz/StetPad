// Runs the packaged app's executable, passing through arguments and exit code.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const release = path.join(__dirname, 'release')
const dir = fs.readdirSync(release).find((d) => d.startsWith('mac'))
if (!dir) { console.error('no packaged build found; run `npm run pack` first'); process.exit(1) }
const exe = path.join(release, dir, 'AiWriterSpike.app', 'Contents', 'MacOS', 'AiWriterSpike')
const r = spawnSync(exe, process.argv.slice(2), { stdio: 'inherit' })
process.exit(r.status ?? 1)
