import {
  blockIdOf,
  blocks as yBlocks,
  blockTexts,
  changes,
  compact,
  content,
  decide,
  insertBlock,
  listChanges,
  newBlockId,
  type RichBlock,
} from '@stetpad/crdt'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import mammoth from 'mammoth'
import { marked } from 'marked'
import { AlignmentType, Document as DocxDocument, ExternalHyperlink, HeadingLevel, LevelFormat, Packer, Paragraph as DocxParagraph, Table as DocxTable, TableCell, TableRow, TextRun, WidthType } from 'docx'
import * as Y from 'yjs'

/** The one simple format every import is reduced to. */
export interface Block {
  type: string
  attrs: Record<string, unknown>
  delta: { insert: string; attributes?: Record<string, unknown> }[]
}

const text = (b: Block): string => b.delta.map((d) => d.insert).join('')
const para = (s: string): Block => ({ type: 'paragraph', attrs: {}, delta: s ? [{ insert: s }] : [] })

// ---------- HTML -> blocks ----------

const MARKS: Record<string, string> = {
  STRONG: 'bold', B: 'bold', EM: 'italic', I: 'italic', U: 'underline',
  S: 'strike', DEL: 'strike', STRIKE: 'strike', CODE: 'code', MARK: 'highlight',
}
const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'HR', 'TABLE', 'IMG', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'FIGURE', 'FIGCAPTION', 'BR'])
const safeHref = (h: string | null): string | null => (h && /^(https?:|mailto:)/i.test(h.trim()) ? h.trim() : null)
const safeSrc = (s: string | null): string | null =>
  s && (/^https?:/i.test(s) || /^\/files\/[\w-]+$/.test(s) || (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(s) && s.length < 400_000)) ? s : null

/**
 * Reduce arbitrary HTML to whitelisted blocks. Nothing from the source is
 * passed through as HTML: only text, a fixed set of marks, and checked URLs.
 */
