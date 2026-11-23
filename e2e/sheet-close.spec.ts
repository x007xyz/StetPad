import { expect, test } from '@playwright/test'

for (const lang of ['zh', 'en'] as const) {
  for (const kind of ['doc', 'folder'] as const) {
    test(`${lang} ${kind} AI sheet closes with its close button`, async ({ page, request }) => {
      await page.setViewportSize({ width: 850, height: 900 })
      await page.addInitScript((locale) => localStorage.setItem('aiw.lang', locale), lang)
      const response = await request.post(`/api/${kind === 'doc' ? 'docs' : 'folders'}`, {
        headers: { Authorization: 'Bearer dev' },
        data: kind === 'doc' ? { title: 'Sheet close regression' } : { name: 'Sheet close regression' },
      })
      await expect(response).toBeOK()
      const { id } = await response.json()
      await page.goto(`/?token=dev#/${kind === 'doc' ? 'd' : 'f'}/${id}`)
      await page.getByRole('button', { name: 'AI', exact: true }).click()
      const sheet = page.getByRole('dialog', { name: lang === 'en' ? 'Panel' : '面板', exact: true })
      await expect(sheet).toBeVisible()
      await sheet.getByRole('button', { name: lang === 'en' ? 'Close' : '关闭', exact: true }).click({ timeout: 5000 })
      await expect(sheet).not.toBeVisible()
    })
  }
}
