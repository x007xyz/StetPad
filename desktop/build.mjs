// Bundles the main process (which contains the whole server) and copies the web app.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const win = process.platform === 'win32'
const { buildSync } = createRequire(join(root, 'packages/server/package.json'))('esbuild')
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', shell: win })
const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', logLevel: 'warning',
  external: ['electron', 'better-sqlite3', 'pdfjs-dist', '@napi-rs/canvas', 'bufferutil', 'utf-8-validate', 'pg-native', 'electron-updater'] }

rmSync(join(here, 'dist'), { recursive: true, force: true })
buildSync({ entryPoints: [join(here, 'src/main.ts')], outfile: join(here, 'dist/main.cjs'), ...common })
// The MCP bridge that external agents start. It is run by Electron in Node mode.
buildSync({ entryPoints: [join(root, 'packages/server/src/mcp.ts')], outfile: join(here, 'dist/mcp.mjs'), bundle: true, platform: 'node', target: 'node22', format: 'esm', logLevel: 'warning',
  external: ['bufferutil', 'utf-8-validate'], banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" } })
buildSync({ entryPoints: [join(here, 'src/preload.ts')], outfile: join(here, 'dist/preload.cjs'), ...common })

const web = join(root, 'apps/web/dist')
if (!existsSync(web)) run('pnpm', ['--dir', join(root, 'apps/web'), 'build'])
rmSync(join(here, 'web'), { recursive: true, force: true })
cpSync(web, join(here, 'web'), { recursive: true })
console.log('desktop build ready')
