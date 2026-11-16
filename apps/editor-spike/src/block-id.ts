import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { ySyncPluginKey } from '@tiptap/y-tiptap'

const newId = (): string => 'b_' + Math.random().toString(36).slice(2, 8)

/** Gives every top-level block a stable, unique `blockId`. */
export const BlockId = Extension.create({
  name: 'blockId',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          blockId: {
            default: null,
            parseHTML: (el) => el.getAttribute('data-block-id'),
            renderHTML: (attrs) => (attrs.blockId ? { 'data-block-id': attrs.blockId } : {}),
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
            } else {
              seen.add(id)
            }
            pos += node.nodeSize
          }
          return tr
        },
      }),
    ]
  },
})
