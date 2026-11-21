// @vitest-environment happy-dom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { initI18n, t } from './i18n'
import { DiffView } from './panels/DiffView'

afterEach(() => {
  localStorage.removeItem('aiw.lang')
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

it.each(['en', 'zh'])('translates move menu labels added after initialization in %s', async (lang) => {
  localStorage.setItem('aiw.lang', lang)
  for (const name of ['alert', 'confirm', 'prompt']) vi.stubGlobal(name, vi.fn())
  document.body.innerHTML = '<div id="root"></div>'
  initI18n()
  const menu = document.createElement('div')
  menu.innerHTML = '<div>移动到…</div><div>还没有文件夹</div>'
  document.getElementById('root')!.append(menu)
  await vi.waitFor(() => expect(menu.textContent).toBe(lang === 'en' ? 'Move to…No folders yet' : '移动到…还没有文件夹'))
})

it('translates every export label in desktop and narrow menus while preserving Chinese', () => {
  const labels: [string, string][] = [
    ['Markdown', 'Markdown'],
    ['Markdown（按修改稿）', 'Markdown (revised)'],
    ['Markdown（按原文）', 'Markdown (original)'],
    ['HTML', 'HTML'],
    ['HTML（按修改稿）', 'HTML (revised)'],
    ['HTML（按原文）', 'HTML (original)'],
    ['Word', 'Word'],
    ['Word（按修改稿）', 'Word (revised)'],
    ['Word（按原文）', 'Word (original)'],
    ['PDF（打印）', 'PDF (print)'],
    ['PDF（打印）（按修改稿）', 'PDF (print, revised)'],
    ['文档包（含图片、视频和全部版本）', 'Package (images, videos and all versions)'],
  ]
  for (const [zh, en] of labels) {
    localStorage.setItem('aiw.lang', 'en')
    expect.soft(t(zh)).toBe(en)
    expect.soft(t(`导出 ${zh}`)).toBe(`Export ${en}`)
    localStorage.setItem('aiw.lang', 'zh')
    expect.soft(t(zh)).toBe(zh)
    expect.soft(t(`导出 ${zh}`)).toBe(`导出 ${zh}`)
  }
})

it('translates a version label error added after initialization', async () => {
  localStorage.setItem('aiw.lang', 'en')
  for (const name of ['alert', 'confirm', 'prompt']) vi.stubGlobal(name, vi.fn())
  document.body.innerHTML = '<div id="root"></div>'
  initI18n()
  const error = document.createElement('p')
  error.className = 'error pad'
  error.textContent = '版本标签不能超过 200 字'
  document.getElementById('root')!.append(error)
  await vi.waitFor(() => expect(error.textContent).toBe("Version label can't exceed 200 characters"))
})

it('preserves user titles in lists, including nested text, attributes and later updates', async () => {
  localStorage.setItem('aiw.lang', 'en')
  for (const name of ['alert', 'confirm', 'prompt']) vi.stubGlobal(name, vi.fn())
  document.body.innerHTML = `<div id="root">
    <main><span translate="no" title="设置">设置</span><button>设置</button></main>
    <nav><span translate="no">设置</span><span translate="no"><mark>设置</mark></span></nav>
    <div translate="no"></div>
  </div>`
  initI18n()
  const root = document.getElementById('root')!
  const title = root.querySelector('main span')!
  expect(title.textContent).toBe('设置')
  expect(title.getAttribute('title')).toBe('设置')
  expect(root.querySelector('button')!.textContent).toBe('Settings')
  expect(root.querySelector('nav')!.textContent).toBe('设置设置')
  expect(root.lastElementChild!.textContent).toBe('')

  title.firstChild!.nodeValue = '搜索文档'
  title.setAttribute('title', '搜索文档')
  root.querySelector('nav')!.insertAdjacentHTML('beforeend', '<span translate="no">设置</span><button>设置</button>')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(title.textContent).toBe('搜索文档')
  expect(title.getAttribute('title')).toBe('搜索文档')
  expect(root.querySelector('nav')!.textContent).toBe('设置设置设置Settings')
})

it('translates diff labels but preserves document text, including newly added marked runs', async () => {
  localStorage.setItem('aiw.lang', 'en')
  const root = document.createElement('div')
  root.id = 'root'
  document.body.append(root)
  const plain = { type: 'paragraph', text: '请点击保存按钮' }
  const rows = [
    { id: 'format', left: plain, right: { ...plain, delta: [{ insert: '请点击' }, { insert: '保存', attributes: { bold: true } }, { insert: '按钮' }] } },
    { id: 'words', left: { type: 'paragraph', text: '保存' }, right: { type: 'paragraph', text: '取消' } },
    { id: 'plain', right: { type: 'codeBlock', text: '保存' } },
  ]
  const render = () => { root.innerHTML = renderToStaticMarkup(createElement(DiffView, { rows, leftTitle: '原文', rightTitle: '修改稿' })) }
  const dialogs = { alert: window.alert, confirm: window.confirm, prompt: window.prompt }
  try {
    Object.assign(window, { alert: vi.fn(), confirm: vi.fn(), prompt: vi.fn() })
    render()
    initI18n()
    expect(root.querySelector('strong')!.textContent).toBe('保存')
    expect(root.querySelector('.muted')!.textContent).toBe('Formatting only')
    expect(root.querySelector('.diff-head')!.textContent).toContain('Original')
    expect(root.querySelector('del')!.textContent).toBe('保存')
    expect(root.querySelector('ins')!.textContent).toBe('取消')
    expect(root.querySelector('.diff-cell.added .doc-text')!.textContent).toBe('保存')
    expect(root.querySelector('.diff-cell.added .kind')!.textContent).toBe('Code')
    render()
    await vi.waitFor(() => expect(root.querySelector('.muted')!.textContent).toBe('Formatting only'))
    expect(root.querySelector('strong')!.textContent).toBe('保存')
  } finally {
    Object.assign(window, dialogs)
    root.remove()
    document.querySelector('.floating-tools')?.remove()
  }
})

it.each([
  ['告诉 AI 你想怎么改这篇文档，例如"把全文改得更正式""给每一节加一句小结"。它的修改会以修订的形式出现在文档里，由你逐条确认。也可以选中文字后直接用工具栏里的润色、扩写。', 'Tell AI how you’d like to edit this document, for example, “Make the whole document more formal” or “Add a short summary to each section.” Its edits appear as tracked changes for you to review one by one. You can also select text and use Polish or Expand in the toolbar.'],
  ['让 AI 修改这篇文档…（@ 引用评论或段落，Enter 发送）', 'Ask AI to edit this document… (@ to reference a comment or paragraph, Enter to send)'],
  ['还没有对话', 'No chats yet'],
  ['切换对话', 'Switch chat'],
  ['段落', 'Paragraph'],
])('translates AI panel copy %s without changing Chinese', (zh, en) => {
  localStorage.setItem('aiw.lang', 'en')
  expect(t(zh)).toBe(en)
  localStorage.setItem('aiw.lang', 'zh')
  expect(t(zh)).toBe(zh)
})

it.each([
  ['公式', 'Formula'],
  ['$$ 空格，LaTeX 实时预览', '$$ space, live LaTeX preview'],
  ['Mermaid 图表', 'Mermaid diagram'],
  ['```mermaid 空格，流程图等', '```mermaid + Space for flowcharts and more'],
  ['AI 生成图表', 'Generate diagram with AI'],
  ['用一句话描述，AI 画出来', 'Describe it in one sentence; AI draws it'],
  ['draw.io 图', 'draw.io diagram'],
  ['在 draw.io 里画图', 'Draw a diagram in draw.io'],
  ['描述画面，AI 画出来', 'Describe an image for AI to draw'],
  ['视频', 'Video'],
  ['上传本地视频（最大 1GB）', 'Upload a local video (up to 1 GB)'],
  ['嵌入视频', 'Embed video'],
  ['B 站 / YouTube / Vimeo 链接', 'Bilibili / YouTube / Vimeo link'],
  ['附件', 'Attachment'],
  ['上传 PDF、Office、压缩包等文件', 'Upload PDFs, Office files, archives, and more'],
  ['链接卡片', 'Link card'],
  ['粘贴网址生成预览卡片', 'Paste a URL to create a preview card'],
])('translates the slash menu string "%s" only in English mode', (zh, en) => {
  localStorage.setItem('aiw.lang', 'zh')
  expect(t(zh)).toBe(zh)
  localStorage.setItem('aiw.lang', 'en')
  expect(t(zh)).toBe(en)
})

it('translates folder page empty, normal and error states without changing Chinese', () => {
  const labels = [
  ['空文件夹（把文档拖进来）', 'Empty folder (drag documents here)'],
  ['侧边面板', 'Side panel'],
  ['文档标题：Draft', 'Document title: Draft'],
  ['单独打开 Draft', 'Open Draft separately'],
  ['共 0 篇', '0 documents'],
  ['共 1 篇', '1 document'],
  ['共 2 篇', '2 documents'],
  ['0 处修订', '0 changes'],
  ['1 处修订', '1 change'],
  ['3 处修订', '3 changes'],
  [
    "找不到这个文件夹，或者你没有权限打开它。",
    "This folder could not be found, or you do not have permission to open it."
  ],
  [
    "这个文件夹还是空的。把侧栏里的文档拖进来，或用文档旁的“移动到…”。",
    "This folder is empty. Drag documents here from the sidebar, or use “Move to…” next to a document."
  ],
  [
    "这里的 AI 能阅读并修改这个文件夹里的全部文档，例如\"统一各篇的语气\"\"检查前后的术语是否一致\"。修改会以修订的形式出现在对应文档里，由你逐条确认。",
    "The AI here can read and edit all documents in this folder, for example to make the tone consistent or check terminology across documents. Edits appear as changes in each document for you to review individually."
  ],
  [
    "没有可用的模型。请在\"设置\"里填写模型密钥。",
    "No models available. Enter a model API key in \"Settings\"."
  ],
  [
    "没有可编辑的文档",
    "No editable documents"
  ],
  [
    "文件夹名称",
    "Folder name"
  ],
  [
    "文件夹大纲",
    "Folder outline"
  ],
  [
    "给文件夹里的 AI 的指令",
    "Instructions for the folder AI"
  ],
  [
    "让 AI 处理整个文件夹…（Enter 发送）",
    "Ask AI to work on the whole folder… (Enter to send)"
  ],
  [
    "在单独页面中打开",
    "Open on a separate page"
  ],
  [
    "滚动到这里时加载内容…",
    "Content loads when you scroll here…"
  ],
  [
    "收起修订",
    "Hide changes"
  ],
  [
    "收起AI",
    "Hide AI"
  ]
]
  for (const [zh, en] of labels) {
    localStorage.setItem('aiw.lang', 'zh')
    expect(t(zh!)).toBe(zh)
    localStorage.setItem('aiw.lang', 'en')
    expect(t(zh!)).toBe(en)
  }
})

it.each(['设置', '搜索文档', '删除 草稿', ''])('preserves interpolated user titles (%s) while translating UI labels', (title) => {
  localStorage.setItem('aiw.lang', 'en')
  const labels = [
    [`无法删除"${title}"。`, `Can't delete "${title}".`],
    [`删除文件夹"${title}"？`, `Delete folder "${title}"?`],
    [`永久删除"${title}"？`, `Permanently delete "${title}"?`],
    [`把"${title}"移到回收站？`, `Move "${title}" to the trash?`],
    [`"${title}" 已移到回收站`, `"${title}" moved to the trash`],
    [`文档标题：${title}`, `Document title: ${title}`],
    [`单独打开 ${title}`, `Open ${title} separately`],
  ]
  for (const [zh, en] of labels) {
    // Empty trailing titles are trimmed by the translator before pattern matching.
    if (!title && zh === '单独打开 ') continue
    expect(t(zh!)).toBe(en)
  }
})

it('translates the Settings model roles, including automatic, empty and error states', () => {
  const labels = [
    ['模型分工', 'Model roles'],
    ['识图模型', 'Vision model'],
    ['图片生成模型', 'Image generation model'],
    ['改图模型', 'Image editing model'],
    ['语音转写模型', 'Transcription model'],
    ['图表生成模型', 'Diagram generation model'],
    ['图片描述、AI 看图、扫描版 PDF 识别', 'Image descriptions, AI vision and scanned PDF recognition'],
    ['AI 生成图片', 'AI image generation'],
    ['AI 改图', 'AI image editing'],
    ['视频转文字稿和字幕', 'Video transcripts and subtitles'],
    ['Mermaid、公式、draw.io 的 AI 生成（自动 = 跟随默认模型）', 'AI generation of Mermaid, formulas and draw.io (automatic = use the default model)'],
    ['自动', 'Automatic'],
    ['自动（当前：Example Model）', 'Automatic (current: Example Model)'],
    ['模型分工暂时不可用', 'Model roles are temporarily unavailable'],
    ['模型分工暂时不可用：HTTP 500', 'Model roles are temporarily unavailable: HTTP 500'],
    ...[['文字', 'Text'], ['识图', 'Vision'], ['生图', 'Image generation'], ['改图', 'Image editing'], ['转写', 'Transcription']].map(([zh, en]) => [
      `没有可用的模型：在模型提供方里给模型勾选"${zh}"能力`,
      `No models available: enable the "${en}" capability for a model under Model providers`,
    ]),
  ]
  for (const [zh, en] of labels) {
    localStorage.setItem('aiw.lang', 'zh')
    expect(t(zh!)).toBe(zh)
    localStorage.setItem('aiw.lang', 'en')
    expect(t(zh!)).toBe(en)
  }
})

it('keeps import overflow notices in Chinese or translates them in the English UI', () => {
  const warning = '导入最多保留前 2000 个段落。继续创建将省略最后 1 个段落。'
  const error = '导入内容超过 2000 个段落，请拆分后重试。'
  localStorage.setItem('aiw.lang', 'zh')
  expect(t(warning)).toBe(warning)
  expect(t(error)).toBe(error)

  localStorage.setItem('aiw.lang', 'en')
  expect(t(warning)).toBe('This import can keep only the first 2000 blocks. Creating the document will omit the last 1 block.')
  expect(t(error)).toBe('The import exceeds 2000 blocks. Split the file and try again.')
})

it.each([
  ['2', 'Page 2 has no extractable text and was skipped. Configure a vision model to recognize this page.'],
  ['2, 4', 'Pages 2, 4 have no extractable text and were skipped. Configure a vision model to recognize these pages.'],
])('translates skipped PDF page numbers (%s)', (pages, expected) => {
  const warning = `第 ${pages} 页没有可提取的文字，已跳过。配置支持图像的模型后可识别这些页面。`
  localStorage.setItem('aiw.lang', 'zh')
  expect(t(warning)).toBe(warning)
  localStorage.setItem('aiw.lang', 'en')
  expect(t(warning)).toBe(expected)
})

it.each([1, 3])('translates omitted PDF pages (%i)', (count) => {
  const warning = `PDF 导入最多保留前 500 页。继续创建将省略最后 ${count} 页。`
  localStorage.setItem('aiw.lang', 'zh')
  expect(t(warning)).toBe(warning)
  localStorage.setItem('aiw.lang', 'en')
  expect(t(warning)).toBe(`This PDF import can keep only the first 500 pages. Creating the document will omit the last ${count} ${count === 1 ? 'page' : 'pages'}.`)
})

it('translates the PDF recognition limit warning', () => {
  const warning = '第 2, 4 页没有可提取的文字，已跳过。这些页面超过了 40 页识别上限，请拆分 PDF 后重试。'
  localStorage.setItem('aiw.lang', 'zh')
  expect(t(warning)).toBe(warning)
  localStorage.setItem('aiw.lang', 'en')
  expect(t(warning)).toBe('Pages 2, 4 have no extractable text and were skipped because they exceed the 40-page recognition limit. Split the PDF and try again.')
})
