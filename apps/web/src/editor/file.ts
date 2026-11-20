import { Node, type NodeViewRenderer } from '@tiptap/core'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { File, FileArchive, FileSpreadsheet, FileText, Presentation, type LucideIcon } from 'lucide-react'

/**
 * An attachment block: an uploaded office document, archive or text file, shown as a card
 * with a download link. PDFs also get a preview, in a sandboxed frame.
 */

/** An uploaded file's url (`/files/<id>`). */
const FILE_SRC = /^\/files\/[\w-]+$/

/** A byte count for people: 980 B, 1.5 KB, 12.3 MB. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 102.4) / 10} KB`
  if (bytes < 1024 ** 3) return `${Math.round((bytes / 1024 ** 2) * 10) / 10} MB`
  return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`
}

/** The icon for a MIME type; a plain file when nothing matches. */
export function fileIcon(mime: string): LucideIcon {
  if (mime === 'application/pdf' || mime === 'application/msword' || mime.endsWith('wordprocessingml.document') || mime === 'text/plain' || mime === 'text/markdown') return FileText
  if (mime.includes('zip')) return FileArchive
  if (mime.endsWith('spreadsheetml.sheet') || mime === 'application/vnd.ms-excel' || mime === 'text/csv') return FileSpreadsheet
  if (mime.endsWith('presentationml.presentation')) return Presentation
  return File
}

const iconMarkup = (Icon: LucideIcon): string => renderToStaticMarkup(createElement(Icon, { size: 22, strokeWidth: 1.75, 'aria-hidden': 'true' }))
/**
 * The card. The download link carries the file name. A PDF is previewed as page images the server renders
 * (`/files/<id>/pages/<n>`): browsers' PDF viewers do not run inside a sandboxed frame, and the PDF itself is
 * never shown unsandboxed under this origin.
 */
export const fileNodeView: NodeViewRenderer = ({ node }) => {
  let current = node
  const dom = document.createElement('div')
  dom.className = 'blk file-wrap'
  const card = document.createElement('div')
  card.className = 'file-card'
  const icon = document.createElement('span')
  icon.className = 'file-icon'
  const info = document.createElement('div')
  info.className = 'file-info'
  const nameEl = document.createElement('div')
  nameEl.className = 'file-name'
  const meta = document.createElement('div')
  meta.className = 'file-meta'
  info.append(nameEl, meta)
  const actions = document.createElement('div')
  actions.className = 'file-actions'
  const preview = document.createElement('button')
  preview.type = 'button'
  preview.className = 'file-preview-toggle'
  preview.textContent = '预览'
  const download = document.createElement('a')
  download.className = 'file-download'
  download.textContent = '下载'
  actions.append(preview, download)
  card.append(icon, info, actions)
  const frameBox = document.createElement('div')
  frameBox.className = 'file-preview'
  frameBox.hidden = true
  dom.append(card, frameBox)

  let open = false
  let shownSrc = ''
  let page = 1
  let pages = 0

  /** The page viewer: one page image, with previous / next and the page number. */
  const showPage = (src: string): void => {
    const img = document.createElement('img')
    img.className = 'file-page'
    img.alt = `第 ${page} 页`
    img.src = `${src}/pages/${page}`
    const bar = document.createElement('div')
    bar.className = 'file-pager'
    const prev = document.createElement('button')
    prev.type = 'button'
    prev.textContent = '上一页'
    prev.disabled = page <= 1
    const label = document.createElement('span')
    label.textContent = pages ? `${page} / ${pages}` : `${page}`
    const next = document.createElement('button')
    next.type = 'button'
    next.textContent = '下一页'
    next.disabled = pages > 0 && page >= pages
    prev.addEventListener('click', (e) => {
      e.preventDefault()
      page = Math.max(1, page - 1)
      showPage(src)
    })
    next.addEventListener('click', (e) => {
      e.preventDefault()
      page = pages ? Math.min(pages, page + 1) : page + 1
      showPage(src)
    })
    bar.append(prev, label, next)
    frameBox.replaceChildren(img, bar)
  }

  const paint = (): void => {
    const { src, name, mime, size, blockId } = current.attrs as { src: string; name: string; mime: string; size: number; blockId?: string | null }
    if (blockId) dom.setAttribute('data-block-id', String(blockId))
    else dom.removeAttribute('data-block-id')
    const safe = FILE_SRC.test(String(src ?? ''))
    const isPdf = mime === 'application/pdf' && safe
    icon.innerHTML = iconMarkup(fileIcon(String(mime ?? '')))
    nameEl.textContent = String(name || '附件')
    meta.textContent = [Number(size) > 0 ? humanSize(Number(size)) : '', String(mime ?? '')].filter(Boolean).join(' · ')
    if (safe) download.setAttribute('href', String(src))
    else download.removeAttribute('href')
    download.setAttribute('download', String(name || ''))
    preview.hidden = !isPdf
    if (!isPdf) open = false
    preview.textContent = open ? '收起预览' : '预览'
    if (isPdf && open) {
      if (shownSrc !== src) {
        shownSrc = String(src)
        page = 1
        pages = 0
        showPage(shownSrc)
        void fetch(`${shownSrc}/pages`)
          .then((r) => (r.ok ? (r.json() as Promise<{ pages: number }>) : null))
          .then((j) => {
            if (j && shownSrc === src) {
              pages = j.pages
              showPage(shownSrc)
            }
          })
          .catch(() => undefined)
      }
      frameBox.hidden = false
    } else {
      shownSrc = ''
      frameBox.replaceChildren()
      frameBox.hidden = true
    }
  }

  preview.addEventListener('click', (e) => {
    e.preventDefault()
    open = !open
    paint()
  })
  paint()
  return {
    dom,
    update(next) {
      if (next.type !== current.type) return false
      current = next
      paint()
      return true
    },
    selectNode() {
      dom.classList.add('selected')
    },
    deselectNode() {
      dom.classList.remove('selected')
    },
    // Links, the preview toggle and the frame keep their own events.
    stopEvent: (e) => {
      const t = e.target as HTMLElement | null
      return t?.closest?.('a, button, .file-preview') != null
    },
    ignoreMutation: () => true,
  }
}

/**
 * The attachment block. `src` is the upload, `name`, `mime` and `size` describe it.
 * An attachment without an uploaded file is dropped on parse.
 */
export const FileBlock = Node.create({
  name: 'file',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes: () => ({
    src: { default: '' },
    name: { default: '' },
    mime: { default: '' },
    size: { default: 0 },
  }),
  parseHTML: () => [
    {
      tag: 'div.blk.file-block[data-src]',
      getAttrs: (el: HTMLElement) => {
        const src = el.getAttribute('data-src') ?? ''
        if (!FILE_SRC.test(src)) return false
        return { src, name: el.getAttribute('data-name') ?? '', mime: el.getAttribute('data-mime') ?? '', size: Number(el.getAttribute('data-size')) || 0 }
      },
    },
  ],
  renderHTML({ node }) {
    const src = String(node.attrs.src ?? '')
    const name = String(node.attrs.name ?? '')
    const safe = FILE_SRC.test(src) ? src : ''
    return ['div', { class: 'blk file-block', 'data-src': safe, 'data-name': name, 'data-mime': String(node.attrs.mime ?? ''), 'data-size': String(node.attrs.size ?? 0) }, ['a', { href: safe, download: name }, name || '附件']]
  },
  addNodeView() {
    return fileNodeView
  },
})
