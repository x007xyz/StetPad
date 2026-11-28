import { blocksToMarkdown, domToBlocks, embedPlayerUrl, isSafeSrc, safeImageSrc, type Block } from '@stetpad/clip'
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
import { Lexer, Marked, Renderer, marked, type MarkedToken, type Token, type Tokens } from 'marked'
import { AlignmentType, Document as DocxDocument, ExternalHyperlink, FootnoteReferenceRun, HeadingLevel, ImageRun, LevelFormat, Packer, Paragraph as DocxParagraph, Table as DocxTable, TableCell, TableRow, TextRun, WidthType } from 'docx'
import { randomUUID } from 'node:crypto'
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
  return parsedHtmlToBlocks(html, { baseUrl })
}

function parsedHtmlToBlocks(html: string, options: Parameters<typeof domToBlocks>[1]): Block[] {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`)
  return domToBlocks(document.body, options)
}

// ---------- files -> blocks ----------

/** For each line, whether it belongs to a fenced code block (fence lines included). */
function fencedCodeLines(lines: string[]): boolean[] {
  const width = (indent: string): number => [...indent].reduce((w, c) => (c === '\t' ? w + 4 - (w % 4) : w + 1), 0)
  let fence: { mark: string; indent: number } | null = null
  return lines.map((line) => {
    if (fence !== null) {
      // A delimiter indented 4+ columns past the opener is code content, not a closer.
      const close = /^([ \t]*)(`{3,}|~{3,})[ \t]*\r?$/.exec(line)
      if (close && width(close[1]!) <= fence.indent + 3 && close[2]![0] === fence.mark[0] && close[2]!.length >= fence.mark.length) fence = null
      return true
    }
    // A backtick fence's info string has no backticks; ```x``` is a code span.
    const open = /^([ \t]*)(`{3,}(?!.*`)|~{3,})/.exec(line)
    if (open) fence = { mark: open[2]!, indent: width(open[1]!) }
    return open !== null
  })
}

const MATH_DELIM = /^[ \t]*\$\$[ \t]*\r?$/
const MATH_LINE = /^[ \t]*\$\$(.+?)\$\$[ \t]*\r?$/
const INDENTED_MATH = /^(?: {4}| {0,3}\t)[ \t]*\$\$/

/** Align tokens with their container source, including newlines omitted from token boundaries. */
function markCodeTokenLines(tokens: MarkedToken[], source: string, fenced: boolean[], indented: boolean[], line = 0): void {
  let offset = 0
  for (const token of tokens) {
    const start = source.indexOf(token.raw, offset)
    if (start === -1) continue
    line += source.slice(offset, start).match(/\n/g)?.length ?? 0
    const next = line + (token.raw.match(/\n/g)?.length ?? 0)
    if (token.type === 'code') {
      const code = token.codeBlockStyle === 'indented' ? indented : fenced
      code.fill(true, line, next + (token.raw.endsWith('\n') ? 0 : 1))
    } else if (token.type === 'list') markCodeTokenLines(token.items, token.raw, fenced, indented, line)
    else if (token.type === 'list_item' || token.type === 'blockquote') markCodeTokenLines(token.tokens as MarkedToken[], token.text, fenced, indented, line)
    offset = start + token.raw.length
    line = next
  }
}

/**
 * `$$` display formulas on their own lines become ```math fences, so marked
 * emits them as `<pre><code class="language-math">`. Fenced and indented code is left alone.
 */
