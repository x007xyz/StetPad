// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { DocPage } from './DocPage'
import { FolderPage } from './FolderPage'
import { Shell } from './Shell'

vi.mock('./App', () => ({ go: vi.fn() }))
vi.mock('@hocuspocus/provider', () => ({ HocuspocusProvider: class { destroy() {} } }))
vi.mock('y-indexeddb', () => ({ IndexeddbPersistence: class { destroy() {} } }))

it.each(['doc', 'folder'].flatMap((view) => ['http', 'network', 'success', 'empty', 'unchanged'].map((result) => ({ view, result }))))('handles title saves in the $view view ($result)', async ({ view, result }) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  const alert = vi.fn()
  vi.stubGlobal('alert', alert)
  const doc = { id: 'doc1', title: 'Saved title', created_at: 1, updated_at: 1 }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      if (result === 'network') throw new TypeError('Failed to fetch')
      return result === 'http' ? Response.json({ error: 'Internal error' }, { status: 500 }) : Response.json({ ok: true })
    }
    if (url === '/api/docs/doc1') return Response.json(doc)
    if (url === '/api/docs' || url === '/api/folders') return Response.json([])
    if (url === '/api/folders/folder1') return Response.json({ id: 'folder1', name: 'Folder', docs: [doc] })
    if (url === '/api/folders/folder1/runs') return Response.json({ active: null, runs: [] })
    if (url.includes('/versions') || url.includes('/chats') || url.includes('/runs')) return Response.json([])
    return Response.json({ models: [], presets: [], runs: [], chats: [] })
  }))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Shell session={{ user: { id: 'me', email: '' } }}>{view === 'doc' ? <DocPage id="doc1" /> : <FolderPage id="folder1" />}</Shell>))
    const input = container.querySelector<HTMLInputElement>(view === 'doc' ? 'input[aria-label="文档标题"]' : 'input[id="doc-title-doc1"]')!
    expect(input.value).toBe('Saved title')
    input.value = result === 'empty' ? '' : result === 'unchanged' ? 'Saved title' : 'New title'
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    if (result === 'http' || result === 'network') {
      expect(input.value).toBe('Saved title')
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('标题保存失败，请重试。')
    } else {
      expect(alert).not.toHaveBeenCalled()
      if (view === 'doc') expect(container.querySelector<HTMLInputElement>('input[aria-label="文档标题"]')!.value).toBe(result === 'empty' ? '未命名文档' : result === 'unchanged' ? 'Saved title' : 'New title')
    }
    expect(alert).not.toHaveBeenCalled()
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
