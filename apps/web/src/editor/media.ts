import type { Editor } from '@tiptap/core'
import { Fragment } from '@tiptap/pm/model'
import { api, getToken } from '../api'
import { ensurePoster } from './poster'

/** Image types the asset endpoint accepts. Keep in sync with the server. */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml'
const IMAGE_TYPES = IMAGE_ACCEPT.split(',')
const MAX_BYTES = 20 * 1024 * 1024

/** Attachment types the asset endpoint takes (anything else that is not an image or video is refused). Keep in sync with the server. */
export const FILE_ACCEPT = [
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
].join(',')
const FILE_TYPES = FILE_ACCEPT.split(',')
const MAX_FILE_BYTES = 100 * 1024 * 1024

/** Upload one image to the doc's asset store and return its `/files/<id>` url. */
export async function uploadFile(docId: string, file: File): Promise<string> {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error('不支持的图片格式')
  if (file.size > MAX_BYTES) throw new Error('图片超过 20MB')
  const form = new FormData()
  form.append('file', file)
  const { url } = await api<{ url: string }>(`/docs/${docId}/assets`, { method: 'POST', body: form })
  return url
}

/** The image files in a file list (drop or paste), in order. */
export function imageFiles(list: FileList | null | undefined): File[] {
  return list ? Array.from(list).filter((f) => IMAGE_TYPES.includes(f.type)) : []
}

/** Position right after the top-level block with this id, or 0 when there is none. */
export function afterBlock(editor: Editor, blockId: string | null): number {
  if (!blockId) return 0
  let pos = 0
  let found = -1
  editor.state.doc.forEach((node, offset) => {
    if (node.attrs.blockId === blockId) found = offset + node.nodeSize
    pos = offset + node.nodeSize
  })
  return found >= 0 ? found : pos
}

/** Window event an image's buttons fire: `detail` is { blockId, src, action }. DocPage opens the matching dialog. */
export const IMAGE_ACTION_EVENT = 'stetpad:image-action'
export type ImageAction = 'crop' | 'ai-edit'

/** A new block id, in the form the editor uses for blocks it creates. */
export function freshBlockId(): string {
  return 'b_' + Math.random().toString(36).slice(2, 10)
}

/** Alt text the model writes for an uploaded image of the document. Rejects when the request fails. */
export async function describeImage(docId: string, src: string): Promise<string> {
  const { alt } = await api<{ alt: string }>(`/docs/${docId}/ai/describe`, { method: 'POST', body: JSON.stringify({ src }) })
  return alt
}

/**
 * Sets the alt of every image with this src whose alt is still `fromAlt`: the file name or prompt it was
 * inserted with. Someone who typed a new alt meanwhile keeps it. One transaction.
 */
export function setImageAlt(editor: Editor, src: string, fromAlt: string, alt: string): boolean {
  if (editor.isDestroyed || !editor.isEditable || !alt) return false
  const hits: number[] = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'image' && node.attrs.src === src && node.attrs.alt === fromAlt) hits.push(pos)
  })
  if (!hits.length) return false
  const tr = editor.state.tr
  for (const pos of hits) tr.setNodeAttribute(pos, 'alt', alt)
  editor.view.dispatch(tr)
  return true
}

/**
 * Describes an image in the background and sets its alt when the alt is still `fromAlt`. Errors are ignored:
 * a missing alt is not worth an interruption.
 */
export function describeInBackground(editor: Editor, docId: string, src: string, fromAlt: string): void {
  describeImage(docId, src)
    .then((alt) => setImageAlt(editor, src, fromAlt, alt))
    .catch(() => {})
}

/** Points the image block with this id at another file, keeping its alt, caption and width. One transaction. */
export function replaceImageSrc(editor: Editor, blockId: string, url: string): boolean {
  if (!editor.isEditable) return false
  let pos = -1
  editor.state.doc.descendants((node, p) => {
    if (pos < 0 && node.type.name === 'image' && node.attrs.blockId === blockId) pos = p
    return pos < 0
  })
  if (pos < 0) return false
  editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'src', url))
  return true
}

