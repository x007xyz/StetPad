import { t } from '../i18n'
import { Extension, Node, mergeAttributes, textblockTypeInputRule } from '@tiptap/core'
import { DOMSerializer } from '@tiptap/pm/model'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import { AI_DIAGRAM_NEW_EVENT, codeBlockView, diagramEditingPlugin, type AiDiagramNewRequest } from './diagram'
import { DRAWIO_PREVIEW, drawioNodeView } from './drawio'
import { describeImage, freshBlockId, IMAGE_ACTION_EVENT, type ImageAction } from './media'
import { validVideo, videoNodeView } from './video'

/**
 * The document schema: a flat list of blocks, the way Notion and Feishu
 * model a page. A list item is a block with an indent, not a nested list.
 */

export const TEXT_BLOCKS = ['paragraph', 'heading', 'bulletItem', 'orderedItem', 'taskItem', 'quote', 'callout', 'codeBlock']
export const ALL_BLOCKS = [...TEXT_BLOCKS, 'divider', 'image', 'table', 'video', 'drawio', 'file', 'linkCard']
const LIST = ['bulletItem', 'orderedItem', 'taskItem']
const INDENTABLE = [...LIST, 'paragraph']

const indentAttr = {
  indent: {
    default: 0,
    parseHTML: (el: HTMLElement) => {
      const d = el.getAttribute('data-indent')
      if (d !== null) return Number(d)
      // A pasted nested list: depth is the number of enclosing lists, minus one.
      let n = 0
      for (let p = el.parentElement; p; p = p.parentElement) if (p.tagName === 'UL' || p.tagName === 'OL') n++
      return Math.min(Math.max(0, n - 1), 6)
    },
    renderHTML: (a: { indent?: number }) => (a.indent ? { 'data-indent': a.indent } : {}),
  },
}

const textBlock = (name: string, cls: string, extra: Partial<Parameters<typeof Node.create>[0]> = {}) =>
  Node.create({
    name,
    group: 'block',
    content: 'inline*',
    defining: true,
    parseHTML: () => [{ tag: `div.${cls}` }],
    renderHTML({ HTMLAttributes }) {
      return ['div', mergeAttributes(HTMLAttributes, { class: `blk ${cls}` }), 0]
    },
    ...extra,
  })

