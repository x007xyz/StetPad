import {
  addToChange,
  buildIndex,
  changes,
  classify,
  content,
  elementId,
  newChangeId,
  rawChars,
  type CharId,
  type Classified,
} from '@stetpad/crdt'
import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { ReplaceStep } from '@tiptap/pm/transform'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import * as Y from 'yjs'

/**
 * Tracked changes in the editor.
 *
 * Changes live in the Y.Doc as sets of item ids (see @stetpad/crdt), not as
 * ProseMirror marks. This extension is the bridge:
 *  - draws them as decorations
 *  - when the user edits with tracking on, turns deletions into suggestions
 *    and records what was typed
 *  - keeps text that is pending deletion from being edited away
 *  - follows text whose ids change when a paragraph is split or joined
 */

export interface TrackedOptions {
  doc: Y.Doc
  user: () => { author: string; tracking: boolean }
}

interface CharAt extends CharId {
  pos: number
  ch: string
}
interface ElAt extends CharId {
  pos: number
  size: number
}

/**
 * Walk the Yjs tree and the ProseMirror document side by side. The collab
 * binding keeps them the same shape, so a Yjs character maps to a position.
 */
export function walk(frag: Y.XmlFragment, pm: PMNode): { chars: CharAt[]; els: ElAt[] } {
  const chars: CharAt[] = []
  const els: ElAt[] = []
  const visit = (y: Y.XmlFragment | Y.XmlElement, node: PMNode, start: number): void => {
    if (node.inlineContent) {
      let off = 0
      for (const child of y.toArray()) {
        if (child instanceof Y.XmlText) {
          rawChars(child).forEach((c, i) => chars.push({ ...c, pos: start + off + i }))
          off += child.length
        } else {
          off += 1 // inline leaf
        }
      }
      return
    }
    let pos = start
    let i = 0
    for (const child of y.toArray()) {
      if (!(child instanceof Y.XmlElement) || i >= node.childCount) continue
      const n = node.child(i++)
      const id = elementId(child)
      els.push({ ...id, pos, size: n.nodeSize })
      visit(child, n, pos + 1)
      pos += n.nodeSize
    }
  }
  visit(frag, pm, 0)
  return { chars, els }
}

const key = new PluginKey<DecorationSet>('tracked')
const same = (a: CharId, b: CharId): boolean => a.client === b.client && a.clock === b.clock

function decorate(ydoc: Y.Doc, pm: PMNode): DecorationSet {
  const idx = buildIndex(ydoc)
  const { chars, els } = walk(content(ydoc), pm)
  const decos: Decoration[] = []
  const authorOf = (id: string): string => String(changes(ydoc).get(id)?.get('author') ?? '')

  const look = (c: Classified): { cls: string; change: string } | null => {
    if (c.removed) return { cls: 'tc-hidden', change: '' }
    if (c.ins.length && c.del.length) return { cls: 'tc-ins tc-del', change: c.del[0]! }
    if (c.del.length) return { cls: 'tc-del', change: c.del[0]! }
    if (c.ins.length) return { cls: 'tc-ins', change: c.ins[0]! }
    return null
  }

  // Merge neighbouring characters with the same look into one span.
  let run: { from: number; to: number; cls: string; change: string } | null = null
  const flush = (): void => {
    if (!run) return
    decos.push(
      Decoration.inline(run.from, run.to, {
        class: run.cls,
        'data-change': run.change,
        'data-author': run.change ? authorOf(run.change) : '',
      }),
    )
    run = null
  }
  for (const c of chars) {
    const l = look(classify(idx, c))
    if (run && l && run.to === c.pos && run.cls === l.cls && run.change === l.change) {
      run.to++
      continue
    }
    flush()
    if (l) run = { from: c.pos, to: c.pos + 1, ...l }
  }
  flush()

  for (const e of els) {
    const c = classify(idx, e)
    const cls = c.removed ? 'tc-block-hidden' : c.del.length ? 'tc-block-del' : c.ins.length ? 'tc-block-ins' : ''
    if (cls) decos.push(Decoration.node(e.pos, e.pos + e.size, { class: cls }))
  }
  return DecorationSet.create(pm, decos)
}

