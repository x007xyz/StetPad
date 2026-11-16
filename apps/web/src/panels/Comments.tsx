import type { CommentView } from '@stetpad/crdt'
import { useState } from 'react'
import { fmtTime } from '../api'

export function CommentsPanel({ list, canWrite, onReply, onResolve, onDelete, onFocus }: {
  list: CommentView[]
  canWrite: boolean
  onReply: (id: string, text: string) => void
  onResolve: (id: string, resolved: boolean) => void
  onDelete: (id: string) => void
  onFocus: (id: string) => void
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [showResolved, setShowResolved] = useState(false)
  const open = list.filter((c) => !c.resolved)
  const shown = showResolved ? list : open
  return (
    <div className="comments">
      <div className="row between pad">
        <strong>{open.length} 条未解决</strong>
        {list.length > open.length && (
          <label className="row"><input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> 显示已解决</label>
        )}
      </div>
      {list.length === 0 && <p className="muted pad">还没有评论。选中一段文字，点工具栏里的"评论"。AI 也会把需要你决定的事写成评论。</p>}
      <ul>
        {shown.map((c) => (
          <li key={c.id} className={c.resolved ? 'resolved' : ''}>
            <button className="change-body" onClick={() => onFocus(c.id)}>
              <div className="quote-of">{c.orphaned ? <span className="warn">原文已删除：</span> : null}{c.quote}</div>
              <div><strong>{c.author}</strong> <span className="muted small">{fmtTime(c.createdAt)}</span></div>
              <div className="answer">{c.text}</div>
            </button>
            {c.replies.map((r, i) => (
              <div key={i} className="reply"><strong>{r.author}</strong> <span className="muted small">{fmtTime(r.createdAt)}</span><div className="answer">{r.text}</div></div>
            ))}
            {canWrite && (
              <form className="row" onSubmit={(e) => {
                e.preventDefault()
                const t = (drafts[c.id] ?? '').trim()
                if (!t) return
                onReply(c.id, t)
                setDrafts({ ...drafts, [c.id]: '' })
              }}>
                <input aria-label="回复" placeholder="回复…" value={drafts[c.id] ?? ''} onChange={(e) => setDrafts({ ...drafts, [c.id]: e.target.value })} />
                <button className="link" type="button" onClick={() => onResolve(c.id, !c.resolved)}>{c.resolved ? '重新打开' : '解决'}</button>
                <button className="link danger" type="button" onClick={() => onDelete(c.id)}>删除</button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
