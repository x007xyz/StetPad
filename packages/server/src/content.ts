import { blocksToMarkdown, domToBlocks, embedPlayerUrl, isSafeSrc, type Block } from '@stetpad/clip'
import {
  blockIdOf,
  blocks as yBlocks,
  blockTexts,
  changes,
  compact,
  content,
  decide,
  footnoteAttr,
  footnotesOf,
  insertBlock,
  listChanges,
  newBlockId,
  type FootnoteInfo,
  type RichBlock,
} from '@stetpad/crdt'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import mammoth from 'mammoth'
import { marked } from 'marked'
import { AlignmentType, Document as DocxDocument, ExternalHyperlink, FootnoteReferenceRun, HeadingLevel, ImageRun, LevelFormat, Packer, Paragraph as DocxParagraph, Table as DocxTable, TableCell, TableRow, TextRun, WidthType } from 'docx'
import * as Y from 'yjs'
import { mathToSvg, svgToPng } from './render'

export type { Block }
export { blocksToMarkdown }

const text = (b: Block): string => b.delta.map((d) => d.insert).join('')
const para = (s: string): Block => ({ type: 'paragraph', attrs: {}, delta: s ? [{ insert: s }] : [] })

// ---------- HTML -> blocks ----------

/**
 * Reduce arbitrary HTML to whitelisted blocks. Nothing from the source is
 * passed through as HTML: only text, a fixed set of marks, and checked URLs.
 */
export function htmlToBlocks(html: string, baseUrl?: string): Block[] {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`)
  return domToBlocks(document.body, { baseUrl })
}

// ---------- files -> blocks ----------

/** For each line, whether it belongs to a fenced code block (fence lines included). */
function fencedCodeLines(lines: string[]): boolean[] {
  let fence: string | null = null
  return lines.map((line) => {
    if (fence !== null) {
      const t = line.trim()
      if (t.length >= fence.length && [...t].every((c) => c === fence![0])) fence = null
      return true
    }
    // A backtick fence's info string has no backticks; ```x``` is a code span.
    const open = /^\s*(`{3,}(?!.*`)|~{3,})/.exec(line)
    if (open) fence = open[1]!
    return open !== null
  })
}

const MATH_DELIM = /^[ \t]*\$\$[ \t]*\r?$/
const MATH_LINE = /^[ \t]*\$\$(.+?)\$\$[ \t]*\r?$/

/**
 * `$$` display formulas on their own lines become ```math fences, so marked
 * emits them as `<pre><code class="language-math">`. Fenced code is left alone.
 */
export function mathToFence(md: string): string {
  const lines = md.split('\n')
  const code = fencedCodeLines(lines)
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (code[i]) {
      out.push(line)
      continue
    }
    const one = MATH_LINE.exec(line)
    if (one) {
      out.push('```math', one[1]!.trim(), '```')
      continue
    }
    const end = MATH_DELIM.test(line) ? lines.findIndex((l, j) => j > i && !code[j] && MATH_DELIM.test(l)) : -1
    if (end === -1) {
      out.push(line)
      continue
    }
    out.push('```math', lines.slice(i + 1, end).join('\n').replace(/\n+$/, ''), '```')
    i = end
  }
  return out.join('\n')
}

export type Ocr = (png: Uint8Array, page: number) => Promise<string>

/** Plain/Markdown-ish transcription -> blocks. */
export function textToBlocks(text: string): Block[] {
  const out: Block[] = []
  for (const chunk of text.split(/\n\s*\n/)) {
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean)
    let buf: string[] = []
    const flush = (): void => {
      if (buf.length) out.push(para(buf.join(/[　-鿿]$/.test(buf[0]!) ? '' : ' ')))
      buf = []
    }
    for (const l of lines) {
      const h = l.match(/^(#{1,3})\s+(.*)$/)
      const b = l.match(/^([-•*]|\d+[.)、])\s+(.*)$/)
      if (h) {
        flush()
        out.push({ type: 'heading', attrs: { level: h[1]!.length }, delta: [{ insert: h[2]! }] })
      } else if (b) {
        flush()
        out.push({ type: /^\d/.test(b[1]!) ? 'orderedItem' : 'bulletItem', attrs: { indent: 0 }, delta: [{ insert: b[2]! }] })
      } else buf.push(l)
    }
    flush()
  }
  return out
}

async function ocrPdf(pdf: { numPages: number; getPage: (n: number) => Promise<any> }, ocr: Ocr): Promise<Block[]> {
  if (pdf.numPages > 40) throw new Error('扫描件识别最多支持 40 页')
  const { createCanvas } = await import('@napi-rs/canvas')
  const texts: string[] = []
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const viewport = page.getViewport({ scale: 1.6 })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    await page.render({ canvas: canvas as any, canvasContext: canvas.getContext('2d') as any, viewport }).promise
    texts.push(await ocr(new Uint8Array(canvas.toBuffer('image/png')), p))
  }
  return textToBlocks(texts.join('\n\n'))
}

