// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { confirmAction, ConfirmHost } from './confirm'

it.each([
  ['包含视频', true],
  ['不含视频', false],
  ['关闭', null],
] as const)('distinguishes the explicit export choices from dismissal: %s', async (label, result) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ConfirmHost />))
    let choice!: Promise<boolean | null>
    await act(async () => {
      choice = confirmAction({ title: '导出时包含视频？', confirmLabel: '包含视频', cancelLabel: '不含视频' })
    })
    const dialog = document.querySelector('[role="dialog"]')!
    await act(async () => {
      Array.from(dialog.querySelectorAll('button')).find((button) => (button.getAttribute('aria-label') ?? button.textContent) === label)!.click()
    })
    expect(await choice).toBe(result)
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

it('returns keyboard focus to the opener when a confirmation is cancelled', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<><button onClick={() => void confirmAction({ title: '放弃未保存的修改？', confirmLabel: '放弃修改' })}>关闭</button><ConfirmHost /></>))
    const opener = container.querySelector('button')!
    opener.focus()
    await act(async () => opener.click())
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.contains(document.activeElement)).toBe(true)
    await act(async () => {
      Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === '取消')!.click()
    })
    await vi.waitFor(() => expect(document.activeElement).toBe(opener))
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
