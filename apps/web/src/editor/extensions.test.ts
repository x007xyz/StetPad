// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { afterEach, expect, it } from 'vitest'
import * as Y from 'yjs'
import { editorExtensions } from './extensions'

let editor: Editor | undefined
afterEach(() => editor?.destroy())

it('preserves custom blocks and inline marks in the shared content when editing a folder document', () => {
  const ydoc = new Y.Doc()
  const content = ydoc.getXmlFragment('content')
  const paragraph = new Y.XmlElement('paragraph')
  const text = new Y.XmlText()
  text.insert(0, 'Formula', { math: true })
  text.insert(7, ' note', { footnote: { id: 'fn-1', note: 'Keep this note' } })
  paragraph.insert(0, [text])
  const types = ['video', 'drawio', 'file', 'linkCard', 'image', 'table', 'divider']
  const nodes = types.map((type) => {
    const node = new Y.XmlElement(type)
    node.setAttribute('blockId', type)
    return node
  })
  content.insert(0, [paragraph, ...nodes])
  editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions({ ydoc, docId: 'test', user: () => ({ author: 'Me', tracking: false }), placeholder: '' }),
  })
  editor.commands.insertContentAt(1, 'Edited ')
  expect(content.toArray().map((node) => (node as Y.XmlElement).nodeName)).toEqual(['paragraph', ...types])
  expect(text.toDelta()).toEqual(expect.arrayContaining([
    expect.objectContaining({ insert: 'Formula', attributes: { math: expect.anything() } }),
    expect.objectContaining({ insert: ' note', attributes: { footnote: { id: 'fn-1', note: 'Keep this note' } } }),
  ]))
})

it('can edit an empty shared document', () => {
  const ydoc = new Y.Doc()
  editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions({ ydoc, docId: 'test', user: () => ({ author: 'Me', tracking: false }), placeholder: '' }),
  })
  editor.commands.insertContent('Hello')
  expect(ydoc.getXmlFragment('content').toString()).toContain('Hello')
})
