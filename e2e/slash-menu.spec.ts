import { expect, test } from '@playwright/test'

test('slash menu scrolls the keyboard-selected item into view', async ({ page }) => {
  await page.goto('/?token=dev')
  await page.getByRole('button', { name: '新建文档', exact: true }).first().click()
  const editor = page.locator('[contenteditable="true"]').first()
  await expect(editor).toBeVisible()
  await editor.focus()
  await page.keyboard.type('/')
  const menu = page.locator('.slash[role="listbox"]')
  await expect(menu).toBeVisible()
  const options = menu.getByRole('option')
  const count = await options.count()
  expect(count).toBeGreaterThan(12)

  const expectSelectedVisible = async (index: number) => {
    const selected = options.nth(index)
    await expect(selected).toHaveAttribute('aria-selected', 'true')
    await expect.poll(async () => {
      const [list, item] = await Promise.all([menu.boundingBox(), selected.boundingBox()])
      return !!list && !!item && item.y >= list.y - 0.5 && item.y + item.height <= list.y + list.height + 0.5
    }).toBe(true)
  }

  for (let i = 1; i <= 12; i++) await page.keyboard.press('ArrowDown')
  await expectSelectedVisible(12)

  for (let i = 12; i < count; i++) await page.keyboard.press('ArrowDown')
  await expectSelectedVisible(0)

  await page.keyboard.press('ArrowUp')
  await expectSelectedVisible(count - 1)
})
