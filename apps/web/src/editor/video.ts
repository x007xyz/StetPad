import { t } from '../i18n'
import type { NodeViewRenderer } from '@tiptap/core'
import { embedPlayerUrl } from '@stetpad/clip'
import { applyTranscript, transcribeVideo } from './media'
import { ensurePoster } from './poster'

/** An uploaded file's url (`/files/<id>`). */
const FILE_SRC = /^\/files\/[\w-]+$/

/**
 * Whether a video block can be shown: an uploaded file for kind 'file', a page
 * link we have a player for for kind 'embed'. Anything else is dropped on parse.
 */
export function validVideo(kind: unknown, src: unknown): boolean {
  if (typeof src !== 'string' || !src) return false
  return kind === 'embed' ? embedPlayerUrl(src) !== null : FILE_SRC.test(src)
}

const EMBED_ALLOW = 'fullscreen; autoplay; picture-in-picture; encrypted-media'
const EMBED_SANDBOX = 'allow-scripts allow-same-origin allow-presentation allow-popups'

function errorBox(message: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'video-error'
  el.textContent = message
  return el
}

/**
 * A video block: an uploaded <video>, or an embedded player in a 16:9 box.
 * Mirrors the image node view: an editable caption, a `selected` class, and
 * the caption's own events kept away from ProseMirror.
 *
 * While editing, an embedded player or an uploaded <video> sits under a
 * transparent overlay with a play button, so a click selects the block instead
 * of landing in the iframe, and starts playback in the same click. The overlay
 * is removed while the block is selected, so the player's own controls work.
 *
 * `docId` is the document the video belongs to: the transcribe button and the
 * background poster frame need it. Without it, neither is offered.
 */
