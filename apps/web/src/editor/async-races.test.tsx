// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deferred } from '../lib/deferred.test-utils'
import { AiDiagramDialog } from './AiDiagramDialog'
import { AiImageDialog } from './AiImageDialog'
import { AiImageEditDialog } from './AiImageEditDialog'

vi.mock('../components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? children : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('../components/ui/select', () => ({
  Select: ({ options, value, onValueChange, ...props }: {
    options: { value: string; label: string }[]; value: string; onValueChange(v: string): void
  }) => <select {...props} value={value} onChange={(e) => onValueChange(e.target.value)}>
    {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
  </select>,
}))
vi.mock('./diagram', () => ({ renderMath: (s: string) => `<svg>${s}</svg>`, renderMermaid: (s: string) => Promise.resolve(`<svg>${s}</svg>`) }))

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
function typePrompt(value: string) {
  const input = document.querySelector('textarea')!
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
  act(() => input.dispatchEvent(new Event('input', { bubbles: true })))
}

it.each(['success', 'error'] as const)('keeps the latest diagram after an old %s response', async (outcome) => {
  const a = deferred<Response>()
  const b = deferred<Response>()
  const fetchMock = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
  vi.stubGlobal('fetch', fetchMock)
  const render = async (open: boolean, prompt: string) => {
    await act(async () => root.render(<AiDiagramDialog docId="doc" open={open}
      initial={{ kind: 'math', prompt, previous: 'broken', error: 'syntax' }} onClose={vi.fn()} onInsert={vi.fn()} />))
  }
  await render(true, 'A')
  await render(false, 'A')
  await render(true, 'B')
  expect(fetchMock).toHaveBeenCalledTimes(2)
  await act(async () => b.resolve(Response.json({ source: 'B' })))
  expect(document.querySelector('pre')?.textContent).toBe('B')
  await act(async () => outcome === 'success' ? a.resolve(Response.json({ source: 'A' })) : a.reject(new Error('stale error')))
  expect(document.querySelector('pre')?.textContent).toBe('B')
  expect(document.body.textContent).not.toContain('stale error')
  expect(document.body.textContent).not.toContain('生成中')
})

it.each([
  ['generate', 'success'], ['generate', 'error'], ['edit', 'success'], ['edit', 'error'],
] as const)('keeps the latest image after cancelling an earlier %s request with %s', async (mode, outcome) => {
  const a = deferred<Response>()
  const b = deferred<Response>()
  const requests = [a, b]
  const fetchMock = vi.fn((url: string) => url.endsWith('-models')
    ? Promise.resolve(Response.json({ models: [{ id: 'model', label: 'Model' }], default: 'model' }))
    : requests.shift()!.promise)
  vi.stubGlobal('fetch', fetchMock)
  const render = async (open: boolean) => {
    await act(async () => root.render(mode === 'generate'
      ? <AiImageDialog docId="doc" open={open} onClose={vi.fn()} onInsert={vi.fn()} />
      : <AiImageEditDialog docId="doc" src="/original.png" open={open} onClose={vi.fn()} onInsert={vi.fn()} onReplace={vi.fn()} />))
  }
  await render(true)
  typePrompt('A')
  click(mode === 'generate' ? '生成' : '改图')
  await render(false)
  await render(true)
  typePrompt('B')
  click(mode === 'generate' ? '生成' : '改图')
  expect(requests).toHaveLength(0)
  await act(async () => b.resolve(Response.json({ url: '/B.png' })))
  expect(document.querySelector('img[src="/B.png"]')).not.toBeNull()
  await act(async () => outcome === 'success' ? a.resolve(Response.json({ url: '/A.png' })) : a.reject(new Error('stale error')))
  expect(document.querySelector('img[src="/B.png"]')).not.toBeNull()
  expect(document.querySelector('img[src="/A.png"]')).toBeNull()
  expect(document.body.textContent).not.toMatch(/生成中|编辑中|stale error/)
})
