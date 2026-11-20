// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { deferred } from './lib/deferred.test-utils'
import { TrashPage } from './TrashPage'

vi.mock('./Shell', () => ({ useWorkspace: () => ({ reload: vi.fn() }), SidebarToggle: () => null }))
it('keeps the latest trash list after overlapping restores reload it', async () => {
  const a = deferred<Response>()
  const b = deferred<Response>()
  const requests = [a, b]
  const doc = (id: string) => ({ id, title: `${id} document`, deleted_at: 0 })
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json([doc('first'), doc('second')]))
    .mockImplementation((url: string) => url === '/api/trash' ? requests.shift()!.promise : Promise.resolve(Response.json({})))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<TrashPage />))
    const restore = [...document.querySelectorAll('button')].filter((b) => b.textContent === '恢复')
    await act(async () => restore[0]!.click())
    expect(restore[1]!.disabled).toBe(false)
    await act(async () => restore[1]!.click())
    expect(requests).toHaveLength(0)
    await act(async () => b.resolve(Response.json([])))
    expect(document.body.textContent).toContain('回收站是空的')
    await act(async () => a.resolve(Response.json([doc('second')])))
    expect(document.body.textContent).toContain('回收站是空的')
    expect(document.body.textContent).not.toContain('second document')
  } finally {
    act(() => root.unmount())
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  }
})

it.each(['empty', 'error'])('ignores a stale %s reload after the latest list loads', async (stale) => {
  const a = deferred<Response>()
  const b = deferred<Response>()
  const requests = [a, b]
  const doc = (id: string) => ({ id, title: `${id} document`, deleted_at: 0 })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json([doc('first'), doc('second')]))
    .mockImplementation((url: string) => url === '/api/trash' ? requests.shift()!.promise : Promise.resolve(Response.json({}))))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<TrashPage />))
    const restore = [...container.querySelectorAll('button')].filter((button) => button.textContent === '恢复')
    await act(async () => restore[0]!.click())
    await act(async () => restore[1]!.click())
    await act(async () => b.resolve(Response.json([doc('remaining')])))
    expect(container.textContent).toContain('remaining document')
    await act(async () => {
      if (stale === 'error') a.reject(new Error('stale failure'))
      else a.resolve(Response.json([]))
    })
    expect(container.textContent).toContain('remaining document')
    expect(container.textContent).not.toContain('回收站是空的')
    expect(container.textContent).not.toContain('stale failure')
  } finally {
    act(() => root.unmount())
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  }
})