/** One page of a PDF as PNG (for attachment previews), with the page count. Null when the page does not exist. */
export async function renderPdfPage(data: Uint8Array, pageNumber: number, scale = 1.5): Promise<{ png: Uint8Array; pages: number } | null> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data, useSystemFonts: true })
  const pdf = await task.promise
  try {
    if (pageNumber < 1 || pageNumber > pdf.numPages) return null
    const { createCanvas } = await import('@napi-rs/canvas')
    const page = await pdf.getPage(pageNumber)
    const viewport = page.getViewport({ scale })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.render({ canvas: canvas as any, canvasContext: ctx as any, viewport }).promise
    return { png: new Uint8Array(canvas.toBuffer('image/png')), pages: pdf.numPages }
  } finally {
    await task.destroy()
  }
}

/** Page count of a PDF. */
export async function pdfPageCount(data: Uint8Array): Promise<number> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data, useSystemFonts: true })
  try {
    return (await task.promise).numPages
  } finally {
    await task.destroy()
  }
}

async function pdfToBlocks(data: Uint8Array, ocr?: Ocr): Promise<Block[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const pdf = await pdfjs.getDocument({ data, useSystemFonts: true }).promise
  type Line = { y: number; x: number; size: number; text: string; page: number }
  const lines: Line[] = []
  for (let p = 1; p <= Math.min(pdf.numPages, 500); p++) {
    const page = await pdf.getPage(p)
    const tc = await page.getTextContent()
    let cur: Line | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const item of tc.items as any[]) {
      if (typeof item.str !== 'string') continue
      const y = item.transform[5] as number
      const size = Math.abs(item.transform[3] as number) || (item.height as number) || 10
      if (cur && Math.abs(cur.y - y) < size * 0.5) {
        cur.text += item.str
        cur.size = Math.max(cur.size, size)
      } else {
        if (cur && cur.text.trim()) lines.push(cur)
        cur = { y, x: item.transform[4] as number, size, text: item.str, page: p }
      }
    }
    if (cur && cur.text.trim()) lines.push(cur)
  }
  if (lines.length === 0) {
    if (ocr) return ocrPdf(pdf, ocr)
    throw new Error('这个 PDF 没有文字层（可能是扫描件），配置一个支持图像的模型后可识别')
  }
  const sizes = lines.map((l) => Math.round(l.size * 2) / 2).sort((a, b) => a - b)
  const body = sizes[Math.floor(sizes.length / 2)]!
  const out: Block[] = []
  let buf = ''
  let prev: Line | null = null
  const flush = (): void => {
    if (buf.trim()) out.push(para(buf.trim()))
    buf = ''
  }
  for (const l of lines) {
    const t = l.text.trim()
    const isHeading = l.size >= body * 1.18 && t.length < 80
    const bullet = t.match(/^([•·▪◦‣\-–]|\d+[.)、])\s+(.*)$/)
    if (isHeading) {
      flush()
      out.push({ type: 'heading', attrs: { level: l.size >= body * 1.6 ? 1 : l.size >= body * 1.35 ? 2 : 3 }, delta: [{ insert: t }] })
    } else if (bullet) {
      flush()
      out.push({ type: /^\d/.test(bullet[1]!) ? 'orderedItem' : 'bulletItem', attrs: { indent: 0 }, delta: [{ insert: bullet[2]! }] })
    } else {
      const gap = prev && prev.page === l.page ? prev.y - l.y : Infinity
      const newPara = !prev || gap > l.size * 1.9 || gap < 0 || (prev.page !== l.page && /[。.!?！？”"]$/.test(buf.trim()))
      if (newPara) flush()
      const cjk = /[　-鿿]$/.test(buf) || /^[　-鿿]/.test(t)
      buf += (buf && !cjk && !buf.endsWith('-') ? ' ' : '') + t
    }
    prev = l
  }
  flush()
  return out
}

