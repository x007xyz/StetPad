/**
 * Pure, DOM-agnostic helpers for normalizing HTML / DOM subtrees into Stetpad
 * whitelisted blocks and serializing blocks back to Markdown. Runs in both
 * browsers (extension content scripts) and Node.js (via linkedom).
 */

export const MAX_IMPORT_BLOCKS = 2000

export interface InlineDelta {
  insert: string
  attributes?: Record<string, unknown>
}

export interface Block {
  /** Set on blocks read from a document (RichBlock); absent on imported ones. */
  blockId?: string
  type: string
  attrs: Record<string, unknown>
  delta: InlineDelta[]
}

export interface ClipMetadata {
  url: string
  title: string
  author?: string
  siteName?: string
  publishedAt?: string
  excerpt?: string
  clippedAt?: string
  note?: string
}

/** Video hosts the notation and the importers accept as embeds. */
export const EMBED_HOSTS = ['youtube.com', 'youtu.be', 'bilibili.com', 'vimeo.com']

/** An https link from one of the allowed video hosts. */
export function isEmbedUrl(src: string): boolean {
  let u: URL
  try {
    u = new URL(src)
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  const h = u.hostname.toLowerCase()
  return EMBED_HOSTS.some((d) => h === d || h.endsWith('.' + d))
}

/** An uploaded file (`/files/<id>`) or an http(s) URL. */
export function isSafeSrc(src: string): boolean {
  return /^https?:/i.test(src) || /^\/files\/[\w-]+$/.test(src)
}

function resolveMaybeRelative(raw: string, baseUrl?: string): string {
  const t = raw.trim()
  if (!t) return ''
  if (!baseUrl) return t
  if (/^(https?:|mailto:|data:|\/files\/)/i.test(t) || t.startsWith('#')) return t
  try {
    return new URL(t, baseUrl).href
  } catch {
    return t
  }
}

export function safeHref(h: string | null | undefined, baseUrl?: string): string | null {
  if (!h) return null
  const t = resolveMaybeRelative(h, baseUrl)
  return /^(https?:|mailto:)/i.test(t) ? t : null
}

export function safeImageSrc(s: string | null | undefined, baseUrl?: string): string | null {
  if (!s) return null
  const t = resolveMaybeRelative(s, baseUrl)
  if (/^https?:/i.test(t) || /^\/files\/[\w-]+$/.test(t)) return t
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(t) && t.length < 400_000) return t
  return null
}

/** A video source: an uploaded file or an https URL (embeds are checked against the host list). */
export function safeVideoSrc(s: string | null | undefined, baseUrl?: string): string | null {
  if (!s) return null
  const t = resolveMaybeRelative(s, baseUrl)
  return /^https:/i.test(t) || /^\/files\/[\w-]+$/.test(t) ? t : null
}

const YT_ID = /^[\w-]{6,20}$/
const BV_ID = /^BV[\dA-Za-z]{10}$/
const AV_ID = /^av(\d+)$/i

/**
 * The iframe player URL for an embed link (YouTube, Bilibili, Vimeo), or null
 * when the link is not a form we know how to play.
 */
export function embedPlayerUrl(src: string): string | null {
  if (!isEmbedUrl(src)) return null
  const u = new URL(src)
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const seg = u.pathname.split('/').filter(Boolean)

  if (host === 'youtu.be') {
    const id = seg[0]
    return id && YT_ID.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null
  }
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    let id: string | null | undefined
    if (seg[0] === 'watch' && seg.length === 1) id = u.searchParams.get('v')
    else if ((seg[0] === 'shorts' || seg[0] === 'embed') && seg.length >= 2) id = seg[1]
    return id && YT_ID.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null
  }
  if (host === 'player.bilibili.com') return src
  if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) {
    if (seg[0] !== 'video' || seg.length < 2) return null
    const video = seg[1]!
    const page = u.searchParams.get('p')
    const pageParam = page && /^\d{1,4}$/.test(page) ? `&p=${page}` : ''
    if (BV_ID.test(video)) return `https://player.bilibili.com/player.html?bvid=${video}&autoplay=0${pageParam}`
    const av = AV_ID.exec(video)
    if (av) return `https://player.bilibili.com/player.html?aid=${av[1]}&autoplay=0${pageParam}`
    return null
  }
  if (host === 'vimeo.com') {
    const id = seg[0] === 'video' ? seg[1] : seg[0]
    return id && /^\d+$/.test(id) ? `https://player.vimeo.com/video/${id}` : null
  }
  return null
}

