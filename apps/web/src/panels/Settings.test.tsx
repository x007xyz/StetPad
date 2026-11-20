// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { deferred } from '../lib/deferred.test-utils'
import { Settings } from './Settings'

vi.mock('../components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
it('keeps the latest preferences when saving overlaps the initial load', async () => {
  const a = deferred<Response>()
  const b = deferred<Response>()
  const requests = [a, b]
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    if (url === '/api/settings' && init.method !== 'PUT') return requests.shift()!.promise
    if (url === '/api/models') return Promise.resolve(Response.json({ models: [], default: null }))
    if (url === '/api/model-roles') return Promise.resolve(Response.json({ roles: [] }))
    if (url === '/api/clipper/tokens') return Promise.resolve(Response.json({ tokens: [] }))
    if (url === '/api/usage') return Promise.resolve(Response.json({ days: [], totals: {}, today: 0 }))
    return Promise.resolve(Response.json({}))
  }))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Settings onClose={vi.fn()} />))
    await act(async () => [...document.querySelectorAll('button')].find((b) => b.textContent === '保存')!.click())
    expect(requests).toHaveLength(0)
    await act(async () => b.resolve(Response.json({ preferences: 'B' })))
    expect(document.querySelector('textarea')?.value).toBe('B')
    await act(async () => a.resolve(Response.json({ preferences: 'A' })))
    expect(document.querySelector('textarea')?.value).toBe('B')
  } finally {
    act(() => root.unmount())
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  }
})
