// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { DocPage } from './DocPage'
import type { AiPanel } from './panels/Ai'

const { start } = vi.hoisted(() => ({ start: vi.fn(async (_req, _title, onStarted?: () => void) => { onStarted?.() }) }))
vi.mock('./Shell', () => ({ useWorkspaceOptional: () => null, SidebarToggle: () => null }))
vi.mock('@hocuspocus/provider', () => ({ HocuspocusProvider: class { destroy() {} } }))
vi.mock('y-indexeddb', () => ({ IndexeddbPersistence: class { destroy() {} } }))
vi.mock('./panels/Ai', async (original) => {
  const mod = await original<typeof import('./panels/Ai')>()
  return { ...mod, AiPanel: (props: ComponentProps<typeof AiPanel>) => <>
    <button onClick={() => props.runs.selectChat('a')}>Chat A</button>
    <button onClick={() => props.runs.selectChat('b')}>Chat B</button>
    <button onClick={() => props.setRefs((cur) => [...cur, {
      id: props.runs.chatId!, kind: 'text', label: `Reference ${props.runs.chatId}`, text: 'selected text', blockIds: [],
    }])}>Attach selection</button>
    <mod.AiPanel {...props} runs={{ ...props.runs, start }} />
  </> }
})

it('keeps references with their chat draft and clears only the sent chat', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(Response.json(
    url.endsWith('/versions') ? []
      : url.endsWith('/models') ? { models: [{ id: 'test', label: 'Test model', verified: true }], presets: [], default: 'test' }
      : url.endsWith('/chats') ? { chats: [] }
        : url.includes('/runs?') ? { runs: [], knownRunIds: [], active: null }
          : { id: 'doc', title: 'Document' },
  ))))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const click = async (label: string) => {
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label)!
    expect(button).toBeDefined()
    await act(async () => button.click())
  }
  const chips = () => [...container.querySelectorAll('.ref-chip')].map((el) => el.textContent)
  const send = async (text: string) => {
    const area = container.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text)
    act(() => area.dispatchEvent(new Event('input', { bubbles: true })))
    await act(async () => area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  }
  try {
    await act(async () => root.render(<DocPage id="doc" />))
    await click('AI')
    await click('Chat A')
    await click('Attach selection')
    expect(chips()).toEqual(['Reference a'])
    await click('Chat B')
    expect(chips()).toEqual([])
    await send('')
    expect(start).not.toHaveBeenCalled()
    await click('Attach selection')
    await click('Chat A')
    expect(chips()).toEqual(['Reference a'])
    await send('Revise A')
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ context: [expect.objectContaining({ id: 'a' })] }), expect.any(String), expect.any(Function))
    expect(chips()).toEqual([])
    await click('Chat B')
    expect(chips()).toEqual(['Reference b'])
    await send('Revise B')
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ context: [expect.objectContaining({ id: 'b' })] }), expect.any(String), expect.any(Function))
    expect(chips()).toEqual([])
    await click('Chat A')
    expect(chips()).toEqual([])
  } finally {
    act(() => root.unmount())
    container.remove()
    localStorage.clear()
    vi.unstubAllGlobals()
  }
})
