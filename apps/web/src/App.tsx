import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { api } from './api'
import { Home } from './Home'
import { t } from './i18n'
import { Shell } from './Shell'
import { TrashPage } from './TrashPage'

const DocPage = lazy(() => import('./DocPage').then((m) => ({ default: m.DocPage })))
const FolderPage = lazy(() => import('./FolderPage').then((m) => ({ default: m.FolderPage })))

type Route =
  | { page: 'home' }
  | { page: 'doc'; id: string }
  | { page: 'folder'; id: string }
  | { page: 'trash' }
const parse = (): Route => {
  if (location.hash === '#/trash') return { page: 'trash' }
  const fo = location.hash.match(/^#\/f\/([\w-]+)/)
  if (fo) return { page: 'folder', id: fo[1]! }
  const m = location.hash.match(/^#\/d\/([\w-]+)/)
  return m ? { page: 'doc', id: m[1]! } : { page: 'home' }
}
export const go = (r: Route): void => {
  location.hash = r.page === 'doc' ? `#/d/${r.id}` : r.page === 'folder' ? `#/f/${r.id}` : r.page === 'trash' ? '#/trash' : '#/'
}

export interface Session { user: { id: string; email: string } }

export function App() {
  const [route, setRoute] = useState<Route>(parse)
  const [session, setSession] = useState<Session | null>(null)
  const [loadError, setLoadError] = useState('')

  const load = useCallback(async () => {
    try {
      setSession(await api<Session>('/me'))
      setLoadError('')
    } catch {
      // The desktop app runs its own local service; there is no sign-in to fall back to.
      setLoadError('无法连接本机服务，请重启应用')
    }
  }, [])
  useEffect(() => {
    void load()
    const on = (): void => setRoute(parse())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [load])
  // Document and folder pages name the tab themselves; the others reset it.
  useEffect(() => {
    if (route.page === 'home') document.title = 'Stetpad'
    else if (route.page === 'trash') document.title = `${t('回收站')} · Stetpad`
  }, [route])

  if (loadError) return <div className="center"><div className="rounded-xl border border-border p-6">{loadError}</div></div>
  if (session === null) return <div className="center muted">加载中…</div>
  return (
    <Shell session={session} activeId={route.page === 'doc' ? route.id : undefined} activeFolderId={route.page === 'folder' ? route.id : undefined} trashActive={route.page === 'trash'}>
      <Suspense fallback={<div className="center muted">加载中…</div>}>
        {route.page === 'doc' ? <DocPage key={route.id} id={route.id} /> : route.page === 'folder' ? <FolderPage key={route.id} id={route.id} /> : route.page === 'trash' ? <TrashPage /> : <Home />}
      </Suspense>
    </Shell>
  )
}