export function htmlToBlocks(html: string): Block[] {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`)
  const out: Block[] = []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inline = (node: any, marks: Record<string, unknown>, delta: Block['delta']): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const s = String(child.textContent).replace(/\s+/g, ' ')
        if (!s) continue
        const attributes = Object.keys(marks).length ? { ...marks } : undefined
        delta.push(attributes ? { insert: s, attributes } : { insert: s })
      } else if (child.nodeType === 1) {
        const tag = String(child.tagName).toUpperCase()
        if (tag === 'BR') delta.push({ insert: ' ' })
        else if (tag === 'SCRIPT' || tag === 'STYLE') continue
        else if (tag === 'A') {
          const href = safeHref(child.getAttribute('href'))
          inline(child, href ? { ...marks, link: { href } } : marks, delta)
        } else if (MARKS[tag]) inline(child, { ...marks, [MARKS[tag]!]: {} }, delta)
        else inline(child, marks, delta)
      }
    }
  }
  const trimmed = (delta: Block['delta']): Block['delta'] => {
    if (delta[0]) delta[0].insert = delta[0].insert.replace(/^\s+/, '')
    const last = delta[delta.length - 1]
    if (last) last.insert = last.insert.replace(/\s+$/, '')
    return delta.filter((d) => d.insert.length > 0)
  }
  const push = (type: string, attrs: Record<string, unknown>, node: unknown): void => {
    const delta: Block['delta'] = []
    inline(node, {}, delta)
    const t = trimmed(delta)
    if (t.length) out.push({ type, attrs, delta: t })
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasBlockChild = (el: any): boolean =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [...el.children].some((c: any) => BLOCK_TAGS.has(String(c.tagName).toUpperCase()) && c.tagName !== 'BR')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const list = (el: any, ordered: boolean, indent: number): void => {
    for (const li of el.children) {
      if (String(li.tagName).toUpperCase() !== 'LI') continue
      const clone = li.cloneNode(true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const nested of [...clone.querySelectorAll('ul,ol')] as any[]) nested.remove()
      const box = clone.querySelector('input[type=checkbox]')
      if (box) push('taskItem', { checked: box.hasAttribute('checked'), indent }, clone)
      else push(ordered ? 'orderedItem' : 'bulletItem', { indent }, clone)
      for (const nested of li.children) {
        const t = String(nested.tagName).toUpperCase()
        if (t === 'UL' || t === 'OL') list(nested, t === 'OL', Math.min(indent + 1, 4))
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (el: any): void => {
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        const s = String(node.textContent).trim()
        if (s) out.push(para(s))
        continue
      }
      if (node.nodeType !== 1) continue
      const tag = String(node.tagName).toUpperCase()
      if (['SCRIPT', 'STYLE', 'NAV', 'NOSCRIPT', 'IFRAME', 'FORM', 'SVG'].includes(tag)) continue
      if (/^H[1-6]$/.test(tag)) push('heading', { level: Math.min(Number(tag[1]), 3) }, node)
      else if (tag === 'UL' || tag === 'OL') list(node, tag === 'OL', 0)
      else if (tag === 'BLOCKQUOTE') {
        if (hasBlockChild(node)) for (const c of node.children) push('quote', {}, c)
        else push('quote', {}, node)
      } else if (tag === 'PRE') {
        const s = String(node.textContent).replace(/\n$/, '')
        if (s) out.push({ type: 'codeBlock', attrs: {}, delta: [{ insert: s }] })
      } else if (tag === 'HR') out.push({ type: 'divider', attrs: {}, delta: [] })
      else if (tag === 'IMG') {
        const src = safeSrc(node.getAttribute('src'))
        if (src) out.push({ type: 'image', attrs: { src, alt: node.getAttribute('alt') ?? '' }, delta: [] })
      } else if (tag === 'TABLE') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = [...node.querySelectorAll('tr')].map((tr: any) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          [...tr.querySelectorAll('th,td')].map((c: any) => String(c.textContent).replace(/\s+/g, ' ').trim()),
        ).filter((r) => r.length)
        if (rows.length) out.push({ type: 'table', attrs: { rows: JSON.stringify(rows) }, delta: [] })
      } else if (tag === 'P' || !hasBlockChild(node)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const img of [...node.querySelectorAll('img')] as any[]) {
          const src = safeSrc(img.getAttribute('src'))
          if (src) out.push({ type: 'image', attrs: { src, alt: img.getAttribute('alt') ?? '' }, delta: [] })
        }
        push('paragraph', {}, node)
      } else walk(node)
    }
  }
  walk(document.body)
  return out
}

// ---------- files -> blocks ----------

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
  if (ext === 'md' || ext === 'markdown') return htmlToBlocks(await marked.parse(str, { gfm: true }))
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

function inlineMd(delta: Block['delta']): string {
  return delta.map((d) => {
    let s = d.insert
    const a = d.attributes ?? {}
    if (a.code) s = '`' + s + '`'
    if (a.bold) s = `**${s}**`
    if (a.italic) s = `*${s}*`
    if (a.strike) s = `~~${s}~~`
    const href = (a.link as { href?: string } | undefined)?.href
    if (href) s = `[${s}](${href})`
    return s
  }).join('')
}
function inlineHtml(delta: Block['delta']): string {
  return delta.map((d) => {
    let s = esc(d.insert)
    const a = d.attributes ?? {}
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

export function blocksToMarkdown(list: Block[]): string {
  const out: string[] = []
  let n = 0
  for (const b of list) {
    const pad = '  '.repeat(Number(b.attrs.indent ?? 0))
    n = b.type === 'orderedItem' ? n + 1 : 0
    switch (b.type) {
      case 'heading': out.push('#'.repeat(Number(b.attrs.level ?? 1)) + ' ' + inlineMd(b.delta)); break
      case 'bulletItem': out.push(`${pad}- ${inlineMd(b.delta)}`); break
      case 'orderedItem': out.push(`${pad}${n}. ${inlineMd(b.delta)}`); break
      case 'taskItem': out.push(`${pad}- [${b.attrs.checked ? 'x' : ' '}] ${inlineMd(b.delta)}`); break
      case 'quote': out.push('> ' + inlineMd(b.delta)); break
      case 'callout': out.push('> [!NOTE] ' + inlineMd(b.delta)); break
      case 'codeBlock': out.push('```\n' + text(b) + '\n```'); break
      case 'divider': out.push('---'); break
      case 'image': out.push(`![${String(b.attrs.alt ?? '')}](${String(b.attrs.src ?? '')})`); break
      case 'table': {
        const rows = tableRows(b)
        if (rows[0]) {
          out.push('| ' + rows[0].join(' | ') + ' |', '| ' + rows[0].map(() => '---').join(' | ') + ' |',
            ...rows.slice(1).map((r) => '| ' + r.join(' | ') + ' |'))
        }
        break
      }
      default: out.push(inlineMd(b.delta))
    }
    const listItem = ['bulletItem', 'orderedItem', 'taskItem'].includes(b.type)
    if (!listItem) out.push('')
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

export function blocksToHtml(list: Block[], title: string): string {
  const body: string[] = []
  let open: string | null = null
  const close = (): void => {
    if (open) body.push(`</${open}>`)
    open = null
  }
  for (const b of list) {
    const level = Number(b.attrs.indent ?? 0)
    const tag = b.type === 'orderedItem' ? 'ol' : b.type === 'bulletItem' || b.type === 'taskItem' ? 'ul' : null
    if (tag !== open) {
      close()
      if (tag) body.push(`<${tag}>`)
      open = tag
    }
    switch (b.type) {
      case 'heading': body.push(`<h${b.attrs.level ?? 1}>${inlineHtml(b.delta)}</h${b.attrs.level ?? 1}>`); break
      case 'bulletItem': case 'orderedItem': body.push(`<li>${inlineHtml(b.delta)}</li>`); break
      case 'taskItem': body.push(`<li><input type="checkbox" disabled${b.attrs.checked ? ' checked' : ''}> ${inlineHtml(b.delta)}</li>`); break
      case 'quote': body.push(`<blockquote>${inlineHtml(b.delta)}</blockquote>`); break
      case 'callout': body.push(`<aside>${inlineHtml(b.delta)}</aside>`); break
      case 'codeBlock': body.push(`<pre><code>${esc(text(b))}</code></pre>`); break
      case 'divider': body.push('<hr>'); break
      case 'image': body.push(`<img src="${esc(String(b.attrs.src ?? ''))}" alt="${esc(String(b.attrs.alt ?? ''))}">`); break
      case 'table': body.push('<table>' + tableRows(b).map((r, i) => '<tr>' + r.map((c) => `<t${i ? 'd' : 'h'}>${esc(c)}</t${i ? 'd' : 'h'}>`).join('') + '</tr>').join('') + '</table>'); break
      default: body.push(`<p${level ? ` data-indent="${level}" style="margin-left:${level * 2}em"` : ''}>${inlineHtml(b.delta)}</p>`)
    }
  }
  close()
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${esc(title)}</title></head>\n<body>\n${body.join('\n')}\n</body></html>\n`
}

/** Word export. Pending changes are resolved by the caller's choice of projection. */
export async function blocksToDocx(list: Block[], title: string): Promise<Uint8Array> {
  const runs = (delta: Block['delta']): (TextRun | ExternalHyperlink)[] =>
    delta.map((d) => {
      const a = d.attributes ?? {}
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
      case 'codeBlock': for (const line of text(b).split('\n')) children.push(new DocxParagraph({ children: [new TextRun({ text: line, font: 'Menlo', size: 20 })] })); break
      case 'divider': children.push(new DocxParagraph({ alignment: AlignmentType.CENTER, children: [new TextRun('———')] })); break
      case 'image': children.push(new DocxParagraph({ children: [new TextRun(`[图片] ${String(b.attrs.alt ?? '')}`)] })); break
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
  const doc = new DocxDocument({
    title,
    numbering: { config: [{ reference: 'ol', levels: [0, 1, 2, 3, 4].map((l) => ({ level: l, format: LevelFormat.DECIMAL, text: `%${l + 1}.`, alignment: AlignmentType.START, style: { paragraph: { indent: { left: 480 * (l + 1), hanging: 360 } } } })) }] },
    sections: [{ children }],
  })
  return new Uint8Array(await Packer.toBuffer(doc))
}
