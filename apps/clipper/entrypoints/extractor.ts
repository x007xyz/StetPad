import { blocksToMarkdown, domToBlocks, type Block } from '@stetpad/clip'
import Defuddle from 'defuddle'
import { prepareDocumentForDefuddle } from '../src/lib/dom-prep'
import type { ExtractedPage } from '../src/lib/types'

const MAX_IMAGE_BYTES = 15 * 1024 * 1024
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  const chunk = 0x8000
  let bin = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

function guessMime(url: string, headerType: string): string | null {
  const clean = headerType.split(';')[0]!.trim().toLowerCase()
  if (IMAGE_MIMES.has(clean)) return clean
  try {
    const p = new URL(url).pathname.toLowerCase()
    if (p.endsWith('.png')) return 'image/png'
    if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg'
    if (p.endsWith('.gif')) return 'image/gif'
    if (p.endsWith('.webp')) return 'image/webp'
    if (p.endsWith('.svg')) return 'image/svg+xml'
  } catch {
    // ignore
  }
  return null
}

function extractSelectionBlocks(baseUrl: string): Block[] {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !sel.toString().trim()) return []
  const wrapper = document.createElement('div')
  for (let i = 0; i < sel.rangeCount; i++) {
    wrapper.appendChild(sel.getRangeAt(i).cloneContents())
  }
  const blocks = domToBlocks(wrapper, { baseUrl })
  if (blocks.length > 0) return blocks
  const plain = sel.toString().trim()
  return plain
    ? plain
        .split(/\n{2,}/)
        .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
        .filter(Boolean)
        .map((p) => ({ type: 'paragraph', attrs: {}, delta: [{ insert: p }] }))
    : []
}

function extract(): ExtractedPage {
  const url = location.href
  const cloned = prepareDocumentForDefuddle(document, url)
  const parsed = new Defuddle(cloned, { url }).parse()
  const contentHtml = parsed.content || cloned.body?.innerHTML || ''
  const htmlDoc = new DOMParser().parseFromString(`<!doctype html><html><body>${contentHtml}</body></html>`, 'text/html')
  let articleBlocks = domToBlocks(htmlDoc.body, { baseUrl: url })
  if (articleBlocks.length === 0) {
    articleBlocks = domToBlocks(cloned.body, { baseUrl: url })
  }
  const selectionBlocks = extractSelectionBlocks(url)
  return {
    url,
    title: (parsed.title || document.title || url).trim(),
    author: parsed.author || undefined,
    siteName: parsed.site || undefined,
    publishedAt: parsed.published || undefined,
    excerpt: parsed.description || undefined,
    articleBlocks,
    articleMarkdown: blocksToMarkdown(articleBlocks),
    selectionBlocks,
    selectionMarkdown: selectionBlocks.length ? blocksToMarkdown(selectionBlocks) : '',
    hasSelection: selectionBlocks.length > 0,
  }
}

async function fetchImageBase64(imgUrl: string): Promise<{ base64: string; mime: string } | null> {
  if (!/^https?:/i.test(imgUrl)) return null
  try {
    const res = await fetch(imgUrl, { credentials: 'include', signal: AbortSignal.timeout(8000) })
    if (res.ok) {
      const mime = guessMime(imgUrl, res.headers.get('content-type') ?? '')
      if (mime) {
        const buf = await res.arrayBuffer()
        if (buf.byteLength > 0 && buf.byteLength <= MAX_IMAGE_BYTES) {
          return { base64: arrayBufferToBase64(buf), mime }
        }
      }
    }
  } catch {
    // Fall through to canvas extraction for already-decoded CORS images.
  }

  try {
    const img = [...document.images].find(
      (el) => el.complete && el.naturalWidth > 0 && (el.currentSrc === imgUrl || el.src === imgUrl),
    )
    if (img) {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(img, 0, 0)
        const dataUrl = canvas.toDataURL('image/png')
        const idx = dataUrl.indexOf(',')
        if (idx > 0) return { base64: dataUrl.slice(idx + 1), mime: 'image/png' }
      }
    }
  } catch {
    // Tainted canvas; caller keeps external image URL.
  }
  return null
}

export default defineUnlistedScript(() => {
  ;(globalThis as unknown as { __stetpadExtractor: { extract: typeof extract; fetchImageBase64: typeof fetchImageBase64 } }).__stetpadExtractor = {
    extract,
    fetchImageBase64,
  }
})