export async function fileToBlocks(name: string, data: Uint8Array, opts: { ocr?: Ocr } = {}): Promise<Block[]> {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (data.byteLength > 30 * 1024 * 1024) throw new Error('文件超过 30MB')
  if (ext === 'docx') {
    const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(data) })
    return htmlToBlocks(value)
  }
  if (ext === 'pdf') return pdfToBlocks(data, opts.ocr)
  const str = new TextDecoder().decode(data)
  if (ext === 'md' || ext === 'markdown') {
    const { body, defs } = splitMdFootnotes(str)
    const { body: safe, tex } = protectInlineMath(mathToFence(body))
    return restoreInlineMath(applyMdFootnotes(htmlToBlocks(await marked.parse(safe, { gfm: true })), defs), tex)
  }
  if (ext === 'html' || ext === 'htm') {
    const { document } = parseHTML(str)
    let article: { content?: string | null; title?: string | null } | null = null
    try {
      article = new Readability(document.cloneNode(true) as unknown as Document).parse()
    } catch {
      article = null
    }
    const blocks = htmlToBlocks(article?.content || document.body?.innerHTML || str)
    const title = article?.title || document.querySelector('title')?.textContent
    if (title && blocks[0]?.type !== 'heading') blocks.unshift({ type: 'heading', attrs: { level: 1 }, delta: [{ insert: title.trim() }] })
    return blocks
  }
  if (ext === 'txt') return str.split(/\n\s*\n/).map((s) => para(s.replace(/\s*\n\s*/g, ' ').trim())).filter((b) => b.delta.length)
  throw new Error(`不支持的文件类型：.${ext}`)
}

// ---------- Markdown footnotes ----------

const FN_DEF = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/
/** Punctuation that ends the word a footnote marker attaches to. */
const FN_STOP = /[\s，。！？；：、,.;:!?()（）「」“”"'《》]/

/** Take `[^label]: text` definitions out of Markdown. They are applied after parsing. */
export function splitMdFootnotes(src: string): { body: string; defs: Map<string, string> } {
  const defs = new Map<string, string>()
  const kept: string[] = []
  for (const line of src.split('\n')) {
    const m = line.match(FN_DEF)
    if (m) defs.set(m[1]!, m[2]!.trim())
    else kept.push(line)
  }
  return { body: kept.join('\n'), defs }
}

/**
 * Turn each `[^label]` marker into a footnote mark over the word before it.
 * A marker with no definition, or with nothing before it, is dropped.
 */
export function applyMdFootnotes(list: Block[], defs: Map<string, string>): Block[] {
  for (const b of list) {
    if (!b.delta.some((d) => d.insert.includes('[^'))) continue
    const chars: { ch: string; attributes?: Record<string, unknown> }[] = []
    for (const d of b.delta) for (const ch of d.insert) chars.push({ ch, attributes: d.attributes })
    const re = /\[\^([^\]\s]+)\]/
    let s = chars.map((c) => c.ch).join('')
    let m: RegExpExecArray | null
    while ((m = re.exec(s))) {
      const at = m.index
      let start = at
      while (start > 0 && !FN_STOP.test(chars[start - 1]!.ch)) start--
      const note = defs.get(m[1]!)
      if (note !== undefined && start < at) {
        const id = 'fn_' + Math.random().toString(36).slice(2, 10)
        for (let k = start; k < at; k++) chars[k]!.attributes = { ...chars[k]!.attributes, footnote: { id, note } }
      }
      chars.splice(at, m[0].length)
      s = chars.map((c) => c.ch).join('')
    }
    const delta: Block['delta'] = []
    for (const c of chars) {
      const attributes = c.attributes && Object.keys(c.attributes).length ? c.attributes : undefined
      const last = delta[delta.length - 1]
      if (last && JSON.stringify(last.attributes ?? null) === JSON.stringify(attributes ?? null)) last.insert += c.ch
      else delta.push(attributes ? { insert: c.ch, attributes } : { insert: c.ch })
    }
    b.delta = delta.filter((d) => d.insert.length > 0)
  }
  return list
}

// ---------- Markdown inline math ----------

/** `$…$` on one line, with the editor's input rule: no space inside the ends, no `$` inside, not before a digit. */
const INLINE_TEX = /(?<![\\$])\$(?=[^\s$])([^$\n]*?[^\s$\\])\$(?![\d$])/g
const TOKEN = /(\d+)/g

