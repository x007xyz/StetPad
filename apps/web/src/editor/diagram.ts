import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type NodeView } from '@tiptap/pm/view'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import type { MermaidConfig } from 'mermaid'
import { api } from '../api'
import { openDiagramZoom } from './DiagramZoom'

/**
 * Mermaid diagrams and LaTeX formulas are ordinary code blocks whose
 * `language` is 'mermaid' or 'math'. The block text is the source, so
 * collaboration, suggestions and AI notation work unchanged. This file draws
 * the preview under the source and handles the editing/viewing switch.
 */

export type DiagramKind = 'mermaid' | 'math'

/** Detail of the `stetpad:ai-diagram` event sent by the "AI 修复" button. */
export interface AiDiagramRequest {
  kind: DiagramKind
  blockId?: string
  previous: string
  error: string
}

export const AI_DIAGRAM_EVENT = 'stetpad:ai-diagram'

/**
 * Detail of the `stetpad:ai-diagram-new` event: open the AI diagram dialog with this preset.
 * The result is inserted as a new block right after the block `afterBlockId` (when given), else at the cursor.
 */
export interface AiDiagramNewRequest {
  kind: DiagramKind | 'drawio'
  prompt: string
  /** The text the model should base the diagram on (for example a table as Markdown). */
  context: string
  afterBlockId?: string
}

export const AI_DIAGRAM_NEW_EVENT = 'stetpad:ai-diagram-new'

const EMPTY_HINT: Record<DiagramKind, string> = { mermaid: '输入 Mermaid 代码', math: '输入 LaTeX 公式' }

const isDiagram = (lang: string): lang is DiagramKind => lang === 'mermaid' || lang === 'math'
const isDark = (): boolean => document.documentElement.classList.contains('dark')

/** Redraws of every mounted preview. The render key includes the theme, so a redraw picks up a change. */
const refreshers = new Set<() => void>()
let themeWatched = false

/** Redraws all previews when the theme changes: the `dark` class on <html>, or the system scheme. */
function watchTheme(): void {
  if (themeWatched || typeof document === 'undefined') return
  themeWatched = true
  const again = (): void => refreshers.forEach((redraw) => redraw())
  new MutationObserver(again).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', again)
}

/** Below this scale a diagram's labels get too small to read, so it keeps its width and scrolls instead. */
const MIN_FIT_SCALE = 0.35

/**
 * Diagrams shrink to fit their box (the 放大 button shows them full size). Only one so wide that fitting would
 * shrink it under MIN_FIT_SCALE keeps its natural width and scrolls sideways (the box has overflow-x: auto).
 * Narrower diagrams never grow past their natural size.
 */
function sizeSvg(preview: HTMLElement): void {
  const svg = preview.querySelector<SVGSVGElement>(':scope > svg')
  if (!svg) return
  const natural = svg.viewBox.baseVal?.width ?? 0
  const box = preview.clientWidth - 32
  if (!(natural > 0) || !(box > 0)) return
  if (box / natural < MIN_FIT_SCALE) {
    svg.setAttribute('width', String(natural))
    svg.style.maxWidth = 'none'
  } else {
    svg.setAttribute('width', '100%')
    svg.style.maxWidth = `${natural}px`
  }
}

/** Renders a LaTeX formula to KaTeX markup. Throws on a syntax error. */
export function renderMath(src: string): string {
  return katex.renderToString(src, { displayMode: true, throwOnError: true })
}

let mermaidDark: boolean | null = null
let mermaidChain: Promise<unknown> = Promise.resolve()
let renderSeq = 0

/** Loads mermaid on first use and re-initializes it when the theme changes. */
async function mermaidApi(dark: boolean) {
  const { default: mermaid } = await import('mermaid')
  if (mermaidDark !== dark) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      flowchart: { htmlLabels: false },
      htmlLabels: false,
    } as MermaidConfig)
    mermaidDark = dark
  }
  return mermaid
}

/**
 * Renders a Mermaid diagram to an SVG string. Throws on a syntax error. Renders run one at a time.
 * `light: true` draws in the light theme whatever the page shows (exports use it). The next render re-applies its own theme.
 */