const MARKS: Record<string, string> = {
  STRONG: 'bold',
  B: 'bold',
  EM: 'italic',
  I: 'italic',
  U: 'underline',
  S: 'strike',
  DEL: 'strike',
  STRIKE: 'strike',
  CODE: 'code',
  MARK: 'highlight',
}

const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'PRE',
  'HR',
  'TABLE',
  'IMG',
  'SECTION',
  'ARTICLE',
  'MAIN',
  'HEADER',
  'FOOTER',
  'FIGURE',
  'FIGCAPTION',
  'ASIDE',
  'BR',
])

const collapse = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()
const blockTextContent = (b: Block): string => b.delta.map((d) => d.insert).join('')
const para = (s: string): Block => ({ type: 'paragraph', attrs: {}, delta: s ? [{ insert: s }] : [] })

/** Image width in percent, 10–100. Undefined means the default of 100, which is not stored. */
const widthOf = (s: string | null | undefined): number | undefined => {
  if (s === null || s === undefined || s.trim() === '') return undefined
  const n = Math.min(100, Math.max(10, Math.round(Number(s))))
  return Number.isFinite(n) && n < 100 ? n : undefined
}

function isPlaceholderImageSrc(src: string | null | undefined): boolean {
  if (!src) return true
  const s = src.trim().toLowerCase()
  if (!s || s.startsWith('about:') || s.startsWith('javascript:')) return true
  if (s.startsWith('data:image/svg+xml')) return true
  // Tiny 1x1 tracking/spacer GIF/PNG data URIs used by lazy loaders before hydration.
  if (s.startsWith('data:image/') && s.length < 180) return true
  return false
}

