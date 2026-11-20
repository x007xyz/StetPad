// @vitest-environment happy-dom
import { ATOM_BLOCK_TYPES, BLOCK_TYPES, blocks, insertBlock } from '@stetpad/crdt'
import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { docEditorExtensions } from './DocPage'
import { folderEditorExtensions } from './FolderPage'

let editor: Editor | undefined
afterEach(() => editor?.destroy())

const pages = [
  { page: 'document page', extensions: docEditorExtensions },
  { page: 'folder page', extensions: folderEditorExtensions },
]

describe.each(pages)('$page editor', ({ extensions }) => {
  it.each(BLOCK_TYPES)('keeps %s blocks intact while the document is edited', (type) => {
    const ydoc = new Y.Doc()
    insertBlock(ydoc, 0, 'edited', 'Text')
    const block = insertBlock(ydoc, 1, 'kept', ATOM_BLOCK_TYPES.has(type) ? '' : `A ${type}`, type)
    const before = block.toJSON()
    editor = new Editor({
      element: document.createElement('div'),
      extensions: extensions({ ydoc, docId: 'test', user: () => ({ author: 'Me', tracking: false }) }),
    })
    editor.commands.insertContentAt(1, 'Edited ')
    expect(blocks(ydoc).map((el) => el.nodeName)).toEqual(['paragraph', type])
    expect(blocks(ydoc)[1]!.toJSON()).toEqual(before)
  })
})
