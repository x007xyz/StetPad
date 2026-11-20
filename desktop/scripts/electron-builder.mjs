// Runs electron-builder with the package.json build config, plus the bundled draw.io folder when it exists
// (npm run fetch:drawio). The merged config is written to dist/, which is not committed.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'))
const config = structuredClone(pkg.build)
if (existsSync(join(desktop, 'drawio', 'index.html'))) {
  // Copied next to the app, outside the asar archive, so main.ts can point the server at it.
  config.extraResources = [{ from: 'drawio', to: 'drawio' }]
}
mkdirSync(join(desktop, 'dist'), { recursive: true })
const file = join(desktop, 'dist', 'electron-builder.json')
writeFileSync(file, JSON.stringify(config, null, 2))
const bin = join(desktop, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder')
const res = spawnSync(bin, ['--config', file, ...process.argv.slice(2)], { cwd: desktop, stdio: 'inherit', shell: process.platform === 'win32' })
process.exit(res.status ?? 1)
