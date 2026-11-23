// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { editorExtensions } from './extensions'
import { describeImage, transcribeVideo, applyTranscript } from './media'

vi.mock('./media', async (original) => ({
  ...await original<typeof import('./media')>(),
  describeImage: vi.fn(), transcribeVideo: vi.fn(), applyTranscript: vi.fn(),
}))
vi.mock('./poster', () => ({ ensurePoster: vi.fn() }))

let editor: Editor
afterEach(() => { editor?.destroy(); vi.resetAllMocks() })

it.each(['image', 'video'] as const)('routes %s errors through the configured callback', async (type) => {
  const onError = vi.fn()
  editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions({ ydoc: new Y.Doc(), docId: 'doc', placeholder: '', user: () => ({ author: 'Me', tracking: false }), onError }),
  })
  editor.commands.setContent({ type: 'doc', content: [{ type, attrs: { blockId: 'block', src: '/files/test', kind: 'file' } }] })
  const request = vi.mocked(type === 'image' ? describeImage : transcribeVideo)
  const button = editor.view.dom.querySelector<HTMLButtonElement>(type === 'image' ? '.image-tools button' : '.video-tools button')!
  expect(button).not.toBeNull()
  request.mockRejectedValueOnce(new Error('Request failed'))
  button.click()
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('Request failed'))
  await vi.waitFor(() => expect(button.disabled).toBe(false))
  request.mockRejectedValueOnce(null)
  button.click()
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(type === 'image' ? '描述失败' : '转写失败'))
  await vi.waitFor(() => expect(button.disabled).toBe(false))
  onError.mockClear()
  if (type === 'image') vi.mocked(describeImage).mockResolvedValueOnce('')
  else vi.mocked(transcribeVideo).mockResolvedValueOnce({ text: '', segments: [], vtt: '' })
  vi.mocked(applyTranscript).mockReturnValue(true)
  button.click()
  await vi.waitFor(() => expect(button.disabled).toBe(false))
  expect(onError).not.toHaveBeenCalled()
  if (type === 'video') {
    vi.mocked(transcribeVideo).mockResolvedValueOnce({ text: 'Transcript', segments: [], vtt: '/files/vtt' })
    vi.mocked(applyTranscript).mockReturnValue(false)
    button.click()
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('视频已不在文档里，字幕没有写入'))
  }
})