export const BulletItem = textBlock('bulletItem', 'bullet', {
  addAttributes: () => indentAttr,
  // Pasted lists from other apps.
  parseHTML: () => [{ tag: 'div.bullet' }, { tag: 'ul > li' }],
  addInputRules() {
    return [textblockTypeInputRule({ find: /^\s*[-*]\s$/, type: this.type })]
  },
})
export const OrderedItem = textBlock('orderedItem', 'ordered', {
  addAttributes: () => indentAttr,
  parseHTML: () => [{ tag: 'div.ordered' }, { tag: 'ol > li' }],
  addInputRules() {
    return [textblockTypeInputRule({ find: /^\s*\d+[.)]\s$/, type: this.type })]
  },
})
let taskTextIds = 0
export const TaskItem = Node.create({
  name: 'taskItem',
  group: 'block',
  content: 'inline*',
  defining: true,
  addAttributes: () => ({
    ...indentAttr,
    checked: {
      default: false,
      parseHTML: (el: HTMLElement) => el.getAttribute('data-checked') === 'true',
      renderHTML: (a: { checked?: boolean }) => ({ 'data-checked': a.checked ? 'true' : 'false' }),
    },
  }),
  parseHTML: () => [{ tag: 'div.task' }],
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'blk task' }), ['span', { class: 'task-box', contenteditable: 'false', role: 'checkbox', 'aria-checked': HTMLAttributes['data-checked'], tabindex: 0 }], ['div', { class: 'task-text' }, 0]]
  },
  addInputRules() {
    return [textblockTypeInputRule({ find: /^\s*\[\s?\]\s$/, type: this.type })]
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const { dom, contentDOM } = DOMSerializer.renderSpec(document, node.type.spec.toDOM!(node))
      const element = dom as HTMLElement
      const box = element.querySelector<HTMLElement>('.task-box')!
      const textId = `task-text-${++taskTextIds}`
      ;(contentDOM as HTMLElement).id = textId
      box.setAttribute('aria-labelledby', textId)
      const toggle = () => {
        const pos = getPos()
        if (typeof pos !== 'number' || !editor.isEditable) return
        const current = editor.state.doc.nodeAt(pos)
        if (current) editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'checked', !current.attrs.checked))
      }
      box.addEventListener('click', toggle)
      box.addEventListener('keydown', (event) => {
        if (event.key !== ' ' && event.key !== 'Enter') return
        event.preventDefault()
        if (!event.repeat) toggle()
      })
      return {
        dom: element,
        contentDOM,
        stopEvent: (event) => event.target === box,
        ignoreMutation: (mutation) => mutation.type !== 'selection' && !contentDOM?.contains(mutation.target),
        update(updated) {
          if (updated.type !== node.type) return false
          if (updated.attrs.blockId) element.setAttribute('data-block-id', String(updated.attrs.blockId))
          else element.removeAttribute('data-block-id')
          element.setAttribute('data-checked', String(updated.attrs.checked))
          if (updated.attrs.indent) element.setAttribute('data-indent', String(updated.attrs.indent))
          else element.removeAttribute('data-indent')
          box.setAttribute('aria-checked', String(updated.attrs.checked))
          return true
        },
      }
    }
  },
})
export const Quote = textBlock('quote', 'quote', {
  addInputRules() {
    return [textblockTypeInputRule({ find: /^\s*>\s$/, type: this.type })]
  },
})
export const Callout = textBlock('callout', 'callout')
export const CodeBlock = Node.create({
  name: 'codeBlock',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  addAttributes() {
    return {
      // '' for plain code; 'mermaid' and 'math' get a rendered preview (see diagram.ts).
      language: {
        default: '',
        parseHTML: (el: HTMLElement) =>
          el.getAttribute('data-language') ?? el.querySelector('code')?.className.match(/language-([\w-]+)/)?.[1] ?? '',
        renderHTML: (attrs: { language?: string }) => (attrs.language ? { 'data-language': attrs.language } : {}),
      },
    }
  },
  parseHTML: () => [{ tag: 'pre', preserveWhitespace: 'full' as const }],
  renderHTML({ HTMLAttributes }) {
    return ['pre', mergeAttributes(HTMLAttributes, { class: 'blk code' }), ['code', 0]]
  },
  addNodeView() {
    return codeBlockView
  },
  addProseMirrorPlugins() {
    return [diagramEditingPlugin]
  },
  addInputRules() {
    return [
      textblockTypeInputRule({ find: /^```([\w-]*)\s$/, type: this.type, getAttributes: (match) => ({ language: match[1] ?? '' }) }),
      textblockTypeInputRule({ find: /^\$\$\s$/, type: this.type, getAttributes: () => ({ language: 'math' }) }),
    ]
  },
})
export const Divider = Node.create({
  name: 'divider',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: 'hr' }],
  renderHTML({ HTMLAttributes }) {
    return ['hr', mergeAttributes(HTMLAttributes, { class: 'blk divider' })]
  },
})
/** Only web, data-image and our own `/files/<id>` urls are allowed into the DOM. */
const safeSrc = (src: string): boolean => /^https?:/i.test(src) || /^data:image\//i.test(src) || /^\/files\/[\w-]+$/.test(src)
const clampWidth = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.min(100, Math.max(10, Math.round(n))) : 100)

export const Image = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  // The document the image belongs to; the AI buttons need it.
  addOptions: () => ({ docId: '' }),
  addAttributes: () => ({
    src: { default: '' },
    alt: { default: '' },
    caption: {
      default: '',
      // From a figure's figcaption; a bare img has none.
      parseHTML: (el: HTMLElement) => el.querySelector('figcaption')?.textContent?.trim() ?? '',
    },
    // Percent of the content column.
    width: {
      default: 100,
      parseHTML: (el: HTMLElement) => clampWidth(Number(el.getAttribute('data-width'))),
    },
  }),
  parseHTML: () => [{ tag: 'figure:has(img)' }, { tag: 'img[src]' }],
  renderHTML({ node }) {
    const src = String(node.attrs.src ?? '')
    const alt = String(node.attrs.alt ?? '')
    const caption = String(node.attrs.caption ?? '')
    const figure: Record<string, string> = { class: 'blk image', 'data-width': String(clampWidth(Number(node.attrs.width))) }
    if (node.attrs.blockId) figure['data-block-id'] = String(node.attrs.blockId)
    const img = ['img', { src: safeSrc(src) ? src : '', alt }] as const
    return caption ? ['figure', figure, img, ['figcaption', {}, caption]] : ['figure', figure, img]
  },
  /**
   * An image with an optional caption and a handle on its right edge. The
   * handle changes the width live and commits once on mouseup; the caption
   * commits on blur or Enter. Both are typed in place, so events there stay
   * with the node.
   */
  addNodeView() {
    const docId = this.options.docId
    return ({ node, editor, getPos }) => {
      let current = node
      const dom = document.createElement('figure')
      dom.className = 'blk image-wrap'
      if (editor.isEditable) dom.classList.add('editable')
      const frame = document.createElement('div')
      frame.className = 'image-frame'
      const img = document.createElement('img')
      img.draggable = false
      frame.appendChild(img)
      const cap = document.createElement('figcaption')
      dom.append(frame, cap)

      const widthOf = (): number => clampWidth(Number(current.attrs.width))
      const paint = (): void => {
        const { src, alt, caption, blockId } = current.attrs as { src: string; alt: string; caption: string; blockId?: string | null }
        if (blockId) dom.setAttribute('data-block-id', String(blockId))
        else dom.removeAttribute('data-block-id')
        if (safeSrc(String(src ?? ''))) img.setAttribute('src', String(src))
        else img.removeAttribute('src')
        img.alt = String(alt ?? '')
        img.title = String(alt ?? '')
        frame.style.width = widthOf() + '%'
        // Leave the caption alone while the user is typing in it.
        if (document.activeElement !== cap) cap.textContent = String(caption ?? '')
        cap.hidden = !editor.isEditable && !caption
      }

      if (editor.isEditable) {
        // Buttons on hover or selection: describe with AI, crop or edit with AI. A click never reaches the editor.
        const tools = document.createElement('div')
        tools.className = 'image-tools'
        tools.contentEditable = 'false'
        const button = (label: string, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement => {
          const b = document.createElement('button')
          b.type = 'button'
          b.textContent = t(label)
          b.addEventListener('mousedown', (e) => e.preventDefault())
          b.addEventListener('click', (e) => {
            e.preventDefault()
            onClick(b)
          })
          return b
        }
        const describeBtn = button('AI 描述', (b) => {
          const src = String(current.attrs.src ?? '')
          if (!docId || !src) return
          b.disabled = true
          b.textContent = t('描述中…')
          describeImage(docId, src)
            .then((alt) => {
              const pos = getPos()
              if (typeof pos === 'number' && alt && editor.isEditable && String(current.attrs.src ?? '') === src) {
                editor.view.dispatch(editor.view.state.tr.setNodeAttribute(pos, 'alt', alt))
              }
            })
            .catch((e: unknown) => alert(e instanceof Error ? e.message : '描述失败'))
            .finally(() => {
              b.disabled = false
              b.textContent = t('AI 描述')
            })
        })
        describeBtn.hidden = !docId
        const actionBtn = (label: string, action: ImageAction): HTMLButtonElement =>
          button(label, () => {
            const pos = getPos()
            const src = String(current.attrs.src ?? '')
            if (typeof pos !== 'number' || !src) return
            // Images inserted by an older path may have no block id yet; the dialogs find the image by it.
            let blockId = current.attrs.blockId as string | null | undefined
            if (!blockId) {
              blockId = freshBlockId()
              editor.view.dispatch(editor.view.state.tr.setNodeAttribute(pos, 'blockId', blockId))
            }
            window.dispatchEvent(new CustomEvent(IMAGE_ACTION_EVENT, { detail: { blockId, src, action } }))
          })
        tools.append(describeBtn, actionBtn('编辑', 'crop'), actionBtn('AI 改图', 'ai-edit'))
        frame.appendChild(tools)

        // Read-only views show the caption as plain text.
        cap.contentEditable = 'plaintext-only'
        cap.dataset.placeholder = t('添加图注')
        const handle = document.createElement('div')
        handle.className = 'image-handle'
        handle.contentEditable = 'false'
        frame.appendChild(handle)
        handle.addEventListener('mousedown', (e) => {
          e.preventDefault()
          const parentWidth = dom.parentElement?.getBoundingClientRect().width || 1
          const startX = e.clientX
          const startW = widthOf()
          let next = startW
          dom.classList.add('resizing')
          const move = (ev: MouseEvent): void => {
            next = clampWidth(startW + ((ev.clientX - startX) / parentWidth) * 100)
            frame.style.width = next + '%'
          }
          const up = (): void => {
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
            dom.classList.remove('resizing')
            frame.style.width = widthOf() + '%'
            const pos = getPos()
            if (typeof pos === 'number' && editor.isEditable && next !== widthOf()) {
              editor.view.dispatch(editor.view.state.tr.setNodeAttribute(pos, 'width', next))
            }
          }
          window.addEventListener('mousemove', move)
          window.addEventListener('mouseup', up)
        })
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
          const changed = a.src !== b.src || a.alt !== b.alt || a.caption !== b.caption || a.width !== b.width || a.blockId !== b.blockId
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
          return t?.closest?.('figcaption, .image-handle, .image-tools') != null
        },
        ignoreMutation: () => true,
      }
    }
  },
})
/** A table as a Markdown table: the first row is the header. Pipes and line breaks in cells are escaped or flattened. */
export function tableMarkdown(rows: string[][]): string {
  const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
  const width = Math.max(1, ...rows.map((r) => r.length))
  const line = (r: string[]): string => `| ${Array.from({ length: width }, (_, j) => cell(r[j] ?? '')).join(' | ')} |`
  const [head = [], ...body] = rows
  return [line(head), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(line)].join('\n')
}

/** The prompt of a table's "生成图表" button. */
const TABLE_CHART_PROMPT = '根据这张表格的数据画一张合适的图表（柱状图或折线图用 xychart-beta，占比用 pie），标题用表格的主题'

export const Table = Node.create({
  name: 'table',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes: () => ({
    rows: {
      default: '[["",""],["",""]]',
      // From our own copies (data-rows) or from a table pasted from elsewhere.
      parseHTML: (el: HTMLElement) => {
        const own = el.getAttribute('data-rows')
        if (own) return own
        const grid = [...el.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim()))
        const width = Math.max(0, ...grid.map((r) => r.length))
        if (!grid.length || !width) return '[["",""],["",""]]'
        return JSON.stringify(grid.slice(0, 200).map((r) => Array.from({ length: Math.min(width, 20) }, (_, i) => r[i] ?? '')))
      },
      renderHTML: (a: { rows?: string }) => ({ 'data-rows': a.rows }),
    },
  }),
  parseHTML: () => [{ tag: 'table' }],
  renderHTML({ HTMLAttributes }) {
    const { rows: _r, ...rest } = HTMLAttributes
    return ['table', mergeAttributes(rest, { class: 'blk table' })]
  },
  /**
   * A simple table: cell text lives in the node's `rows` attribute. Cells are
   * edited in place; each edit writes the whole grid back as one change.
   */
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node
      const dom = document.createElement('div')
      dom.className = 'blk table-wrap'
      const parse = (): string[][] => {
        try {
          const r = JSON.parse(String(current.attrs.rows)) as string[][]
          return r.length ? r : [['']]
        } catch {
          return [['']]
        }
      }
      const commit = (rows: string[][]): void => {
        const pos = getPos()
        if (typeof pos !== 'number' || !editor.isEditable) return
        const next = JSON.stringify(rows)
        if (next !== current.attrs.rows) editor.view.dispatch(editor.view.state.tr.setNodeAttribute(pos, 'rows', next))
      }
      const render = (): void => {
        const rows = parse()
        const focus = document.activeElement instanceof HTMLElement && dom.contains(document.activeElement) ? document.activeElement.dataset.cell : undefined
        dom.replaceChildren()
        if (current.attrs.blockId) dom.setAttribute('data-block-id', String(current.attrs.blockId))
        const table = document.createElement('table')
        table.className = 'table'
        rows.forEach((r, i) => {
          const tr = table.insertRow()
          r.forEach((cell, j) => {
            const td = document.createElement(i === 0 ? 'th' : 'td')
            td.textContent = cell
            td.contentEditable = editor.isEditable ? 'plaintext-only' : 'false'
            td.dataset.cell = `${i}:${j}`
            td.addEventListener('blur', () => {
              const now = parse()
              if (now[i] && now[i]![j] !== td.textContent) {
                now[i]![j] = td.textContent ?? ''
                commit(now)
              }
            })
            tr.appendChild(td)
          })
        })
        dom.appendChild(table)
        if (editor.isEditable) {
          const bar = document.createElement('div')
          bar.className = 'table-bar'
          bar.contentEditable = 'false'
          const button = (label: string, fn: (rows: string[][]) => string[][]): void => {
            const b = document.createElement('button')
            b.type = 'button'
            b.textContent = t(label)
            b.addEventListener('mousedown', (e) => e.preventDefault())
            b.addEventListener('click', () => commit(fn(parse())))
            bar.appendChild(b)
          }
          button('+ 行', (r) => [...r, r[0]!.map(() => '')])
          button('+ 列', (r) => r.map((row) => [...row, '']))
          button('− 行', (r) => (r.length > 1 ? r.slice(0, -1) : r))
          button('− 列', (r) => (r[0]!.length > 1 ? r.map((row) => row.slice(0, -1)) : r))
          const chart = document.createElement('button')
          chart.type = 'button'
          chart.textContent = t('生成图表')
          chart.addEventListener('mousedown', (e) => e.preventDefault())
          chart.addEventListener('click', () => {
            const detail: AiDiagramNewRequest = { kind: 'mermaid', prompt: TABLE_CHART_PROMPT, context: tableMarkdown(parse()) }
            if (current.attrs.blockId) detail.afterBlockId = String(current.attrs.blockId)
            window.dispatchEvent(new CustomEvent(AI_DIAGRAM_NEW_EVENT, { detail }))
          })
          bar.appendChild(chart)
          dom.appendChild(bar)
        }
        if (focus) dom.querySelector<HTMLElement>(`[data-cell="${focus}"]`)?.focus()
      }
      render()
      return {
        dom,
        update(next) {
          if (next.type !== current.type) return false
          const changed = next.attrs.rows !== current.attrs.rows || next.attrs.blockId !== current.attrs.blockId
          current = next
          if (changed) render()
          return true
        },
        // Typing in a cell is the table's business, not the editor's.
        stopEvent: (e) => (e.target as HTMLElement).closest?.('td, th, .table-bar') != null,
        ignoreMutation: () => true,
      }
    }
  },
})

/**
 * An imported video, not edited here: `kind` 'file' is an uploaded `/files/<id>`,
 * 'embed' is the original B 站 / YouTube / Vimeo page URL. Only the node view
 * knows how to turn either into a player (see video.ts).
 */
export const Video = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  // The document the video belongs to; the transcribe button and the poster frame need it.
  addOptions: () => ({ docId: '' }),
  addAttributes: () => ({
    src: { default: '' },
    kind: { default: 'file' },
    title: { default: '' },
    caption: { default: '' },
    // A JPEG of the document's files: the frame shown before the video plays.
    poster: { default: '' },
    // WebVTT subtitles of the document's files, from transcription.
    captions: { default: '' },
  }),
  parseHTML: () => [
    {
      tag: 'figure.blk.video[data-src]',
      getAttrs: (el: HTMLElement) => {
        const src = el.getAttribute('data-src') ?? ''
        const kind = el.getAttribute('data-kind') === 'embed' ? 'embed' : 'file'
        if (!validVideo(kind, src)) return false
        return {
          src,
          kind,
          title: el.querySelector('video, iframe')?.getAttribute('title') ?? '',
          caption: el.querySelector('figcaption')?.textContent?.trim() ?? '',
        }
      },
    },
  ],
  renderHTML({ node }) {
    const src = String(node.attrs.src ?? '')
    const kind = node.attrs.kind === 'embed' ? 'embed' : 'file'
    const title = String(node.attrs.title ?? '')
    const caption = String(node.attrs.caption ?? '')
    const figure: Record<string, string> = { class: 'blk video', 'data-kind': kind, 'data-src': validVideo(kind, src) ? src : '' }
    if (node.attrs.blockId) figure['data-block-id'] = String(node.attrs.blockId)
    // The copy carries the page link; the player is rebuilt from it.
    const poster = String(node.attrs.poster ?? '')
    const media =
      kind === 'embed'
        ? ['iframe', { src: '', title, allowfullscreen: 'true', loading: 'lazy' }]
        : ['video', { src: '', controls: 'true', preload: 'metadata', playsinline: 'true', title, ...(FILE_SRC_RE.test(poster) ? { poster } : {}) }]
    return caption ? ['figure', figure, media, ['figcaption', {}, caption]] : ['figure', figure, media]
  },
  addNodeView() {
    return videoNodeView(this.options.docId)
  },
})

const FILE_SRC_RE = /^\/files\/[\w-]+$/

/** The XML must be an mxGraphModel or an mxfile; anything else is dropped on parse. */
const drawioXml = (s: string): string => (/<mx(GraphModel|file)[\s>]/.test(s) ? s : '')

/**
 * A draw.io diagram. `xml` is the source the draw.io editor loads; `preview` is
 * a PNG of it (`/files/<id>`), drawn by the hidden renderer in drawio.ts.
 */
export const Drawio = Node.create({
  name: 'drawio',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addOptions: () => ({ docId: '' }),
  addAttributes: () => ({
    xml: {
      default: '',
      parseHTML: (el: HTMLElement) => drawioXml(el.getAttribute('data-xml') ?? ''),
    },
    preview: {
      default: '',
      parseHTML: (el: HTMLElement) => {
        const src = el.querySelector('img')?.getAttribute('src') ?? ''
        return DRAWIO_PREVIEW.test(src) ? src : ''
      },
    },
    caption: {
      default: '',
      parseHTML: (el: HTMLElement) => el.querySelector('figcaption')?.textContent?.trim() ?? '',
    },
  }),
  // Ahead of the image rule: a drawio figure also contains an img.
  parseHTML: () => [{ tag: 'figure.blk.drawio', priority: 200 }],
  renderHTML({ node }) {
    const xml = String(node.attrs.xml ?? '')
    const preview = String(node.attrs.preview ?? '')
    const caption = String(node.attrs.caption ?? '')
    const figure: Record<string, string> = { class: 'blk drawio' }
    if (xml) figure['data-xml'] = xml
    if (node.attrs.blockId) figure['data-block-id'] = String(node.attrs.blockId)
    const img = ['img', { src: DRAWIO_PREVIEW.test(preview) ? preview : '', alt: 'draw.io 图' }] as const
    return caption ? ['figure', figure, img, ['figcaption', {}, caption]] : ['figure', figure, img]
  },
  addNodeView() {
    return drawioNodeView(this.options.docId)
  },
})

const newId = (): string => 'b_' + Math.random().toString(36).slice(2, 10)

/** Gives every block a stable, unique `blockId`. */
export const BlockId = Extension.create({
  name: 'blockId',
  addGlobalAttributes() {
    return [
      {
        types: ALL_BLOCKS,
        attributes: {
          blockId: {
            default: null,
            parseHTML: (el) => el.getAttribute('data-block-id'),
            renderHTML: (attrs) => (attrs.blockId ? { 'data-block-id': attrs.blockId } : {}),
          },
        },
      },
      {
        // Paragraphs can be indented with Tab, like list items.
        types: ['paragraph'],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (el) => Math.min(4, Math.max(0, Number(el.getAttribute('data-indent') ?? 0) || 0)),
            renderHTML: (attrs) => (attrs.indent ? { 'data-indent': attrs.indent } : {}),
          },
        },
      },
    ]
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(trs, _old, state) {
          // Only repair after local edits; a remote peer repairs its own.
          if (!trs.some((t) => t.docChanged && !t.getMeta(ySyncPluginKey))) return null
          const seen = new Set<string>()
          let tr = null
          let pos = 0
          for (let i = 0; i < state.doc.childCount; i++) {
            const node = state.doc.child(i)
            const id = node.attrs.blockId as string | null
            if (!id || seen.has(id)) {
              tr ??= state.tr
              tr.setNodeAttribute(pos, 'blockId', newId())
            } else seen.add(id)
            pos += node.nodeSize
          }
          return tr
        },
      }),
    ]
  },
})

export function moveBlock(editor: { state: import('@tiptap/pm/state').EditorState; view: import('@tiptap/pm/view').EditorView }, dir: 1 | -1): boolean {
  const { state } = editor
  const $from = state.selection.$from
  if ($from.depth < 1) return false
  const index = $from.index(0)
  const target = index + dir
  if (target < 0 || target >= state.doc.childCount) return true
  const node = state.doc.child(index)
  const pos = $from.before(1)
  const offset = state.selection.from - pos
  const other = state.doc.child(target)
  const tr = state.tr.delete(pos, pos + node.nodeSize)
  const at = dir === 1 ? pos + other.nodeSize : pos - other.nodeSize
  tr.insert(at, node)
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(at + offset, tr.doc.content.size))))
  editor.view.dispatch(tr.scrollIntoView())
  return true
}

/** Enter, Backspace and Tab behave the way they do in a block editor. */
export const BlockKeys = Extension.create({
  name: 'blockKeys',
  addKeyboardShortcuts() {
    const current = () => {
      const { $from, empty } = this.editor.state.selection
      return { $from, empty, node: $from.node(1), pos: $from.depth >= 1 ? $from.before(1) : 0 }
    }
    // Indent every list item or paragraph the selection touches.
    const indent = (delta: number) => () => {
      const { state } = this.editor
      const { from, to } = state.selection
      const targets: { pos: number; level: number }[] = []
      state.doc.forEach((node, pos) => {
        if (pos + node.nodeSize <= from || pos > to) return
        if (INDENTABLE.includes(node.type.name)) targets.push({ pos, level: Number(node.attrs.indent ?? 0) })
      })
      if (!targets.length) return false
      return this.editor.commands.command(({ tr }) => {
        for (const t of targets) tr.setNodeAttribute(t.pos, 'indent', Math.max(0, Math.min(4, t.level + delta)))
        // Keep the selection so repeated Tab presses act on the same blocks.
        tr.setSelection(TextSelection.create(tr.doc, from, to))
        return true
      })
    }
    // In a code block, Tab indents the current line(s) by two spaces.
    const codeIndent = (delta: number) => {
      const { state } = this.editor
      const { $from, from, to, empty } = state.selection
      const start = $from.start(1)
      const text = $from.node(1).textContent
      if (delta > 0 && empty) return this.editor.commands.insertContent('  ')
      const lines: number[] = []
      for (let i = text.lastIndexOf('\n', from - start - 1) + 1; i <= to - start; i = text.indexOf('\n', i) + 1) {
        lines.push(i)
        if (text.indexOf('\n', i) === -1) break
      }
      return this.editor.commands.command(({ tr }) => {
        for (const i of lines.reverse()) {
          if (delta > 0) tr.insertText('  ', start + i)
          else {
            const n = /^ {0,2}/.exec(text.slice(i))![0].length
            if (n) tr.delete(start + i, start + i + n)
          }
        }
        tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(from), tr.mapping.map(to)))
        return true
      })
    }
    const tab = (delta: number) => () => {
      const { node } = current()
      if (node?.type.name === 'codeBlock') return codeIndent(delta)
      indent(delta)()
      // Keep focus in the editor even when there is nothing to indent.
      return true
    }
    return {
      Enter: () => {
        const { $from, empty, node } = current()
        if (!node || !empty) return false
        const name = node.type.name
        if (name === 'codeBlock') return this.editor.commands.insertContent('\n')
        const special = LIST.includes(name) || name === 'quote' || name === 'callout'
        if (!special) return false
        // An empty item ends the list.
        if (node.content.size === 0) return this.editor.commands.setNode('paragraph')
        return this.editor.commands.command(({ tr, dispatch }) => {
          if (dispatch) {
            tr.split($from.pos, 1, [{ type: node.type, attrs: { ...node.attrs, checked: false, blockId: null } }])
            tr.scrollIntoView()
          }
          return true
        })
      },
      Backspace: () => {
        const { $from, empty, node } = current()
        if (!node || !empty || $from.parentOffset !== 0 || $from.depth !== 1) return false
        if (INDENTABLE.includes(node.type.name) && Number(node.attrs.indent ?? 0) > 0) return indent(-1)()
        if (node.type.name === 'paragraph') return false
        return this.editor.commands.setNode('paragraph')
      },
      // Move the current block up or down.
      'Alt-ArrowUp': () => moveBlock(this.editor, -1),
      'Alt-ArrowDown': () => moveBlock(this.editor, 1),
      Tab: tab(1),
      'Shift-Tab': tab(-1),
      'Mod-a': () => {
        // In a code block, select the block first.
        const { node, $from } = current()
        if (node?.type.name !== 'codeBlock') return false
        const start = $from.start(1)
        const sel = this.editor.state.selection
        if (sel.from === start && sel.to === start + node.content.size) return false
        return this.editor.commands.command(({ tr }) => {
          tr.setSelection(TextSelection.create(tr.doc, start, start + node.content.size))
          return true
        })
      },
    }
  },
})

export const SLASH_ITEMS: { label: string; hint: string; type: string; attrs?: Record<string, unknown>; keys: string }[] = [
  { label: '正文', hint: '普通段落', type: 'paragraph', keys: 'text zhengwen p' },
  { label: '标题 1', hint: '# 空格', type: 'heading', attrs: { level: 1 }, keys: 'h1 biaoti heading' },
  { label: '标题 2', hint: '## 空格', type: 'heading', attrs: { level: 2 }, keys: 'h2 biaoti heading' },
  { label: '标题 3', hint: '### 空格', type: 'heading', attrs: { level: 3 }, keys: 'h3 biaoti heading' },
  { label: '无序列表', hint: '- 空格', type: 'bulletItem', keys: 'bullet list liebiao ul' },
  { label: '有序列表', hint: '1. 空格', type: 'orderedItem', keys: 'ordered number list ol' },
  { label: '待办', hint: '[] 空格', type: 'taskItem', keys: 'todo task daiban' },
  { label: '引用', hint: '> 空格', type: 'quote', keys: 'quote yinyong' },
  { label: '高亮块', hint: '提示或备注', type: 'callout', keys: 'callout note gaoliang' },
  { label: '代码块', hint: '``` 空格', type: 'codeBlock', keys: 'code daima' },
  { label: '公式', hint: '$$ 空格，LaTeX 实时预览', type: 'codeBlock', attrs: { language: 'math' }, keys: 'math formula gongshi latex' },
  { label: 'Mermaid 图表', hint: '```mermaid 空格，流程图等', type: 'codeBlock', attrs: { language: 'mermaid' }, keys: 'mermaid diagram tubiao flowchart liuchengtu' },
  { label: 'AI 生成图表', hint: '用一句话描述，AI 画出来', type: '__ai_diagram', keys: 'ai diagram tubiao chart' },
  { label: 'draw.io 图', hint: '在 draw.io 里画图', type: '__drawio', keys: 'drawio diagram huatu liuchengtu jiagou' },
  { label: '分割线', hint: '---', type: 'divider', keys: 'divider hr fenge' },
  { label: '表格', hint: '可编辑的简单表格', type: 'table', keys: 'table biaoge' },
  { label: '图片', hint: '从电脑选择', type: '__image', keys: 'image tupian picture' },
  { label: 'AI 生成图片', hint: '描述画面，AI 画出来', type: '__ai_image', keys: 'ai image tupian huatu draw picture shengcheng' },
  { label: '视频', hint: '上传本地视频（最大 1GB）', type: '__video', keys: 'video shipin mp4 upload' },
  { label: '嵌入视频', hint: 'B 站 / YouTube / Vimeo 链接', type: '__video_embed', keys: 'video embed bilibili youtube shipin lianjie' },
  { label: '附件', hint: '上传 PDF、Office、压缩包等文件', type: '__file', keys: 'file attachment fujian pdf zip' },
  { label: '链接卡片', hint: '粘贴网址生成预览卡片', type: '__link_card', keys: 'link card url lianjie kapian bookmark' },
]