/** A code span: a run of backticks, then text, then a run of the same length. */
const CODE_SPAN = /(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/g

/** Applies `f` to the parts of `line` outside code spans. */
function outsideCodeSpans(line: string, f: (part: string) => string): string {
  let out = ''
  let last = 0
  for (const m of line.matchAll(CODE_SPAN)) {
    out += f(line.slice(last, m.index)) + m[0]
    last = m.index + m[0].length
  }
  return out + f(line.slice(last))
}

/**
 * Replaces inline `$…$` with placeholders before Markdown parsing, so that `*` and `_` inside a
 * formula are not read as emphasis. Code (fenced blocks, code spans), tables and lines with links or
 * images are left alone. `restoreInlineMath` puts the formulas back as math-marked text.
 */
export function protectInlineMath(md: string): { body: string; tex: string[] } {
  const tex: string[] = []
  const lines = md.split('\n')
  const code = fencedCodeLines(lines)
  const body = lines
    .map((line, i) => {
      if (code[i]) return line
      if (/^\s*\|/.test(line) || line.includes('](') || line.includes('![')) return line
      return outsideCodeSpans(line, (part) =>
        part.replace(INLINE_TEX, (_m, src: string) => {
          tex.push(src)
          return `${tex.length - 1}`
        }),
      )
    })
    .join('\n')
  return { body, tex }
}

/** Puts back the formulas of `protectInlineMath` as runs with the `math` mark. Stray placeholders become plain `$…$`. */
export function restoreInlineMath(list: Block[], tex: string[]): Block[] {
  if (!tex.length) return list
  for (const b of list) {
    const delta: Block['delta'] = []
    const push = (insert: string, attributes?: Record<string, unknown>): void => {
      if (!insert) return
      const last = delta[delta.length - 1]
      if (last && JSON.stringify(last.attributes ?? null) === JSON.stringify(attributes ?? null)) last.insert += insert
      else delta.push(attributes ? { insert, attributes } : { insert })
    }
    for (const d of b.delta) {
      d.insert.split(/(\d+)/).forEach((part, i) => {
        if (i % 2) push(tex[Number(part)] ?? '', { math: true })
        else push(part, d.attributes)
      })
    }
    b.delta = delta
    for (const [k, v] of Object.entries(b.attrs)) {
      if (typeof v === 'string' && v.includes('')) b.attrs[k] = v.replace(TOKEN, (_m, n: string) => `$${tex[Number(n)] ?? ''}$`)
    }
  }
  return list
}

// ---------- blocks <-> Y.Doc ----------

export function docFromBlocks(list: Block[]): Y.Doc {
  const doc = new Y.Doc()
  const all = list.length ? list : [para('')]
  doc.transact(() => {
    all.forEach((b, i) => insertBlock(doc, i, newBlockId(), '', b.type, b.attrs, b.delta))
  })
  return doc
}

/**
 * Make the document read like `target` (used by "restore version"). Written
 * as ordinary edits on top of the current state, so it syncs like any other
 * change. Pending suggestions are rejected first: they refer to text that the
 * restore is about to replace.
 */
export function applyBlocks(doc: Y.Doc, target: RichBlock[]): void {
  doc.transact(() => {
    for (const c of listChanges(doc)) decide(doc, c.id, 'reject')
    compact(doc)
    const frag = content(doc)
    const want = new Map(target.map((b) => [b.blockId, b]))
    // Drop blocks that are gone or whose type changed.
    for (let i = frag.length - 1; i >= 0; i--) {
      const el = frag.get(i)
      if (!(el instanceof Y.XmlElement)) continue
      const t = want.get(blockIdOf(el))
      if (!t || t.type !== el.nodeName) frag.delete(i, 1)
    }
    target.forEach((b, i) => {
      const at = frag.get(i)
      const el = at instanceof Y.XmlElement && blockIdOf(at) === b.blockId ? at : null
      if (!el) {
        // Yjs cannot move a node: remove a misplaced copy and recreate it here.
        const j = yBlocks(doc).findIndex((x) => blockIdOf(x) === b.blockId)
        if (j >= 0) frag.delete(j, 1)
        insertBlock(doc, i, b.blockId, '', b.type, b.attrs, b.delta)
        return
      }
      const cur = el.getAttributes() as Record<string, unknown>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const [k, v] of Object.entries(b.attrs)) if (cur[k] !== v) el.setAttribute(k, v as any)
      const now = JSON.stringify(blockTexts(el).flatMap((t) => t.toDelta()))
      if (now !== JSON.stringify(b.delta)) {
        for (const t of blockTexts(el)) t.delete(0, t.length)
        if (b.delta.length) {
          let t = blockTexts(el)[0]
          if (!t) {
            t = new Y.XmlText()
            el.insert(0, [t])
          }
          t.applyDelta(b.delta)
        }
      }
    })
    while (frag.length > target.length) frag.delete(frag.length - 1, 1)
    void changes
  })
}

// ---------- export ----------

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Footnote numbers are in reading order. Each footnote gets one reference
 * marker, placed after the last run of its id, as a synthetic run that the
 * inline writers turn into their own reference syntax.
 */
