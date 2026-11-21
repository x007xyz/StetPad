// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deferred } from '../lib/deferred.test-utils'
import { AiPanel, useRuns, type ContextItem } from './Ai'
import { TooltipProvider } from '../components/ui/tooltip'

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

function Composer() {
  const state = useRuns('composer', finished)
  const [refs, setRefs] = useState<ContextItem[]>([{ id: 'ref', kind: 'text', label: 'Reference', text: 'Reference text', blockIds: [] }])
  return <TooltipProvider><AiPanel docId="composer" runs={state} changes={[]} decided={[]} blockText={() => ''}
    onDecide={() => {}} onFocus={() => {}} refs={refs} setRefs={setRefs} comments={[]} listBlocks={() => []} focusSignal={0} /></TooltipProvider>
}

it.each(['no model', '400', 'network', 'success', 'empty'] as const)('preserves the composer unless a run starts: %s', async (outcome) => {
  HTMLElement.prototype.scrollIntoView = vi.fn()
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/models')) return Promise.resolve(Response.json({ models: outcome === 'no model' ? [] : [{ id: 'test', label: 'Test', verified: true }], default: 'test' }))
    if (url.endsWith('/chats') && init?.method === 'POST') return Promise.resolve(Response.json({ chat: { id: 'new-chat', title: '', runs: 0 } }))
    if (url.endsWith('/chats')) return Promise.resolve(Response.json({ chats: [] }))
    if (url.endsWith('/runs') && init?.method === 'POST') {
      if (outcome === 'network') return Promise.reject(new Error('Network unavailable'))
      return Promise.resolve(outcome === 'success' ? Response.json({ runId: 'run' }) : Response.json({ error: 'Cannot start' }, { status: 400 }))
    }
    if (url.endsWith('/events')) return new Promise<Response>(() => {})
    return Promise.resolve(Response.json({ runs: [], knownRunIds: [], active: null }))
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<Composer />))
  const area = document.querySelector('textarea')!
  const draft = outcome === 'empty' ? '   ' : 'Keep my draft'
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, draft)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const send = document.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!
  expect(send.disabled).toBe(outcome === 'no model' || outcome === 'empty')
  await act(async () => area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(area.value).toBe(outcome === 'success' ? '' : draft)
  expect(document.querySelectorAll('.ref-chip')).toHaveLength(outcome === 'success' ? 0 : 1)
  const posts = fetchMock.mock.calls.filter(([url, init]) => url.endsWith('/runs') && init?.method === 'POST')
  expect(posts).toHaveLength(outcome === 'no model' || outcome === 'empty' ? 0 : 1)
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
