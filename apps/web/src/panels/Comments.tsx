import type { CommentView } from '@stetpad/crdt'
import { useEffect, useRef, useState } from 'react'
import { fmtTime } from '../api'
import { MentionInput, renderMentions } from '../MentionInput'

export function CommentsPanel({ list, focusId, aiHint, onReply, onResolve, onDelete, onFocus }: {
  list: CommentView[]
  /** A comment to bring into view (from a deep link). */
  focusId?: string | null
  /** Shown after a comment or reply asked @AI. */
  aiHint: boolean
  onReply: (id: string, text: string) => void
  onResolve: (id: string, resolved: boolean) => void
  onDelete: (id: string) => void
  onFocus: (id: string) => void
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [showResolved, setShowResolved] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const open = list.filter((c) => !c.resolved)
  const shown = showResolved ? list : open

  // Bring the linked comment into view, showing resolved ones if it is one of them.
  const focused = focusId ? list.find((c) => c.id === focusId) : undefined
  useEffect(() => {
    if (focused?.resolved) setShowResolved(true)
  }, [focused?.id, focused?.resolved])
  useEffect(() => {
    if (!focusId) return
    const t = setTimeout(() => {
      const el = root.current?.querySelector<HTMLElement>(`[data-cid="${focusId}"]`)
      if (!el) return
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.classList.add('flash')
      setTimeout(() => el.classList.remove('flash'), 1200)
    }, 60)
    return () => clearTimeout(t)
  }, [focusId, showResolved, list.length])

  return (
    <div className="comments" ref={root}>
      <div className="row between pad">
        <strong>{open.length} 条未解决</strong>
        {list.length > open.length && (
          <label className="row"><input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> 显示已解决</label>
        )}
      </div>
      {aiHint && <p className="ai-hint pad small" role="status">已请 AI 处理，回复会出现在这条评论下</p>}
      {list.length === 0 && <p className="muted pad">还没有评论。选中一段文字，点工具栏里的"评论"。AI 也会把需要你决定的事写成评论。</p>}
      <ul>
        {shown.map((c) => (
          <li key={c.id} data-cid={c.id} className={c.resolved ? 'resolved' : ''}>
            <button className="change-body" onClick={() => onFocus(c.id)}>
              <div className="quote-of">{c.orphaned ? <span className="warn">原文已删除：</span> : null}{c.quote}</div>
              <div><strong>{c.author}</strong> <span className="muted small">{fmtTime(c.createdAt)}</span></div>
              <div className="answer">{renderMentions(c.text)}</div>
            </button>
            {c.replies.map((r, i) => (
              <div key={i} className="reply"><strong>{r.author}</strong> <span className="muted small">{fmtTime(r.createdAt)}</span><div className="answer">{renderMentions(r.text)}</div></div>
            ))}
            <form className="row" onSubmit={(e) => {
              e.preventDefault()
              const t = (drafts[c.id] ?? '').trim()
              if (!t) return
              onReply(c.id, t)
              setDrafts({ ...drafts, [c.id]: '' })
            }}>
              <MentionInput
                aria-label="回复"
                placeholder="回复…"
                value={drafts[c.id] ?? ''}
                onChange={(v) => setDrafts({ ...drafts, [c.id]: v })}
              />
              <button className="link" type="button" onClick={() => onResolve(c.id, !c.resolved)}>{c.resolved ? '重新打开' : '解决'}</button>
              <button className="link danger" type="button" onClick={() => onDelete(c.id)}>删除</button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  )
}
