import { domToBlocks } from '@stetpad/clip'
import { parseHTML } from 'linkedom'
import { expect, it, vi } from 'vitest'
import { clipOverflowNotice } from '../src/lib/i18n'

const { addListener, addMenuListener, executeScript, setTitle } = vi.hoisted(() => ({
  addListener: vi.fn(), addMenuListener: vi.fn(), executeScript: vi.fn(), setTitle: vi.fn(),
}))
vi.mock('wxt/browser', () => ({
  browser: {
    runtime: { getManifest: () => ({ name: 'Stetpad Web Clipper' }), onInstalled: { addListener: vi.fn() }, onMessage: { addListener } },
    storage: { local: {
      get: vi.fn(async () => ({
        'stetpad.profiles': { local: { id: 'local', mode: 'local', baseUrl: 'http://127.0.0.1:8787', token: 'clp_test' } },
      })),
      set: vi.fn(),
    } },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn(), setTitle },
    contextMenus: { onClicked: { addListener: addMenuListener } },
    scripting: { executeScript },
    i18n: { getUILanguage: () => 'en-US' },
  },
}))

it('saves the first 2,000 clip blocks including the source header and reports the omitted tail', async () => {
  vi.stubGlobal('defineBackground', (entry: () => void) => entry())
  const paragraphs = Array.from({ length: 2001 }, (_, i) => `Paragraph ${i + 1}`)
  const { document } = parseHTML(`<html><body>${paragraphs.map((p) => `<p>${p}</p>`).join('')}</body></html>`)
  const blocks = domToBlocks(document.body)
  expect(blocks).toHaveLength(2001)
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/clipper/ping')) return Response.json({ service: 'stetpad', mode: 'local' })
    const body = JSON.parse(init?.body as string)
    if (body.blocks.length > 2000) return Response.json({ error: 'Import exceeds 2,000 blocks' }, { status: 413 })
    return Response.json({ id: 'doc' })
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.useFakeTimers()
  try {
    await import('../entrypoints/background')
    const result = await addListener.mock.calls[0]![0]({
      type: 'stetpad:clip',
      payload: {
        profileId: 'local', workflow: 'create', sourceKind: 'article', title: 'Long page',
        url: 'https://example.com', note: '', localizeImages: false, asSuggestion: false, blocks,
      },
    })
    expect(result).toMatchObject({ ok: true, result: { docId: 'doc', omittedBlockCount: 3 } })
    const call = fetchMock.mock.calls.find(([url]) => url.endsWith('/api/import/create'))!
    const sent = JSON.parse(call[1]?.body as string).blocks
    expect(sent.slice(0, 2).map((b: { type: string }) => b.type)).toEqual(['quote', 'divider'])
    expect(sent.slice(2)).toEqual(blocks.slice(0, 1998))

    executeScript.mockResolvedValue([{ result: { url: 'https://example.com', title: 'Long page', articleBlocks: blocks, articleMarkdown: '' } }])
    addMenuListener.mock.calls[0]![0]({ menuItemId: 'stetpad-clip-page' }, { id: 1 })
    await vi.waitFor(() => expect(setTitle).toHaveBeenLastCalledWith({ title: '只保留了前 2000 个区块，已省略最后 3 个区块。' }))
  } finally {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

it('uses the clipper UI language by default and provides an English translation', () => {
  expect(clipOverflowNotice(1)).toBe('只保留了前 2000 个区块，已省略最后 1 个区块。')
  expect(clipOverflowNotice(1, 'en')).toBe('Only the first 2000 blocks were kept. The last 1 block was omitted.')
})
