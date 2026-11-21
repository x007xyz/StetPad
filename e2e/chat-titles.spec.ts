import { expect, test } from '@playwright/test'

test('preserves a user chat title in the English chat picker', async ({ page, request }) => {
  const doc = await request.post('/api/docs', {
    headers: { Authorization: 'Bearer dev' },
    data: { title: 'Chat title regression' },
  })
  await expect(doc).toBeOK()
  const { id } = await doc.json()
  await page.addInitScript(() => localStorage.setItem('aiw.lang', 'en'))
  await page.goto(`/?token=dev#/d/${id}`)
  await page.getByRole('button', { name: 'AI', exact: true }).click()

  const create = page.getByRole('button', { name: 'New chat', exact: true })
  const current = page.getByRole('button', { name: 'Switch chat' })
  const menu = page.locator('.chat-menu')
  const pick = menu.locator('.chat-title')
  await create.click()
  await expect(current).toHaveText('New chat')
  await current.click()
  await expect(pick).toHaveText('New chat')

  await menu.getByRole('button', { name: /^(重命名|Rename)$/ }).click()
  const rename = menu.getByRole('textbox')
  await rename.fill('设置')
  await rename.press('Enter')

  await expect.soft(pick).toHaveText('设置')
  await expect.soft(current).toHaveText('设置')
  await expect(current).toHaveAttribute('title', '设置')
})