function withFootnoteRefs(input: Block[]): { blocks: Block[]; notes: FootnoteInfo[] } {
  const notes = footnotesOf(input)
  const number = new Map(notes.map((n) => [n.id, n.number]))
  // Position "block:run" of the last run of each id.
  const last = new Map<string, string>()
  input.forEach((b, bi) => b.delta.forEach((d, di) => {
    const f = footnoteAttr(d.attributes)
    if (f) last.set(f.id, `${bi}:${di}`)
  }))
  const blocks = input.map((b, bi) => ({
    ...b,
    delta: b.delta.flatMap((d, di) => {
      const ids = [...last].filter(([, at]) => at === `${bi}:${di}`).map(([id]) => id)
      return [d, ...ids.map((id) => ({ insert: '', attributes: { footnoteRef: number.get(id) } }))]
    }),
  }))
  return { blocks, notes }
}

function inlineHtml(delta: Block['delta']): string {
  return delta.map((d) => {
    let s = esc(d.insert)
    const a = d.attributes ?? {}
    if (a.footnoteRef) {
      const n = Number(a.footnoteRef)
      return `<sup><a href="#fn-${n}" id="fnref-${n}">${n}</a></sup>`
    }
    // Inline math is not combined with other marks: the formula is drawn as its own svg.
    if (a.math) {
      const svg = mathToSvg(d.insert, { display: false })
      return svg ? `<span class="math-inline">${svg}</span>` : esc(`$${d.insert}$`)
    }
    if (a.code) s = `<code>${s}</code>`
    if (a.bold) s = `<strong>${s}</strong>`
    if (a.italic) s = `<em>${s}</em>`
    if (a.underline) s = `<u>${s}</u>`
    if (a.strike) s = `<s>${s}</s>`
    if (a.highlight) s = `<mark>${s}</mark>`
    const href = (a.link as { href?: string } | undefined)?.href
    if (href) s = `<a href="${esc(href)}">${s}</a>`
    return s
  }).join('')
}
const tableRows = (b: Block): string[][] => {
  try {
    return JSON.parse(String(b.attrs.rows ?? '[]')) as string[][]
  } catch {
    return []
  }
}

/**
 * `renders`: block id -> inline SVG the browser made for a mermaid or math block.
 * The SVG is written as it is: the caller must produce it, not user input.
 */
export interface HtmlOptions {
  renders?: Record<string, string>
}

