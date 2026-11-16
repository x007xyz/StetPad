import { Extension, Node, mergeAttributes, textblockTypeInputRule } from '@tiptap/core'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import { ySyncPluginKey } from '@tiptap/y-tiptap'

/**
 * The document schema: a flat list of blocks, the way Notion and Feishu
 * model a page. A list item is a block with an indent, not a nested list.
 */

export const TEXT_BLOCKS = ['paragraph', 'heading', 'bulletItem', 'orderedItem', 'taskItem', 'quote', 'callout', 'codeBlock']
export const ALL_BLOCKS = [...TEXT_BLOCKS, 'divider', 'image', 'table']
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
    return ['div', mergeAttributes(HTMLAttributes, { class: 'blk task' }), ['span', { class: 'task-box', contenteditable: 'false' }], ['div', { class: 'task-text' }, 0]]
  },
  addInputRules() {
    return [textblockTypeInputRule({ find: /^\s*\[\s?\]\s$/, type: this.type })]
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleClick(view, pos, event) {
            if (!(event.target as HTMLElement).classList?.contains('task-box')) return false
            const $pos = view.state.doc.resolve(pos)
            const at = $pos.before(1)
            const node = view.state.doc.nodeAt(at)
            if (!node) return false
            view.dispatch(view.state.tr.setNodeAttribute(at, 'checked', !node.attrs.checked))
            return true
          },
        },
      }),
    ]
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
  parseHTML: () => [{ tag: 'pre', preserveWhitespace: 'full' as const }],
  renderHTML({ HTMLAttributes }) {
    return ['pre', mergeAttributes(HTMLAttributes, { class: 'blk code' }), ['code', 0]]
  },
  addInputRules() {
    return [textblockTypeInputRule({ find: /^```\s$/, type: this.type })]
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
export const Image = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes: () => ({ src: { default: '' }, alt: { default: '' } }),
  parseHTML: () => [{ tag: 'img[src]' }],
  renderHTML({ HTMLAttributes }) {
    const src = String(HTMLAttributes.src ?? '')
    const ok = /^https?:/i.test(src) || /^data:image\//i.test(src) || /^\/files\/[\w-]+$/.test(src)
    return ['img', mergeAttributes(HTMLAttributes, { class: 'blk image', src: ok ? src : '' })]
  },
})
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
            b.textContent = label
            b.addEventListener('mousedown', (e) => e.preventDefault())
            b.addEventListener('click', () => commit(fn(parse())))
            bar.appendChild(b)
          }
          button('+ 行', (r) => [...r, r[0]!.map(() => '')])
          button('+ 列', (r) => r.map((row) => [...row, '']))
          button('− 行', (r) => (r.length > 1 ? r.slice(0, -1) : r))
          button('− 列', (r) => (r[0]!.length > 1 ? r.map((row) => row.slice(0, -1)) : r))
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
  { label: '分割线', hint: '---', type: 'divider', keys: 'divider hr fenge' },
  { label: '表格', hint: '可编辑的简单表格', type: 'table', keys: 'table biaoge' },
  { label: '图片', hint: '从电脑选择', type: '__image', keys: 'image tupian picture' },
]
