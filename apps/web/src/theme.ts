/** Light / dark. Follows the system until the user picks one; the choice is remembered. */
const KEY = 'aiw.theme'
type Theme = 'light' | 'dark'

const stored = (): Theme | null => {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : null
  } catch {
    return null
  }
}
const systemDark = (): boolean => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
const apply = (t: Theme): void => {
  document.documentElement.classList.toggle('dark', t === 'dark')
}

export function initTheme(): void {
  apply(stored() ?? (systemDark() ? 'dark' : 'light'))
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!stored()) apply(systemDark() ? 'dark' : 'light')
  })
}

export function toggleTheme(): void {
  const next: Theme = document.documentElement.classList.contains('dark') ? 'light' : 'dark'
  try {
    localStorage.setItem(KEY, next)
  } catch {
    /* storage unavailable */
  }
  apply(next)
}
