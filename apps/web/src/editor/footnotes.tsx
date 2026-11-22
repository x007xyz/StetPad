import { Mark, mergeAttributes, type Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { FootnoteInfo } from '@stetpad/crdt'
import { useEffect, useState } from 'react'
import { Button } from '../components/ui/button'

/**
 * Footnotes. A footnote is the mark `footnote` with attrs `{ id, note }` over
 * the annotated text. Numbers are not stored: they follow the order of first
 * occurrence in the document. The reference number `[n]` is a widget right
 * after the last run of each id; the references list is rendered by the page.
 */

export interface FootnoteOptions {
  /** A number was hovered (pinned: false) or clicked (pinned: true). */
  onOpen: (id: string, rect: DOMRect, pinned: boolean) => void
  /** The pointer left a number. */
  onLeave: () => void
  /** Mod-Alt-f: open the note input for the current selection. */
  onShortcut: () => void
}

export const Footnote = Mark.create<FootnoteOptions>({
  name: 'footnote',
  inclusive: false,
  addOptions() {
    return { onOpen: () => {}, onLeave: () => {}, onShortcut: () => {} }
  },
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-fn-id'),
        renderHTML: (a: { id?: string | null }) => (a.id ? { 'data-fn-id': a.id } : {}),
      },
      note: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-fn-note') ?? '',
        renderHTML: (a: { note?: string }) => ({ 'data-fn-note': a.note ?? '' }),
      },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-fn-id]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'fn' }), 0]
  },
  addKeyboardShortcuts() {
    return {
      'Mod-Alt-f': () => {
        this.options.onShortcut()
        return true
      },
    }
  },
  addProseMirrorPlugins() {
    const { onOpen, onLeave } = this.options
    return [
      new Plugin({
        state: {
          init: (_, state) => numberWidgets(state.doc, onOpen, onLeave),
          apply: (tr, old, _prev, next) => (tr.docChanged ? numberWidgets(next.doc, onOpen, onLeave) : old),
        },
        props: {
          decorations(state) {
            return this.getState(state)
          },
        },
      }),
    ]
  },
})

export interface FootnoteSpot {
  id: string
  note: string
  /** Start of the first run and end of the last run of this id. */
  from: number
  to: number
}

/** Footnotes in document order, one entry per id. */
export function footnoteSpots(doc: PMNode): FootnoteSpot[] {
  const byId = new Map<string, FootnoteSpot>()
  doc.descendants((node, pos) => {
    if (!node.isText) return true
    const m = node.marks.find((x) => x.type.name === 'footnote' && x.attrs.id)
    if (m) {
      const id = String(m.attrs.id)
      const seen = byId.get(id)
      if (seen) seen.to = pos + node.nodeSize
      else byId.set(id, { id, note: String(m.attrs.note ?? ''), from: pos, to: pos + node.nodeSize })
    }
    return true
  })
  return [...byId.values()]
}

function numberWidgets(doc: PMNode, onOpen: FootnoteOptions['onOpen'], onLeave: FootnoteOptions['onLeave']): DecorationSet {
  return DecorationSet.create(
    doc,
    footnoteSpots(doc).map((s, i) => {
      const n = i + 1
      return Decoration.widget(
        s.to,
        () => {
          const el = document.createElement('sup')
          el.className = 'fn-num'
          el.dataset.fnId = s.id
          el.contentEditable = 'false'
          el.textContent = `[${n}]`
          el.addEventListener('mousedown', (e) => e.preventDefault())
          el.addEventListener('mouseenter', () => onOpen(s.id, el.getBoundingClientRect(), false))
          el.addEventListener('mouseleave', () => onLeave())
          el.addEventListener('click', (e) => {
            e.preventDefault()
            e.stopPropagation()
            onOpen(s.id, el.getBoundingClientRect(), true)
          })
          return el
        },
        { side: 1, key: `fn-${s.id}-${n}`, ignoreSelection: true },
      )
    }),
  )
}

/** Add a footnote over the current selection. */
export function addFootnote(editor: Editor, note: string): boolean {
  const text = note.trim()
  if (!text || editor.state.selection.empty) return false
  const id = 'fn_' + Math.random().toString(36).slice(2, 10)
  return editor.chain().focus().setMark('footnote', { id, note: text }).run()
}

/** Change the note of every run that carries this id, in one transaction. */
export function setFootnoteNote(editor: Editor, id: string, note: string): void {
  const type = editor.schema.marks.footnote!
  const tr = editor.state.tr
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return true
    if (node.marks.some((m) => m.type === type && m.attrs.id === id)) tr.addMark(pos, pos + node.nodeSize, type.create({ id, note }))
    return true
  })
  if (tr.docChanged) editor.view.dispatch(tr)
}

/** Remove the footnote from its text. The text stays. */
export function removeFootnote(editor: Editor, id: string): void {
  const type = editor.schema.marks.footnote!
  const tr = editor.state.tr
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return true
    const m = node.marks.find((x) => x.type === type && x.attrs.id === id)
    if (m) tr.removeMark(pos, pos + node.nodeSize, m)
    return true
  })
  if (tr.docChanged) editor.view.dispatch(tr)
}

/** Scroll to the number of a footnote in the text. */
export function scrollToFootnote(root: HTMLElement | null, id: string): void {
  const el = root?.querySelector<HTMLElement>(`sup.fn-num[data-fn-id="${CSS.escape(id)}"]`)
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

/** The note of one footnote, shown next to its number. */
export function FootnotePopover({
  editor,
  id,
  x,
  y,
  onEnter,
  onLeave,
  onClose,
}: {
  editor: Editor
  id: string
  x: number
  y: number
  onEnter: () => void
  onLeave: () => void
  onClose: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const spots = footnoteSpots(editor.state.doc)
  const index = spots.findIndex((s) => s.id === id)
  const spot = spots[index]

  useEffect(() => {
    const down = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement).closest?.('.fn-pop, .fn-num')) onClose()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [onClose])

  if (!spot) return null
  const editable = editor.isEditable
  return (
    <div className="fn-pop" role="dialog" aria-label={`脚注 ${index + 1}`} style={{ left: Math.max(8, Math.min(x, window.innerWidth - 328)), top: y }} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="fn-pop-head">{`脚注 ${index + 1}`}</div>
      {editing ? (
        <form
          className="fn-pop-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (draft.trim()) setFootnoteNote(editor, id, draft.trim())
            setEditing(false)
          }}
        >
          <textarea autoFocus rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)} aria-label="脚注内容" />
          <div className="fn-pop-actions">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>取消</Button>
            <Button type="submit" size="sm" disabled={!draft.trim()}>保存</Button>
          </div>
        </form>
      ) : (
        <>
          <div className="fn-pop-text">{spot.note ? <span translate="no">{spot.note}</span> : <span className="muted">（空）</span>}</div>
          {editable && (
            <div className="fn-pop-actions">
              <Button type="button" variant="ghost" size="sm" onClick={() => { setDraft(spot.note); setEditing(true) }}>编辑</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => { removeFootnote(editor, id); onClose() }}>删除脚注</Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** The references list under the document. Hidden when there are no footnotes. */
export function FootnoteList({ notes, onJump }: { notes: FootnoteInfo[]; onJump: (id: string) => void }) {
  if (!notes.length) return null
  return (
    <section className="fn-list" aria-label="脚注">
      <h2>脚注</h2>
      <ol>
        {notes.map((n) => (
          <li key={n.id} value={n.number}>
            <button type="button" className="fn-item" onClick={() => onJump(n.id)} title="回到正文">
              {n.note ? <span translate="no">{n.note}</span> : <span className="muted">（空）</span>}
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}