/** Inserts an image block right after the top-level block with this id. */
export function insertImageAfter(editor: Editor, blockId: string, src: string, alt: string): boolean {
  if (!editor.isEditable) return false
  return editor.chain().insertContentAt(afterBlock(editor, blockId), { type: 'image', attrs: { src, alt, blockId: freshBlockId() } }).run()
}

/**
 * Upload the files one after another and insert each as an image block at the
 * top-level boundary `pos`. The spot is remembered as "after block X", not as a
 * number, so typing or remote edits during a slow upload don't move it.
 * Throws on the first failed upload; images already inserted stay.
 */
export async function insertImageFiles(editor: Editor, docId: string, files: File[], pos: number): Promise<void> {
  const before = editor.state.doc.resolve(Math.min(pos, editor.state.doc.content.size)).nodeBefore
  let anchor = (before?.attrs.blockId as string | undefined) ?? null
  for (const file of files) {
    const src = await uploadFile(docId, file)
    const blockId = freshBlockId()
    if (editor.chain().insertContentAt(afterBlock(editor, anchor), { type: 'image', attrs: { src, alt: file.name, blockId } }).run()) {
      anchor = blockId
      describeInBackground(editor, docId, src, file.name)
    }
  }
}

/** Video types the asset endpoint accepts. Keep in sync with the server. */
export const VIDEO_ACCEPT = 'video/mp4,video/webm,video/quicktime,video/ogg'
const VIDEO_TYPES = VIDEO_ACCEPT.split(',')
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024
/** Videos above this go through the resumable path, in chunks. */
export const RESUMABLE_MIN_BYTES = 20 * 1024 * 1024
const CHUNK_BYTES = 8 * 1024 * 1024
/** Waits before the 1st, 2nd … retry of a failed chunk. */
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]

/** The video files in a file list (drop or paste), in order. */
export function videoFiles(list: FileList | null | undefined): File[] {
  return list ? Array.from(list).filter((f) => VIDEO_TYPES.includes(f.type)) : []
}

/** The files in a list that are neither images nor videos: attachments, in order. */
export function attachmentFiles(list: FileList | null | undefined): File[] {
  return list ? Array.from(list).filter((f) => !IMAGE_TYPES.includes(f.type) && !VIDEO_TYPES.includes(f.type)) : []
}
const abortError = (): DOMException => new DOMException('已取消', 'AbortError')
const isAbort = (err: unknown): boolean => err instanceof DOMException && err.name === 'AbortError'

/**
 * Upload one file as the raw request body, reporting the sent fraction (0–1).
 * XHR rather than fetch, for the upload progress events. Rejects with an
 * AbortError when `signal` fires.
 */
function uploadRaw(docId: string, file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const onAbort = (): void => xhr.abort()
    const done = (): void => signal?.removeEventListener('abort', onAbort)
    signal?.addEventListener('abort', onAbort, { once: true })
    xhr.open('POST', `/api/docs/${docId}/assets`)
    xhr.setRequestHeader('authorization', `Bearer ${getToken()}`)
    xhr.setRequestHeader('content-type', file.type)
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name))
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total))
    }
    xhr.onload = () => {
      done()
      let body: { url?: string; error?: string } | null = null
      try {
        body = JSON.parse(xhr.responseText) as { url?: string; error?: string }
      } catch {
        body = null
      }
      if (xhr.status >= 200 && xhr.status < 300 && body?.url) resolve(body.url)
      else reject(new Error(body?.error || `上传失败（${xhr.status}）`))
    }
    xhr.onerror = () => {
      done()
      reject(new Error('网络错误，上传失败'))
    }
    xhr.onabort = () => {
      done()
      reject(abortError())
    }
    xhr.send(file)
  })
}

