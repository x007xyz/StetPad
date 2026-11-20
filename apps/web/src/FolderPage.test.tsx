// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { deferred } from './lib/deferred.test-utils'
import { FolderPage } from './FolderPage'

vi.mock('./Shell', () => ({ useWorkspaceOptional: () => null, SidebarToggle: () => null }))
vi.mock('y-indexeddb', () => ({ IndexeddbPersistence: class { destroy() {} } }))
vi.mock('@hocuspocus/provider', () => ({ HocuspocusProvider: class { destroy() {} } }))

it.each(['success', 'empty', 'error'])('ignores a stale folder %s after navigation', async (stale) => {
  const a = deferred<Response>()
  const b = deferred<Response>()
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/folders/a') return a.promise
    if (url === '/api/folders/b') return b.promise
    return Promise.resolve(Response.json({ runs: [], active: null, models: [] }))
  }))
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const title = document.title
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const folder = (id: string, empty = false) => ({ id, name: `${id} folder`, docs: empty ? [] : [{ id, title: `${id} document` }] })
  try {
    await act(async () => root.render(<FolderPage id="a" />))
    await act(async () => root.render(<FolderPage id="b" />))
    await act(async () => b.resolve(Response.json(folder('b'))))
    expect(container.querySelector('h1')?.textContent).toBe('b folder')
    expect(container.textContent).toContain('b document')
    await act(async () => {
      if (stale === 'error') a.reject(new Error('stale failure'))
      else a.resolve(Response.json(folder('a', stale === 'empty')))
    })
    expect(container.querySelector('h1')?.textContent).toBe('b folder')
    expect(container.querySelector<HTMLInputElement>('input[aria-label="文件夹名称"]')?.value).toBe('b folder')
    expect(document.title).toBe('b folder')
    expect(container.textContent).toContain('b document')
    expect(container.textContent).not.toContain('a document')
    expect(container.textContent).not.toContain('找不到这个文件夹')
  } finally {
    act(() => root.unmount())
    document.body.replaceChildren()
    document.title = title
    vi.unstubAllGlobals()
  }
})
