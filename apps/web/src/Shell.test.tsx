// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { DocMeta, Folder } from './api'
import { go } from './App'
import { deferred } from './lib/deferred.test-utils'
import { Shell, useWorkspace } from './Shell'

vi.mock('./App', () => ({ go: vi.fn() }))

it.each(['http', 'network', 'success'])('handles document creation (%s)', async (result) => {
  vi.mocked(go).mockClear()
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return Response.json([])
    if (result === 'network') throw new TypeError('Failed to fetch')
    return result === 'http'
      ? Response.json({ error: 'Creation failed' }, { status: 500 })
      : Response.json({ id: 'new-doc' })
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let createDoc!: () => Promise<void>
  function Consumer() {
    createDoc = useWorkspace().createDoc
    return null
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Shell session={{ user: { id: 'me', email: '' } }}><Consumer /></Shell>))
    await act(async () => {
      await expect(createDoc()).resolves.toBeUndefined()
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/docs', expect.objectContaining({ method: 'POST' }))
    if (result === 'success') {
      expect(go).toHaveBeenCalledWith({ page: 'doc', id: 'new-doc' })
      expect(container.querySelector('[role="alert"]')).toBeNull()
    } else {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('新建文档失败，请重试。')
      expect(go).not.toHaveBeenCalled()
    }
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

it.each([
  ['Linux x86_64', 'Ctrl K'],
  ['Win32', 'Ctrl K'],
  ['MacIntel', '⌘K'],
  ['iPhone', '⌘K'],
  ['iPad', '⌘K'],
  ['', 'Ctrl K'],
])('shows the search shortcut for platform %s', async (platform, hint) => {
  vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue(platform)
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([])))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Shell session={{ user: { id: 'me', email: '' } }}>Content</Shell>))
    expect(container.querySelector('kbd')?.textContent).toBe(hint)
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

function sidebarSnapshot(id: string, title: string, folderName: string) {
  const docs = deferred<Response>()
  const folders = deferred<Response>()
  const folder: Folder = { id: `folder-${id}`, name: folderName, created_at: 0 }
  const doc: DocMeta = { id, title, folder_id: folder.id, created_at: 0, updated_at: 0 }
  return {
    docs,
    folders,
    resolve() {
      docs.resolve(Response.json([doc]))
      folders.resolve(Response.json([folder]))
    },
  }
}

it('keeps the latest sidebar documents and folders after navigation', async () => {
  const old = sidebarSnapshot('a', 'Old document', 'Old folder')
  const latest = sidebarSnapshot('b', 'New document', 'New folder')
  const requests = {
    '/api/docs': [old.docs.promise, latest.docs.promise],
    '/api/folders': [old.folders.promise, latest.folders.promise],
  }
  vi.stubGlobal('fetch', vi.fn((url: keyof typeof requests) => {
    const response = requests[url]?.shift()
    if (!response) throw new Error(`Unexpected request: ${url}`)
    return response
  }))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const session = { user: { id: 'me', email: '' } }
  try {
    await act(async () => root.render(<Shell session={session} activeId="a">Content</Shell>))
    await act(async () => root.render(<Shell session={session} activeId="b">Content</Shell>))
    const sidebar = container.querySelector('nav[aria-label="文档"]')!
    const expectLatest = () => {
      const folder = sidebar.querySelector('[aria-label="文件夹 New folder"]')
      expect(folder?.querySelector('button[aria-current="page"]')?.textContent).toBe('New document')
      expect(sidebar.textContent).not.toContain('Old document')
      expect(sidebar.querySelector('[aria-label="文件夹 Old folder"]')).toBeNull()
    }
    await act(async () => latest.resolve())
    expectLatest()
    await act(async () => old.resolve())
    expectLatest()
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

it.each(['http', 'network', 'success'] as const)('handles a folder rename in the sidebar (%s)', async (outcome) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let name = 'Saved folder'
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/folders/f1' && init?.method === 'PATCH') {
      if (outcome === 'network') throw new TypeError('Failed to fetch')
      if (outcome === 'http') return Response.json({ error: 'Internal error' }, { status: 500 })
      name = (JSON.parse(String(init.body)) as { name: string }).name
      return Response.json({ ok: true })
    }
    if (url === '/api/folders') return Response.json([{ id: 'f1', name, created_at: 0 }])
    return Response.json([])
  }))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Shell session={{ user: { id: 'me', email: '' } }}>Content</Shell>))
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="重命名 Saved folder"]')!.click())
    const input = container.querySelector<HTMLInputElement>('input[aria-label="文件夹名称"]')!
    input.value = 'Renamed'
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    const alert = container.querySelector('[role="alert"]')?.textContent ?? ''
    if (outcome === 'success') {
      expect(container.querySelector('li[aria-label="文件夹 Renamed"]')).not.toBeNull()
      expect(alert).not.toContain('文件夹名称保存失败')
    } else {
      expect(container.querySelector('li[aria-label="文件夹 Saved folder"]')).not.toBeNull()
      expect(alert).toContain('文件夹名称保存失败，请重试。')
    }
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
