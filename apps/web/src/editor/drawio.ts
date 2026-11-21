import { getLang, t } from '../i18n'
import type { Editor, NodeViewRenderer } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { api, getToken } from '../api'

/**
 * draw.io blocks: the node view, the bridge to the draw.io embed (JSON
 * postMessage protocol), and a hidden renderer that makes the PNG preview.
 */

/** Window event the node view fires; DocPage opens DrawioEditor for `detail.blockId`. */
export const DRAWIO_EDIT_EVENT = 'stetpad:drawio-edit'
/** Only our own `/files/<id>` urls may be shown as a preview. */
export const DRAWIO_PREVIEW = /^\/files\/[\w-]+$/
const DEFAULT_BASE = 'https://embed.diagrams.net'

let baseCache: Promise<string> | null = null

/** The draw.io embed base url from the server's public config. Fetched once; the default on failure. */
export function drawioBaseUrl(): Promise<string> {
  baseCache ??= api<{ drawioUrl?: string }>('/config')
    .then((c) => {
      const raw = (c.drawioUrl ?? '').trim()
      if (!raw) return DEFAULT_BASE
      const u = new URL(raw)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return DEFAULT_BASE
      return u.origin + u.pathname.replace(/\/+$/, '')
    })
    .catch(() => {
      // Not cached: the next use asks again.
      baseCache = null
      return DEFAULT_BASE
    })
  return baseCache
}

export function drawioEditorUrl(base: string): string {
  return `${base}/?embed=1&proto=json&spin=1&ui=min&lang=${getLang()}&saveAndExit=1&noExitBtn=0`
}

/** The protocol's messages are JSON strings. Anything else is ignored. */
export function parseDrawioMessage(data: unknown): Record<string, unknown> | null {
  if (typeof data !== 'string') return null
  try {
    const m = JSON.parse(data) as unknown
    return m && typeof m === 'object' ? (m as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Uploads a `data:image/png;base64,...` url as an asset of the doc and returns its `/files/<id>` url. */
export async function uploadPng(docId: string, dataUrl: string): Promise<string> {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl)
  if (!m) throw new Error('draw.io 没有返回有效的 PNG')
  const bin = atob(m[1]!.replace(/\s/g, ''))
  const bytes = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const res = await fetch(`/api/docs/${docId}/assets`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'x-file-name': 'diagram.png', authorization: `Bearer ${getToken()}` },
    body: bytes,
  })
  const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null
  if (!res.ok || !body?.url) throw new Error(body?.error || `图片上传失败（${res.status}）`)
  return body.url
}

/** A top-level block by its blockId, with its position. */
export function findTopBlock(doc: PMNode, blockId: string): { pos: number; node: PMNode } | null {
  let pos = 0
  for (let i = 0; i < doc.childCount; i++) {
    const node = doc.child(i)
    if (node.attrs.blockId === blockId) return { pos, node }
    pos += node.nodeSize
  }
  return null
}

/** Saves new XML and its preview in one transaction. False if the block is gone. */
export function commitDrawio(editor: Editor, blockId: string, xml: string, preview: string): boolean {
  if (editor.isDestroyed) return false
  const found = findTopBlock(editor.state.doc, blockId)
  if (!found || found.node.type.name !== 'drawio') return false
  const tr = editor.state.tr.setNodeAttribute(found.pos, 'xml', xml).setNodeAttribute(found.pos, 'preview', preview)
  editor.view.dispatch(tr)
  return true
}

/** Sets only the preview, and only while the block still holds the XML it was rendered from. */
function setDrawioPreview(editor: Editor, blockId: string, xml: string, preview: string): boolean {
  if (editor.isDestroyed) return false
  const found = findTopBlock(editor.state.doc, blockId)
  if (!found || found.node.type.name !== 'drawio' || found.node.attrs.xml !== xml) return false
  editor.view.dispatch(editor.state.tr.setNodeAttribute(found.pos, 'preview', preview))
  return true
}

// --- hidden renderer

let renderQueue: Promise<unknown> = Promise.resolve()
/** Block + XML pairs already sent to the renderer this page load: one attempt each, so a failure is not retried in a loop. */
const attempted = new Set<string>()

/**
 * Draws the XML in an offscreen draw.io editor and uploads the PNG (the diagram
 * is embedded in it). One render at a time; rejects after 30 s.
 */
export function renderDrawioPreview(docId: string, xml: string): Promise<string> {
  const job = renderQueue.then(() => renderOnce(docId, xml))
  renderQueue = job.catch(() => undefined)
  return job
}

async function renderOnce(docId: string, xml: string): Promise<string> {
  const base = await drawioBaseUrl()
  const origin = new URL(base).origin
  return new Promise<string>((resolve, reject) => {
    const frame = document.createElement('iframe')
    frame.tabIndex = -1
    frame.setAttribute('aria-hidden', 'true')
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:900px;border:0'
    let sentLoad = false
    let settled = false
    const send = (msg: Record<string, unknown>): void => {
      frame.contentWindow?.postMessage(JSON.stringify(msg), origin)
    }
    const finish = (err: Error | null, url?: string): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      frame.remove()
      if (err) reject(err)
      else resolve(url ?? '')
    }
    const timer = window.setTimeout(() => finish(new Error('draw.io 预览生成超时')), 30_000)
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== frame.contentWindow || e.origin !== origin) return
      const msg = parseDrawioMessage(e.data)
      if (!msg) return
      if (msg.event === 'init' && !sentLoad) {
        sentLoad = true
        send({ action: 'load', xml, autosave: 0 })
        send({ action: 'export', format: 'xmlpng', scale: 2, border: 10 })
      } else if (msg.event === 'export' && typeof msg.data === 'string') {
        uploadPng(docId, msg.data).then(
          (url) => finish(null, url),
          (err: unknown) => finish(err instanceof Error ? err : new Error(String(err))),
        )
      }
    }
    window.addEventListener('message', onMessage)
    frame.src = drawioEditorUrl(base)
    document.body.appendChild(frame)
  })
}

