import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const safariOut = join(root, '.output/safari-mv3')
const xcodeOut = join(root, '.output/safari-xcode')

if (!existsSync(safariOut)) {
  console.log('Building Safari WebExtension first...')
  execFileSync(join(root, 'node_modules/.bin/wxt'), ['build', '-b', 'safari'], { cwd: root, stdio: 'inherit' })
}

execFileSync(
  'xcrun',
  [
    'safari-web-extension-converter',
    '--macos-only',
    '--copy-resources',
    '--no-open',
    '--no-prompt',
    '--force',
    '--app-name',
    'Stetpad Clipper',
    '--bundle-identifier',
    'app.stetpad.clipper',
    '--project-location',
    xcodeOut,
    safariOut,
  ],
  { cwd: root, stdio: 'inherit' },
)

console.log(`Safari Xcode project generated at ${xcodeOut}`)
