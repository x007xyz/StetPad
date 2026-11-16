import { useEffect, useState } from 'react'
import { api, post, type Space } from './api'
import { Button } from './components/ui/button'
import { Dialog, DialogContent } from './components/ui/dialog'
import { Input } from './components/ui/input'
import { Select } from './components/ui/select'

export function Members({ space, onClose }: { space: Space; onClose: () => void }) {
  const [list, setList] = useState<{ user_id: string; email: string; role: string }[]>([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('editor')
  const [error, setError] = useState('')
  const load = (): Promise<void> => api<{ user_id: string; email: string; role: string }[]>(`/spaces/${space.id}/members`).then(setList)
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space.id])
  const names: Record<string, string> = { owner: '所有者', editor: '可编辑', viewer: '只读' }
  const owner = space.role === 'owner'
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`${space.name} 的成员`}>
        <ul className="shares">
          {list.map((m) => (
            <li key={m.user_id}>
              <span style={{ flex: 1 }}>{m.email}</span>
              <span className="chip">{names[m.role] ?? m.role}</span>
              {owner && m.role !== 'owner' && <Button variant="destructive" size="sm" onClick={async () => { await api(`/spaces/${space.id}/members/${m.user_id}`, { method: 'DELETE' }); await load() }}>移除</Button>}
            </li>
          ))}
        </ul>
        {owner && (
          <form className="mt-3 flex items-center gap-2" onSubmit={async (e) => {
            e.preventDefault()
            setError('')
            try {
              await post(`/spaces/${space.id}/members`, { email, role })
              setEmail('')
              await load()
            } catch (err) {
              setError(err instanceof Error ? err.message : '添加失败')
            }
          }}>
            <Input type="email" required placeholder="对方的注册邮箱" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Select className="w-28 shrink-0" aria-label="角色" value={role} onValueChange={setRole} options={[{ value: 'editor', label: '可编辑' }, { value: 'viewer', label: '只读' }]} />
            <Button variant="default">添加</Button>
          </form>
        )}
        {error && <p className="error mt-2 text-sm">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}
