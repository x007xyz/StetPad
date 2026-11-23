import { expect, test, type Locator } from '@playwright/test'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../packages/server/package.json', import.meta.url))
const { commentOnBlock, insertBlock, projectBlocks, proposeReplace, readBlock, resolveComment } = require('@stetpad/crdt')
const { HocuspocusProvider } = require('@hocuspocus/provider')
const Y = require('yjs')

async function noOverlap(close: Locator, control: Locator) {
  const a = await close.boundingBox()
  const b = await control.boundingBox()
  expect(a).not.toBeNull()
  expect(b).not.toBeNull()
  expect(a!.x >= b!.x + b!.width || b!.x >= a!.x + a!.width || a!.y >= b!.y + b!.height || b!.y >= a!.y + a!.height).toBe(true)
}

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
      if (kind === 'doc') await noOverlap(sheet.getByRole('button', { name: lang === 'en' ? 'Close' : '关闭', exact: true }), sheet.locator('.chat-new'))
      await sheet.getByRole('button', { name: lang === 'en' ? 'Close' : '关闭', exact: true }).click({ timeout: 5000 })
      await expect(sheet).not.toBeVisible()
    })
  }
}

test('bottom-sheet header controls stay clickable across document and folder panels', async ({ page, request, baseURL }) => {
  const headers = { Authorization: 'Bearer dev' }
  const folder = await request.post('/api/folders', { headers, data: { name: 'Sheet tabs' } })
  const { id: folderId } = await folder.json()
  const response = await request.post('/api/docs', { headers, data: { title: 'Sheet tabs', folderId } })
  const { id } = await response.json()
  const doc = new Y.Doc()
  const provider = new HocuspocusProvider({ url: baseURL!.replace('http', 'ws') + '/collab', name: id, document: doc, token: 'dev' })
  try {
    await expect.poll(() => projectBlocks(doc, 'physical').length).toBe(1)
    insertBlock(doc, 1, 'sheet-fixture', 'Original sentence.')
    proposeReplace(doc, readBlock(doc, 'sheet-fixture')!, 'Improved sentence.', { author: 'AI' })
    const comment = commentOnBlock(doc, 'sheet-fixture', 'sentence', '我', 'Resolved fixture')!
    resolveComment(doc, comment)
    await expect.poll(() => provider.hasUnsyncedChanges).toBe(false)
    await page.setViewportSize({ width: 850, height: 900 })
    await page.addInitScript(() => localStorage.setItem('aiw.lang', 'zh'))
    for (const kind of ['doc', 'folder']) {
      await page.goto(`/?token=dev#/${kind === 'doc' ? 'd/' + id : 'f/' + folderId}`)
      await page.getByRole('button', { name: /^修订(?:\s*\d+)?$/, exact: true }).click()
      const sheet = page.getByRole('dialog', { name: '面板', exact: true })
      const close = sheet.getByRole('button', { name: '关闭', exact: true })
      const reject = sheet.getByRole('button', { name: '全部拒绝', exact: true })
      await expect(reject).toBeVisible()
      await noOverlap(close, reject)
      const box = await reject.boundingBox()
      await reject.click({ position: { x: box!.width - 2, y: box!.height / 2 } })
      await expect(sheet).toBeVisible()
      await expect(reject).not.toBeVisible()
      await close.click()
      if (kind === 'doc') {
        await page.getByRole('button', { name: /^评论(?:\s*\d+)?$/, exact: true }).click()
        const resolved = sheet.getByRole('checkbox', { name: '显示已解决' })
        await noOverlap(close, resolved.locator('..'))
        await resolved.check()
        await expect(sheet.getByText('Resolved fixture', { exact: true })).toBeVisible()
        await expect(sheet).toBeVisible()
        await close.click()
        proposeReplace(doc, readBlock(doc, 'sheet-fixture')!, 'Another sentence.', { author: 'AI' })
        await expect.poll(() => provider.hasUnsyncedChanges).toBe(false)
      }
    }
    await page.setViewportSize({ width: 650, height: 900 })
    await page.getByRole('button', { name: '打开侧栏', exact: true }).click()
    const drawer = page.getByRole('dialog', { name: '侧栏', exact: true })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole('button', { name: '关闭', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(drawer).not.toBeVisible()
  } finally {
    provider.destroy()
    doc.destroy()
  }
})
