import { expect, test } from '@playwright/test'

test('ordered lists restart at each depth and after non-list blocks', async ({ page }) => {
  await page.goto('/?token=dev')
  await page.getByRole('button', { name: '新建文档', exact: true }).first().click()
  const editor = page.locator('[contenteditable="true"]').first()
  await expect(editor).toBeVisible()
  await page.getByRole('textbox', { name: '文档标题', exact: true }).fill('Nested ordered lists')
  await editor.focus()
  const items: [number | null, string][] = [
    [0, 'first'], [0, 'second'], [1, 'nested a'], [1, 'nested b'],
    [2, 'deeper a'], [2, 'deeper b'], [1, 'nested c'], [0, 'third'],
    [1, 'new nested run'], [2, 'third level'], [3, 'fourth level'],
    [4, 'fifth level'], [5, 'sixth level'], [6, 'seventh level'],
    [0, 'fourth'], [null, 'A paragraph resets numbering.'], [0, 'fresh list'],
  ]
  await editor.evaluate((el, blocks) => {
    const data = new DataTransfer()
    data.setData('text/html', blocks.map(([indent, text]) => indent === null
      ? `<p>${text}</p>`
      : `<div class="ordered" data-indent="${indent}">${text}</div>`).join(''))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, items)
  await expect(editor.locator('.ordered')).toHaveCount(16)
  await page.evaluate(() => document.fonts.ready)
  if (process.env.LIST_SCREENSHOT) {
    await editor.screenshot({ path: process.env.LIST_SCREENSHOT, animations: 'disabled', caret: 'hide' })
  }
  // Computed CSS content preserves counter() expressions; the layout snapshot resolves them.
  const session = await page.context().newCDPSession(page)
  const { documents, strings } = await session.send('DOMSnapshot.captureSnapshot', { computedStyles: [] })
  const markers = documents[0].layout.text.map(index => strings[index]).filter(text => /^\d+$/.test(text)).map(text => `${text}.`)
  expect(markers).toEqual(['1.', '2.', '1.', '2.', '1.', '2.', '3.', '3.', '1.', '1.', '1.', '1.', '1.', '1.', '4.', '1.'])
})

for (const kind of ['bullet', 'task']) {
  test(`nested ${kind} blocks preserve outer numbering and reset their own level`, async ({ page }) => {
    await page.goto('/?token=dev')
    await page.getByRole('button', { name: '新建文档', exact: true }).first().click()
    const editor = page.locator('[contenteditable="true"]').first()
    await expect(editor).toBeVisible()
    await editor.focus()
    await editor.evaluate((el, blockKind) => {
      const data = new DataTransfer()
      data.setData('text/html', Array.from({ length: 6 }, (_, index) => {
        const level = index + 1
        return `<div class="ordered" data-indent="${level - 1}">outer first</div>
          <div class="${blockKind}" data-indent="${level}">nested interruption</div>
          <div class="ordered" data-indent="${level - 1}">outer second</div>
          <div class="ordered" data-indent="${level}">nested first</div>
          <div class="${blockKind}" data-indent="${level}">same-level interruption</div>
          <div class="ordered" data-indent="${level}">nested restart</div>
          <p>Reset all levels.</p>`
      }).join(''))
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, kind)
    await expect(editor.locator(`.${kind}`)).toHaveCount(12)
    await expect(editor.locator('.ordered')).toHaveCount(24)
    const session = await page.context().newCDPSession(page)
    const { documents, strings } = await session.send('DOMSnapshot.captureSnapshot', { computedStyles: [] })
    const markers = documents[0].layout.text.map(index => strings[index]).filter(text => /^\d+$/.test(text))
    expect(markers).toEqual(Array.from({ length: 6 }, () => ['1', '2', '1', '1']).flat())
  })
}
