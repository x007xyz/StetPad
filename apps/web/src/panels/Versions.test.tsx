// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { deferred } from '../lib/deferred.test-utils'
import { VersionsMenu } from './Versions'

vi.mock('../components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverContent: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../components/ui/tooltip', () => ({ Tip: ({ children }: { children: ReactNode }) => children }))

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
