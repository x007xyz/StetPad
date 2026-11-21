import { expect, test } from '@playwright/test'

for (const lang of ['en', 'zh'] as const) {
  const en = lang === 'en'

  test.describe(`${lang} interface copy`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((locale) => localStorage.setItem('aiw.lang', locale), lang)
      await page.goto('/?token=dev')
    })

    test('localizes attachment and footnote controls, not document content', async ({ page, request }) => {
      const doc = await request.post('/api/import/create', {
        headers: { Authorization: 'Bearer dev' },
        data: {
          title: '设置',
          blocks: [
            { type: 'paragraph', delta: [{ insert: '保存', attributes: { footnote: { id: 'fn-1', note: '附件' } } }] },
            { type: 'file', attrs: { src: '/files/fixture', name: '预览', mime: 'application/pdf', size: 1024 }, delta: [] },
          ],
        },
      })
      await expect(doc).toBeOK()
      await page.goto(`/#/d/${(await doc.json()).id}`)

      await expect(page.getByRole('textbox', { name: en ? 'Document title' : '文档标题', exact: true })).toHaveValue('设置')
      await expect(page.locator('.ProseMirror > p').first()).toContainText('保存')
      const attachment = page.locator('.file-card')
      await expect(attachment.locator('.file-name')).toHaveText('预览')
      await expect.soft(attachment.getByRole('button')).toHaveText(en ? 'Preview' : '预览')
      await expect.soft(attachment.getByRole('link')).toHaveText(en ? 'Download' : '下载')
      const notes = page.locator('.fn-list')
      await expect.soft(notes.getByRole('heading')).toHaveText(en ? 'Footnotes' : '脚注')
      await expect.soft(notes.getByRole('button')).toHaveText('附件')
      await expect.soft(notes.getByRole('button')).toHaveAttribute('title', en ? 'Back to text' : '回到正文')

      await page.locator('.ProseMirror .fn-num').click()
      const footnote = page.getByRole('dialog', { name: en ? 'Footnote 1' : '脚注 1' })
      await expect(footnote.locator('.fn-pop-text')).toHaveText('附件')
      await expect(footnote.getByRole('button', { name: en ? 'Delete footnote' : '删除脚注' })).toBeVisible()
    })

    test('localizes the provider catalog and the model selection step', async ({ page }) => {
      await page.getByRole('complementary', { name: en ? 'Sidebar' : '侧栏' })
        .getByRole('button', { name: en ? 'Settings' : '设置', exact: true }).last().click()
      await page.getByRole('button', { name: en ? 'Manage providers…' : '管理提供方…' }).click()
      await page.getByRole('button', { name: en ? 'Add provider' : '添加提供方', exact: true }).first().click()

      const catalog = page.locator('.addp')
      const search = catalog.getByRole('textbox')
      await expect.soft(search).toHaveAttribute('placeholder', en ? 'Search by name or ID…' : '搜索名称或 ID…')
      await expect.soft(catalog.getByRole('tab').allTextContents()).resolves.toEqual(
        en ? ['All', 'China', 'International', 'Aggregators', 'Local'] : ['全部', '国内', '海外', '聚合平台', '本机'],
      )
      const name = en ? 'Alibaba Cloud Model Studio' : '阿里云百炼'
      await search.fill(name)
      const card = catalog.locator('.prov-card').filter({ hasText: name }).first()
      await expect(card).toContainText(en ? 'Qwen models via an OpenAI-compatible API' : 'Qwen 系列，OpenAI 兼容模式')
      await card.click()
      await expect(catalog.getByRole('button', { name: en ? 'Verify key and fetch models' : '验证密钥并获取模型' })).toBeVisible()
      await expect(catalog.getByText(en ? /^\d+ of \d+ models? selected$/ : /^已选 \d+ \/ 共 \d+ 个模型$/)).toBeVisible()
    })
  })
}