export function mathToFence(md: string): string {
  const lines = md.split('\n')
  const fenced = fencedCodeLines(lines)
  const indented = new Array<boolean>(lines.length).fill(false)
  if (lines.some((line, i) => !fenced[i] && INDENTED_MATH.test(line))) {
    markCodeTokenLines(marked.lexer(md, { gfm: true }) as MarkedToken[], md.replace(/\r\n?/g, '\n'), fenced, indented)
  }
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (fenced[i] || indented[i]) {
      out.push(line)
      continue
    }
    const one = MATH_LINE.exec(line)
    if (one) {
      out.push('```math', one[1]!.trim(), '```')
      continue
    }
    // Inside a display formula, indentation belongs to the formula, not to Markdown code.
    const end = MATH_DELIM.test(line) ? lines.findIndex((l, j) => j > i && !fenced[j] && MATH_DELIM.test(l)) : -1
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

async function ocrPdfPage(pdf: { getPage: (n: number) => Promise<any> }, p: number, ocr: Ocr): Promise<Block[]> {
  const { createCanvas } = await import('@napi-rs/canvas')
  const page = await pdf.getPage(p)
  const viewport = page.getViewport({ scale: 1.6 })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  await page.render({ canvas: canvas as any, canvasContext: canvas.getContext('2d') as any, viewport }).promise
  return textToBlocks(await ocr(new Uint8Array(canvas.toBuffer('image/png')), p))
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

const MAX_PDF_PAGES = 500
export type SkippedPageReason = 'no-ocr' | 'ocr-limit'

// Single unified-ideograph cross-references from the Unicode Names List.
const cjkRadicalIdeographs: Record<string, string> = {
  '⺂': '乛', '⺃': '乚', '⺄': '乙', '⺅': '亻', '⺆': '冂', '⺉': '刂', '⺊': '卜', '⺋': '㔾',
  '⺌': '小', '⺏': '尣', '⺐': '尢', '⺒': '巳', '⺓': '幺', '⺔': '彑', '⺕': '彐', '⺖': '忄',
  '⺘': '扌', '⺙': '攵', '⺛': '旡', '⺝': '月', '⺞': '歺', '⺠': '民', '⺡': '氵', '⺢': '氺',
  '⺣': '灬', '⺤': '爫', '⺥': '爫', '⺦': '丬', '⺨': '犭', '⺬': '示', '⺭': '礻', '⺯': '糹',
  '⺰': '纟', '⺱': '罓', '⺵': '𦉫', '⺶': '羊', '⺹': '耂', '⺺': '肀', '⺻': '聿', '⺼': '肉',
  '⺾': '艹', '⺿': '艹', '⻀': '艹', '⻁': '虎', '⻂': '衤', '⻃': '覀', '⻄': '西', '⻅': '见',
  '⻆': '角', '⻇': '𧢲', '⻈': '讠', '⻉': '贝', '⻋': '车', '⻌': '辶', '⻍': '辶', '⻎': '辶',
  '⻏': '邑', '⻐': '钅', '⻑': '長', '⻒': '镸', '⻓': '长', '⻔': '门', '⻖': '阝', '⻗': '雨',
  '⻘': '青', '⻙': '韦', '⻚': '页', '⻛': '风', '⻜': '飞', '⻝': '食', '⻞': '𩙿', '⻟': '飠',
  '⻠': '饣', '⻡': '𩠐', '⻢': '马', '⻣': '骨', '⻤': '鬼', '⻥': '鱼', '⻦': '鸟', '⻧': '卤',
  '⻨': '麦', '⻩': '黄', '⻪': '黾', '⻫': '斉', '⻬': '齐', '⻭': '歯', '⻮': '齿', '⻰': '龙',
  '⻱': '龜', '⻲': '亀',
}

function joinPdfLines(left: string, right: string): string {
  const cjk = /[　-鿿\p{Script=Han}]$/u.test(left) || /^[　-鿿\p{Script=Han}]/u.test(right)
  return left + (left && !cjk && !left.endsWith('-') ? ' ' : '') + right
}

async function pdfToBlocks(data: Uint8Array, ocr?: Ocr, onOmittedPages?: (count: number) => void, onSkippedPages?: (pages: number[], reason: SkippedPageReason) => void): Promise<Block[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const pdf = await pdfjs.getDocument({ data, useSystemFonts: true }).promise
  if (pdf.numPages > MAX_PDF_PAGES) onOmittedPages?.(pdf.numPages - MAX_PDF_PAGES)
  type Line = { y: number; x: number; right: number; size: number; text: string; page: number }
  const lines: Line[] = []
  const entries: (Line | { page: number })[] = []
  const emptyPages: number[] = []
  for (let p = 1; p <= Math.min(pdf.numPages, MAX_PDF_PAGES); p++) {
    const start = lines.length
    const page = await pdf.getPage(p)
    const tc = await page.getTextContent()
    let cur: Line | null = null
    for (const item of tc.items) {
      if (!('str' in item) || !item.str) continue
      const x = item.transform[4] as number
      const y = item.transform[5] as number
      const size = Math.abs(item.transform[3] as number) || item.height || 10
      const right = x + item.width
      if (cur && Math.abs(cur.y - y) < size * 0.5) {
        cur.text += item.str
        cur.size = Math.max(cur.size, size)
        cur.right = Math.max(cur.right, right)
      } else {
        if (cur && cur.text.trim()) lines.push(cur)
        cur = { y, x, right, size, text: item.str, page: p }
      }
    }
    if (cur && cur.text.trim()) lines.push(cur)
    if (lines.length === start) {
      emptyPages.push(p)
      entries.push({ page: p })
    } else entries.push(...lines.slice(start))
  }
  if (lines.length === 0 && !ocr) {
    throw new Error('这个 PDF 没有文字层（可能是扫描件），配置一个支持图像的模型后可识别')
  }
  if (ocr && emptyPages.length > 40 && lines.length === 0) throw new Error('扫描件识别最多支持 40 页')
  const recognize = emptyPages.length <= 40 ? ocr : undefined
  if (!recognize && emptyPages.length) onSkippedPages?.(emptyPages, ocr ? 'ocr-limit' : 'no-ocr')
  const sizes = lines.map((l) => Math.round(l.size * 2) / 2).sort((a, b) => a - b)
  const body = sizes[Math.floor(sizes.length / 2)]!
  const out: Block[] = []
  let pending: { type: Block['type']; attrs: Block['attrs']; text: string } | null = null
  let prev: Line | null = null
  let start: Line | null = null
  const flush = (): void => {
    if (pending) out.push({ type: pending.type, attrs: pending.attrs, delta: [{ insert: pending.text }] })
    pending = null
  }
  for (const l of entries) {
    if (!('text' in l)) {
      flush()
      if (recognize) out.push(...await ocrPdfPage(pdf, l.page, recognize))
      prev = null
      continue
    }
    const t = l.text.trim().replace(/[\u2e80-\u2fdf]/g, (radical) => cjkRadicalIdeographs[radical] ?? radical.normalize('NFKC'))
    const isHeading = l.size >= body * 1.18 && t.length < 80
    const marker = t.match(/^([•·▪◦‣\-–]|\d+[.)、])\s+(.*)$/)
    const ordered = marker && /^\d/.test(marker[1]!)
    const gap = prev && prev.page === l.page ? prev.y - l.y : Infinity
    const aligned = prev !== null && Math.abs(prev.x - l.x) <= l.size * 0.25
    const close = prev !== null && gap > 0 && gap <= l.size * 1.65 && Math.abs(prev.size - l.size) <= l.size * 0.05
    const fillsLine = prev !== null && prev.right - prev.x >= l.size * 4 &&
      prev.right >= l.right - l.size && !/[。.!?！？”"]$/.test(prev.text.trimEnd())
    if (pending && prev && start && close) {
      const headingWrap = pending.type === 'heading' && (
        aligned || Math.abs(prev.right - l.right) <= l.size * 0.25 ||
        Math.abs(prev.x + prev.right - l.x - l.right) <= l.size * 0.5
      )
      const list = pending.type === 'orderedItem' || pending.type === 'bulletItem'
      const listWrap = list && !isHeading && !marker && (
        prev === start
          ? (l.x - start.x > l.size * 0.25 && l.x - start.x <= l.size * 3) || (aligned && fillsLine)
          : aligned
      )
      const paragraphWrap = pending.type === 'paragraph' && !isHeading && ordered && aligned && fillsLine
      if (headingWrap || listWrap || paragraphWrap) {
        pending.text = joinPdfLines(pending.text, t)
        prev = l
        continue
      }
    }
    if (isHeading) {
      flush()
      pending = { type: 'heading', attrs: { level: l.size >= body * 1.6 ? 1 : l.size >= body * 1.35 ? 2 : 3 }, text: t }
      start = l
    } else if (marker) {
      flush()
      pending = { type: ordered ? 'orderedItem' : 'bulletItem', attrs: { indent: 0 }, text: marker[2]! }
      start = l
    } else if (pending?.type === 'paragraph' && gap >= 0 && gap <= l.size * 1.9) {
      pending.text = joinPdfLines(pending.text, t)
    } else {
      flush()
      pending = { type: 'paragraph', attrs: {}, text: t }
      start = l
    }
    prev = l
  }
  flush()
  return out
}

export async function fileToBlocks(name: string, data: Uint8Array, opts: {
  ocr?: Ocr
  onOmittedPages?: (count: number) => void
  onSkippedPages?: (pages: number[], reason: SkippedPageReason) => void
  docxImageSrc?: (data: Buffer, mime: string) => string
} = {}): Promise<Block[]> {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (data.byteLength > 30 * 1024 * 1024) throw new Error('文件超过 30MB')
  if (ext === 'docx') {
    const assetSrc = opts.docxImageSrc
    const convertImage = assetSrc && mammoth.images.imgElement(async (image) => {
      const prefix = `data:${image.contentType};base64,`
      if (!safeImageSrc(prefix)) return { src: '' }
      const bytes = await image.readAsBuffer()
      const inline = prefix + bytes.toString('base64')
      return { src: safeImageSrc(inline) ?? assetSrc(bytes, image.contentType) }
    })
    const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(data) }, { convertImage })
    return htmlToBlocks(value)
  }
  if (ext === 'pdf') return pdfToBlocks(data, opts.ocr, opts.onOmittedPages, opts.onSkippedPages)
  const str = new TextDecoder().decode(data)
  if (ext === 'md' || ext === 'markdown') {
    const { body, defs } = splitMdFootnotes(str)
    const prefix = `\ue000${randomUUID()}:`
    const { body: safe, tex } = protectInlineMath(mathToFence(body), prefix)
    return restoreInlineMath(await parseMdFootnotes(safe, defs), tex, prefix)
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
  if (ext === 'txt') {
    const hanOrKana = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ーｰ]/u
    const cjkPunctuation = /(?=[\u3000-\u303f\uff01-\uff60])\p{P}/u
    const joinLines = (_: string, last = '', next = ''): string => {
      const noSpace = cjkPunctuation.test(last) || (hanOrKana.test(last) && (hanOrKana.test(next) || cjkPunctuation.test(next)))
      return last + (noSpace ? '' : ' ')
    }
    return str.split(/\n\s*\n/)
      .map((s) => para(s.replace(/(\S)?\s*\n\s*(?=(\S)?)/gu, joinLines).trim()))
      .filter((b) => b.delta.length)
  }
  throw new Error(`不支持的文件类型：.${ext}`)
}

