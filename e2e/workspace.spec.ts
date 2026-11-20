import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const editor = (page: Page) => page.locator('[contenteditable="true"]').first()
const sidebar = (page: Page) => page.getByRole('complementary', { name: '侧栏' })

async function createDoc(page: Page, title: string) {
  await sidebar(page).getByRole('button', { name: '新建文档', exact: true }).first().click()
  await expect(editor(page)).toBeVisible()
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('未命名文档')
  await page.getByRole('textbox', { name: '文档标题', exact: true }).fill(title)
  await page.getByRole('textbox', { name: '文档标题', exact: true }).press('Enter')
  await expect(sidebar(page).getByRole('button', { name: title, exact: true })).toBeVisible()
  await expect(editor(page)).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/?token=dev')
  await expect(page.getByRole('heading', { name: '我的文档' })).toBeVisible()
})

test('edits a document and persists its title and text', async ({ page }) => {
  await createDoc(page, 'Editing draft')
  await editor(page).fill('Persistent prose from the browser.')
  await expect(editor(page)).toContainText('Persistent prose from the browser.')
  await page.getByRole('button', { name: 'Stetpad', exact: true }).click()
  await sidebar(page).getByRole('button', { name: 'Editing draft', exact: true }).click()
  await expect(editor(page)).toContainText('Persistent prose from the browser.')
  await page.reload()
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('Editing draft')
  await expect(editor(page)).toContainText('Persistent prose from the browser.')
})

test('shows an empty folder then its moved document in folder view', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: '新建文件夹', exact: true }).first().click()
  const folderName = page.getByRole('textbox', { name: '文件夹名称', exact: true })
  await expect(page.getByRole('heading', { name: '新建文件夹', exact: true })).toBeVisible()
  await folderName.fill('Research folder')
  await folderName.press('Enter')
  await sidebar(page).getByRole('button', { name: /^Research folder \d+$/ }).click()
  await expect(page.getByText('这个文件夹还是空的。', { exact: false })).toBeVisible()
  await createDoc(page, 'Folder draft')
  await editor(page).fill('Folder view body')
  await sidebar(page).getByRole('button', { name: 'Folder draft', exact: true }).hover()
  await page.getByRole('button', { name: '移动 Folder draft', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Research folder', exact: true }).click()
  await sidebar(page).getByRole('button', { name: /^Research folder \d+$/ }).click()
  await expect(page.getByRole('textbox', { name: '文档标题：Folder draft', exact: true })).toHaveValue('Folder draft')
  await expect(editor(page)).toContainText('Folder view body')
})

test('searches titles, opens a result, and clears results', async ({ page }) => {
  await createDoc(page, 'Searchable nebula')
  await page.getByRole('button', { name: '搜索文档', exact: false }).click()
  const search = page.getByRole('combobox', { name: '搜索文档' })
  await search.fill('nebula')
  await expect(page.getByRole('option')).toContainText('Searchable nebula')
  await search.fill('')
  await expect(page.getByRole('option')).toHaveCount(0)
  await expect(page.getByText('输入关键词，搜索你能看到的所有文档。')).toBeVisible()
  await search.fill('nebula')
  await expect(page.getByRole('option')).toBeVisible()
  await search.press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('Searchable nebula')
})

test('shows empty and failed search states', async ({ page }) => {
  await page.getByRole('button', { name: '搜索文档', exact: false }).click()
  const search = page.getByRole('combobox', { name: '搜索文档' })
  await search.fill('nonexistent-astral-document')
  await expect(page.getByText('没有找到相关文档。')).toBeVisible()
  await page.route('**/api/search?*', route => route.fulfill({ status: 500, body: '{}' }))
  await search.fill('failure')
  await expect(page.getByText('搜索失败，请稍后再试。')).toBeVisible()
  await search.fill('')
  await expect(page.getByText('搜索失败，请稍后再试。')).toHaveCount(0)
})

test('imports Markdown with preview and exports its content', async ({ page }) => {
  await page.locator('input[type="file"]').setInputFiles({ name: 'imported.md', mimeType: 'text/markdown', buffer: Buffer.from('# Imported heading\n\nRound trip prose.') })
  const preview = page.getByRole('dialog', { name: '导入预览' })
  await expect(preview).toContainText('Round trip prose.')
  await preview.getByRole('button', { name: '创建文档' }).click()
  await expect(editor(page)).toContainText('Round trip prose.')
  await page.getByRole('button', { name: '导出', exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: 'Markdown', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/\.md$/)
  expect(await readFile((await download.path())!, 'utf8')).toContain('Round trip prose.')
})

test('reports an invalid document package without creating a document', async ({ page }) => {
  await page.locator('input[type="file"]').setInputFiles({ name: 'broken.stetpad', mimeType: 'application/octet-stream', buffer: Buffer.from('not a package') })
  await expect(page.locator('main .error')).toBeVisible()
  await expect(page.getByRole('heading', { name: '我的文档' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('trashes, restores, then permanently deletes a document', async ({ page }) => {
  await createDoc(page, 'Disposable draft')
  const remove = async () => {
    await sidebar(page).getByRole('button', { name: 'Disposable draft', exact: true }).hover()
    await page.getByRole('button', { name: '删除 Disposable draft', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '移到回收站', exact: true }).click()
    await sidebar(page).getByRole('button', { name: '回收站', exact: true }).click()
  }
  await remove()
  const row = page.getByRole('listitem').filter({ hasText: 'Disposable draft', has: page.getByRole('button', { name: '恢复', exact: true }) })
  await row.getByRole('button', { name: '恢复', exact: true }).click()
  await expect(row).toHaveCount(0)
  await expect(sidebar(page).getByRole('button', { name: 'Disposable draft', exact: true })).toBeVisible()
  await sidebar(page).getByRole('button', { name: 'Disposable draft', exact: true }).click()
  await remove()
  await row.getByRole('button', { name: '彻底删除', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '彻底删除', exact: true }).click()
  await expect(row).toHaveCount(0)
  await expect(page.getByText('回收站是空的。删除的文档会先放在这里。')).toBeVisible()
})

test('refreshes trash when deleting from the sidebar while trash is open', async ({ page }) => {
  await createDoc(page, 'Live trash draft')
  await sidebar(page).getByRole('button', { name: '回收站', exact: true }).click()
  await expect(page.getByText('回收站是空的。删除的文档会先放在这里。')).toBeVisible()
  await sidebar(page).getByRole('button', { name: 'Live trash draft', exact: true }).hover()
  await page.getByRole('button', { name: '删除 Live trash draft', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '移到回收站', exact: true }).click()
  await expect(sidebar(page).getByRole('button', { name: 'Live trash draft', exact: true })).toHaveCount(0)
  await expect(page.getByRole('listitem').filter({ hasText: 'Live trash draft' })).toBeVisible()
})
