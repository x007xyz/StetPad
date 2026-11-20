// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { deferred } from '../lib/deferred.test-utils'
import { AddProvider } from './AddProvider'

it('does not update the new provider form after leaving an earlier verification', async () => {
  const a = deferred<Response>()
  const b = deferred<Response>()
  const fetchMock = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  function click(text: string) {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!
    expect(button.disabled).toBe(false)
    act(() => button.click())
  }
  try {
    await act(async () => root.render(<AddProvider catalog={[]} rows={[]} onCancel={vi.fn()} onDone={vi.fn()} />))
    function configure() {
      click('添加自定义')
      const input = document.querySelector<HTMLInputElement>('input[placeholder="https://host/v1"]')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://example.com/v1')
      act(() => input.dispatchEvent(new Event('input', { bubbles: true })))
      click('验证')
    }
    configure()
    click('返回')
    configure()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await act(async () => b.resolve(Response.json({ models: [{ id: 'B-model' }] })))
    expect(document.body.textContent).toContain('B-model')
    await act(async () => a.resolve(Response.json({ models: [{ id: 'A-model' }] })))
    expect(document.body.textContent).toContain('B-model')
    expect(document.body.textContent).not.toContain('A-model')
  } finally {
    act(() => root.unmount())
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  }
})
