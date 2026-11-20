// Downloads the pinned draw.io webapp (the release's draw.war, which is a zip) and extracts it to desktop/drawio,
// so the desktop app can serve the diagram editor offline. Run: npm run fetch:drawio (in desktop/).
import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, renameSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The draw.io release to bundle. Bump it deliberately: the editor and its embed protocol come from this version. */
export const DRAWIO_VERSION = '32.6.10'

const here = dirname(fileURLToPath(import.meta.url))
const TARGET = resolve(here, '..', 'drawio')
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

export function drawioUrl(version = DRAWIO_VERSION) {
  return `https://github.com/jgraph/drawio/releases/download/v${version}/draw.war`
}

/**
 * True when a zip entry name could be written outside the target folder: empty, absolute, a drive letter,
 * a backslash, or any `..` segment. Such an archive is refused before anything is extracted.
 */
export function unsafeEntry(name) {
  if (!name || name.includes('\0') || name.includes('\\')) return true
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return true
  return name.split('/').some((segment) => segment === '..')
}

/** Throws unless `unzip` is available. It is the only zip reader used here. */
function requireUnzip() {
  const probe = spawnSync('unzip', ['-v'], { encoding: 'utf8' })
  if (probe.error) {
    throw new Error('需要 unzip 命令来解压 draw.io（macOS 和 Linux 自带；Windows 请先安装 unzip 或在 WSL 中运行）')
  }
}

/** Lists the entry names of a zip, after checking that the archive opens. Throws if it is not a readable zip. */
export function listZip(archive) {
  const test = spawnSync('unzip', ['-tq', archive], { encoding: 'utf8' })
  if (test.status !== 0) throw new Error(`下载的文件不是有效的 zip 包：${archive}`)
  const list = spawnSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
  if (list.status !== 0) throw new Error('无法读取 draw.war 的目录')
  return list.stdout.split('\n').filter(Boolean)
}

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok || !res.body) throw new Error(`下载 draw.io 失败（${res.status}）：${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file))
}

export async function fetchDrawio({ version = DRAWIO_VERSION, target = TARGET } = {}) {
  requireUnzip()
  const work = mkdtempSync(join(tmpdir(), 'stetpad-drawio-'))
  const war = join(work, 'draw.war')
  const partial = `${target}.partial`
  try {
    const url = drawioUrl(version)
    console.log(`下载 ${url}`)
    await download(url, war)
    console.log(`已下载 ${statSync(war).size} 字节，检查压缩包`)
    const names = listZip(war)
    const bad = names.find(unsafeEntry)
    if (bad !== undefined) throw new Error(`draw.war 含有不安全的路径，已拒绝：${bad}`)
    rmSync(partial, { recursive: true, force: true })
    mkdirSync(partial, { recursive: true })
    const extract = spawnSync('unzip', ['-q', '-o', war, '-d', partial], { encoding: 'utf8' })
    if (extract.status !== 0) throw new Error(`解压 draw.war 失败：${extract.stderr || extract.status}`)
    if (!existsSync(join(partial, 'index.html'))) throw new Error('draw.war 中没有 index.html')
    rmSync(target, { recursive: true, force: true })
    renameSync(partial, target)
    console.log(`draw.io ${version} 已解压到 ${target}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
    rmSync(partial, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  fetchDrawio().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
