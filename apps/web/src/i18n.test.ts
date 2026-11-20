// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { t } from './i18n'

afterEach(() => localStorage.removeItem('aiw.lang'))

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