export function renderMermaid(src: string, opts: { light?: boolean } = {}): Promise<string> {
  const job = mermaidChain.then(async () => {
    const id = `mmd-${++renderSeq}`
    const mermaid = await mermaidApi(opts.light ? false : isDark())
    try {
      const { svg } = await mermaid.render(id, src)
      return svg
    } catch (e) {
      // Mermaid leaves its scratch element behind on a parse error.
      document.getElementById('d' + id)?.remove()
      throw e
    }
  })
  mermaidChain = job.catch(() => undefined)
  return job
}

/**
 * The block's text as the reader sees it: pending tracked deletions are
 * skipped, so the preview shows the revised source.
 */
export function blockSource(code: HTMLElement): string {
  let out = ''
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const hidden = n.parentElement?.closest('.tc-del, .tc-hidden')
    if (hidden && code.contains(hidden)) continue
    if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n as HTMLElement
      // A line break in the code block; ProseMirror's trailing-break placeholder is not text.
      if (el.tagName === 'BR' && !el.classList.contains('ProseMirror-trailingBreak')) out += '\n'
      continue
    }
    out += n.textContent ?? ''
  }
  return out
}

/** blockId → SVG markup for the mermaid blocks that rendered. Math is rendered on the server. */
export function collectRenders(root: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {}
  root.querySelectorAll<HTMLElement>('.code-wrap.lang-mermaid').forEach((wrap) => {
    const id = wrap.getAttribute('data-block-id')
    const svg = wrap.querySelector<SVGSVGElement>(':scope > .diagram-preview > svg')
    if (id && svg) out[id] = withInlineStyles(svg)
  })
  return out
}

/** A browser-drawn PNG of each rendered mermaid block, for Word export (the server's SVG renderer skips arrowheads). */
export interface Raster { png: string; width: number; height: number }

/** Draws SVG markup of width × height CSS px to a white PNG data url, at `scale` times the pixels. Null if the browser cannot draw it. */
async function drawPng(markup: string, width: number, height: number, scale: number): Promise<string | null> {
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = width * scale
    canvas.height = height * scale
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  } catch {
    // The server falls back to rasterizing the SVG itself.
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * A white PNG of a standalone SVG string (for example from renderMermaid), at `scale` times its size.
 * Null when the markup has no size or the browser cannot draw it.
 */
export async function rasterizeSvg(svgMarkup: string, scale = 2): Promise<Raster | null> {
  const root = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml').documentElement
  if (!root || root.nodeName.toLowerCase() !== 'svg') return null
  const vb = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  const width = Math.round((vb.length === 4 ? vb[2] : Number.parseFloat(root.getAttribute('width') ?? '')) || 0)
  const height = Math.round((vb.length === 4 ? vb[3] : Number.parseFloat(root.getAttribute('height') ?? '')) || 0)
  if (!width || !height) return null
  root.setAttribute('width', String(width))
  root.setAttribute('height', String(height))
  root.setAttribute('style', (root.getAttribute('style') ?? '').replace(/max-width:[^;]*;?/g, ''))
  const png = await drawPng(new XMLSerializer().serializeToString(root), width, height, scale)
  return png ? { png, width, height } : null
}

export async function collectRasters(root: HTMLElement, scale = 2): Promise<Record<string, Raster>> {
  const out: Record<string, Raster> = {}
  for (const wrap of root.querySelectorAll<HTMLElement>('.code-wrap.lang-mermaid')) {
    const id = wrap.getAttribute('data-block-id')
    const svg = wrap.querySelector<SVGSVGElement>(':scope > .diagram-preview > svg')
    if (!id || !svg) continue
    const box = svg.getBoundingClientRect()
    const vb = svg.viewBox.baseVal
    const width = Math.round(vb?.width || box.width)
    const height = Math.round(vb?.height || box.height)
    if (!width || !height) continue
    const copy = inlineStyled(svg)
    copy.setAttribute('width', String(width))
    copy.setAttribute('height', String(height))
    copy.style.removeProperty('max-width')
    const png = await drawPng(new XMLSerializer().serializeToString(copy), width, height, scale)
    if (png) out[id] = { png, width, height }
  }
  return out
}

// Properties Mermaid sets through its <style> sheet. The server rasterizes with a renderer that only
// partly understands CSS, so the export carries what the browser actually computed.
const INLINE_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'opacity', 'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline']

