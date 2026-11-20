// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { fmtTime } from './api'
import { ago } from './panels/Ai'
import { t } from './i18n'

afterEach(() => {
  localStorage.removeItem('aiw.lang')
  vi.useRealTimers()
})

it.each(['en', 'zh'])('formats dates in the selected %s UI language', (lang) => {
  localStorage.setItem('aiw.lang', lang)
  const date = new Date(2026, 10, 20, 9, 5).getTime()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 22, 12))
  expect(fmtTime(date)).toBe(lang === 'en' ? 'Nov 20, 09:05' : '11月20日 09:05')
  expect(t(ago(Date.now()))).toBe(lang === 'en' ? 'Just now' : '刚刚')
  expect(t(ago(Date.now() - 5 * 60_000))).toBe(lang === 'en' ? '5 min ago' : '5 分钟前')
  expect(t(ago(Date.now() - 2 * 3600_000))).toBe(lang === 'en' ? '2 h ago' : '2 小时前')
})

it.each(['en', 'zh'])('formats older AI chat dates in %s', (lang) => {
  localStorage.setItem('aiw.lang', lang)
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 22, 12))
  expect(ago(new Date(2026, 10, 20, 9, 5).getTime())).toBe(lang === 'en' ? 'Nov 20' : '11月20日')
})

it.each(['en', 'zh'])('translates the versions tooltip and accessible label in %s', (lang) => {
  localStorage.setItem('aiw.lang', lang)
  expect(t('版本历史')).toBe(lang === 'en' ? 'Version history' : '版本历史')
})
