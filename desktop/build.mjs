// Bundles the main process (which contains the whole server) and copies the web app.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const win = process.platform === 'win32'
const esbuild = join(root, 'packages/server/node_modules/.bin', win ? 'esbuild.cmd' : 'esbuild')
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', shell: win })
const common = ['--bundle', '--platform=node', '--target=node22', '--format=cjs', '--log-level=warning',
  '--external:electron', '--external:better-sqlite3', '--external:pdfjs-dist', '--external:@napi-rs/canvas', '--external:bufferutil', '--external:utf-8-validate', '--external:pg-native', '--external:electron-updater']

rmSync(join(here, 'dist'), { recursive: true, force: true })
run(esbuild, [join(here, 'src/main.ts'), `--outfile=${join(here, 'dist/main.cjs')}`, ...common])
// The MCP bridge that external agents start. It is run by Electron in Node mode.
run(esbuild, [join(root, 'packages/server/src/mcp.ts'), `--outfile=${join(here, 'dist/mcp.mjs')}`, '--bundle', '--platform=node', '--target=node22', '--format=esm', '--log-level=warning',
  '--external:bufferutil', '--external:utf-8-validate', "--banner:js=import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);"])
run(esbuild, [join(here, 'src/preload.ts'), `--outfile=${join(here, 'dist/preload.cjs')}`, ...common])

const web = join(root, 'apps/web/dist')
if (!existsSync(web)) run('pnpm', ['--dir', join(root, 'apps/web'), 'build'])
rmSync(join(here, 'web'), { recursive: true, force: true })
cpSync(web, join(here, 'web'), { recursive: true })
console.log('desktop build ready')