/** The SVG markup with each element's computed paint and font written into its style attribute. */
function withInlineStyles(svg: SVGSVGElement): string {
  return inlineStyled(svg).outerHTML
}

/** A copy of the SVG with each element's computed paint and font written into its style attribute. */
function inlineStyled(svg: SVGSVGElement): SVGSVGElement {
  const copy = svg.cloneNode(true) as SVGSVGElement
  const live = [svg, ...svg.querySelectorAll('*')]
  const dead = [copy, ...copy.querySelectorAll('*')]
  live.forEach((el, i) => {
    const target = dead[i]
    if (!target || el.closest('style')) return
    const cs = getComputedStyle(el)
    const css = INLINE_PROPS.map((p) => [p, cs.getPropertyValue(p)] as const)
      .filter(([, v]) => v && v !== 'normal' && v !== 'auto')
      .map(([p, v]) => `${p}:${v}`)
      .join(';')
    if (css) target.setAttribute('style', css + ';' + (target.getAttribute('style') ?? ''))
  })
  return copy
}

/** Sources whose light-theme SVG was already sent to the server in this page session. */
const sharedRenders = new Set<string>()

/** The document open in the editor (its URL is #/d/<id>), or null on a shared page. */
const openDocId = (): string | null => /^#\/d\/([\w-]+)/.exec(location.hash)?.[1] ?? null

/**
 * Sends a light-theme mermaid SVG to the server, which keeps it, so a GET export (API, MCP) can draw the diagram
 * without a browser. Once per distinct source per page; a failed send is retried on the next render.
 */
function shareRender(source: string, svg: string): void {
  if (isDark()) return
  const docId = openDocId()
  if (!docId) return
  const key = `${docId}\u0000${source.trim()}`
  if (sharedRenders.has(key)) return
  sharedRenders.add(key)
  api(`/docs/${docId}/renders`, { method: 'PUT', body: JSON.stringify({ source, svg }) }).catch(() => {
    sharedRenders.delete(key)
  })
}

/**
 * Adds the class `editing` to the top-level code block that holds the
 * selection. The CSS shows the source only while it is editing.
 */
export const diagramEditingPlugin = new Plugin({
  key: new PluginKey('diagramEditing'),
  props: {
    decorations(state) {
      const { $from } = state.selection
      if ($from.depth < 1) return null
      const block = $from.node(1)
      if (block.type.name !== 'codeBlock') return null
      const pos = $from.before(1)
      return DecorationSet.create(state.doc, [Decoration.node(pos, pos + block.nodeSize, { class: 'editing' })])
    },
  },
})

const hint = (text: string): HTMLElement => {
  const el = document.createElement('div')
  el.className = 'diagram-hint'
  el.textContent = text
  return el
}

/**
 * Node view for every code block. Plain blocks look as before; mermaid and
 * math blocks also get a preview after the source.
 */
