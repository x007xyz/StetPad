// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deferred } from '../lib/deferred.test-utils'
import { useRuns } from './Ai'

let root: Root
let runs: ReturnType<typeof useRuns>
const finished = vi.fn()
function Panel() {
  runs = useRuns('doc', finished)
  return <><button onClick={() => runs.selectChat('a')}>A</button><button onClick={() => runs.selectChat('b')}>B</button>
    <output>{JSON.stringify(runs.history)}</output></>
}
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
  localStorage.clear()
})
it.each(['data', 'empty', 'error'] as const)('ignores stale chat history with %s', async (outcome) => {
  const a = deferred<Response>()
  const b = deferred<Response>()
  const fetchMock = vi.fn((url: string) => {
    if (url.endsWith('?chat=a')) return a.promise
    if (url.endsWith('?chat=b')) return b.promise
    if (url.endsWith('/models')) return Promise.resolve(Response.json({ models: [], default: null }))
    if (url.endsWith('/chats')) return Promise.resolve(Response.json({ chats: [] }))
    return Promise.resolve(Response.json({ runs: [], active: null }))
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<Panel />))
  act(() => document.querySelectorAll('button')[0]!.click())
  act(() => document.querySelectorAll('button')[1]!.click())
  expect(fetchMock).toHaveBeenCalledWith('/api/docs/doc/runs?chat=a', expect.anything())
  expect(fetchMock).toHaveBeenCalledWith('/api/docs/doc/runs?chat=b', expect.anything())
  await act(async () => b.resolve(Response.json({ runs: [{ id: 'B' }], knownRunIds: ['B'] })))
  expect(document.querySelector('output')!.textContent).toContain('B')
  await act(async () => outcome === 'error' ? a.reject(new Error('stale'))
    : a.resolve(Response.json({ runs: outcome === 'empty' ? [] : [{ id: 'A' }], knownRunIds: ['A'] })))
  expect(document.querySelector('output')!.textContent).toBe('[{"id":"B"}]')
  expect(runs.knownRunIds).toEqual(['B'])
  expect(runs.chatId).toBe('b')
  expect(runs.error).toBe('')
})
