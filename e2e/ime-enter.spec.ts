import { expect, test as base, type Locator, type Page } from '@playwright/test'

const headers = { Authorization: 'Bearer dev' }

const test = base.extend<{ seed: (route: 'docs' | 'folders' | 'import/create', data: object) => Promise<string> }>({
  seed: async ({ request }, use) => {
    const paths: string[] = []
    await use(async (route, data) => {
      const response = await request.post(`/api/${route}`, { headers, data })
      await expect(response).toBeOK()
      const { id } = await response.json()
      paths.unshift(`/api/${route === 'folders' ? 'folders' : 'docs'}/${id}`)
      return id
    })
    for (const path of paths) {
      await expect(await request.delete(path, { headers })).toBeOK()
      if (path.startsWith('/api/docs/')) await expect(await request.delete(`${path}/purge`, { headers })).toBeOK()
    }
  },
})

async function startComposition(page: Page, input: Locator, pinyin: string) {
  await input.selectText()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: pinyin, selectionStart: pinyin.length, selectionEnd: pinyin.length })
  await expect(input).toHaveValue(pinyin)
  return cdp
}

for (const location of ['document', 'document in folder', 'folder', 'sidebar folder'] as const) {
  test(`Enter does not save unconverted pinyin in the ${location} title`, async ({ page, request, seed }) => {
    const title = `Draft: ${location}`
    const folderId = location === 'document' ? undefined : await seed('folders', { name: title })
    const isDoc = location.startsWith('document')
    let path = `/api/folders/${folderId}`
    let valueKey = 'name'
    let hash = `#/f/${folderId}`
    let input = page.getByRole('textbox', { name: '文件夹名称', exact: true })
    if (isDoc) {
      const id = await seed('docs', { title, folderId })
      path = `/api/docs/${id}`
      valueKey = 'title'
      if (location === 'document') hash = `#/d/${id}`
      input = page.getByRole('textbox', { name: location === 'document' ? /^文档标题$/ : /^文档标题：/ })
    }
    await page.goto(`/?token=dev${location === 'sidebar folder' ? '' : hash}`)
    if (location === 'sidebar folder') {
      const row = page.getByRole('listitem', { name: `文件夹 ${title}`, exact: true })
      await row.hover()
      await row.getByRole('button', { name: `重命名 ${title}`, exact: true }).click()
    }

    await expect(input).toHaveValue(title)
    const cdp = await startComposition(page, input, 'wenjian')
    await page.keyboard.press('Enter')
    await expect(input).toBeFocused()
    expect(await (await request.get(path, { headers })).json()).toMatchObject({ [valueKey]: title })

    await cdp.send('Input.insertText', { text: '文件' })
    await expect(input).toHaveValue('文件')
    if (location === 'document') {
      await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: false })
      await expect(input).toBeFocused()
    }
    await input.press('Enter')
    await expect.poll(async () => (await (await request.get(path, { headers })).json())[valueKey]).toBe('文件')
  })
}

for (const addingProvider of [false, true]) {
  test(`Enter does not add unconverted pinyin as a model ID when ${addingProvider ? 'adding' : 'editing'} a provider`, async ({ page }) => {
    await page.goto('/?token=dev')
    await page.getByRole('complementary', { name: '侧栏' }).getByRole('button', { name: '设置', exact: true }).last().click()
    await page.getByRole('button', { name: '管理提供方…' }).click()
    if (addingProvider) {
      await page.getByRole('button', { name: '添加提供方', exact: true }).first().click()
      await page.getByRole('button', { name: '没有找到？添加自定义 OpenAI 兼容端点' }).click()
    } else {
      await page.getByRole('tab', { name: '模型', exact: true }).click()
    }
    const input = page.getByRole('textbox', { name: addingProvider ? '手动添加模型 ID' : '添加模型', exact: true })
    const pinyin = addingProvider ? 'xuanze' : 'moxing'
    const converted = addingProvider ? '选择' : '模型'
    const cdp = await startComposition(page, input, pinyin)
    await page.keyboard.press('Enter')
    await expect(page.getByText(pinyin, { exact: true })).toHaveCount(0)
    await expect(input).toHaveValue(pinyin)

    await cdp.send('Input.insertText', { text: converted })
    await expect(input).toHaveValue(converted)
    await input.press('Enter')
    await expect(page.locator('code').and(page.getByText(converted, { exact: true }))).toBeVisible()
    await expect(input).toBeEmpty()
  })
}

for (const mode of ['generate', 'edit'] as const) {
  test(`Ctrl+Enter does not submit unconverted pinyin to ${mode} an image`, async ({ page, seed }) => {
    const edit = mode === 'edit'
    const src = '/files/fixture'
    const id = await seed('import/create', {
      title: 'Image draft',
      blocks: edit ? [{ type: 'image', attrs: { src, alt: 'Fixture' }, delta: [] }] : [],
    })
    const model = { id: 'fixture:image', label: 'Fixture model' }
    await page.route(edit ? '**/api/image-edit-models' : '**/api/image-models', (route) =>
      route.fulfill({ json: { models: [model], default: model.id } }))
    const prompts: string[] = []
    await page.route(`**/api/docs/${id}/ai/${edit ? 'image-edit' : 'image'}`, (route) => {
      prompts.push(route.request().postDataJSON().prompt)
      return route.fulfill({ json: { url: src } })
    })
    await page.goto(`/?token=dev#/d/${id}`)
    if (edit) {
      await page.locator('.image-wrap').hover()
      await page.getByRole('button', { name: 'AI 改图', exact: true }).click()
    } else {
      await page.locator('.ProseMirror').focus()
      await page.keyboard.type('/huatu')
      await page.getByRole('option', { name: /AI 生成图片/ }).click()
    }
    const dialog = page.getByRole('dialog', { name: edit ? 'AI 改图' : 'AI 生成图片', exact: true })
    await expect(dialog.getByRole('combobox', { name: '模型' })).toHaveText(model.label)
    const input = dialog.getByRole('textbox')
    const cdp = await startComposition(page, input, 'huatu')
    await page.keyboard.press('Control+Enter')
    await expect(input).toBeEditable()
    await cdp.send('Input.insertText', { text: '画图' })
    await expect(input).toHaveValue('画图')
    await input.press('Control+Enter')
    await expect.poll(() => prompts).toEqual(['画图'])
  })
}