/** A byte count for people: 980 B, 1.5 KB, 12.3 MB. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 102.4) / 10} KB`
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2 * 10) / 10} MB`
  return `${Math.round(bytes / 1024 ** 3 * 10) / 10} GB`
}
const FILE_SRC = /^\/files\/[\w-]+$/
const WEB_URL = /^https?:\/\//i

const figure = (inner: string, caption: string): string =>
  `<figure>${inner}${caption ? `<figcaption>${esc(caption)}</figcaption>` : ''}</figure>`

export function blocksToHtml(input: Block[], title: string, opts: HtmlOptions = {}): string {
  const { blocks: list, notes } = withFootnoteRefs(input)
  const body: string[] = []
  const open: { tag: string; level: number }[] = []
  const close = (): void => {
    const last = open.pop()
    if (last) body.push(`</li></${last.tag}>`)
  }
  for (const b of list) {
    const level = Number(b.attrs.indent ?? 0)
    const tag = b.type === 'orderedItem' ? 'ol' : b.type === 'bulletItem' || b.type === 'taskItem' ? 'ul' : null
    while (open.length && (!tag || open[open.length - 1]!.level > level)) close()
    if (tag) {
      let last = open[open.length - 1]
      if (last?.level === level && last.tag !== tag) {
        close()
        last = open[open.length - 1]
      }
      if (last?.level === level) body.push('</li>')
      else {
        body.push(`<${tag}>`)
        open.push({ tag, level })
      }
    }
    switch (b.type) {
      case 'heading': body.push(`<h${b.attrs.level ?? 1}>${inlineHtml(b.delta)}</h${b.attrs.level ?? 1}>`); break
      case 'bulletItem': case 'orderedItem': body.push(`<li>${inlineHtml(b.delta)}`); break
      case 'taskItem': body.push(`<li><input type="checkbox" disabled${b.attrs.checked ? ' checked' : ''}> ${inlineHtml(b.delta)}`); break
      case 'quote': body.push(`<blockquote>${inlineHtml(b.delta)}</blockquote>`); break
      case 'callout': body.push(`<aside>${inlineHtml(b.delta)}</aside>`); break
      case 'codeBlock': {
        const lang = String(b.attrs.language ?? '')
        const svg = (lang === 'mermaid' || lang === 'math') && b.blockId ? opts.renders?.[b.blockId] : undefined
        if (svg && /^<svg[\s>]/i.test(svg.trim()) && !/<script/i.test(svg)) body.push(`<figure class="diagram">${svg}</figure>`)
        else {
          const cls = lang.replace(/[^\w+#.-]/g, '')
          body.push(`<pre><code${cls ? ` class="language-${cls}"` : ''}>${esc(text(b))}</code></pre>`)
        }
        break
      }
      case 'divider': body.push('<hr>'); break
      case 'image': {
        const width = Math.min(100, Math.max(10, Number(b.attrs.width ?? 100)))
        body.push(figure(`<img src="${esc(String(b.attrs.src ?? ''))}" alt="${esc(String(b.attrs.alt ?? ''))}" style="width:${width}%">`, String(b.attrs.caption ?? '')))
        break
      }
      case 'video': {
        const src = String(b.attrs.src ?? '')
        const t = esc(String(b.attrs.title ?? ''))
        const caption = String(b.attrs.caption ?? '')
        const embed = b.attrs.kind === 'embed'
        const player = embed ? embedPlayerUrl(src) : null
        if (player) body.push(figure(`<iframe src="${esc(player)}" title="${t}" allowfullscreen></iframe>`, caption))
        else if (!embed && (/^\/files\/[\w-]+$/.test(src) || /^https:/i.test(src))) {
          const poster = String(b.attrs.poster ?? '')
          const posterAttr = /^\/files\/[\w-]+$/.test(poster) ? ` poster="${esc(poster)}"` : ''
          const captions = String(b.attrs.captions ?? '')
          const track = /^\/files\/[\w-]+$/.test(captions) ? `<track kind="subtitles" src="${esc(captions)}" srclang="zh" label="字幕" default>` : ''
          body.push(figure(`<video controls${posterAttr} src="${esc(src)}" title="${t}">${track}</video>`, caption))
        }
        else body.push(`<p>[视频] ${t}</p>`)
        break
      }
      case 'drawio': {
        const preview = String(b.attrs.preview ?? '')
        const caption = String(b.attrs.caption ?? '')
        if (preview && isSafeSrc(preview)) body.push(figure(`<img src="${esc(preview)}" alt="${esc(caption || 'draw.io')}">`, caption))
        else body.push(`<p>[draw.io 图]${caption ? ' ' + esc(caption) : ''}</p>`)
        break
      }
      case 'file': {
        const src = String(b.attrs.src ?? '')
        const name = String(b.attrs.name ?? '')
        const size = Number(b.attrs.size ?? 0)
        const sizeText = size > 0 ? ` (${humanSize(size)})` : ''
        if (FILE_SRC.test(src)) body.push(`<p class="attachment"><a href="${esc(src)}" download="${esc(name)}">${esc(name || '附件')}</a>${sizeText}</p>`)
        else body.push(`<p class="attachment">[附件] ${esc(name)}${sizeText}</p>`)
        break
      }
      case 'linkCard': {
        const url = String(b.attrs.url ?? '')
        const title = esc(String(b.attrs.title ?? '') || url)
        const desc = b.attrs.description ? `<span class="link-card-desc">${esc(String(b.attrs.description))}</span>` : ''
        const site = b.attrs.site ? `<small>${esc(String(b.attrs.site))}</small>` : ''
        const image = String(b.attrs.image ?? '')
        const pic = FILE_SRC.test(image) ? `<img src="${esc(image)}" alt="">` : ''
        if (WEB_URL.test(url)) body.push(`<a class="link-card" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><span class="link-card-body"><strong>${title}</strong>${desc}${site}</span>${pic}</a>`)
        else body.push(`<p>[链接] ${title}</p>`)
        break
      }
      case 'table': body.push('<table>' + tableRows(b).map((r, i) => '<tr>' + r.map((c) => `<t${i ? 'd' : 'h'}>${esc(c)}</t${i ? 'd' : 'h'}>`).join('') + '</tr>').join('') + '</table>'); break
      default: body.push(`<p${level ? ` data-indent="${level}" style="margin-left:${level * 2}em"` : ''}>${inlineHtml(b.delta)}</p>`)
    }
  }
  while (open.length) close()
  const foot = notes.length
    ? `<section class="footnotes"><ol>${notes.map((n) => `<li id="fn-${n.number}">${esc(n.note)} <a href="#fnref-${n.number}">↩</a></li>`).join('')}</ol></section>`
    : ''
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${esc(title)}</title></head>\n<body>\n${body.join('\n')}\n${foot}</body></html>\n`
}

export interface DocxOptions {
  /** Loads an image by its `src` (`/files/<id>` or https). Null when it cannot be loaded. */
  loadAsset?: (src: string) => Promise<{ mime: string; data: Uint8Array } | null>
  /** Block id -> rendered PNG for mermaid and math blocks, with its pixel size. */
  renders?: Record<string, { png: Uint8Array; width: number; height: number }>
}

