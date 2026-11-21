// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { deferred } from '../lib/deferred.test-utils'
import { VersionsMenu } from './Versions'
import { ConfirmHost } from '../components/confirm'
import { alignBlocks } from './DiffView'
import type { RichBlock } from '../api'

vi.mock('../components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverContent: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../components/ui/tooltip', () => ({ Tip: ({ children }: { children: ReactNode }) => children }))
vi.mock('./DiffView', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./DiffView')>()
  return { ...actual, alignBlocks: vi.fn(actual.alignBlocks) }
})

it('restores a version only after accepting the in-app dialog', async () => {
  const version = { id: 'v1', label: 'First draft', trigger: 'manual', created_at: 0, word_count: 1 }
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json([version])))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const click = (parent: ParentNode, label: string) => act(async () => {
    Array.from(parent.querySelectorAll('button')).find((button) => button.textContent === label)!.click()
  })
  try {
    await act(async () => root.render(<><ConfirmHost /><VersionsMenu docId="doc" refreshKey={0} current={() => []} /></>))
    await click(container, '恢复')
    expect(nativeConfirm).not.toHaveBeenCalled()
    const dialog = () => document.querySelector('[role="dialog"]')!
    expect(dialog().textContent).toContain('First draft')
    await click(dialog(), '取消')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await click(container, '恢复')
    await click(dialog(), '恢复')
    expect(fetchMock).toHaveBeenCalledWith('/api/versions/v1/restore', expect.objectContaining({ method: 'POST' }))
  } finally {
    act(() => root.unmount())
    container.remove()
    nativeConfirm.mockRestore()
    vi.unstubAllGlobals()
  }
})

it.each([
  ['save', 'New name'], ['rename', 'New name'], ['save', ''], ['rename', ''], ['save', null], ['rename', null],
] as const)('can %s a version with label %s without Electron native prompts', async (action, label) => {
  const version = { id: 'v1', label: 'Old name', trigger: 'manual', created_at: 0, word_count: 1 }
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json([version])))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const prompt = vi.spyOn(window, 'prompt').mockImplementation(() => { throw new Error('prompt() is not supported.') })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<><ConfirmHost /><VersionsMenu docId="doc" refreshKey={0} current={() => []} /></>))
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === (action === 'save' ? '保存当前版本' : '命名'))!
    await act(async () => button.click())
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')
    expect(input).not.toBeNull()
    expect(input!.value).toBe(action === 'save' ? '' : 'Old name')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, label ?? '')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === (label === null ? '取消' : '保存'))!.click())
    if (label === null) expect(fetchMock).toHaveBeenCalledTimes(1)
    else expect(fetchMock).toHaveBeenCalledWith(action === 'save' ? '/api/docs/doc/versions' : '/api/versions/v1', expect.objectContaining({
      method: action === 'save' ? 'POST' : 'PATCH', body: JSON.stringify({ label }),
    }))
    expect(prompt).not.toHaveBeenCalled()
  } finally {
    act(() => root.unmount())
    container.remove()
    prompt.mockRestore()
    vi.unstubAllGlobals()
  }
})

it.each([
  ['the same document refreshes', 'doc', 1],
  ['the document changes', 'other-doc', 0],
] as const)('keeps the latest version list when %s', async (_, docId, refreshKey) => {
  const a = deferred<Response>()
  const b = deferred<Response>()
  const fetchMock = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const current = () => []
  const names = () => [...container.querySelectorAll('.v-name')].map((row) => row.textContent)
  try {
    await act(async () => root.render(<VersionsMenu docId="doc" refreshKey={0} current={current} />))
    await act(async () => root.render(<VersionsMenu docId={docId} refreshKey={refreshKey} current={current} />))
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/docs/doc/versions', `/api/docs/${docId}/versions`])
    const version = (id: string) => ({ id, label: id, trigger: 'manual', created_at: 0, word_count: 1 })
    await act(async () => b.resolve(Response.json([version('B')])))
    expect(names()).toEqual(['B'])
    await act(async () => a.resolve(Response.json([version('A')])))
    expect(names()).toEqual(['B'])
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

it('aligns a compared version pair once and only refilters when toggling changed paragraphs', async () => {
  const paragraph = (id: string, text: string): RichBlock => ({ blockId: id, type: 'paragraph', text, attrs: {}, delta: [{ insert: text }] })
  const saved = [paragraph('a', 'Same'), paragraph('b', 'Old')]
  const version = { id: 'v1', label: 'First draft', trigger: 'manual', created_at: 0, word_count: 2 }
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => Promise.resolve(Response.json(
    url === '/api/versions/v1' ? { ...version, content: { revised: saved, original: saved } } : [version],
  ))))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.mocked(alignBlocks).mockClear()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const current = () => [paragraph('a', 'Same'), paragraph('b', 'New')]
  const rows = () => document.querySelectorAll('[role="dialog"] .diff-row').length
  try {
    await act(async () => root.render(<VersionsMenu docId="doc" refreshKey={0} current={current} />))
    await act(async () => container.querySelector<HTMLInputElement>('.version input')!.click())
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === '与当前文档对比')!.click())
    expect(rows()).toBe(1)
    const onlyChanged = document.querySelector<HTMLInputElement>('[role="dialog"] label input')!
    await act(async () => onlyChanged.click())
    expect(rows()).toBe(2)
    await act(async () => onlyChanged.click())
    expect(rows()).toBe(1)
    expect(alignBlocks).toHaveBeenCalledTimes(1)
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

it('tells the user when saving creates no new version because nothing changed', async () => {
  const version = { id: 'v1', label: null, trigger: 'manual', created_at: 0, word_count: 1 }
  const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
    Promise.resolve(Response.json(init?.method === 'POST' ? { id: null } : [version])))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<><ConfirmHost /><VersionsMenu docId="doc" refreshKey={0} current={() => []} /></>))
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === '保存当前版本')!.click())
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === '保存')!.click())
    expect(fetchMock).toHaveBeenCalledWith('/api/docs/doc/versions', expect.objectContaining({ method: 'POST' }))
    expect(container.querySelector('[role="status"]')?.textContent).toBe('自上个版本以来没有改动，未保存新版本。')
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
