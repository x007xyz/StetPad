// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { go } from './App'
import { SearchDialog } from './SearchDialog'
import { deferred } from './lib/deferred.test-utils'

vi.mock('./App', () => ({ go: vi.fn() }))

let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function typeQuery(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  act(() => input.dispatchEvent(new Event('input', { bubbles: true })))
}

it('keeps cleared search results empty when an earlier request finishes', async () => {
  const { promise, resolve } = deferred<Response>()
  const fetchSearch = vi.fn(() => promise)
  vi.stubGlobal('fetch', fetchSearch)
  const onClose = vi.fn()
  await act(async () => root.render(<SearchDialog onClose={onClose} />))
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!

  typeQuery(input, 'Orchid')
  await act(() => vi.advanceTimersByTimeAsync(200))
  expect(fetchSearch).toHaveBeenCalledExactlyOnceWith('/api/search?q=Orchid', expect.anything())

  typeQuery(input, '')
  await act(async () => resolve(Response.json({ results: [{
    id: 'orchid', title: 'Orchid Field Notes', updated_at: 0, folder_id: null, snippet: '', titleMatch: true,
  }] })))

  expect(document.querySelector('[role="option"]')).toBeNull()
  expect(input.getAttribute('aria-expanded')).toBe('false')
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(onClose).not.toHaveBeenCalled()
  expect(go).not.toHaveBeenCalled()
})