type Picture = { type: 'png' | 'jpg' | 'gif'; data: Uint8Array; width: number; height: number }

/** Format and pixel size of a PNG, JPEG or GIF, read from its header. Null for anything else. */
export function pictureSize(data: Uint8Array): Picture | null {
  const u16be = (i: number): number => (data[i]! << 8) | data[i + 1]!
  const u32be = (i: number): number => ((data[i]! << 24) >>> 0) + ((data[i + 1]! << 16) | (data[i + 2]! << 8) | data[i + 3]!)
  if (data.length >= 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return { type: 'png', data, width: u32be(16), height: u32be(20) }
  }
  if (data.length >= 10 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) {
    return { type: 'gif', data, width: data[6]! | (data[7]! << 8), height: data[8]! | (data[9]! << 8) }
  }
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let i = 2
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) return null
      const marker = data[i + 1]!
      if (marker === 0xff) {
        i++
        continue
      }
      // Start-of-frame markers carry the size; C4, C8 and CC are not frames.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'jpg', data, height: u16be(i + 5), width: u16be(i + 7) }
      }
      if (marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2
        continue
      }
      i += 2 + u16be(i + 2)
    }
  }
  return null
}

/** Display size in Word: at most 600 px wide, scaled by a percentage, aspect ratio kept. */
const fitPicture = (pic: Picture, pct = 100): { width: number; height: number } => {
  const width = Math.max(1, Math.round((Math.min(pic.width, 600) * pct) / 100))
  const height = Math.max(1, Math.round((pic.height * width) / Math.max(1, pic.width)))
  return { width, height }
}

