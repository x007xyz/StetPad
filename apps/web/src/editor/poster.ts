import type { Editor } from '@tiptap/core'
import { api } from '../api'

/** Uploaded-file urls of this app. */
const FILE_SRC = /^\/files\/[\w-]+$/
/** The poster frame is at most this wide; a taller video keeps its aspect ratio. */
const MAX_WIDTH = 1280
/** A video that never yields a frame is given up on after this long. */
const GRAB_TIMEOUT_MS = 30_000

/** Sources already tried in this page load: one attempt per video. */
const attempted = new Set<string>()

/**
 * The frame at min(1 s, duration / 3) of a video, as a JPEG. Rejects when the
 * video cannot be read. The element is offscreen and never attached.
 */
export function grabFrame(src: string): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    let timer = 0
    const finish = (err: Error | null, blob?: Blob): void => {
      window.clearTimeout(timer)
      video.onerror = null
      video.onloadedmetadata = null
      video.onseeked = null
      video.removeAttribute('src')
      video.load()
      if (err) reject(err)
      else if (blob) resolve(blob)
    }
    timer = window.setTimeout(() => finish(new Error('截取封面超时')), GRAB_TIMEOUT_MS)
    video.onerror = () => finish(new Error('视频无法读取'))
    video.onloadedmetadata = () => {
      const d = video.duration
      if (!Number.isFinite(d) || d <= 0) return finish(new Error('视频长度不正确'))
      video.currentTime = Math.min(1, d / 3)
    }
    video.onseeked = () => {
      try {
        const w = video.videoWidth
        const h = video.videoHeight
        if (!w || !h) return finish(new Error('视频没有画面'))
        const scale = Math.min(1, MAX_WIDTH / w)
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(w * scale))
        canvas.height = Math.max(1, Math.round(h * scale))
        const ctx = canvas.getContext('2d')
        if (!ctx) return finish(new Error('截图失败'))
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        canvas.toBlob((blob) => (blob ? finish(null, blob) : finish(new Error('截图失败'))), 'image/jpeg', 0.85)
      } catch {
        finish(new Error('截图失败'))
      }
    }
    video.src = src
  })
}

/**
 * Sets an attribute of the video block with this id, in one transaction. With `expectSrc`, only while the
 * block still shows that file; with `onlyIfEmpty`, only while the attribute is still empty.
 */
export function setVideoAttr(
  editor: Editor,
  blockId: string,
  name: 'poster' | 'captions',
  value: string,
  opts: { expectSrc?: string; onlyIfEmpty?: boolean } = {},
): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false
  let pos = -1
  editor.state.doc.descendants((node, p) => {
    if (pos < 0 && node.type.name === 'video' && node.attrs.blockId === blockId) pos = p
    return pos < 0
  })
  if (pos < 0) return false
  const node = editor.state.doc.nodeAt(pos)
  if (!node) return false
  if (opts.expectSrc !== undefined && node.attrs.src !== opts.expectSrc) return false
  if (opts.onlyIfEmpty && node.attrs[name]) return false
  editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, name, value))
  return true
}

/**
 * Gives a file video of the document a poster frame, in the background. Once per source per page load: the
 * frame is taken from `source` (the file just uploaded) or from the video's own url, uploaded as a JPEG, and
 * set as the block's `poster` while that is still empty. Failures are ignored: a video without a poster works.
 */
export function ensurePoster(editor: Editor, docId: string, blockId: string, src: string, source?: Blob): void {
  if (!docId || !FILE_SRC.test(src) || !editor.isEditable || attempted.has(src)) return
  attempted.add(src)
  void (async () => {
    const objectUrl = source ? URL.createObjectURL(source) : null
    let frame: Blob
    try {
      frame = await grabFrame(objectUrl ?? src)
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
    const form = new FormData()
    form.append('file', new File([frame], 'poster.jpg', { type: 'image/jpeg' }))
    const { url } = await api<{ url: string }>(`/docs/${docId}/assets`, { method: 'POST', body: form })
    setVideoAttr(editor, blockId, 'poster', url, { expectSrc: src, onlyIfEmpty: true })
  })().catch(() => {})
}
