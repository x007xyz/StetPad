import { expect, test } from '@playwright/test'

const headers = { Authorization: 'Bearer dev' }

test.beforeEach(async ({ page, request }) => {
  const doc = await request.post('/api/import/create', {
    headers,
    data: {
      title: 'Table editing',
      blocks: [{ type: 'table', attrs: { rows: JSON.stringify([['Item', 'Quantity'], ['Pencils', '12']]) }, delta: [] }],
    },
  })
  await expect(doc).toBeOK()
  await page.addInitScript(() => localStorage.setItem('aiw.lang', 'en'))
  await page.goto(`/?token=dev#/d/${(await doc.json()).id}`)
  await expect(page.locator('[data-cell="1:0"]')).toHaveText('Pencils')
})

test('saves a focused table cell to the server and survives reload', async ({ page, request }) => {
  const cell = page.locator('[data-cell="1:0"]')
  await cell.fill('Pens')
  const id = new URL(page.url()).hash.split('/').pop()
  await expect.soft.poll(async () => {
    const exported = await request.get(`/api/docs/${id}/export?format=md`, { headers })
    return exported.text()
  }).toContain('| Pens | 12 |')
  await expect(cell).toBeFocused()
  await page.reload()
  await expect(cell).toHaveText('Pens')
})

test('Tab after an edit focuses the next table cell', async ({ page }) => {
  await page.locator('[data-cell="1:0"]').fill('Pens')
  await page.keyboard.press('Tab')
  await expect(page.locator('[data-cell="1:1"]')).toBeFocused()
})

test('adding a row keeps the focused cell and its edit', async ({ page }) => {
  const cell = page.locator('[data-cell="1:0"]')
  await cell.fill('Pens')
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('.table-bar button')].find((el) => el.textContent === '+ Row')!
    button.addEventListener('click', () => {
      document.querySelector('.table-wrap')?.setAttribute('data-value-on-add', document.querySelector('[data-cell="1:0"]')?.textContent ?? '')
    }, { once: true })
  })
  await page.getByRole('button', { name: '+ Row', exact: true }).click()
  await expect(page.locator('.table-wrap tr')).toHaveCount(3)
  await expect(page.locator('.table-wrap')).toHaveAttribute('data-value-on-add', 'Pens')
  await expect(cell).toHaveText('Pens')
  await expect(cell).toBeFocused()
})
