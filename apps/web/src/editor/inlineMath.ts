import { InputRule, Mark, mergeAttributes } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import katex from 'katex'
import { hiddenRanges } from './tracked'

/**
 * Inline math. The mark `math` (no attributes) covers LaTeX source that is
 * ordinary text, so it flows through Yjs as a format: `math: true`. The mark
 * excludes every other mark, so the source is never formatted.
 *
 * Display: for each run of math text that does not contain the selection,
 * the source is hidden and a KaTeX widget follows it. When the selection is
 * inside the run, the source shows as code with a small KaTeX preview above it.
 */

export interface MathRun {
  from: number
  to: number
  /** The source. Pending tracked deletions inside the run are included (the raw text). */
  src: string
}

/**
 * The source as the reader sees it: the run's text minus characters pending
 * tracked deletion or removed. The formula is rendered from this, not from `src`.
 */
export function shownSource(state: EditorState, run: MathRun): string {
  let out = ''
  let pos = run.from
  for (const [a, b] of hiddenRanges(state, run.from, run.to)) {
    if (a > pos) out += state.doc.textBetween(pos, a)
    pos = Math.max(pos, b)
  }
  if (pos < run.to) out += state.doc.textBetween(pos, run.to)
  return out
}

/** Maximal runs of math text, in document order. Runs never span two blocks. */
export function mathRuns(doc: PMNode): MathRun[] {
  const runs: MathRun[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    let run: MathRun | null = null
    node.forEach((child, offset) => {
      const start = pos + 1 + offset
      const isMath = child.isText && child.marks.some((m) => m.type.name === 'math')
      if (!isMath) {
        if (run) runs.push(run)
        run = null
        return
      }
      if (run && run.to === start) {
        run.to = start + child.nodeSize
        run.src += child.text ?? ''
      } else {
        if (run) runs.push(run)
        run = { from: start, to: start + child.nodeSize, src: child.text ?? '' }
      }
    })
    if (run) runs.push(run)
    return false
  })
  return runs
}

/** `$…$` as typed: the closing dollar is the last character. The content has no space at either end and no `$`. */
const TYPED = /(^|[^\\$])\$([^\s$](?:[^$]*?[^\s$])?)\$$/

const katexHtml = (src: string, display: boolean): string => katex.renderToString(src, { displayMode: display, throwOnError: false })

function widget(run: MathRun, shown: string, view: EditorView, getPos: () => number | undefined): HTMLElement {
  const el = document.createElement('span')
  el.className = 'math-view'
  el.contentEditable = 'false'
  el.title = '点击编辑公式'
  el.innerHTML = katexHtml(shown, false)
  el.addEventListener('mousedown', (e) => {
    // Clicking a formula puts the cursor at the end of its source.
    e.preventDefault()
    const pos = getPos()
    if (pos === undefined) return
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
    view.focus()
  })
  return el
}

const decorate = (state: EditorState): DecorationSet => {
  const runs = mathRuns(state.doc)
  if (!runs.length) return DecorationSet.empty
  const { from, to } = state.selection
  const decos: Decoration[] = []
  for (const run of runs) {
    if (run.from <= from && to <= run.to) {
      decos.push(Decoration.inline(run.from, run.to, { class: 'math-code' }))
      continue
    }
    const shown = shownSource(state, run)
    decos.push(Decoration.inline(run.from, run.to, { class: 'math-src' }))
    decos.push(
      Decoration.widget(run.to, (view, getPos) => widget(run, shown, view, getPos), {
        side: -1,
        key: `math:${shown}`,
        ignoreSelection: true,
      }),
    )
  }
  return DecorationSet.create(state.doc, decos)
}

/** The floating KaTeX preview above the source the selection is in. One element per editor. */
const previewPlugin = new Plugin({
  key: new PluginKey('inlineMathPreview'),
  view(view) {
    const pop = document.createElement('div')
    pop.className = 'math-float'
    pop.hidden = true
    document.body.append(pop)
    let shown: string | null = null
    return {
      update(v) {
        const { from, to } = v.state.selection
        const run = mathRuns(v.state.doc).find((r) => r.from <= from && to <= r.to)
        if (!run || !v.hasFocus()) {
          pop.hidden = true
          return
        }
        const text = shownSource(v.state, run)
        if (shown !== text) {
          pop.innerHTML = katexHtml(text, false)
          shown = text
        }
        const at = v.coordsAtPos(run.from)
        pop.style.left = `${at.left}px`
        pop.style.top = `${at.top - 6}px`
        pop.hidden = false
      },
      destroy() {
        pop.remove()
      },
    }
  },
})

export const InlineMath = Mark.create({
  name: 'math',
  inclusive: false,
  // Applying math removes the other marks; other marks cannot be applied onto math.
  excludes: '_',

  parseHTML() {
    return [{ tag: 'span[data-math]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'math-mark', 'data-math': '' }), 0]
  },

  addInputRules() {
    return [
      new InputRule({
        find: TYPED,
        handler: ({ state, range, match }) => {
          const $at = state.doc.resolve(range.from)
          if ($at.parent.type.spec.code || $at.parent.type.name === 'codeBlock') return null
          // The character after the closing dollar: a price such as "$5 and $6" is not math.
          const $after = state.doc.resolve(range.to)
          if (/\d/.test($after.parent.textBetween($after.parentOffset, Math.min($after.parentOffset + 1, $after.parent.content.size)))) return null
          const lead = match[1] ?? ''
          const open = range.from + lead.length
          const close = range.to - 1
          const { tr } = state
          // Delete the closing dollar first so the opening position does not move.
          tr.delete(close, close + 1)
          tr.delete(open, open + 1)
          tr.addMark(open, close - 1, this.type.create())
          tr.removeStoredMark(this.type)
        },
      }),
    ]
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('inlineMath'),
        props: {
          decorations: (state) => decorate(state),
        },
      }),
      previewPlugin,
    ]
  },
})
