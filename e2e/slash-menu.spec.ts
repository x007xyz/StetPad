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

  // Hovering a row the menu only partly shows highlights it without scrolling the menu.
  const scrollTop = await menu.evaluate((el) => el.scrollTop)
  const list = (await menu.boundingBox())!
  let clipped = -1
  let visibleBottom = 0
  for (let i = 0; i < count && clipped < 0; i++) {
    const item = (await options.nth(i).boundingBox())!
    if (item.y < list.y && item.y + item.height > list.y + 8) [clipped, visibleBottom] = [i, item.y + item.height]
  }
  expect(clipped).toBeGreaterThanOrEqual(0)
  await page.mouse.move(list.x + list.width / 2, (list.y + visibleBottom) / 2)
  await expect(options.nth(clipped)).toHaveAttribute('aria-selected', 'true')
  await page.waitForTimeout(200)
  expect(await menu.evaluate((el) => el.scrollTop)).toBe(scrollTop)
})
