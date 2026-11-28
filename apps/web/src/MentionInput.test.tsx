// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MentionInput } from './MentionInput'

let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('leaves composing Enter to the IME when a comment mention is open', () => {
  const onChange = vi.fn()
  act(() => root.render(<MentionInput value="@a" onChange={onChange} />))
  const input = document.querySelector('input')!
  expect(input.getAttribute('aria-expanded')).toBe('true')

  const enter = (composition: KeyboardEventInit = {}) =>
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...composition })
  for (const event of [enter({ isComposing: true }), enter({ keyCode: 229 })]) {
    act(() => input.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
  }

  act(() => input.dispatchEvent(enter()))
  expect(onChange).toHaveBeenCalledExactlyOnceWith('@AI ')
})
