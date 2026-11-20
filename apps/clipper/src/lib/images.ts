import { collectImageUrls, type Block } from '@stetpad/clip'
import { uploadDocAsset } from './api'
import { fetchImageViaTab } from './inject'
import type { ClipperProfile } from './types'

const MAX_IMAGES_PER_CLIP = 25
const MAX_IMAGE_BYTES = 15 * 1024 * 1024
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function guessMimeFromUrl(url: string): string | null {
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

function filenameFromUrl(url: string, idx: number): string {
  try {
    const seg = new URL(url).pathname.split('/').pop()
    if (seg && seg.length <= 80) return seg
  } catch {
    // ignore
  }
  return `clip-image-${idx + 1}`
}

async function fetchDirectImage(url: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const rawMime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    const mime = IMAGE_MIME_TYPES.has(rawMime) ? rawMime : guessMimeFromUrl(url)
    if (!mime || !IMAGE_MIME_TYPES.has(mime)) return null
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null
    return { bytes: buf, mime }
  } catch {
    return null
  }
}

export async function localizeBlockImages(
  blocks: Block[],
  opts: { tabId?: number; docId: string; profile: ClipperProfile },
): Promise<{ blocks: Block[]; uploadedImages: number; skippedImages: number }> {
  const urls = collectImageUrls(blocks)
  if (urls.length === 0) return { blocks, uploadedImages: 0, skippedImages: 0 }

  const targets = urls.slice(0, MAX_IMAGES_PER_CLIP)
  let skippedImages = Math.max(0, urls.length - targets.length)
  let uploadedImages = 0
  const mapping = new Map<string, string>()

  let cursor = 0
  const workers = Array.from({ length: Math.min(4, targets.length) }, async () => {
    while (cursor < targets.length) {
      const idx = cursor++
      const imgUrl = targets[idx]!
      try {
        let payload: { bytes: Uint8Array; mime: string } | null = null
        if (opts.tabId !== undefined) {
          const fromTab = await fetchImageViaTab(opts.tabId, imgUrl)
          if (fromTab) payload = { bytes: base64ToBytes(fromTab.base64), mime: fromTab.mime }
        }
        if (!payload) payload = await fetchDirectImage(imgUrl)
        if (!payload) {
          skippedImages++
          continue
        }
        const uploaded = await uploadDocAsset(opts.profile, opts.docId, payload.bytes, payload.mime, filenameFromUrl(imgUrl, idx))
        mapping.set(imgUrl, uploaded.url)
        uploadedImages++
      } catch {
        skippedImages++
      }
    }
  })

  await Promise.all(workers)

  const rewritten = blocks.map((b) => {
    if (b.type !== 'image') return b
    const localUrl = mapping.get(String(b.attrs.src ?? ''))
    return localUrl ? { ...b, attrs: { ...b.attrs, src: localUrl } } : b
  })
  return { blocks: rewritten, uploadedImages, skippedImages }
}
