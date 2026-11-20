import { MAX_IMPORT_BLOCKS } from '@stetpad/clip'

const overflowMessages = {
  'zh-CN': (limit: number, omitted: number) => `只保留了前 ${limit} 个区块，已省略最后 ${omitted} 个区块。`,
  en: (limit: number, omitted: number) => `Only the first ${limit} blocks were kept. The last ${omitted} ${omitted === 1 ? 'block was' : 'blocks were'} omitted.`,
}

// The extension UI is Chinese, regardless of the browser's locale.
const CLIPPER_UI_LOCALE = 'zh-CN'

export function clipOverflowNotice(omitted: number, locale: keyof typeof overflowMessages = CLIPPER_UI_LOCALE): string {
  return overflowMessages[locale](MAX_IMPORT_BLOCKS, omitted)
}
