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
