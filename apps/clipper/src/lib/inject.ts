import { browser } from 'wxt/browser'
import type { ExtractedPage } from './types'

interface ExtractorHandle {
  extract: () => ExtractedPage
  fetchImageBase64: (imgUrl: string) => Promise<{ base64: string; mime: string } | null>
}

export async function injectExtractor(tabId: number): Promise<void> {
  await browser.scripting.executeScript({
    target: { tabId },
    files: ['/extractor.js'],
  })
}

export async function extractActiveTab(tabId: number): Promise<ExtractedPage> {
  await injectExtractor(tabId)
  const results = await browser.scripting.executeScript({
    target: { tabId },
    func: () => {
      const handle = (globalThis as unknown as { __stetpadExtractor?: ExtractorHandle }).__stetpadExtractor
      return handle ? handle.extract() : null
    },
  })
  const data = results[0]?.result as ExtractedPage | null | undefined
  if (!data) throw new Error('无法读取当前网页内容（浏览器限制页面或脚本注入失败）')
  return data
}

export async function fetchImageViaTab(tabId: number, imgUrl: string): Promise<{ base64: string; mime: string } | null> {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: async (url: string) => {
        const handle = (globalThis as unknown as { __stetpadExtractor?: ExtractorHandle }).__stetpadExtractor
        return handle ? await handle.fetchImageBase64(url) : null
      },
      args: [imgUrl],
    })
    return (results[0]?.result as { base64: string; mime: string } | null | undefined) ?? null
  } catch {
    return null
  }
}