// --- node view

/**
 * A draw.io block: the preview image, or a placeholder. Mirrors the image node
 * view: an editable caption, a `selected` class, and events on the caption and
 * the edit button kept away from ProseMirror.
 */
export function drawioNodeView(docId: string): NodeViewRenderer {
  return ({ node, editor, getPos }) => {
    let current = node
    /** Shown in place of the spinner after a failed render. */
    let note = ''
    const dom = document.createElement('figure')
    dom.className = 'blk drawio-wrap'
    if (editor.isEditable) dom.classList.add('editable')
    const frame = document.createElement('div')
    frame.className = 'drawio-frame'
    const cap = document.createElement('figcaption')
    dom.append(frame, cap)

    const openEditor = (): void => {
      const id = current.attrs.blockId as string | null | undefined
      if (!id || !editor.isEditable) return
      window.dispatchEvent(new CustomEvent(DRAWIO_EDIT_EVENT, { detail: { blockId: id } }))
    }

    const renderPreview = (): void => {
      if (!editor.isEditable) return
      const { xml, blockId } = current.attrs as { xml: string; blockId?: string | null }
      const source = String(xml ?? '')
      const key = `${blockId}\u0000${source}`
      if (!source || !blockId || attempted.has(key)) return
      attempted.add(key)
      const id = String(blockId)
      renderDrawioPreview(docId, source).then(
        (url) => {
          setDrawioPreview(editor, id, source, url)
        },
        () => {
          if (String(current.attrs.xml ?? '') !== source) return
          note = t('预览生成失败，请编辑后保存')
          paint()
        },
      )
    }

    const paint = (): void => {
      const { xml, preview, caption, blockId } = current.attrs as { xml: string; preview: string; caption: string; blockId?: string | null }
      if (blockId) dom.setAttribute('data-block-id', String(blockId))
      else dom.removeAttribute('data-block-id')
      frame.replaceChildren()
      const url = String(preview ?? '')
      const source = String(xml ?? '')
      if (DRAWIO_PREVIEW.test(url)) {
        const img = document.createElement('img')
        img.className = 'drawio-img'
        img.alt = t('draw.io 图')
        img.draggable = false
        img.src = url
        frame.appendChild(img)
      } else if (source) {
        const status = document.createElement('div')
        status.className = 'drawio-status'
        status.textContent = note || t('正在生成预览…')
        frame.appendChild(status)
        renderPreview()
      } else {
        const empty = document.createElement('div')
        empty.className = 'drawio-empty'
        empty.textContent = editor.isEditable ? t('空白 draw.io 图 · 双击编辑') : t('空白 draw.io 图')
        frame.appendChild(empty)
      }
      // Leave the caption alone while the user is typing in it.
      if (document.activeElement !== cap) cap.textContent = String(caption ?? '')
      cap.hidden = !editor.isEditable && !caption
    }

    if (editor.isEditable) {
      frame.addEventListener('dblclick', openEditor)
      const edit = document.createElement('button')
      edit.type = 'button'
      edit.className = 'drawio-edit'
      edit.contentEditable = 'false'
      edit.textContent = t('编辑')
      edit.addEventListener('mousedown', (e) => e.preventDefault())
      edit.addEventListener('click', (e) => {
        e.preventDefault()
        openEditor()
      })
      dom.appendChild(edit)
      cap.contentEditable = 'plaintext-only'
      cap.dataset.placeholder = t('添加图注')
      cap.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault()
          cap.blur()
        }
      })
      cap.addEventListener('blur', () => {
        const pos = getPos()
        if (typeof pos !== 'number' || !editor.isEditable) return
        const text = (cap.textContent ?? '').replace(/\s+/g, ' ').trim()
        if (text !== String(current.attrs.caption ?? '')) editor.view.dispatch(editor.view.state.tr.setNodeAttribute(pos, 'caption', text))
      })
    }
    paint()

    return {
      dom,
      update(next) {
        if (next.type !== current.type) return false
        const a = current.attrs
        const b = next.attrs
        const changed = a.xml !== b.xml || a.preview !== b.preview || a.caption !== b.caption || a.blockId !== b.blockId
        if (a.xml !== b.xml) note = ''
        current = next
        if (changed) paint()
        return true
      },
      selectNode() {
        dom.classList.add('selected')
      },
      deselectNode() {
        dom.classList.remove('selected')
      },
      stopEvent: (e) => {
        const t = e.target as HTMLElement | null
        return t?.closest?.('figcaption, .drawio-edit') != null
      },
      ignoreMutation: () => true,
    }
  }
}
