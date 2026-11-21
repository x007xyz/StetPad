// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Text from '@tiptap/extension-text'
import { afterEach, expect, it } from 'vitest'
import { TaskItem } from './schema'

let editor: Editor
afterEach(() => editor?.destroy())

function setup(text = 'Task') {
  editor = new Editor({
    element: document.body.appendChild(document.createElement('div')),
    extensions: [Document, Text, TaskItem],
    content: { type: 'doc', content: [{ type: 'taskItem', content: text ? [{ type: 'text', text }] : [] }] },
  })
  return editor.view.dom.querySelector<HTMLElement>('.task-box')!
}

it.each(['Task', ''])('exposes checkbox state and toggles with Space and Enter (%s)', (text) => {
  const box = setup(text)
  expect(box.getAttribute('role')).toBe('checkbox')
  expect(box.getAttribute('aria-checked')).toBe('false')
  expect(box.tabIndex).toBe(0)
  box.focus()
  for (const [key, checked] of [[' ', true], ['Enter', false]] as const) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    box.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(editor.state.doc.firstChild!.attrs.checked).toBe(checked)
    expect(box.getAttribute('aria-checked')).toBe(String(checked))
    expect(document.activeElement).toBe(box)
  }
})

it('ignores other keys and task text, supports click and external state updates', () => {
  const box = setup()
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
  editor.view.dom.querySelector('.task-text')!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  expect(editor.state.doc.firstChild!.attrs.checked).toBe(false)
  box.click()
  expect(editor.state.doc.firstChild!.attrs.checked).toBe(true)
  editor.view.dispatch(editor.state.tr.setNodeAttribute(0, 'checked', false))
  expect(box.getAttribute('aria-checked')).toBe('false')
  editor.commands.insertContentAt(1, 'Edited ')
  expect(editor.state.doc.textContent).toBe('Edited Task')
})
