import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initI18n } from './i18n'
import { initTheme } from './theme'
import './style.css'

initTheme()
createRoot(document.getElementById('root')!).render(<App />)
initI18n()
