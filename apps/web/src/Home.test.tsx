// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { Home } from './Home'
import { initI18n } from './i18n'
import { deferred } from './lib/deferred.test-utils'

vi.mock('./Shell', () => ({ useWorkspace: () => ({ docs: [], createDoc: vi.fn() }), SidebarToggle: () => null }))
vi.mock('./App', () => ({ go: vi.fn() }))

it.each([
  { lang: 'en', count: 0 },
  { lang: 'en', count: 201 },
  { lang: 'zh', count: 201 },
])('translates import preview text nodes ($lang, $count blocks)', async ({ lang, count }) => {
  localStorage.setItem('aiw.lang', lang)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
    title: 'Import',
    blocks: Array.from({ length: count }, () => ({ type: 'paragraph', attrs: {}, delta: [{ insert: 'Hello' }] })),
    omittedBlockCount: count ? 3 : 0,
    omittedPageCount: count ? 2 : 0,
  })))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  container.id = 'root'
  document.body.append(container)
  const root = createRoot(container)
  const dialogs = { alert: window.alert, confirm: window.confirm, prompt: window.prompt }
  try {
    for (const name of ['alert', 'confirm', 'prompt']) vi.stubGlobal(name, vi.fn())
    initI18n()
    await act(async () => root.render(<Home />))
    const input = container.querySelector('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [new File(['Hello'], 'import.md')] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    const total = count ? count + 3 : 0
    await vi.waitFor(() => {
      const dialog = document.querySelector('[role="dialog"]')!
      expect(dialog.querySelector('p')?.textContent).toBe(lang === 'en'
        ? `The original layout is not kept; the content was normalised into the simple format below. ${total} blocks.`
        : `原文档的排版不会保留，内容已整理成下面的简单格式。共 ${total} 个段落。`)
      const warnings = Array.from(dialog.querySelectorAll('[role="alert"]'), (p) => p.textContent)
      expect(warnings).toEqual(!count ? [] : lang === 'en' ? [
        'This PDF import can keep only the first 500 pages. Creating the document will omit the last 2 pages.',
        `This import can keep only the first ${count} blocks. Creating the document will omit the last 3 blocks.`,
      ] : [
        'PDF 导入最多保留前 500 页。继续创建将省略最后 2 页。',
        `导入最多保留前 ${count} 个段落。继续创建将省略最后 3 个段落。`,
      ])
      if (count) expect(dialog.querySelector('.preview > p')?.textContent).toBe(lang === 'en' ? '…1 more blocks not shown' : '……其余 1 段未显示')
    })
  } finally {
    act(() => root.unmount())
    document.body.replaceChildren()
    Object.assign(window, dialogs)
    localStorage.removeItem('aiw.lang')
    vi.unstubAllGlobals()
  }
})

it.each([false, true])('creates only one document for rapid preview confirmation (empty: %s)', async (empty) => {
  const pending = deferred<Response>()
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({
    title: 'Import', blocks: empty ? [] : [{ type: 'paragraph', attrs: {}, delta: [{ insert: 'Hello' }] }],
  })).mockImplementation(() => pending.promise)
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Home />))
    const input = container.querySelector('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [new File(['Hello'], 'import.md')] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    const create = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '创建文档')!
    act(() => { create.click(); create.click() })
    expect(fetch.mock.calls.filter(([url]) => url === '/api/import/create')).toHaveLength(1)
    expect(create.disabled).toBe(true)
    await act(async () => pending.resolve(Response.json({ id: 'imported' })))
  } finally {
    act(() => root.unmount())
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  }
})

it('allows retry after a failed create request', async () => {
  const pending = deferred<Response>()
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ title: 'Import', blocks: [] }))
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValueOnce(Response.json({ id: 'retried' }))
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Home />))
    const input = container.querySelector('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [new File([''], 'empty.md')] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    const create = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '创建文档')!
    act(() => create.click())
    await act(async () => pending.resolve(Response.json({ error: 'Create failed' }, { status: 500 })))
    expect(create.disabled).toBe(false)
    expect(container.textContent).toContain('Create failed')
    await act(async () => create.click())
    expect(fetch.mock.calls.filter(([url]) => url === '/api/import/create')).toHaveLength(2)
    expect(container.textContent).not.toContain('Create failed')
  } finally {
    act(() => root.unmount())
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  }
})

it.each([undefined, 1, 3])('shows a PDF page warning only when pages were omitted (%s)', async (omittedPageCount) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ title: 'PDF', blocks: [], omittedPageCount })))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Home />))
    const input = container.querySelector('input[type="file"]')!
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['pdf'], 'long.pdf')] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    const warning = document.querySelector('[role="alert"]')
    if (omittedPageCount) expect(warning?.textContent).toBe(`PDF 导入最多保留前 500 页。继续创建将省略最后 ${omittedPageCount} 页。`)
    else expect(warning).toBeNull()
  } finally {
    act(() => root.unmount())
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  }
})

it.each([
  ...[undefined, [], [2], [2, 4]].map((skippedPages) => ({ skippedPages, skippedPageReason: 'no-ocr' })),
  { skippedPages: [2, 4], skippedPageReason: 'ocr-limit' },
])('warns about skipped PDF pages only when present (%j)', async ({ skippedPages, skippedPageReason }) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ title: 'PDF', blocks: [], skippedPages, skippedPageReason })))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Home />))
    const input = container.querySelector('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [new File(['pdf'], 'mixed.pdf')] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    const warning = document.querySelector('[role="alert"]')
    if (skippedPageReason === 'ocr-limit') expect(warning?.textContent).toBe('第 2, 4 页没有可提取的文字，已跳过。这些页面超过了 40 页识别上限，请拆分 PDF 后重试。')
    else if (skippedPages?.length) expect(warning?.textContent).toBe(`第 ${skippedPages.join(', ')} 页没有可提取的文字，已跳过。配置支持图像的模型后可识别这些页面。`)
    else expect(warning).toBeNull()
  } finally {
    act(() => root.unmount())
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  }
})

it.each(['preview', 'empty', 'error'])('keeps the latest import preview after a stale %s response', async (stale) => {
  const a = deferred<Response>()
  const b = deferred<Response>()
  const requests = [a, b]
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => requests.shift()!.promise))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Home />))
    const input = container.querySelector('input[type="file"]')!
    const select = (name: string) => {
      Object.defineProperty(input, 'files', { configurable: true, value: [new File(['content'], name)] })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }
    await act(async () => select('A.txt'))
    await act(async () => select('B.txt'))
    expect(requests).toHaveLength(0)
    await act(async () => b.resolve(Response.json({ title: 'B preview', blocks: [] })))
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe('B preview')
    await act(async () => {
      if (stale === 'error') a.reject(new Error('stale failure'))
      else a.resolve(Response.json({ title: 'A preview', blocks: stale === 'empty' ? [] : [{ type: 'paragraph', attrs: {}, delta: [{ insert: 'A content' }] }] }))
    })
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe('B preview')
    expect(container.textContent).not.toContain('stale failure')
    expect(document.body.textContent).not.toContain('A content')
  } finally {
    act(() => root.unmount())
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  }
})
