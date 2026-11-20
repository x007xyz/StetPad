// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { deferred } from '../lib/deferred.test-utils'
import { ImageEditDialog } from './ImageEditDialog'

vi.mock('../components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? children : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
it.each(['success', 'error'] as const)('ignores the old image fetch %s after the source changes', async (outcome) => {
  const a = deferred<Response>()
  const b = deferred<Response>()
  const fetchMock = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const objectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:latest')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    const render = async (src: string) => {
      await act(async () => root.render(<ImageEditDialog docId="doc" src={src} open onClose={vi.fn()} onSaved={vi.fn()} />))
    }
    await render('/A.png')
    await render('/B.png')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await act(async () => b.reject(new Error('latest error')))
    expect(document.body.textContent).toContain('latest error')
    await act(async () => outcome === 'success' ? a.resolve(new Response(new Blob(['A'], { type: 'image/png' }))) : a.reject(new Error('stale error')))
    expect(objectUrl).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('latest error')
    expect(document.body.textContent).not.toContain('stale error')
  } finally {
    act(() => root.unmount())
    document.body.replaceChildren()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  }
})