/** What a local edit leaves to do once the collab binding has written to Yjs. */
interface Followup {
  /** Pending characters and where each one ends up, so a new id can inherit its changes. */
  carry: { pos: number; ch: string; old: CharId; ins: string[]; del: string[] }[]
  /** Ranges of the new document that this edit inserted. */
  inserted: { from: number; to: number }[]
}

const isRemote = (tr: Transaction): boolean => !!tr.getMeta(ySyncPluginKey)

export const Tracked = Extension.create<TrackedOptions>({
  name: 'tracked',
  // Run after the collaboration extension.
  priority: 10,

  addProseMirrorPlugins() {
    const { doc: ydoc, user } = this.options
    const frag = content(ydoc)
    const queue: Followup[] = []
    let view: EditorView | null = null

    const refresh = (): void => {
      queueMicrotask(() => {
        if (view && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, { refresh: true }))
      })
    }

    /** Runs after the binding has synced a local edit into Yjs. */
    const settle = (f: Followup): void => {
      if (!view) return
      const me = user()
      const idx = buildIndex(ydoc)
      const { chars } = walk(frag, view.state.doc)
      const at = new Map(chars.map((c) => [c.pos, c]))
      const recs = changes(ydoc)
      const metaOf = (id: string) => ({ author: String(recs.get(id)?.get('author') ?? me.author) })

      // 1. Text that moved (paragraph split or join) got new ids. Re-attach its changes.
      const carried = new Set<number>()
      const add = new Map<string, CharId[]>() // `${side}:${changeId}` -> ids
      for (const c of f.carry) {
        const now = at.get(c.pos)
        if (!now || now.ch !== c.ch || same(now, c.old)) continue
        carried.add(now.pos)
        for (const [side, list] of [['ins', c.ins], ['del', c.del]] as const) {
          for (const id of list) {
            const k = `${side}:${id}`
            add.set(k, [...(add.get(k) ?? []), now])
          }
        }
      }
      for (const [k, ids] of add) {
        const [side, id] = k.split(':') as ['ins' | 'del', string]
        addToChange(ydoc, id, side, ids, metaOf(id))
      }

      // 2. Record what was typed.
      const mine = (c: CharAt | undefined): string | undefined => {
        if (!c) return undefined
        const cl = classify(idx, c)
        return [...cl.ins, ...cl.del].find((id) => recs.get(id)?.get('author') === me.author)
      }
      for (const r of f.inserted) {
        const fresh = chars.filter(
          (c) => c.pos >= r.from && c.pos < r.to && !carried.has(c.pos) && classify(idx, c).ins.length === 0,
        )
        if (fresh.length === 0) continue
        const left = at.get(r.from - 1)
        const right = at.get(r.to)
        let join: string | undefined
        if (me.tracking) {
          join = mine(left) ?? mine(right)
        } else if (left && right) {
          // Not tracking: text typed strictly inside a pending insertion joins it.
          const l = classify(idx, left).ins
          join = classify(idx, right).ins.find((id) => l.includes(id))
          if (!join) continue
        } else {
          continue
        }
        addToChange(ydoc, join ?? newChangeId(), 'ins', fresh, join ? metaOf(join) : { author: me.author })
      }
      refresh()
    }

    /**
     * A deletion the user asked for, split into what really goes and what
     * stays in the document as a suggestion. Returns null to let the edit through.
     */
    const intercept = (tr: Transaction, state: EditorState): (() => void) | null => {
      if (tr.steps.length !== 1) return null
      const step = tr.steps[0]
      if (!(step instanceof ReplaceStep) || step.from >= step.to) return null
      const { from, to, slice } = step
      const me = user()
      const idx = buildIndex(ydoc)
      const all = walk(frag, state.doc).chars
      const range = all.filter((c) => c.pos >= from && c.pos < to)
      const recs = changes(ydoc)
      const ownInsert = (c: Classified): boolean =>
        c.ins.some((id) => recs.get(id)?.get('author') === me.author)

      const really: number[] = [] // positions to delete for real
      const suggest: CharAt[] = [] // characters that become a pending deletion
      let untouchable = 0
      for (const c of range) {
        const cl = classify(idx, c)
        if (cl.removed || cl.del.length > 0) untouchable++
        else if (!me.tracking || ownInsert(cl)) really.push(c.pos)
        else suggest.push(c)
      }
      if (suggest.length === 0 && untouchable === 0) return null

      const at = new Map(all.map((c) => [c.pos, c]))
      const mine = (c: CharAt | undefined): string | undefined => {
        if (!c) return undefined
        const cl = classify(idx, c)
        return [...cl.del, ...cl.ins].find((id) => recs.get(id)?.get('author') === me.author)
      }
      const changeId = mine(at.get(to)) ?? mine(at.get(from - 1)) ?? newChangeId()

      return () => {
        if (!view || view.state !== state) return
        if (suggest.length) addToChange(ydoc, changeId, 'del', suggest, { author: me.author })
        const next = state.tr
        // Delete from the end so earlier positions stay valid.
        const sorted = [...really].sort((a, b) => b - a)
        for (let i = 0; i < sorted.length; ) {
          let j = i
          while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! - 1) j++
          next.delete(sorted[j]!, sorted[i]! + 1)
          i = j + 1
        }
        const end = next.mapping.map(to, 1)
        const start = next.mapping.map(from, -1)
        let cursor: number
        if (slice.size > 0) {
          next.replace(end, end, slice)
          cursor = end + slice.size
        } else {
          const sel = state.selection
          cursor = sel.empty && sel.from === from ? end : start
        }
        next.setSelection(TextSelection.near(next.doc.resolve(Math.min(cursor, next.doc.content.size))))
        next.setMeta(key, { pass: true }).scrollIntoView()
        view.dispatch(next)
      }
    }

    const plugin: Plugin<DecorationSet> = new Plugin<DecorationSet>({
      key,
      state: {
        init: (_, state) => decorate(ydoc, state.doc),
        apply(tr, set, oldState, newState) {
          const meta = tr.getMeta(key) as { refresh?: boolean; pass?: boolean } | undefined
          if (meta?.refresh || (tr.docChanged && isRemote(tr))) return decorate(ydoc, newState.doc)
          if (!tr.docChanged) return set

          // A local edit. Yjs still matches the old document here.
          const idx = buildIndex(ydoc)
          const f: Followup = { carry: [], inserted: [] }
          for (const c of walk(frag, oldState.doc).chars) {
            const cl = classify(idx, c)
            if (cl.ins.length === 0 && cl.del.length === 0) continue
            const m = tr.mapping.mapResult(c.pos, 1)
            if (!m.deleted) f.carry.push({ pos: m.pos, ch: c.ch, old: c, ins: cl.ins, del: cl.del })
          }
          tr.mapping.maps.forEach((map, i) => {
            const rest = tr.mapping.slice(i + 1)
            map.forEach((_a, _b, newStart, newEnd) => {
              if (newEnd > newStart) f.inserted.push({ from: rest.map(newStart, 1), to: rest.map(newEnd, -1) })
            })
          })
          queue.push(f)
          return set.map(tr.mapping, tr.doc)
        },
      },
      props: {
        decorations: (state) => plugin.getState(state),
      },
      filterTransaction(tr, state) {
        if (!tr.docChanged || isRemote(tr) || tr.getMeta(key) || view?.composing) return true
        const replacement = intercept(tr, state)
        if (!replacement) return true
        queueMicrotask(replacement)
        return false
      },
      view(v) {
        view = v
        // Decisions, settlements and other people's suggestions.
        const onChanges = (): void => refresh()
        changes(ydoc).observeDeep(onChanges)
        return {
          update() {
            if (queue.length === 0) return
            const pending = queue.splice(0)
            // After every plugin view has run, so the binding has written to Yjs.
            queueMicrotask(() => pending.forEach(settle))
          },
          destroy() {
            changes(ydoc).unobserveDeep(onChanges)
            view = null
          },
        }
      },
    })
    return [plugin]
  },
})
