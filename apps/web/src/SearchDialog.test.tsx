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

it.each([
  ['composition', { isComposing: true }],
  ['legacy composition', { keyCode: 229 }],
])('ignores result keys during %s but opens with plain Enter', async (_, composition) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ results: [
    { id: 'orchid-0', title: 'Orchid First', updated_at: 0 },
    { id: 'orchid-1', title: 'Orchid Second', updated_at: 0 },
  ] })))
  const onClose = vi.fn()
  await act(async () => root.render(<SearchDialog onClose={onClose} />))
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!
  typeQuery(input, 'Orchid')
  await act(() => vi.advanceTimersByTimeAsync(200))

  for (const key of ['Enter', 'ArrowDown', 'ArrowUp']) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...composition })
    act(() => input.dispatchEvent(event))
    expect(go).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(input.getAttribute('aria-activedescendant')).toBe('search-r-orchid-0')
    expect(event.defaultPrevented).toBe(false)
  }

  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(go).toHaveBeenCalledExactlyOnceWith({ page: 'doc', id: 'orchid-0' })
  expect(onClose).toHaveBeenCalledOnce()
})

it.each(['Catalpa', ''])('does not select previous results while the query is %j', async (query) => {
  const next = deferred<Response>()
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ results: [{ id: 'chestnut', title: 'Chestnut', updated_at: 0 }] }))
    .mockReturnValueOnce(next.promise))
  const onClose = vi.fn()
  await act(async () => root.render(<SearchDialog onClose={onClose} />))
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!
  typeQuery(input, 'Chestnut')
  await act(() => vi.advanceTimersByTimeAsync(200))
  expect(document.querySelector('[role="option"]')?.textContent).toContain('Chestnut')

  typeQuery(input, query)
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(go).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
  expect(document.querySelector('[role="option"]')).toBeNull()
  expect(input.getAttribute('aria-expanded')).toBe('false')
  expect(input.hasAttribute('aria-activedescendant')).toBe(false)

  if (!query) return
  await act(() => vi.advanceTimersByTimeAsync(200))
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(go).not.toHaveBeenCalled()
  await act(async () => next.resolve(Response.json({ results: [{ id: 'catalpa', title: 'Catalpa', updated_at: 0 }] })))
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(go).toHaveBeenCalledExactlyOnceWith({ page: 'doc', id: 'catalpa' })
})

it.each(['empty', 'error'])('does not restore previous results after an %s response', async (outcome) => {
  const next = deferred<Response>()
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ results: [{ id: 'chestnut', title: 'Chestnut', updated_at: 0 }] }))
    .mockReturnValueOnce(next.promise))
  const onClose = vi.fn()
  await act(async () => root.render(<SearchDialog onClose={onClose} />))
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!
  typeQuery(input, 'Chestnut')
  await act(() => vi.advanceTimersByTimeAsync(200))
  typeQuery(input, 'Catalpa')
  await act(() => vi.advanceTimersByTimeAsync(200))
  await act(async () => next.resolve(outcome === 'empty'
    ? Response.json({ results: [] })
    : Response.json({ error: 'unavailable' }, { status: 500 })))
  expect(document.querySelector('[role="option"]')).toBeNull()
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(go).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
})

it('scrolls the selected result into view when arrow keys wrap or advance', async () => {
  const scrollIntoView = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ results: Array.from({ length: 30 }, (_, i) => ({
    id: `orchid-${i}`, title: `Orchid ${i}`, updated_at: 0, folder_id: null, snippet: '', titleMatch: true,
  })) })))
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(scrollIntoView)
  try {
    await act(async () => root.render(<SearchDialog onClose={vi.fn()} />))
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!
    typeQuery(input, 'Orchid')
    await act(() => vi.advanceTimersByTimeAsync(200))

    for (const [key, id] of [['ArrowUp', 'orchid-29'], ['ArrowDown', 'orchid-0'], ['ArrowDown', 'orchid-1']]) {
      scrollIntoView.mockClear()
      act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
      const selected = document.querySelector('[aria-selected="true"]')!
      expect(selected.id).toBe(`search-r-${id}`)
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
      expect(scrollIntoView.mock.instances).toContain(selected)
    }
  } finally {
    scroll.mockRestore()
  }
})

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
