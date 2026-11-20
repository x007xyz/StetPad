// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { t } from './i18n'

afterEach(() => localStorage.removeItem('aiw.lang'))

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
