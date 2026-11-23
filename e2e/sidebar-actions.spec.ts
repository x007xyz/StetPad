import { expect, test } from '@playwright/test'

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

test('moves and trashes a sidebar document by touch without hover', async ({ page, request }) => {
  const headers = { Authorization: 'Bearer dev' }
  const title = 'Touch sidebar draft'
  const folderName = 'Touch sidebar folder'
  await expect(await request.post('/api/folders', { headers, data: { name: folderName } })).toBeOK()
  const doc = await request.post('/api/docs', { headers, data: { title } })
  await expect(doc).toBeOK()
  const { id } = await doc.json()

  await page.goto('/?token=dev')
  expect(await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)).toBe(true)
  await page.getByRole('button', { name: '打开侧栏', exact: true }).tap()

  const sidebar = page.getByRole('dialog', { name: '侧栏', exact: true })
  const move = sidebar.getByRole('button', { name: `移动 ${title}`, exact: true })
  const remove = sidebar.getByRole('button', { name: `删除 ${title}`, exact: true })
  await expect(move).toBeVisible()
  await expect(remove).toBeVisible()
  await move.tap()
  await page.getByRole('menuitem', { name: folderName, exact: true }).tap()

  const folder = sidebar.getByRole('listitem', { name: `文件夹 ${folderName}`, exact: true })
  await expect(folder.getByRole('button', { name: title, exact: true })).toBeVisible()
  await remove.tap()
  const confirm = page.getByRole('dialog', { name: `把"${title}"移到回收站？`, exact: true })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: '移到回收站', exact: true }).tap()
  await expect(sidebar.getByRole('button', { name: title, exact: true })).toHaveCount(0)
  await expect(await request.delete(`/api/docs/${id}/purge`, { headers })).toBeOK()
})

test('renames and deletes a sidebar folder by touch without hovering or selecting it first', async ({ page, request }) => {
  const headers = { Authorization: 'Bearer dev' }
  const folderName = 'Touch folder actions'
  const renamed = 'Renamed touch folder'
  await expect(await request.post('/api/folders', { headers, data: { name: folderName } })).toBeOK()

  await page.goto('/?token=dev')
  expect(await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)).toBe(true)
  await page.getByRole('button', { name: '打开侧栏', exact: true }).tap()

  const sidebar = page.getByRole('dialog', { name: '侧栏', exact: true })
  const folder = sidebar.getByRole('listitem', { name: `文件夹 ${folderName}`, exact: true })
  const rename = folder.getByRole('button', { name: `重命名 ${folderName}`, exact: true })
  await expect(rename).toBeVisible()
  await expect(folder.getByRole('button', { name: `删除文件夹 ${folderName}`, exact: true })).toBeVisible()

  await rename.tap()
  const nameInput = folder.getByRole('textbox', { name: '文件夹名称', exact: true })
  await expect(nameInput).toBeFocused()
  await nameInput.fill(renamed)
  await nameInput.press('Enter')

  const renamedFolder = sidebar.getByRole('listitem', { name: `文件夹 ${renamed}`, exact: true })
  await renamedFolder.getByRole('button', { name: `删除文件夹 ${renamed}`, exact: true }).tap()
  const confirm = page.getByRole('dialog', { name: `删除文件夹"${renamed}"？`, exact: true })
  await confirm.getByRole('button', { name: '删除', exact: true }).tap()
  await expect(renamedFolder).toHaveCount(0)
})