export function codeBlockView({ node, editor, getPos }: { node: PMNode; editor: Editor; getPos: () => number | undefined }): NodeView {
  let current = node
  let timer = 0
  let gen = 0
  let shown: string | null = null

  const dom = document.createElement('div')
  const pre = document.createElement('pre')
  pre.className = 'code'
  const code = document.createElement('code')
  pre.append(code)
  dom.append(pre)
  const preview = document.createElement('div')
  preview.className = 'diagram-preview'
  preview.contentEditable = 'false'
  // Shown on hover; it lives in the preview, after the diagram, so a redraw keeps it.
  const zoom = document.createElement('button')
  zoom.type = 'button'
  zoom.className = 'diagram-zoom'
  zoom.textContent = '放大'
  zoom.setAttribute('aria-label', '放大查看')
  zoom.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const target = preview.querySelector(':scope > svg') ?? preview.querySelector('.katex-display')
    if (target) openDiagramZoom(target)
  })
  /** Puts a rendered diagram (Mermaid SVG or KaTeX markup) in the preview. */
  const show = (markup: string): void => {
    const tpl = document.createElement('template')
    tpl.innerHTML = markup
    preview.replaceChildren(...tpl.content.childNodes, zoom)
    sizeSvg(preview)
  }
  // Re-fit the diagram when the editor's width changes.
  const fit = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => sizeSvg(preview))
  fit?.observe(preview)

  const lang = (): string => String(current.attrs.language ?? '').replace(/[^\w-]/g, '')
  const kind = (): DiagramKind | null => {
    const l = lang()
    return isDiagram(l) ? l : null
  }

  const paint = (): void => {
    const l = lang()
    // Only touch our own classes: ProseMirror adds decoration classes such as `editing` to this element.
    for (const c of [...dom.classList]) if (c.startsWith('lang-')) dom.classList.remove(c)
    dom.classList.add('blk', 'code-wrap')
    if (l) dom.classList.add(`lang-${l}`)
    dom.classList.toggle('readonly', !editor.isEditable)
    if (current.attrs.blockId) dom.setAttribute('data-block-id', String(current.attrs.blockId))
    else dom.removeAttribute('data-block-id')
    if (l) pre.setAttribute('data-language', l)
    else pre.removeAttribute('data-language')
    if (kind()) {
      if (preview.parentNode !== dom) dom.append(preview)
    } else if (preview.parentNode) preview.remove()
  }

  const showError = (k: DiagramKind, src: string, e: unknown): void => {
    const full = e instanceof Error ? e.message : String(e)
    const line = document.createElement('div')
    line.className = 'diagram-error'
    const text = document.createElement('span')
    // Mermaid errors span lines ("Parse error on line 3:", the source excerpt, a caret line, "Expecting ...").
    const lines = full.split('\n').map((l) => l.trim()).filter((l) => l && !/^-*\^$/.test(l))
    text.textContent = `渲染失败：${lines.join(' · ').slice(0, 300)}`
    line.append(text)
    if (editor.isEditable) {
      const fix = document.createElement('button')
      fix.type = 'button'
      fix.className = 'diagram-fix'
      fix.textContent = 'AI 修复'
      fix.addEventListener('click', (ev) => {
        ev.preventDefault()
        const detail: AiDiagramRequest = { kind: k, previous: src, error: full }
        if (current.attrs.blockId) detail.blockId = String(current.attrs.blockId)
        window.dispatchEvent(new CustomEvent(AI_DIAGRAM_EVENT, { detail }))
      })
      line.append(fix)
    }
    preview.replaceChildren(line)
  }

  const run = async (): Promise<void> => {
    const k = kind()
    if (!k) return
    const src = blockSource(code)
    const key = `${k}\u0000${isDark()}\u0000${src}`
    if (key === shown) return
    const my = ++gen
    if (!src.trim()) {
      shown = key
      preview.replaceChildren(hint(EMPTY_HINT[k]))
      return
    }
    try {
      const svg = k === 'math' ? renderMath(src) : await renderMermaid(src)
      if (my !== gen) return
      shown = key
      show(svg)
      if (k === 'mermaid') shareRender(src, svg)
    } catch (e) {
      if (my !== gen) return
      shown = key
      showError(k, src, e)
    }
  }

  const schedule = (): void => {
    window.clearTimeout(timer)
    // Wait for ProseMirror to finish the DOM update before reading the text.
    timer = window.setTimeout(() => requestAnimationFrame(() => void run()), 250)
  }

  // Clicking the preview moves the cursor to the end of the source and edits it.
  preview.addEventListener('mousedown', (e) => {
    if (!editor.isEditable || (e.target as HTMLElement).closest('button')) return
    const pos = getPos()
    if (pos === undefined) return
    e.preventDefault()
    const end = pos + current.nodeSize - 1
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, end)))
    editor.view.focus()
  })

  watchTheme()
  const redraw = (): void => {
    if (kind()) void run()
  }
  refreshers.add(redraw)

  paint()
  schedule()

  return {
    dom,
    contentDOM: code,
    update(next) {
      if (next.type !== current.type) return false
      current = next
      paint()
      schedule()
      return true
    },
    // Events on the preview belong to the preview, not to the editor.
    stopEvent: (e) => preview.contains(e.target as Node),
    // Only changes inside the source are ProseMirror's; the preview and our own classes are not.
    ignoreMutation: (m) => m.type !== 'selection' && !code.contains(m.target),
    destroy() {
      window.clearTimeout(timer)
      refreshers.delete(redraw)
      fit?.disconnect()
    },
  }
}