/** Word export. Pending changes are resolved by the caller's choice of projection. */
export async function blocksToDocx(input: Block[], title: string, opts: DocxOptions = {}): Promise<Uint8Array> {
  const { blocks: list, notes } = withFootnoteRefs(input)
  const picture = async (src: string): Promise<Picture | null> => {
    if (!opts.loadAsset) return null
    const got = await opts.loadAsset(src).catch(() => null)
    const pic = got ? pictureSize(got.data) : null
    return pic && pic.width > 0 && pic.height > 0 ? pic : null
  }
  const imagePara = (pic: Picture, pct = 100): DocxParagraph => {
    const { width, height } = fitPicture(pic, pct)
    return new DocxParagraph({
      alignment: AlignmentType.CENTER,
      children: [new ImageRun({ type: pic.type, data: pic.data, transformation: { width, height } })],
    })
  }
  const captionPara = (s: string): DocxParagraph =>
    new DocxParagraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: s, italics: true })] })
  const runs = (delta: Block['delta']): (TextRun | ExternalHyperlink | FootnoteReferenceRun | ImageRun)[] =>
    delta.map((d) => {
      const a = d.attributes ?? {}
      if (a.footnoteRef) return new FootnoteReferenceRun(Number(a.footnoteRef))
      if (a.math) {
        const r = maths.get(d.insert)
        return r ? new ImageRun({ type: 'png', data: r.png, transformation: { width: r.width, height: r.height } }) : new TextRun(`$${d.insert}$`)
      }
      const run = new TextRun({
        text: d.insert,
        bold: !!a.bold,
        italics: !!a.italic,
        underline: a.underline ? {} : undefined,
        strike: !!a.strike,
        font: a.code ? 'Menlo' : undefined,
        highlight: a.highlight ? 'yellow' : undefined,
      })
      const href = (a.link as { href?: string } | undefined)?.href
      return href ? new ExternalHyperlink({ link: href, children: [run] }) : run
    })
  // Inline formulas become PNG pictures sized to the text line (the svg height is about the ex height x 8 px).
  const maths = new Map<string, { png: Uint8Array; width: number; height: number } | null>()
  for (const b of list) {
    for (const d of b.delta) {
      if (!d.attributes?.math || maths.has(d.insert)) continue
      const svg = mathToSvg(d.insert, { display: false })
      maths.set(d.insert, svg ? await svgToPng(svg, 2) : null)
    }
  }
  const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3]
  const children: (DocxParagraph | DocxTable)[] = []
  for (const b of list) {
    const level = Number(b.attrs.indent ?? 0)
    switch (b.type) {
      case 'heading': children.push(new DocxParagraph({ heading: headings[Number(b.attrs.level ?? 1) - 1], children: runs(b.delta) })); break
      case 'bulletItem': children.push(new DocxParagraph({ bullet: { level }, children: runs(b.delta) })); break
      case 'orderedItem': children.push(new DocxParagraph({ numbering: { reference: 'ol', level }, children: runs(b.delta) })); break
      case 'taskItem': children.push(new DocxParagraph({ bullet: { level }, children: [new TextRun(b.attrs.checked ? '☑ ' : '☐ '), ...runs(b.delta)] })); break
      case 'quote': case 'callout': children.push(new DocxParagraph({ indent: { left: 480 }, children: runs(b.delta) })); break
      case 'codeBlock': {
        const lang = String(b.attrs.language ?? '')
        const r = (lang === 'mermaid' || lang === 'math') && b.blockId ? opts.renders?.[b.blockId] : undefined
        if (r && r.width > 0 && r.height > 0) children.push(imagePara({ type: 'png', data: r.png, width: r.width, height: r.height }))
        else for (const line of text(b).split('\n')) children.push(new DocxParagraph({ children: [new TextRun({ text: line, font: 'Menlo', size: 20 })] }))
        break
      }
      case 'divider': children.push(new DocxParagraph({ alignment: AlignmentType.CENTER, children: [new TextRun('———')] })); break
      case 'image': {
        const alt = String(b.attrs.alt ?? '')
        const pic = await picture(String(b.attrs.src ?? ''))
        if (pic) children.push(imagePara(pic, Number(b.attrs.width ?? 100)))
        else children.push(new DocxParagraph({ children: [new TextRun(`[图片] ${alt}`)] }))
        if (b.attrs.caption) children.push(captionPara(String(b.attrs.caption)))
        break
      }
      case 'video': {
        const src = String(b.attrs.src ?? '')
        const title = String(b.attrs.title ?? '')
        const poster = b.attrs.poster ? await picture(String(b.attrs.poster)) : null
        if (poster) children.push(imagePara(poster))
        const link: (TextRun | ExternalHyperlink)[] = [new TextRun(`[视频] ${title ? title + ' ' : ''}`)]
        if (/^https:/i.test(src)) link.push(new ExternalHyperlink({ link: src, children: [new TextRun({ text: src, underline: {} })] }))
        else link.push(new TextRun(src))
        children.push(new DocxParagraph({ children: link }))
        if (b.attrs.caption) children.push(captionPara(String(b.attrs.caption)))
        break
      }
      case 'drawio': {
        const preview = String(b.attrs.preview ?? '')
        const pic = preview ? await picture(preview) : null
        if (pic) children.push(imagePara(pic))
        else children.push(new DocxParagraph({ children: [new TextRun('[draw.io 图]')] }))
        if (b.attrs.caption) children.push(captionPara(String(b.attrs.caption)))
        break
      }
      case 'file': {
        const name = String(b.attrs.name ?? '') || '附件'
        const size = Number(b.attrs.size ?? 0)
        children.push(new DocxParagraph({ children: [new TextRun(`[附件] ${name}${size > 0 ? ` (${humanSize(size)})` : ''}`)] }))
        break
      }
      case 'linkCard': {
        const url = String(b.attrs.url ?? '')
        const title = String(b.attrs.title ?? '') || url
        const link = WEB_URL.test(url)
          ? new ExternalHyperlink({ link: url, children: [new TextRun({ text: title, bold: true, underline: {} })] })
          : new TextRun({ text: title, bold: true })
        children.push(new DocxParagraph({ children: [link] }))
        if (b.attrs.description) children.push(new DocxParagraph({ children: [new TextRun(String(b.attrs.description))] }))
        const pic = b.attrs.image ? await picture(String(b.attrs.image)) : null
        if (pic) children.push(imagePara(pic, 30))
        break
      }
      case 'table': {
        const rows = tableRows(b)
        if (rows.length) {
          children.push(new DocxTable({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: rows.map((r, i) => new TableRow({ children: r.map((c) => new TableCell({ children: [new DocxParagraph({ children: [new TextRun({ text: c, bold: i === 0 })] })] })) })),
          }))
        }
        break
      }
      default: children.push(new DocxParagraph({ ...(level ? { indent: { left: 480 * level } } : {}), children: runs(b.delta) }))
    }
  }
  // Real Word footnotes: the reference runs above point at these ids.
  const footnotes = Object.fromEntries(notes.map((n) => [n.number, { children: [new DocxParagraph({ children: [new TextRun(n.note)] })] }]))
  const doc = new DocxDocument({
    title,
    numbering: { config: [{ reference: 'ol', levels: [0, 1, 2, 3, 4].map((l) => ({ level: l, format: LevelFormat.DECIMAL, text: `%${l + 1}.`, alignment: AlignmentType.START, style: { paragraph: { indent: { left: 480 * (l + 1), hanging: 360 } } } })) }] },
    ...(notes.length ? { footnotes } : {}),
    sections: [{ children }],
  })
  return new Uint8Array(await Packer.toBuffer(doc))
}
