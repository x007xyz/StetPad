// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deferred } from './lib/deferred.test-utils'
import { FolderPage } from './FolderPage'

const workspace = vi.hoisted(() => ({ docs: [] as unknown[], notify: vi.fn(), reload: vi.fn() }))
vi.mock('./Shell', () => ({ useWorkspaceOptional: () => workspace, SidebarToggle: () => null }))
vi.mock('y-indexeddb', () => ({ IndexeddbPersistence: class { destroy() {} } }))
vi.mock('@hocuspocus/provider', () => ({ HocuspocusProvider: class { destroy() {} } }))

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let title: string
const folder = (id: string, empty = false) => ({ id, name: `${id} folder`, docs: empty ? [] : [{ id, title: `${id} document` }] })

beforeEach(() => {
  workspace.docs = []
  workspace.notify.mockReset()
  workspace.reload.mockReset()
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  title = document.title
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  document.title = title
  vi.unstubAllGlobals()
})

it.each(['no model', '400', 'network', 'success', 'empty', 'no documents'] as const)('preserves the folder composer unless a run starts: %s', async (outcome) => {
  HTMLElement.prototype.scrollIntoView = vi.fn()
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/models')) return Promise.resolve(Response.json({ models: outcome === 'no model' ? [] : [{ id: 'test', label: 'Test', verified: true }], default: 'test' }))
    if (url === '/api/folders/a') return Promise.resolve(Response.json(folder('a', outcome === 'no documents')))
    if (url.endsWith('/runs') && init?.method === 'POST') {
      if (outcome === 'network') return Promise.reject(new Error('Network unavailable'))
      return Promise.resolve(outcome === 'success' ? Response.json({ runId: 'run' }) : Response.json({ error: 'Cannot start' }, { status: 400 }))
    }
    if (url.endsWith('/events')) return new Promise<Response>(() => {})
    return Promise.resolve(Response.json({ runs: [], active: null }))
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<FolderPage id="a" />))
  const area = container.querySelector('textarea')!
  const draft = outcome === 'empty' ? '   ' : 'Keep my draft'
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, draft)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const send = [...container.querySelectorAll('button')].find((button) => button.textContent === '发送')!
  const blocked = outcome === 'no model' || outcome === 'empty' || outcome === 'no documents'
  expect(send.disabled).toBe(blocked)
  await act(async () => area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(area.value).toBe(outcome === 'success' ? '' : draft)
  const posts = fetchMock.mock.calls.filter(([url, init]) => url.endsWith('/runs') && init?.method === 'POST')
  expect(posts).toHaveLength(blocked ? 0 : 1)
})

it.each(['success', 'empty', 'error'])('ignores a stale folder %s after keyed navigation', async (stale) => {
  const a = deferred<Response>()
  const b = deferred<Response>()
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/folders/a') return a.promise
    if (url === '/api/folders/b') return b.promise
    return Promise.resolve(Response.json({ runs: [], active: null, models: [] }))
  }))
  await act(async () => root.render(<FolderPage key="a" id="a" />))
  await act(async () => root.render(<FolderPage key="b" id="b" />))
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
})

it.each(['success', 'empty', 'error'])('ignores a stale %s workspace reload of the same folder', async (stale) => {
  const a = deferred<Response>()
  const b = deferred<Response>()
  const requests = [a, b]
  vi.stubGlobal('fetch', vi.fn((url: string) => url === '/api/folders/a'
    ? requests.shift()!.promise
    : Promise.resolve(Response.json({ runs: [], active: null, models: [] }))))
  await act(async () => root.render(<FolderPage key="a" id="a" />))
  workspace.docs = [{}]
  await act(async () => root.render(<FolderPage key="a" id="a" />))
  expect(requests).toHaveLength(0)
  await act(async () => b.resolve(Response.json({ ...folder('a'), docs: folder('new').docs })))
  expect(container.textContent).toContain('new document')
  await act(async () => {
    if (stale === 'error') a.reject(new Error('stale failure'))
    else a.resolve(Response.json(folder('a', stale === 'empty')))
  })
  expect(container.textContent).toContain('new document')
  expect(container.textContent).not.toContain('a document')
  expect(container.textContent).not.toContain('找不到这个文件夹')
})

it.each(['http', 'network', 'success'] as const)('handles a folder rename in the header (%s)', async (outcome) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/folders/a' && init?.method === 'PATCH') {
      if (outcome === 'network') throw new TypeError('Failed to fetch')
      return outcome === 'http' ? Response.json({ error: 'Internal error' }, { status: 500 }) : Response.json({ ok: true })
    }
    if (url === '/api/folders/a') return Response.json(folder('a'))
    return Response.json({ runs: [], active: null, models: [] })
  }))
  await act(async () => root.render(<FolderPage id="a" />))
  const input = container.querySelector<HTMLInputElement>('input[aria-label="文件夹名称"]')!
  expect(input.value).toBe('a folder')
  input.value = 'Renamed'
  await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  const saved = outcome === 'success' ? 'Renamed' : 'a folder'
  expect(container.querySelector<HTMLInputElement>('input[aria-label="文件夹名称"]')!.value).toBe(saved)
  expect(container.querySelector('h1')?.textContent).toBe(saved)
  expect(document.title).toBe(saved)
  if (outcome === 'success') {
    expect(workspace.notify).not.toHaveBeenCalled()
    expect(workspace.reload).toHaveBeenCalledOnce()
  } else {
    expect(workspace.notify).toHaveBeenCalledWith('文件夹名称保存失败，请重试。', { error: true })
    expect(workspace.reload).not.toHaveBeenCalled()
  }
})
