import { createCanvas, loadImage } from '@napi-rs/canvas'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js'
import { TeX } from 'mathjax-full/js/input/tex.js'
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js'
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js'
import { mathjax } from 'mathjax-full/js/mathjax.js'
import { SVG } from 'mathjax-full/js/output/svg.js'
import type { Block } from './content'

/** Rendering of `math` and `mermaid` code blocks for export. */

const adaptor = liteAdaptor()
RegisterHTMLHandler(adaptor)

const MAX_SVG_BYTES = 2 * 1024 * 1024
/** One `ex` is about half an em; the export text is 16px, so 1ex is about 8px. */
const EX_PX = 8

/** Writes width/height attributes on the root <svg> in px, taken from the given size or the viewBox. */
function withSize(svg: string, size?: { width: number; height: number }): { svg: string; width: number; height: number } | null {
  const m = /^<svg\b[^>]*>/i.exec(svg)
  if (!m) return null
  const tag = m[0]
  const attr = (name: string): number | null => {
    const v = new RegExp(`\\s${name}\\s*=\\s*"([\\d.]+)(ex|px)?"`, 'i').exec(tag)
    if (!v) return null
    const n = Number(v[1])
    return Number.isFinite(n) ? (v[2]?.toLowerCase() === 'ex' ? n * EX_PX : n) : null
  }
  const vb = /viewBox\s*=\s*"([^"]+)"/i.exec(tag)?.[1]?.trim().split(/[\s,]+/).map(Number)
  let width = size?.width ?? attr('width') ?? (vb && vb.length === 4 ? vb[2]! : 0)
  let height = size?.height ?? attr('height') ?? (vb && vb.length === 4 ? vb[3]! : 0)
  width = Math.round(width * 100) / 100
  height = Math.round(height * 100) / 100
  if (!(width > 0 && height > 0)) return null
  let next = tag.replace(/\s(width|height)\s*=\s*"[^"]*"/gi, '')
  next = next.replace(/^<svg\b/i, `<svg width="${width}" height="${height}"`)
  if (!/\sxmlns\s*=/.test(next)) next = next.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  return { svg: next + svg.slice(tag.length), width, height }
}

const svgCache = new Map<string, string | null>()
const SVG_CACHE_MAX = 300

/**
 * LaTeX -> self-contained SVG (glyphs as paths), or null on a TeX error.
 * `display: false` is an inline formula: its `vertical-align` (MathJax puts it on the container) is copied onto the svg.
 */
export function mathToSvg(tex: string, opts: { display?: boolean } = {}): string | null {
  const src = tex.trim()
  if (!src || src.length > 20000) return null
  const display = opts.display !== false
  const key = (display ? 'd' : 'i') + src
  if (svgCache.has(key)) return svgCache.get(key) ?? null
  const out = convertTex(src, display)
  if (svgCache.size >= SVG_CACHE_MAX) svgCache.delete(svgCache.keys().next().value as string)
  svgCache.set(key, out)
  return out
}

function convertTex(src: string, display: boolean): string | null {
  try {
    const input = new TeX({ packages: AllPackages, formatError: (_jax: unknown, err: Error) => { throw err } })
    const output = new SVG({ fontCache: 'none' })
    const doc = mathjax.document('', { InputJax: input, OutputJax: output })
    const html = adaptor.outerHTML(doc.convert(src, { display }))
    const m = /<svg[\s\S]*<\/svg>/.exec(html)
    if (!m) return null
    const sized = withSize(m[0])?.svg
    if (!sized) return null
    const va = display ? null : /vertical-align:\s*(-?[\d.]+ex)/.exec(html)?.[1]
    return va ? withStyle(sized, `vertical-align: ${va}`) : sized
  } catch {
    return null
  }
}

/** Adds a CSS declaration to the root <svg> tag, merging with any style it already has. */
function withStyle(svg: string, decl: string): string {
  const m = /^<svg\b[^>]*>/i.exec(svg)
  if (!m) return svg
  const tag = m[0]
  const existing = /\sstyle\s*=\s*"([^"]*)"/i.exec(tag)
  if (existing && /vertical-align/.test(existing[1]!)) return svg
  const next = existing
    ? tag.replace(existing[0], ` style="${existing[1]!.replace(/;?\s*$/, '')}; ${decl}"`)
    : tag.replace(/^<svg\b/i, `<svg style="${decl}"`)
  return next + svg.slice(tag.length)
}