/** Upload one video, checked against the server's rules first. */
export function uploadVideo(docId: string, file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<string> {
  if (!VIDEO_TYPES.includes(file.type)) return Promise.reject(new Error('不支持的视频格式'))
  if (file.size > MAX_VIDEO_BYTES) return Promise.reject(new Error('视频超过 1GB'))
  return uploadRaw(docId, file, onProgress, signal)
}

/** Upload one attachment, checked against the server's rules first. */
export function uploadAttachment(docId: string, file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<string> {
  if (!FILE_TYPES.includes(file.type)) return Promise.reject(new Error('不支持的文件类型'))
  if (file.size > MAX_FILE_BYTES) return Promise.reject(new Error('附件超过 100MB'))
  return uploadRaw(docId, file, onProgress, signal)
}

/**
 * Puts a block after the anchor block (or in the empty paragraph the slash command
 * left, when `wantReplace`). Shared by the video and attachment inserts.
 */
function placeBlock(editor: Editor, anchor: string | null, wantReplace: boolean, node: { type: string; attrs: Record<string, unknown> }): void {
  if (wantReplace && anchor) {
    // Still empty and still there? Then the video takes its place.
    let from = -1
    let to = -1
    editor.state.doc.forEach((n, offset) => {
      if (n.attrs.blockId === anchor && n.type.name === 'paragraph' && n.content.size === 0) {
        from = offset
        to = offset + n.nodeSize
      }
    })
    if (from >= 0 && editor.chain().insertContentAt({ from, to }, node).run()) return
  }
  editor.chain().insertContentAt(afterBlock(editor, anchor), node).run()
}

/** A failure that retrying will not fix: the server answered and refused. */
class RefusedError extends Error {}

/** Where the server has a resumable upload: its offset, and its url once the file is stored. */
async function uploadStatus(uploadId: string, signal?: AbortSignal): Promise<{ offset: number; url?: string }> {
  const res = await fetch(`/api/uploads/${uploadId}`, { headers: { authorization: `Bearer ${getToken()}` }, signal })
  if (!res.ok) throw new RefusedError(res.status === 404 ? '上传已失效，请重新上传' : `上传失败（${res.status}）`)
  return (await res.json()) as { offset: number; url?: string }
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const t = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      window.clearTimeout(t)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/**
 * Upload a large video in chunks. A failed chunk is retried with backoff; before each retry the server is
 * asked where the upload stands, so a dropped connection resumes rather than restarts. Resolves to the
 * `/files/<id>` url. Rejects with an AbortError when `signal` fires.
 */
export async function uploadResumable(docId: string, file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<string> {
  if (!VIDEO_TYPES.includes(file.type)) throw new Error('不支持的视频格式')
  if (file.size > MAX_VIDEO_BYTES) throw new Error('视频超过 1GB')
  if (signal?.aborted) throw abortError()
  const created = await api<{ uploadId: string; offset: number }>(`/docs/${docId}/uploads`, {
    method: 'POST',
    body: JSON.stringify({ name: file.name, mime: file.type, size: file.size }),
  })
  const uploadId = created.uploadId
  let offset = created.offset
  let retries = 0
  for (;;) {
    if (signal?.aborted) throw abortError()
    if (offset >= file.size) {
      // Every byte is with the server: the last chunk stored the file, or it is stored now.
      const st = await uploadStatus(uploadId, signal)
      if (st.url) return st.url
      throw new Error('上传失败，请重新上传')
    }
    const end = Math.min(offset + CHUNK_BYTES, file.size) - 1
    try {
      const res = await fetch(`/api/uploads/${uploadId}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${getToken()}`, 'content-range': `bytes ${offset}-${end}/${file.size}` },
        body: file.slice(offset, end + 1),
        signal,
      })
      const body = (await res.json().catch(() => ({}))) as { done?: boolean; url?: string; offset?: number; error?: string }
      if (res.status === 409) {
        // The server is somewhere else (an earlier chunk arrived after all): continue from there.
        if (body.url) return body.url
        offset = Number(body.offset ?? offset)
        retries = 0
        continue
      }
      if (res.status >= 500) throw new Error(body.error || `上传失败（${res.status}）`)
      if (!res.ok) throw new RefusedError(body.error || `上传失败（${res.status}）`)
      retries = 0
      if (body.done && body.url) {
        onProgress(1)
        return body.url
      }
      offset = Number(body.offset ?? offset)
      onProgress(offset / file.size)
    } catch (err) {
      if (isAbort(err) || err instanceof RefusedError) throw err
      if (retries >= RETRY_DELAYS_MS.length) throw new Error('网络错误，上传失败')
      await sleep(RETRY_DELAYS_MS[retries]!, signal)
      retries++
      // Ask where the server has got to; if that fails too, the next attempt does the asking.
      try {
        offset = (await uploadStatus(uploadId, signal)).offset
      } catch (statusErr) {
        if (isAbort(statusErr) || statusErr instanceof RefusedError) throw statusErr
      }
    }
  }
}

/** Upload one video with whichever path fits its size. */
function uploadAny(docId: string, file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<string> {
  return file.size > RESUMABLE_MIN_BYTES ? uploadResumable(docId, file, onProgress, signal) : uploadVideo(docId, file, onProgress, signal)
}

/**
 * Upload one video and insert it as a file video block at the top-level boundary
 * `pos`, anchored the same way as `insertImageFiles`. With `replaceEmpty`, an
 * empty paragraph right before that spot (the slash command's line) is replaced.
 * Resolves to the new block's id. A poster frame is made in the background.
 */
export async function insertVideoFile(
  editor: Editor,
  docId: string,
  file: File,
  pos: number,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
  replaceEmpty = false,
): Promise<string> {
  const before = editor.state.doc.resolve(Math.min(pos, editor.state.doc.content.size)).nodeBefore
  const anchor = (before?.attrs.blockId as string | undefined) ?? null
  const wantReplace = replaceEmpty && before?.type.name === 'paragraph' && before.content.size === 0
  const src = await uploadAny(docId, file, onProgress, signal)
  const blockId = freshBlockId()
  ensurePoster(editor, docId, blockId, src, file)
  placeBlock(editor, anchor, wantReplace, { type: 'video', attrs: { src, kind: 'file', title: file.name, blockId } })
  return blockId
}

/** Upload one attachment and insert it as a file block, placed like `insertVideoFile`. Resolves to its block id. */
export async function insertAttachment(
  editor: Editor,
  docId: string,
  file: File,
  pos: number,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
  replaceEmpty = false,
): Promise<string> {
  const before = editor.state.doc.resolve(Math.min(pos, editor.state.doc.content.size)).nodeBefore
  const anchor = (before?.attrs.blockId as string | undefined) ?? null
  const wantReplace = replaceEmpty && before?.type.name === 'paragraph' && before.content.size === 0
  const src = await uploadAttachment(docId, file, onProgress, signal)
  const blockId = freshBlockId()
  placeBlock(editor, anchor, wantReplace, { type: 'file', attrs: { src, name: file.name, mime: file.type, size: file.size, blockId } })
  return blockId
}

/** Position right after the top-level block with this id, or the end of the document when it is gone. */
export function posAfterBlock(editor: Editor, blockId: string): number {
  return afterBlock(editor, blockId)
}

/** The transcript of a video: the WebVTT file's url, and the segments with their times in seconds. */
export interface Transcript {
  text: string
  segments: { start: number; end: number; text: string }[]
  vtt: string
}

/** Transcribe a video of the document. Rejects with the server's message when it cannot. */
export function transcribeVideo(docId: string, src: string): Promise<Transcript> {
  return api<Transcript>(`/docs/${docId}/ai/transcribe`, { method: 'POST', body: JSON.stringify({ src }) })
}

/** `mm:ss` for a time in seconds. */
export function clockTime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
}

/**
 * Sets the captions of the video block and inserts the transcript after it as quote blocks, one per three
 * segments, each starting `[mm:ss]`. One transaction. False when the block is gone.
 */
export function applyTranscript(editor: Editor, blockId: string, transcript: Transcript): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false
  let pos = -1
  editor.state.doc.descendants((node, p) => {
    if (pos < 0 && node.type.name === 'video' && node.attrs.blockId === blockId) pos = p
    return pos < 0
  })
  if (pos < 0) return false
  const schema = editor.state.schema
  const video = editor.state.doc.nodeAt(pos)
  if (!video) return false
  const quotes = []
  for (let i = 0; i < transcript.segments.length; i += 3) {
    const group = transcript.segments.slice(i, i + 3)
    const text = group.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim()
    if (!text) continue
    quotes.push(schema.nodes.quote!.create({ blockId: freshBlockId() }, schema.text(`[${clockTime(group[0]!.start)}] ${text}`)))
  }
  const tr = editor.state.tr.setNodeAttribute(pos, 'captions', transcript.vtt)
  // Setting an attribute keeps the node's size, so the position after it is unchanged.
  if (quotes.length) tr.insert(pos + video.nodeSize, Fragment.fromArray(quotes))
  editor.view.dispatch(tr)
  return true
}
