import { MAX_IMPORT_BLOCKS } from '@stetpad/clip'
import { browser } from 'wxt/browser'

export function clipOverflowNotice(omitted: number): string {
  return browser.i18n.getUILanguage().toLowerCase().startsWith('zh')
    ? `只保留了前 ${MAX_IMPORT_BLOCKS} 个区块，已省略最后 ${omitted} 个区块。`
    : `Only the first ${MAX_IMPORT_BLOCKS} blocks were kept. The last ${omitted} ${omitted === 1 ? 'block was' : 'blocks were'} omitted.`
}