export function videoNodeView(docId: string, onError?: (text: string) => void): NodeViewRenderer {
  return ({ node, editor, getPos }) => {
    let current = node
    let selected = false
    let busy = false
    const dom = document.createElement('figure')
    dom.className = 'blk video-wrap'
    if (editor.isEditable) dom.classList.add('editable')
    const frame = document.createElement('div')
    frame.className = 'video-frame'
    const tools = document.createElement('div')
    tools.className = 'video-tools'
    const transcribeBtn = document.createElement('button')
    transcribeBtn.type = 'button'
    transcribeBtn.addEventListener('mousedown', (e) => e.preventDefault())
    transcribeBtn.addEventListener('click', (e) => {
      e.preventDefault()
      transcribe()
    })
    tools.appendChild(transcribeBtn)
    const cap = document.createElement('figcaption')
    dom.append(frame, tools, cap)

    /**
     * Starts playback for the block's player: an uploaded video plays directly;
     * an embed gets `autoplay=1` on its player url (reloads the iframe once).
     */
    const startPlayback = (): void => {
      const video = frame.querySelector('video')
      if (video) {
        video.play().catch(() => {})
        return
      }
      const iframe = frame.querySelector<HTMLIFrameElement>('.video-embed iframe')
      if (!iframe) return
      try {
        const url = new URL(iframe.src)
        if (url.searchParams.get('autoplay') === '1') return
        url.searchParams.set('autoplay', '1')
        iframe.src = url.toString()
      } catch {
        // An unparsable player url is left as it is.
      }
    }

    const syncOverlay = (): void => {
      const host = frame.querySelector('.video-embed, video')
      const overlay = frame.querySelector('.video-overlay')
      const wanted = host != null && editor.isEditable && !selected
      if (wanted && !overlay) {
        const o = document.createElement('div')
        o.className = 'video-overlay'
        o.contentEditable = 'false'
        o.title = t('播放')
        o.setAttribute('role', 'button')
        o.setAttribute('aria-label', t('播放'))
        o.innerHTML = '<span class="video-play"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="#fff"/></svg></span>'
        // mousedown, not click: the overlay goes away once the block is selected, which can happen before a click.
        o.addEventListener('mousedown', (e) => {
          if (e.button === 0) startPlayback()
        })
        frame.appendChild(o)
      } else if (!wanted && overlay) overlay.remove()
    }

    const paintTools = (): void => {
      const src = String(current.attrs.src ?? '')
      tools.hidden = !(editor.isEditable && docId && current.attrs.kind !== 'embed' && FILE_SRC.test(src))
      transcribeBtn.disabled = busy
      transcribeBtn.textContent = busy ? t('转写中…') : current.attrs.captions ? t('重新转写') : t('转写')
    }

    /** Transcribes the video: sets its subtitles and inserts the transcript after it. One at a time. */
    const transcribe = (): void => {
      const { blockId, src } = current.attrs as { blockId?: string | null; src?: string }
      if (busy || !editor.isEditable || !blockId || !src || !FILE_SRC.test(src)) return
      busy = true
      paintTools()
      transcribeVideo(docId, src)
        .then((transcript) => {
          if (!applyTranscript(editor, blockId, transcript)) onError?.('视频已不在文档里，字幕没有写入')
        })
        .catch((err: unknown) => onError?.(err instanceof Error ? err.message : '转写失败'))
        .finally(() => {
          busy = false
          paintTools()
        })
    }

    const paint = (): void => {
      const { src, kind, title, caption, blockId, poster, captions } = current.attrs as {
        src: string
        kind: string
        title: string
        caption: string
        blockId?: string | null
        poster?: string
        captions?: string
      }
      if (blockId) dom.setAttribute('data-block-id', String(blockId))
      else dom.removeAttribute('data-block-id')
      frame.replaceChildren(tools)
      const url = String(src ?? '')
      const label = String(title ?? '')
      if (kind === 'embed') {
        const player = embedPlayerUrl(url)
        if (!player) frame.appendChild(errorBox(t('[不支持的视频链接]')))
        else {
          const box = document.createElement('div')
          box.className = 'video-embed'
          const iframe = document.createElement('iframe')
          iframe.src = player
          iframe.title = label || t('视频')
          iframe.setAttribute('allow', EMBED_ALLOW)
          iframe.allowFullscreen = true
          iframe.referrerPolicy = 'strict-origin-when-cross-origin'
          iframe.setAttribute('sandbox', EMBED_SANDBOX)
          iframe.loading = 'lazy'
          box.appendChild(iframe)
          frame.appendChild(box)
        }
      } else if (FILE_SRC.test(url)) {
        const video = document.createElement('video')
        video.controls = true
        video.preload = 'metadata'
        video.playsInline = true
        video.src = url
        if (label) video.title = label
        if (poster && FILE_SRC.test(poster)) video.poster = poster
        if (captions && FILE_SRC.test(captions)) {
          const track = document.createElement('track')
          track.kind = 'subtitles'
          track.src = captions
          track.srclang = 'zh'
          track.label = t('字幕')
          track.default = true
          video.appendChild(track)
        }
        frame.appendChild(video)
        // A video without a poster frame gets one, in the background, while the document is being edited.
        if (editor.isEditable && docId && blockId && !poster) ensurePoster(editor, docId, String(blockId), url)
      } else frame.appendChild(errorBox(t('[无效的视频]')))
      syncOverlay()
      paintTools()
      // Leave the caption alone while the user is typing in it.
      if (document.activeElement !== cap) cap.textContent = String(caption ?? '')
      cap.hidden = !editor.isEditable && !caption
    }

    if (editor.isEditable) {
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
        const changed =
          a.src !== b.src || a.kind !== b.kind || a.title !== b.title || a.caption !== b.caption || a.blockId !== b.blockId || a.poster !== b.poster || a.captions !== b.captions
        current = next
        if (changed) paint()
        else paintTools()
        return true
      },
      selectNode() {
        selected = true
        dom.classList.add('selected')
        syncOverlay()
      },
      deselectNode() {
        selected = false
        dom.classList.remove('selected')
        syncOverlay()
      },
      stopEvent: (e) => {
        const t = e.target as HTMLElement | null
        if (t?.closest?.('figcaption, .video-tools')) return true
        // Once selected, the player's own controls get the events; before that a click selects the block.
        return selected && t?.closest?.('video, iframe') != null
      },
      ignoreMutation: () => true,
    }
  }
}
