// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { Home } from './Home'
import { deferred } from './lib/deferred.test-utils'

vi.mock('./Shell', () => ({ useWorkspace: () => ({ docs: [], createDoc: vi.fn() }), SidebarToggle: () => null }))
vi.mock('./App', () => ({ go: vi.fn() }))

it.each(['preview', 'empty', 'error'])('keeps the latest import preview after a stale %s response', async (stale) => {
  const a = deferred<Response>()
  const b = deferred<Response>()
  const requests = [a, b]
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => requests.shift()!.promise))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Home />))
    const input = container.querySelector('input[type="file"]')!
    const select = (name: string) => {
      Object.defineProperty(input, 'files', { configurable: true, value: [new File(['content'], name)] })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }
    await act(async () => select('A.txt'))
    await act(async () => select('B.txt'))
    expect(requests).toHaveLength(0)
    await act(async () => b.resolve(Response.json({ title: 'B preview', blocks: [] })))
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe('B preview')
    await act(async () => {
      if (stale === 'error') a.reject(new Error('stale failure'))
      else a.resolve(Response.json({ title: 'A preview', blocks: stale === 'empty' ? [] : [{ type: 'paragraph', attrs: {}, delta: [{ insert: 'A content' }] }] }))
    })
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe('B preview')
    expect(container.textContent).not.toContain('stale failure')
    expect(document.body.textContent).not.toContain('A content')
  } finally {
    act(() => root.unmount())
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  }
})