const DANGEROUS_ELEMENTS = /<(script|foreignObject|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi
const LONE_DANGEROUS_TAGS = /<\/?(script|foreignObject|iframe|object|embed)\b[^>]*>/gi
const TAG = /<[A-Za-z][^\s/>]*(?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*\s*\/?>/g
const ATTR = /\s(on[a-z]+|(?:xlink:)?href)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/gi

/** An SVG string from the browser, reduced to something safe to inline. Null if it is not an SVG. */
export function sanitizeSvg(svg: string): string | null {
  if (typeof svg !== 'string' || svg.length > MAX_SVG_BYTES) return null
  let s = svg.trim()
  if (!/^<svg[\s>]/i.test(s)) return null
  s = s.replace(DANGEROUS_ELEMENTS, '').replace(LONE_DANGEROUS_TAGS, '')
  s = s.replace(TAG, (tag) => tag.replace(ATTR, (whole, name: string, raw: string) => {
    if (/^on/i.test(name)) return ''
    const v = raw.replace(/^["']|["']$/g, '').trim()
    return v.startsWith('#') || /^data:image\//i.test(v) ? whole : ''
  }))
  return /^<svg[\s>]/i.test(s) ? s : null
}

/**
 * Rasterizes an SVG to PNG on white. `width`/`height` are the CSS px size; the PNG
 * has `scale` times that many pixels.
 */
export async function svgToPng(svg: string, scale = 2): Promise<{ png: Uint8Array; width: number; height: number } | null> {
  try {
    // The rasterizer ignores `em` in text positions (Mermaid labels use them); 16px is Mermaid's font size.
    svg = svg.replace(/\b(x|y|dx|dy)="(-?[\d.]+)em"/g, (_, a: string, n: string) => `${a}="${(Number(n) * 16).toFixed(2)}"`)
    const sized = withSize(svg)
    if (!sized) return null
    const big = withSize(svg, { width: sized.width * scale, height: sized.height * scale })
    if (!big) return null
    const img = await loadImage(Buffer.from(big.svg))
    const canvas = createCanvas(Math.round(sized.width * scale), Math.round(sized.height * scale))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return { png: new Uint8Array(canvas.toBuffer('image/png')), width: sized.width, height: sized.height }
  } catch {
    return null
  }
}

/**
 * Inline SVG for each `math` (rendered here) and `mermaid` (from the browser, sanitized) code block,
 * keyed by block id. PNGs are made only when `opts.png` is set (Word export).
 */
export interface Raster { png: Uint8Array; width: number; height: number }

/** The source text of a code block, as the export sees it (the key of the render cache for mermaid). */
export function diagramSource(b: Block): string {
  return b.delta.map((d) => d.insert).join('')
}

/**
 * Mermaid SVG (and the browser's PNG, when there is one) per diagram source, on disk under `dir`.
 * Keyed by the sha256 of the trimmed source, so a diagram can be exported without a browser once the
 * editor has shown it. Every failure is a miss: the cache only saves a render.
 */
export class RenderCache {
  /** `scope` (a document id) keeps one document's renders apart from another's: a user can only write to their own. */
  constructor(
    private readonly dir: string,
    private readonly scope = '',
  ) {}

  /** The cache of one document. */
  forDoc(docId: string): RenderCache {
    return new RenderCache(this.dir, docId)
  }

  /** One folder per document (named by a hash, so any id is a safe name), so deleting a document clears its renders. */
  private get folder(): string {
    return join(this.dir, createHash('sha256').update(this.scope).digest('hex').slice(0, 32))
  }

  private file(source: string, ext: string): string {
    return join(this.folder, createHash('sha256').update(source.trim()).digest('hex') + ext)
  }

  /** Removes every render of this document. */
  async clear(): Promise<void> {
    await rm(this.folder, { recursive: true, force: true }).catch(() => undefined)
  }

  async get(source: string): Promise<{ svg: string; raster?: Raster } | null> {
    if (!source.trim()) return null
    try {
      const svg = sanitizeSvg(await readFile(this.file(source, '.svg'), 'utf8'))
      if (!svg) return null
      const out: { svg: string; raster?: Raster } = { svg }
      try {
        const meta = JSON.parse(await readFile(this.file(source, '.json'), 'utf8')) as { width?: unknown; height?: unknown }
        const width = Number(meta.width)
        const height = Number(meta.height)
        const png = new Uint8Array(await readFile(this.file(source, '.png')))
        if (width > 0 && height > 0 && png.length > 0) out.raster = { png, width, height }
      } catch {
        // No raster cached for this source.
      }
      return out
    } catch {
      return null
    }
  }

  /** Stores the sanitized SVG, and the raster when given. Without a raster, an older one for the source is removed. */
  async put(source: string, svg: string, raster?: Raster): Promise<void> {
    const clean = sanitizeSvg(svg)
    if (!source.trim() || !clean) return
    try {
      await mkdir(this.folder, { recursive: true })
      await writeFile(this.file(source, '.svg'), clean)
      if (raster) {
        await writeFile(this.file(source, '.png'), raster.png)
        await writeFile(this.file(source, '.json'), JSON.stringify({ width: raster.width, height: raster.height }))
      } else {
        await Promise.all(['.png', '.json'].map((ext) => rm(this.file(source, ext), { force: true }).catch(() => undefined)))
      }
    } catch {
      // A cache that cannot be written only costs a render later.
    }
  }
}

export async function prepareRenders(
  blocks: Block[],
  clientSvgs: Record<string, string> | undefined,
  opts: { png: boolean; rasters?: Record<string, Raster>; cache?: RenderCache },
): Promise<{ svg: Record<string, string>; png: Record<string, Raster> }> {
  const svg: Record<string, string> = {}
  const png: Record<string, Raster> = {}
  for (const b of blocks) {
    if (b.type !== 'codeBlock' || !b.blockId) continue
    const lang = String(b.attrs.language ?? '')
    let out: string | null = null
    let raster: Raster | undefined
    if (lang === 'math') out = mathToSvg(diagramSource(b))
    else if (lang === 'mermaid') {
      const source = diagramSource(b)
      // The browser's SVG (and PNG) is the current one: keep it in the cache. Otherwise use the cache.
      raster = opts.rasters?.[b.blockId]
      const raw = clientSvgs?.[b.blockId]
      out = raw ? sanitizeSvg(raw) : null
      if (out) await opts.cache?.put(source, out, raster)
      else if (opts.cache) {
        const hit = await opts.cache.get(source)
        if (hit) {
          out = hit.svg
          raster = hit.raster
        }
      }
    }
    if (!out) continue
    svg[b.blockId] = out
    if (opts.png) {
      // A PNG the browser drew is exact; our own SVG renderer drops markers (arrowheads).
      const r = raster ?? (await svgToPng(out))
      if (r) png[b.blockId] = r
    }
  }
  return { svg, png }
}

/** A browser-drawn PNG sent as `{ png: 'data:image/png;base64,...', width, height }`, or null when it is not one. */
export function parseRaster(v: unknown): { png: Uint8Array; width: number; height: number } | null {
  if (!v || typeof v !== 'object') return null
  const { png, width, height } = v as { png?: unknown; width?: unknown; height?: unknown }
  if (typeof png !== 'string' || !png.startsWith('data:image/png;base64,')) return null
  const w = Number(width)
  const h = Number(height)
  if (!(w > 0 && w <= 10000 && h > 0 && h <= 10000)) return null
  const bytes = new Uint8Array(Buffer.from(png.slice('data:image/png;base64,'.length), 'base64'))
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  return sig.every((b, i) => bytes[i] === b) ? { png: bytes, width: w, height: h } : null
}

/**
 * Word only embeds PNG, JPEG and GIF. WebP (common for AI images) becomes JPEG and SVG becomes PNG;
 * other types pass through unchanged. Null when a conversion fails.
 */
export async function wordSafeImage(asset: { mime: string; data: Uint8Array }): Promise<{ mime: string; data: Uint8Array } | null> {
  if (asset.mime === 'image/svg+xml') {
    const r = await svgToPng(new TextDecoder().decode(asset.data), 1)
    return r ? { mime: 'image/png', data: r.png } : null
  }
  if (asset.mime !== 'image/webp') return asset
  try {
    const img = await loadImage(Buffer.from(asset.data))
    // AI images are photo-like: JPEG keeps the Word file small. White under any transparency.
    const canvas = createCanvas(img.width, img.height)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, img.width, img.height)
    ctx.drawImage(img, 0, 0)
    return { mime: 'image/jpeg', data: new Uint8Array(await canvas.encode('jpeg', 88)) }
  } catch {
    return null
  }
}