// ---------- Markdown footnotes ----------

const FN_DEF = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/
/** Punctuation that ends the word a footnote marker attaches to. */
const FN_STOP = /[\s，。！？；：、,.;:!?()（）「」“”"'《》]/

const markdown = new Marked({ extensions: [{
  name: 'editorMathSpan',
  level: 'inline',
  tokenizer(src) {
    if (this.lexer.state.inRawBlock) return
    const raw = /^<span(?=[\s>])(?:"[^"]*"|'[^']*'|[^"'<>])*?>([^<]+)<\/span\s*>/i.exec(src)?.[0]
    if (!raw || !raw.includes('data-math')) return
    const span = parseHTML(raw).document.querySelector('span')
    if (span?.getAttribute('data-math') !== '' || !span.textContent) return
    // Tokenize the whole span before Markdown can interpret escapes inside its TeX.
    span.setAttribute('data-math', span.textContent)
    span.textContent = ''
    return { type: 'editorMathSpan', raw, html: span.outerHTML }
  },
  renderer(token) {
    return token.html
  },
}] })

class MarkdownRenderer extends Renderer {
  override code(token: Tokens.Code): string {
    if (token.codeBlockStyle === 'indented') return super.code(token)
    const source = token.escaped ? token.text : token.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return super.code({ ...token, text: '' })
      .replace('<pre>', '<pre data-stetpad-fenced>')
      .replace('</code>', () => `${source}</code>`)
  }
}

async function parseMdFootnotes(body: string, defs: Map<string, string>): Promise<Block[]> {
  const renderer = new MarkdownRenderer()
  const parse = (html: string) => parsedHtmlToBlocks(html, { markdown: true })
  if (!body.includes('\\')) return applyMdFootnotes(parse(await markdown.parse(body, { gfm: true, renderer })), defs)
  // Keep escaped brackets distinct until after the footnote pass, even after HTML parsing.
  const escape = `\ue002${randomUUID()}`
  const html = await markdown.parse(body, {
    gfm: true,
    renderer,
    walkTokens(token) {
      if (token.type === 'escape' && (token.text === '[' || token.text === ']')) {
        token.text = escape + (token.text === '[' ? 'L' : 'R')
      }
    },
  })
  const list = applyMdFootnotes(parse(html), defs, escape)
  const restore = (value: string): string => value.replaceAll(escape + 'L', '[').replaceAll(escape + 'R', ']')
  for (const b of list) {
    for (const d of b.delta) d.insert = restore(d.insert)
    for (const [k, v] of Object.entries(b.attrs)) if (typeof v === 'string') b.attrs[k] = restore(v)
  }
  return list
}

/** Take `[^label]: text` definitions out of Markdown, outside fenced code. They are applied after parsing. */
export function splitMdFootnotes(src: string): { body: string; defs: Map<string, string> } {
  const defs = new Map<string, string>()
  const kept: string[] = []
  const lines = src.split('\n')
  const code = fencedCodeLines(lines)
  for (const [i, line] of lines.entries()) {
    const m = code[i] ? null : line.match(FN_DEF)
    if (m) defs.set(m[1]!, m[2]!.trim())
    else kept.push(line)
  }
  return { body: kept.join('\n'), defs }
}

/**
 * Turn each unescaped `[^label]` marker outside code into a footnote mark over the word before it.
 * A marker with no definition, or with nothing before it, is dropped.
 */
function applyMdFootnotes(list: Block[], defs: Map<string, string>, escape?: string): Block[] {
  for (const b of list) {
    if (b.type === 'codeBlock' || !b.delta.some((d) => d.insert.includes('[^'))) continue
    // One entry per UTF-16 code unit, so regex match offsets index `chars` directly.
    const chars: { ch: string; attributes?: Record<string, unknown> }[] = []
    for (const d of b.delta) for (const ch of d.insert.split('')) chars.push({ ch, attributes: d.attributes })
    const re = /\[\^([^\]\s]+)\]/g
    let s = chars.map((c) => c.ch).join('')
    let m: RegExpExecArray | null
    while ((m = re.exec(s))) {
      const at = m.index
      if ((escape && m[1]!.includes(escape)) || chars.slice(at, re.lastIndex).some((c) => c.attributes?.code || c.attributes?.math)) {
        re.lastIndex = at + 1
        continue
      }
      let start = at
      while (start > 0 && !FN_STOP.test(chars[start - 1]!.ch)) start--
      const note = defs.get(m[1]!)
      if (note !== undefined && start < at) {
        const id = 'fn_' + Math.random().toString(36).slice(2, 10)
        for (let k = start; k < at; k++) chars[k]!.attributes = { ...chars[k]!.attributes, footnote: { id, note } }
      }
      chars.splice(at, m[0].length)
      s = chars.map((c) => c.ch).join('')
      re.lastIndex = at
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
const MATH_PREFIX = '\ue000'

/** A link reference definition: `[label]: destination`. */
const LINK_DEF = /^ {0,3}\[[^\]]+\]:/

/** A stretch of a line that marked reads as code (`opaque`), HTML, a link or an image. */
type Verbatim = { start: number; end: number; opaque: boolean }

/** The verbatim stretches among inline `tokens` that start at offset `at`, in order; code in a link text follows its link. */
function verbatimSpans(tokens: Token[], at: number, out: Verbatim[] = []): Verbatim[] {
  for (const t of tokens) {
    const end = at + t.raw.length
    if (t.type === 'codespan' || t.type === 'editorMathSpan') out.push({ start: at, end, opaque: true })
    else if (t.type === 'html') out.push({ start: at, end, opaque: false })
    else if (t.type === 'link' || t.type === 'image') {
      out.push({ start: at, end, opaque: false })
      if (t.raw.startsWith('[')) verbatimSpans(t.tokens ?? [], at + 1, out)
    }
    else if (t.type === 'em' || t.type === 'strong' || t.type === 'del') {
      // The delimiters are the same length on both sides of the inner text.
      verbatimSpans(t.tokens ?? [], at + (t.raw.length - t.text.length) / 2, out)
    }
    at = end
  }
  return out
}

/**
 * Replaces the formulas on one line with placeholders, pushing their sources to `tex`. Code, HTML,
 * links and images come from marked's own reading of the line (`lexer` holds the document's link
 * definitions), so they match the later parse. A formula may hold whole HTML tags (`$<u>_i$`) and
 * links, but no code, and may not end inside any of them.
 */
function protectLine(line: string, lexer: Lexer, tex: string[], prefix: string): string {
  const spans = verbatimSpans(lexer.inlineTokens(line), 0)
  const formula = new RegExp(INLINE_TEX.source, 'g')
  let out = ''
  let at = 0
  let s = 0
  for (let f = formula.exec(line); f; f = formula.exec(line)) {
    while (s < spans.length && spans[s]!.end <= f.index) s++
    if (s < spans.length && spans[s]!.start <= f.index) {
      formula.lastIndex = spans[s]!.end
      continue
    }
    const end = f.index + f[0].length
    let k = s
    while (k < spans.length && spans[k]!.start < end && !spans[k]!.opaque && spans[k]!.end <= end) k++
    if (k < spans.length && spans[k]!.start < end) {
      formula.lastIndex = f.index + 1
      continue
    }
    tex.push(f[1]!)
    out += line.slice(at, f.index) + `${prefix}${tex.length - 1}\ue001`
    at = end
  }
  return out + line.slice(at)
}

/**
 * Replaces inline `$…$` with placeholders before Markdown parsing, so that `*` and `_` inside a
 * formula are not read as emphasis. Code (fenced blocks, code spans), HTML, tables, links, images and
 * link reference definitions are left alone. `restoreInlineMath` puts the formulas back as math-marked text.
 */
export function protectInlineMath(md: string, prefix = MATH_PREFIX): { body: string; tex: string[] } {
  const tex: string[] = []
  if (!md.includes('$')) return { body: md, tex }
  // marked reads `\r\n` and `\r` as `\n`; matching it keeps its token text findable in `md`.
  md = md.replace(/\r\n?/g, '\n')
  const options = { ...markdown.defaults, gfm: true }
  const doc = markdown.lexer(md, options)
  const lexer = new Lexer(options)
  Object.assign(lexer.tokens.links, doc.links)
  const lines = md.split('\n')
  const code = fencedCodeLines(lines)
  // Indented code blocks too, as marked finds them: their text is never read as inline Markdown.
  let from = 0
  let line = 0
  for (const t of doc) {
    const at = md.indexOf(t.raw, from)
    if (at < 0) break
    line += md.slice(from, at).split('\n').length - 1
    const span = t.raw.replace(/\n+$/, '').split('\n').length
    if (t.type === 'code') code.fill(true, line, line + span)
    line += t.raw.split('\n').length - 1
    from = at + t.raw.length
  }
  const body = lines
    .map((line, i) => {
      if (code[i] || LINK_DEF.test(line)) return line
      if (line.includes('$') && !/^\s*\|/.test(line)) return protectLine(line, lexer, tex, prefix)
      // Lex skipped lines with tags too, so an `<a>` left open or closed there is tracked as marked does.
      if (line.includes('<')) lexer.inlineTokens(line)
      return line
    })
    .join('\n')
  return { body, tex }
}

/** Puts back the formulas of `protectInlineMath` as runs with the `math` mark. Stray placeholders become plain `$…$`. */
export function restoreInlineMath(list: Block[], tex: string[], prefix = MATH_PREFIX): Block[] {
  if (!tex.length) return list
  const token = new RegExp(`${prefix}(\\d+)\ue001`, 'g')
  for (const b of list) {
    const delta: Block['delta'] = []
    const push = (insert: string, attributes?: Record<string, unknown>): void => {
      if (!insert) return
      const last = delta[delta.length - 1]
      if (last && JSON.stringify(last.attributes ?? null) === JSON.stringify(attributes ?? null)) last.insert += insert
      else delta.push(attributes ? { insert, attributes } : { insert })
    }
    for (const d of b.delta) {
      d.insert.split(token).forEach((part, i) => {
        if (i % 2) {
          const src = tex[Number(part)] ?? ''
          if (b.type === 'codeBlock' || d.attributes?.code) push(`$${src}$`, d.attributes)
          else push(src, { math: true })
        }
        else push(part, d.attributes)
      })
    }
    b.delta = delta
    for (const [k, v] of Object.entries(b.attrs)) {
      if (typeof v === 'string' && v.includes(prefix)) b.attrs[k] = v.replace(token, (_m, n: string) => `$${tex[Number(n)] ?? ''}$`)
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
 * change. Full restores reject pending suggestions first. Partial restores
 * replace only chosen nodes, leaving all other nodes and change records intact.
 */
export function applyBlocks(doc: Y.Doc, target: RichBlock[], blockIds?: string[]): void {
  doc.transact(() => {
    if (blockIds?.length) {
      const chosen = new Map(target.filter((b) => blockIds.includes(b.blockId)).map((b) => [b.blockId, b]))
      const frag = content(doc)
      for (let i = 0; i < frag.length; i++) {
        const el = frag.get(i)
        if (!(el instanceof Y.XmlElement)) continue
        const b = chosen.get(blockIdOf(el))
        if (!b) continue
        frag.delete(i, 1)
        insertBlock(doc, i, b.blockId, '', b.type, b.attrs, b.delta)
        chosen.delete(b.blockId)
      }
      for (const b of chosen.values()) insertBlock(doc, frag.length, b.blockId, '', b.type, b.attrs, b.delta)
      return
    }
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
      for (const k of Object.keys(cur)) if (k !== 'blockId' && !Object.hasOwn(b.attrs, k)) el.removeAttribute(k)
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
  if (!notes.length) return { blocks: input, notes }
  // Position "block:run" of the last run of each id.
  const last = new Map<string, string>()
  input.forEach((b, bi) => b.delta.forEach((d, di) => {
    const f = footnoteAttr(d.attributes)
    if (f) last.set(f.id, `${bi}:${di}`)
  }))
  const refs = new Map(notes.map(({ id, number }) => [last.get(id), number]))
  const blocks = input.map((b, bi) => ({
    ...b,
    delta: b.delta.flatMap((d, di) => {
      const ref = refs.get(`${bi}:${di}`)
      return ref === undefined ? d : [d, { insert: '', attributes: { footnoteRef: ref } }]
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
