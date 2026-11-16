import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, ApiError, getToken, post, setToken, type DocMeta } from './api'
import { DocPage } from './DocPage'
import { FolderPage } from './FolderPage'
import { Button } from './components/ui/button'
import { Field, Input } from './components/ui/input'
import { Home } from './Home'
import { Shell } from './Shell'

type Route = { page: 'home' } | { page: 'doc'; id: string } | { page: 'folder'; id: string } | { page: 'share'; token: string }
const parse = (): Route => {
  const sh = location.hash.match(/^#\/s\/([\w-]+)/)
  if (sh) return { page: 'share', token: sh[1]! }
  const fo = location.hash.match(/^#\/f\/([\w-]+)/)
  if (fo) return { page: 'folder', id: fo[1]! }
  const m = location.hash.match(/^#\/d\/([\w-]+)/)
  return m ? { page: 'doc', id: m[1]! } : { page: 'home' }
}
export const go = (r: Route): void => {
  location.hash = r.page === 'doc' ? `#/d/${r.id}` : r.page === 'folder' ? `#/f/${r.id}` : r.page === 'share' ? `#/s/${r.token}` : '#/'
}

export interface Session { user: { id: string; email: string }; mode: 'local' | 'web' }

export function App() {
  const [route, setRoute] = useState<Route>(parse)
  const [session, setSession] = useState<Session | null | 'anonymous'>(null)

  const load = useCallback(async () => {
    try {
      setSession(await api<Session>('/me'))
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setSession('anonymous')
      else throw e
    }
  }, [])
  useEffect(() => {
    void load()
    const on = (): void => setRoute(parse())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [load])

  // A share link works without an account.
  if (route.page === 'share') return <SharedDoc key={route.token} token={route.token} />
  if (session === null) return <div className="center muted">加载中…</div>
  if (session === 'anonymous') return <Login onDone={load} />
  const logout = async (): Promise<void> => {
    await post('/auth/logout').catch(() => {})
    setToken(null)
    setSession('anonymous')
  }
  return (
    <Shell session={session} onLogout={logout} activeId={route.page === 'doc' ? route.id : undefined} activeFolderId={route.page === 'folder' ? route.id : undefined}>
      {route.page === 'doc' ? <DocPage key={route.id} id={route.id} session={session} /> : route.page === 'folder' ? <FolderPage key={route.id} id={route.id} session={session} /> : <Home />}
    </Shell>
  )
}

function SharedDoc({ token }: { token: string }) {
  const [info, setInfo] = useState<{ docId: string; title: string; role: 'edit' | 'suggest' | 'view' } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    fetch(`/api/share/${token}`).then(async (r) => {
      const body = await r.json()
      if (r.ok) setInfo(body)
      else setError(body.error ?? '链接无效')
    }).catch(() => setError('无法连接服务器'))
  }, [token])
  if (error) return <div className="center"><div className="rounded-xl border border-border p-6">{error}</div></div>
  if (!info) return <div className="center muted">加载中…</div>
  return <SharedPage token={token} info={info} />
}

function SharedPage({ token, info }: { token: string; info: { docId: string; title: string; role: 'edit' | 'suggest' | 'view' } }) {
  // One stable object: the document page reconnects when this identity changes.
  const shared = useMemo(() => ({ token, role: info.role, title: info.title }), [token, info.role, info.title])
  return <div className="flex h-full flex-col"><DocPage id={info.docId} session={null} shared={shared} /></div>
}

function Login({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const r = await post<{ token: string }>(`/auth/${mode}`, { email, password })
      setToken(r.token)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : '出错了')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="center">
      <form className="flex w-full max-w-sm flex-col gap-1" onSubmit={submit}>
        <img src="/favicon.svg" alt="" className="mb-3 size-10" />
        <h1 className="text-2xl font-bold tracking-tight">Stetpad</h1>
        <p className="muted mb-2">AI 的每一处修改都由你逐条确认。</p>
        <Field label="邮箱">
          <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="h-9" />
        </Field>
        <Field label="密码">
          <Input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required className="h-9" />
        </Field>
        {error && <p className="error">{error}</p>}
        <Button type="submit" variant="default" size="lg" className="mt-4" disabled={busy}>{mode === 'login' ? '登录' : '注册并登录'}</Button>
        <Button type="button" variant="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? '没有账号？注册' : '已有账号？登录'}
        </Button>
      </form>
    </div>
  )
}

export type { DocMeta }
export { getToken }