function bestFromSrcset(srcset: string | null | undefined): string | null {
  if (!srcset) return null
  let bestUrl: string | null = null
  let bestScore = -1
  for (const part of srcset.split(',')) {
    const tokens = part.trim().split(/\s+/)
    const url = tokens[0]
    if (!url || isPlaceholderImageSrc(url)) continue
    const desc = tokens[1] ?? ''
    const w = /^(\d+)w$/i.exec(desc)?.[1]
    const x = /^(\d+(?:\.\d+)?)x$/i.exec(desc)?.[1]
    const score = w ? Number(w) : x ? Number(x) * 1000 : 1
    if (score > bestScore) {
      bestScore = score
      bestUrl = url
    }
  }
  return bestUrl
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveImageSrc(img: any, baseUrl?: string): string | null {
  const lazyAttrs = ['data-actualsrc', 'data-original', 'data-src', 'data-lazy-src', 'data-url']
  const candidates: (string | null | undefined)[] = []
  const rawSrc = img.getAttribute('src')
  if (rawSrc && !isPlaceholderImageSrc(rawSrc)) candidates.push(rawSrc)
  for (const attr of lazyAttrs) candidates.push(img.getAttribute(attr))
  candidates.push(bestFromSrcset(img.getAttribute('data-srcset') ?? img.getAttribute('srcset')))
  if (rawSrc) candidates.push(rawSrc)

  for (const c of candidates) {
    const safe = safeImageSrc(c, baseUrl)
    if (safe) return safe
  }
  return null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function imageBlock(img: any, caption: string, wrapper?: any, baseUrl?: string): Block | null {
  const src = resolveImageSrc(img, baseUrl)
  if (!src) return null
  // The export writes the width as `style="width:N%"`; `data-width` is the same value for other writers.
  const styled = /width:\s*(\d+(?:\.\d+)?)%/.exec(img.getAttribute('style') ?? '')?.[1]
  const width = widthOf(img.getAttribute('data-width') ?? styled ?? wrapper?.getAttribute('data-width'))
  return { type: 'image', attrs: { src, alt: img.getAttribute('alt') ?? '', caption, ...(width ? { width } : {}) }, delta: [] }
}

/** An uploaded or embedded video. Anything else is dropped. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mediaBlock(node: any, caption: string, baseUrl?: string): Block | null {
  if (isHiddenElement(node)) return null
  const tag = String(node.tagName).toUpperCase()
  const title = collapse(node.getAttribute('title'))
  if (tag === 'VIDEO') {
    const src = safeVideoSrc(node.getAttribute('src') ?? node.querySelector('source')?.getAttribute('src') ?? null, baseUrl)
    return src ? { type: 'video', attrs: { src, kind: 'file', title, caption }, delta: [] } : null
  }
  if (tag === 'IFRAME') {
    const src = resolveMaybeRelative(node.getAttribute('src') ?? '', baseUrl)
    return isEmbedUrl(src) ? { type: 'video', attrs: { src, kind: 'embed', title, caption }, delta: [] } : null
  }
  return null
}

const CALLOUT_PREFIX = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hasClass(el: any, name: string): boolean {
  const cls = String(el.getAttribute?.('class') ?? '')
  return cls.split(/\s+/).includes(name)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isHiddenElement(el: any): boolean {
  if (!el || el.nodeType !== 1) return false
  if (isHiddenElement(el.parentElement)) return true
  if (el.hasAttribute?.('hidden')) return true
  const style = String(el.getAttribute?.('style') ?? '').toLowerCase()
  if (!style) return false
  return (
    /(?:^|;)\s*display\s*:\s*none\b/.test(style) ||
    /(?:^|;)\s*visibility\s*:\s*hidden\b/.test(style) ||
    /(?:^|;)\s*opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)/.test(style) ||
    /(?:^|;)\s*font-size\s*:\s*0(?:px|em|rem|pt|%)?\s*(?:;|$)/.test(style)
  )
}

/** Hidden and also removed from layout, so it occupies no table column. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function takesNoSpace(el: any): boolean {
  if (el.hasAttribute?.('hidden')) return true
  return /(?:^|;)\s*display\s*:\s*none\b/.test(String(el.getAttribute?.('style') ?? '').toLowerCase())
}

/** Extract TeX source from KaTeX / MathML / MathJax nodes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractMathTex(el: any): { tex: string; display: boolean } | null {
  if (!el || el.nodeType !== 1) return null
  const tag = String(el.tagName).toUpperCase()
  if (tag === 'SCRIPT') {
    const type = String(el.getAttribute?.('type') ?? '').toLowerCase()
    if (type.startsWith('math/tex')) {
      const tex = String(el.textContent ?? '').trim()
      return tex ? { tex, display: type.includes('display') } : null
    }
    return null
  }
  if (tag === 'MATH') {
    const ann = el.querySelector?.('annotation[encoding="application/x-tex"]') ?? el.querySelector?.('annotation')
    const tex = collapse(ann?.textContent ?? el.getAttribute?.('alttext') ?? '')
    return tex ? { tex, display: el.getAttribute?.('display') === 'block' } : null
  }
  if (hasClass(el, 'katex-display')) {
    const ann = el.querySelector?.('annotation[encoding="application/x-tex"]') ?? el.querySelector?.('annotation')
    const tex = collapse(ann?.textContent ?? el.querySelector?.('math')?.getAttribute?.('alttext') ?? '')
    return tex ? { tex, display: true } : null
  }
  if (hasClass(el, 'katex')) {
    const ann = el.querySelector?.('annotation[encoding="application/x-tex"]') ?? el.querySelector?.('annotation')
    const tex = collapse(ann?.textContent ?? el.querySelector?.('math')?.getAttribute?.('alttext') ?? '')
    return tex ? { tex, display: false } : null
  }
  const dataMath = el.getAttribute?.('data-math')
  if (dataMath && String(dataMath).trim()) {
    return { tex: String(dataMath).trim(), display: tag === 'DIV' || tag === 'PRE' }
  }
  return null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function preText(node: any): string {
  if (isHiddenElement(node)) return ''
  let out = ''
  for (const child of node.childNodes ?? []) {
    if (child.nodeType === 3) {
      out += String(child.textContent ?? '')
    } else if (child.nodeType === 1) {
      if (isHiddenElement(child)) continue
      const tag = String(child.tagName).toUpperCase()
      if (tag === 'BR') out += '\n'
      else if (['BUTTON', 'STYLE', 'SCRIPT'].includes(tag)) continue
      else if (hasClass(child, 'line-numbers-rows') || hasClass(child, 'hljs-ln-numbers')) continue
      else {
        const inner = preText(child)
        out += inner
        if ((tag === 'DIV' || tag === 'P' || tag === 'LI') && !inner.endsWith('\n')) out += '\n'
      }
    }
  }
  return out
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function codeLangOf(pre: any, code: any): string {
  const fromAttr = code?.getAttribute?.('data-lang') ?? code?.getAttribute?.('data-language') ?? pre.getAttribute?.('data-lang') ?? pre.getAttribute?.('data-language')
  if (fromAttr && /^[\w+#.-]+$/.test(fromAttr.trim())) return fromAttr.trim()
  const cls = `${code?.getAttribute?.('class') ?? ''} ${pre.getAttribute?.('class') ?? ''}`
  return /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(cls)?.[1] ?? ''
}

function stripLeadingPrefix(delta: InlineDelta[], pattern: RegExp): InlineDelta[] {
  if (!delta.length) return delta
  const first = delta[0]!
  const next = first.insert.replace(pattern, '')
  if (next === first.insert) return delta
  const rest = delta.slice(1)
  return next ? [{ ...first, insert: next }, ...rest] : rest
}

/**
 * Reduce a DOM element/document fragment into whitelisted Stetpad blocks.
 * Nothing from the source is passed through as raw HTML: only text, a fixed
 * set of inline marks, and validated URLs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function domToBlocks(root: any, opts: { baseUrl?: string } = {}): Block[] {
  if (!root) return []
  const baseUrl = opts.baseUrl
  const out: Block[] = []

  const pushDelta = (delta: InlineDelta[], insert: string, marks: Record<string, unknown>): void => {
    const attrKey = Object.keys(marks).length ? JSON.stringify(marks) : ''
    const prev = delta[delta.length - 1]
    const prevKey = prev?.attributes ? JSON.stringify(prev.attributes) : ''
    if (prev && prevKey === attrKey) {
      if (!marks.code && prev.insert.endsWith(' ') && insert.startsWith(' ')) insert = insert.slice(1)
      prev.insert += insert
      return
    }
    const attributes = attrKey ? { ...marks } : undefined
    delta.push(attributes ? { insert, attributes } : { insert })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inline = (node: any, marks: Record<string, unknown>, delta: InlineDelta[]): void => {
    for (const child of node.childNodes ?? []) {
      if (child.nodeType === 3) {
        const text = String(child.textContent)
        const s = marks.code ? text : text.replace(/\s+/g, ' ')
        if (!s) continue
        pushDelta(delta, s, marks)
      } else if (child.nodeType === 1) {
        const tag = String(child.tagName).toUpperCase()
        if (isHiddenElement(child)) continue
        if (tag === 'BR') {
          pushDelta(delta, ' ', marks)
          continue
        }
        const math = extractMathTex(child)
        if (math) {
          pushDelta(delta, `$${math.tex}$`, marks)
          continue
        }
        if (tag === 'SCRIPT' || tag === 'STYLE') continue
        if (tag === 'A') {
          const href = safeHref(child.getAttribute('href'), baseUrl)
          inline(child, href ? { ...marks, link: { href } } : marks, delta)
        } else if (MARKS[tag]) {
          inline(child, { ...marks, [MARKS[tag]!]: {} }, delta)
        } else {
          inline(child, marks, delta)
        }
      }
    }
  }

  const trimmed = (delta: InlineDelta[]): InlineDelta[] => {
    if (delta[0] && !delta[0].attributes?.code) delta[0].insert = delta[0].insert.replace(/^\s+/, '')
    const last = delta[delta.length - 1]
    if (last && !last.attributes?.code) last.insert = last.insert.replace(/\s+$/, '')
    return delta.filter((d) => d.insert.length > 0)
  }

  const push = (type: string, attrs: Record<string, unknown>, node: unknown, stripPrefix?: RegExp): void => {
    const delta: InlineDelta[] = []
    inline(node, {}, delta)
    let t = trimmed(delta)
    if (stripPrefix) t = stripLeadingPrefix(t, stripPrefix)
    if (t.length) out.push({ type, attrs, delta: t })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasBlockChild = (el: any): boolean =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [...(el.children ?? [])].some((c: any) => BLOCK_TAGS.has(String(c.tagName).toUpperCase()) && String(c.tagName).toUpperCase() !== 'BR')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const list = (el: any, ordered: boolean, indent: number): void => {
    for (const li of el.children ?? []) {
      if (String(li.tagName).toUpperCase() !== 'LI') continue
      if (isHiddenElement(li)) continue
      const clone = li.cloneNode(true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const nested of [...clone.querySelectorAll('ul,ol')] as any[]) nested.remove()
      const box = clone.querySelector('input[type=checkbox]')
      if (box) push('taskItem', { checked: box.hasAttribute('checked'), indent }, clone)
      else push(ordered ? 'orderedItem' : 'bulletItem', { indent }, clone)
      for (const nested of li.children ?? []) {
        const t = String(nested.tagName).toUpperCase()
        if (t === 'UL' || t === 'OL') list(nested, t === 'OL', Math.min(indent + 1, 4))
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (el: any): void => {
    for (const node of el.childNodes ?? []) {
      if (node.nodeType === 3) {
        const s = String(node.textContent).trim()
        if (s) out.push(para(s))
        continue
      }
      if (node.nodeType !== 1) continue
      const tag = String(node.tagName).toUpperCase()
      if (isHiddenElement(node)) continue

      const math = extractMathTex(node)
      if (math?.display) {
        out.push({ type: 'codeBlock', attrs: { language: 'math' }, delta: [{ insert: math.tex }] })
        continue
      }

      if (tag === 'VIDEO' || tag === 'IFRAME') {
        const b = mediaBlock(node, '', baseUrl)
        if (b) out.push(b)
        continue
      }
      if (['SCRIPT', 'STYLE', 'NAV', 'NOSCRIPT', 'FORM', 'SVG'].includes(tag)) continue
      if (/^H[1-6]$/.test(tag)) push('heading', { level: Math.min(Number(tag[1]), 3) }, node)
      else if (tag === 'UL' || tag === 'OL') list(node, tag === 'OL', 0)
      else if (tag === 'ASIDE' || node.hasAttribute?.('data-callout') || hasClass(node, 'callout')) {
        if (hasBlockChild(node)) {
          for (const c of node.children ?? []) {
            if (!isHiddenElement(c)) push('callout', {}, c, CALLOUT_PREFIX)
          }
        } else {
          push('callout', {}, node, CALLOUT_PREFIX)
        }
      } else if (tag === 'BLOCKQUOTE') {
        const rawText = String(node.textContent ?? '').trim()
        const isCallout = CALLOUT_PREFIX.test(rawText)
        const targetType = isCallout ? 'callout' : 'quote'
        if (hasBlockChild(node)) {
          let first = true
          for (const c of node.children ?? []) {
            if (isHiddenElement(c)) continue
            push(targetType, {}, c, isCallout && first ? CALLOUT_PREFIX : undefined)
            first = false
          }
        } else {
          push(targetType, {}, node, isCallout ? CALLOUT_PREFIX : undefined)
        }
      } else if (tag === 'PRE') {
        const code = node.querySelector('code')
        const lang = codeLangOf(node, code)
        const s = preText(code ?? node).replace(/\n+$/, '')
        if (s && lang === 'drawio') out.push({ type: 'drawio', attrs: { xml: s.trim() }, delta: [] })
        else if (s) out.push({ type: 'codeBlock', attrs: { language: lang }, delta: [{ insert: s }] })
      } else if (tag === 'HR') {
        out.push({ type: 'divider', attrs: {}, delta: [] })
      } else if (tag === 'IMG') {
        const b = imageBlock(node, collapse(node.getAttribute('title')), undefined, baseUrl)
        if (b) out.push(b)
      } else if (tag === 'FIGURE') {
        const caption = collapse(node.querySelector('figcaption')?.textContent)
        const img = node.querySelector('img')
        const image = img ? imageBlock(img, caption, node, baseUrl) : null
        let media: Block | null = null
        if (!image) for (const m of [...node.querySelectorAll('video,iframe')]) media ??= mediaBlock(m, caption, baseUrl)
        if (image) out.push(image)
        else if (media) out.push(media)
        else walk(node)
      } else if (tag === 'TABLE') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = [...node.querySelectorAll('tr')]
          .filter((tr: any) => !isHiddenElement(tr))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((tr: any) => [...tr.querySelectorAll('th,td')].filter((c: any) => !takesNoSpace(c)).map((c: any) => {
            if (isHiddenElement(c)) return ''
            const delta: InlineDelta[] = []
            inline(c, {}, delta)
            return collapse(delta.map((d) => d.insert).join(''))
          }))
          .filter((r) => r.length)
        if (rows.length) out.push({ type: 'table', attrs: { rows: JSON.stringify(rows) }, delta: [] })
      } else if (tag === 'P' || !hasBlockChild(node)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const img of [...node.querySelectorAll('img')] as any[]) {
          if (isHiddenElement(img)) continue
          const b = imageBlock(img, collapse(img.getAttribute('title')), undefined, baseUrl)
          if (b) out.push(b)
        }
        for (const m of [...node.querySelectorAll('video,iframe')]) {
          const b = mediaBlock(m, '', baseUrl)
          if (b) out.push(b)
        }
        push('paragraph', {}, node)
      } else {
        walk(node)
      }
    }
  }

  walk(root)
  return out
}

/** Build leading metadata blocks (source citation quote, optional note callout, divider). */
export function buildSourceHeaderBlocks(meta: ClipMetadata): Block[] {
  const out: Block[] = []
  const href = safeHref(meta.url)
  const delta: InlineDelta[] = [{ insert: '来源：' }]
  const label = collapse(meta.title) || meta.url
  if (href) delta.push({ insert: label, attributes: { link: { href } } })
  else delta.push({ insert: label })

  const extra: string[] = []
  if (meta.author?.trim()) extra.push(`作者：${collapse(meta.author)}`)
  if (meta.siteName?.trim()) extra.push(collapse(meta.siteName))
  if (meta.publishedAt?.trim()) extra.push(collapse(meta.publishedAt))
  if (meta.clippedAt?.trim()) extra.push(`剪藏于 ${collapse(meta.clippedAt)}`)
  if (extra.length) delta.push({ insert: ` · ${extra.join(' · ')}` })

  out.push({ type: 'quote', attrs: {}, delta })
  if (meta.note?.trim()) {
    out.push({ type: 'callout', attrs: {}, delta: [{ insert: `笔记：${meta.note.trim()}` }] })
  }
  out.push({ type: 'divider', attrs: {}, delta: [] })
  return out
}

/** Deduplicated list of external http(s) image URLs present in `blocks`. */
export function collectImageUrls(blocks: Block[]): string[] {
  const seen = new Set<string>()
  for (const b of blocks) {
    if (b.type !== 'image') continue
    const src = String(b.attrs.src ?? '')
    if (/^https?:/i.test(src)) seen.add(src)
  }
  return [...seen]
}

// ---------- Markdown serialization ----------

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const mdOneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ')
const mdAlt = (s: string): string => mdOneLine(s).replace(/[[\]]/g, '')
const mdItalic = (s: string): string => '*' + mdOneLine(s).replace(/([*_\\`])/g, '\\$1') + '*'

const mdEscapeText = (s: string): string => s.replace(/([\\`*_\[\]~<]|&(?=[\w#]+;))/g, '\\$1').replace(/\b(https?):(?=\/\/)/gi, '$1\\:')

function mdInlineText(text: string): string {
  // HTML imports store inline formulas as $…$ text. Keep their TeX verbatim.
  return text.split(/((?<![\\$])\$(?=[^\s$])[^$\n]*?[^\s$\\]\$(?![\d$]))/g)
    .map((part, i) => i % 2 ? part : mdEscapeText(part)).join('')
}

function mdCodeSpan(text: string): string {
  const fence = '`'.repeat((text.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length + 1), 1))
  const pad = /^[ `]|[ `]$/.test(text) && /[^ ]/.test(text) ? ' ' : ''
  return fence + pad + text + pad + fence
}

function inlineMd(delta: InlineDelta[]): string {
  return delta
    .map((d) => {
      let s = d.insert
      const a = d.attributes ?? {}
      if (a.footnoteRef) return `[^${Number(a.footnoteRef)}]`
      // Inline math is not combined with other marks: the source goes out as written.
      if (a.math) return `$${s}$`
      s = a.code ? mdCodeSpan(s) : mdInlineText(s)
      if (a.bold) s = `**${s}**`
      if (a.italic) s = `*${s}*`
      if (a.strike) s = `~~${s}~~`
      const href = (a.link as { href?: string } | undefined)?.href
      if (href) s = `[${s}](${href})`
      return s
    })
    .join('')
}

const tableRows = (b: Block): string[][] => {
  try {
    return JSON.parse(String(b.attrs.rows ?? '[]')) as string[][]
  } catch {
    return []
  }
}

/**
 * Footnotes are a text format: a run carries `footnote: { id, note }`. Numbers are positions in reading order,
 * counted once per id. Keep this in step with `footnotesOf` in @stetpad/crdt (the editor, the agent and the
 * HTML / Word exports use that one; this package does not depend on it). A test checks they agree.
 */
export function footnoteNotes(list: { delta: InlineDelta[] }[]): { id: string; note: string; number: number }[] {
  const out = new Map<string, { id: string; note: string; number: number }>()
  for (const b of list) {
    for (const d of b.delta) {
      const f = d.attributes?.footnote as { id?: unknown; note?: unknown } | undefined
      if (!f || typeof f !== 'object' || typeof f.id !== 'string' || !f.id || out.has(f.id)) continue
      out.set(f.id, { id: f.id, note: typeof f.note === 'string' ? f.note : '', number: out.size + 1 })
    }
  }
  return [...out.values()]
}

/** The blocks with an empty `footnoteRef` run after the last run of each footnote. */
function withFootnoteRefs(list: Block[], notes: ReturnType<typeof footnoteNotes>): Block[] {
  if (!notes.length) return list
  const number = new Map(notes.map((n) => [n.id, n.number]))
  const last = new Map<string, string>()
  list.forEach((b, bi) => b.delta.forEach((d, di) => {
    const id = (d.attributes?.footnote as { id?: unknown } | undefined)?.id
    if (typeof id === 'string' && number.has(id)) last.set(id, `${bi}:${di}`)
  }))
  const refs = new Map(Array.from(last, ([id, at]) => [at, number.get(id)]))
  return list.map((b, bi) => ({
    ...b,
    delta: b.delta.flatMap((d, di) => {
      const ref = refs.get(`${bi}:${di}`)
      return ref === undefined ? d : [d, { insert: '', attributes: { footnoteRef: ref } }]
    }),
  }))
}

export function blocksToMarkdown(input: Block[]): string {
  const notes = footnoteNotes(input)
  const list = withFootnoteRefs(input, notes)
  const out: (string | { code: string })[] = []
  const markers: { type: string; n: number; width: number }[] = []
  for (const b of list) {
    const listItem = ['bulletItem', 'orderedItem', 'taskItem'].includes(b.type)
    const level = Number(b.attrs.indent ?? 0)
    if (!listItem && markers.length) out.push('')
    markers.length = listItem ? Math.min(markers.length, level + 1) : 0
    const previous = markers[level]
    const n = b.type === 'orderedItem' && previous?.type === b.type ? previous.n + 1 : 1
    const pad = ' '.repeat(Array.from({ length: level }, (_, i) => markers[i]?.width ?? 2).reduce((a, b) => a + b, 0))
    if (listItem) markers[level] = { type: b.type, n, width: b.type === 'orderedItem' ? String(n).length + 2 : 2 }
    switch (b.type) {
      case 'heading':
        out.push('#'.repeat(Number(b.attrs.level ?? 1)) + ' ' + inlineMd(b.delta))
        break
      case 'bulletItem':
        out.push(`${pad}- ${inlineMd(b.delta)}`)
        break
      case 'orderedItem':
        out.push(`${pad}${n}. ${inlineMd(b.delta)}`)
        break
      case 'taskItem':
        out.push(`${pad}- [${b.attrs.checked ? 'x' : ' '}] ${inlineMd(b.delta)}`)
        break
      case 'quote':
        out.push('> ' + inlineMd(b.delta))
        break
      case 'callout':
        out.push('> [!NOTE] ' + inlineMd(b.delta))
        break
      case 'codeBlock': {
        const lang = String(b.attrs.language ?? '')
        const text = blockTextContent(b)
        const fence = '`'.repeat((text.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length + 1), 3))
        out.push(lang === 'math' ? `$$\n${text}\n$$` : { code: fence + lang + '\n' + text + '\n' + fence })
        break
      }
      case 'divider':
        out.push('---')
        break
      case 'image': {
        const caption = mdOneLine(String(b.attrs.caption ?? ''))
        out.push(`![${mdAlt(String(b.attrs.alt ?? ''))}](${String(b.attrs.src ?? '')}${caption ? ` "${caption.replace(/"/g, "'")}"` : ''})`)
        break
      }
      case 'video': {
        const src = String(b.attrs.src ?? '')
        const title = String(b.attrs.title ?? '')
        if (b.attrs.kind === 'embed') out.push(`[▶ ${mdAlt(title || src)}](${src})`)
        else out.push(`<video src="${esc(src)}" controls></video>`)
        if (b.attrs.caption) out.push(mdItalic(String(b.attrs.caption)))
        break
      }
      case 'file':
        out.push(`[📎 ${mdAlt(String(b.attrs.name ?? '')) || '附件'}](${String(b.attrs.src ?? '')})`)
        break
      case 'linkCard': {
        const url = String(b.attrs.url ?? '')
        const desc = mdOneLine(String(b.attrs.description ?? ''))
        out.push(`[${mdAlt(String(b.attrs.title ?? '')) || url}](${url})${desc ? ` — ${desc}` : ''}`)
        break
      }
      case 'drawio': {
        const preview = String(b.attrs.preview ?? '')
        const caption = String(b.attrs.caption ?? '')
        if (preview) out.push(`![${mdAlt(caption || 'draw.io')}](${preview})`)
        else {
          out.push('```drawio\n' + String(b.attrs.xml ?? '') + '\n```')
          if (caption) out.push(mdItalic(caption))
        }
        break
      }
      case 'table': {
        const rows = tableRows(b).map((r) => r.map((c) => String(c ?? '').replace(/([\\|])/g, '\\$1')))
        if (rows[0]) {
          out.push('| ' + rows[0].join(' | ') + ' |', '| ' + rows[0].map(() => '---').join(' | ') + ' |', ...rows.slice(1).map((r) => '| ' + r.join(' | ') + ' |'))
        }
        break
      }
      default:
        out.push(inlineMd(b.delta))
    }
    if (!listItem) out.push('')
  }
  let markdown = ''
  let nonCode = ''
  out.forEach((part, i) => {
    nonCode += i ? '\n' : ''
    if (typeof part === 'string') nonCode += part
    else {
      markdown += nonCode.replace(/\n{3,}/g, '\n\n') + part.code
      nonCode = ''
    }
  })
  const body = (markdown + nonCode.replace(/\n{3,}/g, '\n\n')).trim() + '\n'
  if (!notes.length) return body
  return body + '\n' + notes.map((n) => `[^${n.number}]: ${mdOneLine(n.note).trim()}`).join('\n') + '\n'
}
