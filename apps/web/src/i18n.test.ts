// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { t } from './i18n'

afterEach(() => localStorage.removeItem('aiw.lang'))

it('translates folder page empty, normal and error states without changing Chinese', () => {
  const labels = [
  ['空文件夹（把文档拖进来）', 'Empty folder (drag documents here)'],
  ['侧边面板', 'Side panel'],
  ['文档标题：Draft', 'Document title: Draft'],
  ['单独打开 Draft', 'Open separately Draft'],
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
  ],
  [
    "共",
    "Total"
  ],
  [
    "篇",
    "documents"
  ],
  [
    "处修订",
    "changes"
  ]
]
  for (const [zh, en] of labels) {
    localStorage.setItem('aiw.lang', 'zh')
    expect(t(zh!)).toBe(zh)
    localStorage.setItem('aiw.lang', 'en')
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
