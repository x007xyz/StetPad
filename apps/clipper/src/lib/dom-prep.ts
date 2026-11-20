/**
 * Clones a live or parsed DOM Document before Defuddle extraction:
 * - hydrates lazy-loaded `<img>` sources & live `currentSrc`
 * - converts relative `img[src]` and `a[href]` to absolute URLs
 * - removes CSS-hidden noise nodes that could bias scoring or carry prompt injection
 */
function isPlaceholderSrc(src: string | null | undefined): boolean {
  if (!src) return true
  const s = src.trim().toLowerCase()
  if (!s || s.startsWith('about:') || s.startsWith('javascript:')) return true
  if (s.startsWith('data:image/svg+xml')) return true
  if (s.startsWith('data:image/') && s.length < 180) return true
  return false
}

function resolveAbsolute(raw: string, baseUrl: string): string {
  const t = raw.trim()
  if (!t || /^(https?:|mailto:|data:|#)/i.test(t)) return t
  try {
    return new URL(t, baseUrl).href
  } catch {
    return t
  }
}

function pickBestSrcset(srcset: string | null | undefined): string | null {
  if (!srcset) return null
  let best: string | null = null
  let maxScore = -1
  for (const part of srcset.split(',')) {
    const tokens = part.trim().split(/\s+/)
    const url = tokens[0]
    if (!url || isPlaceholderSrc(url)) continue
    const desc = tokens[1] ?? ''
    const w = /^(\d+)w$/i.exec(desc)?.[1]
    const x = /^(\d+(?:\.\d+)?)x$/i.exec(desc)?.[1]
    const score = w ? Number(w) : x ? Number(x) * 1000 : 1
    if (score > maxScore) {
      maxScore = score
      best = url
    }
  }
  return best
}

function isHiddenStyle(el: Element): boolean {
  const tag = el.tagName.toUpperCase()
  if (['PICTURE', 'SOURCE', 'MATH', 'SEMANTICS', 'ANNOTATION', 'BODY', 'HTML', 'HEAD'].includes(tag)) return false
  const cls = String(el.getAttribute('class') ?? '').split(/\s+/)
  if (cls.includes('katex') || cls.includes('katex-mathml')) return false
  if (el.hasAttribute('hidden')) return true
  const style = (el.getAttribute('style') ?? '').toLowerCase()
  if (!style) return false
  return (
    /(?:^|;)\s*display\s*:\s*none\b/.test(style) ||
    /(?:^|;)\s*visibility\s*:\s*hidden\b/.test(style) ||
    /(?:^|;)\s*opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)/.test(style) ||
    /(?:^|;)\s*font-size\s*:\s*0(?:px|em|rem|pt|%)?\s*(?:;|$)/.test(style)
  )
}

export function prepareDocumentForDefuddle(doc: Document, pageUrl: string): Document {
  const clone = doc.cloneNode(true) as Document

  const liveImgs = [...doc.querySelectorAll('img')]
  const cloneImgs = [...clone.querySelectorAll('img')]
  cloneImgs.forEach((img, i) => {
    const liveCurrent = (liveImgs[i] as HTMLImageElement | undefined)?.currentSrc
    const raw = img.getAttribute('src')
    let chosen: string | null = null
    if (liveCurrent && !isPlaceholderSrc(liveCurrent) && /^https?:/i.test(liveCurrent)) {
      chosen = liveCurrent
    } else if (raw && !isPlaceholderSrc(raw)) {
      chosen = raw
    } else {
      for (const attr of ['data-actualsrc', 'data-original', 'data-src', 'data-lazy-src', 'data-url']) {
        const val = img.getAttribute(attr)
        if (val && !isPlaceholderSrc(val)) {
          chosen = val
          break
        }
      }
      chosen ??= pickBestSrcset(img.getAttribute('data-srcset') ?? img.getAttribute('srcset'))
    }
    if (chosen) img.setAttribute('src', resolveAbsolute(chosen, pageUrl))
  })

  for (const a of [...clone.querySelectorAll('a[href]')]) {
    const href = a.getAttribute('href')
    if (href) a.setAttribute('href', resolveAbsolute(href, pageUrl))
  }

  for (const el of [...clone.querySelectorAll('body *')]) {
    if (el.parentNode && isHiddenStyle(el)) el.remove()
  }

  return clone
}
