// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deferred } from '../lib/deferred.test-utils'
import { Providers } from './Providers'

vi.mock('../components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})
function click(label: string) {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent === label)!
  expect(button.disabled).toBe(false)
  act(() => button.click())
}
async function setup() {
  const a = deferred<Response>()
  const b = deferred<Response>()
  const requests = [a, b]
  const fetchMock = vi.fn((url: string) => {
    if (url.endsWith('/balance')) return requests.shift()!.promise
    if (url.endsWith('/models')) return Promise.resolve(Response.json({ default: null, providerList:
      ['deepseek', 'openrouter'].map((id) => ({ id, name: id, builtin: true, baseURL: `https://api.${id}.com`,
        keySource: 'saved', enabled: true, currency: 'USD', models: [] })) }))
    if (url.endsWith('/usage')) return Promise.resolve(Response.json({ days: [] }))
    return Promise.resolve(Response.json({ catalog: [] }))
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<Providers onClose={vi.fn()} onChanged={vi.fn()} />))
  return { a, b, requests }
}
it.each(['data', 'empty', 'error'] as const)('keeps another provider balance when an earlier provider returns %s', async (outcome) => {
  const { a, b, requests } = await setup()
  click('查询余额')
  act(() => document.querySelectorAll<HTMLButtonElement>('.prov-item')[1]!.click())
  click('查询余额')
  expect(requests).toHaveLength(0)
  await act(async () => b.resolve(Response.json({ items: [{ label: 'Balance', value: 'B' }] })))
  expect(document.body.textContent).toContain('Balance：B')
  await act(async () => outcome === 'error' ? a.reject(new Error('stale error'))
    : a.resolve(Response.json({ items: outcome === 'empty' ? [] : [{ label: 'Balance', value: 'A' }] })))
  expect(document.body.textContent).toContain('Balance：B')
  expect(document.body.textContent).not.toContain('Balance：A')
  expect(document.body.textContent).not.toContain('查询中')
  expect(document.body.textContent).not.toContain('stale error')
})
