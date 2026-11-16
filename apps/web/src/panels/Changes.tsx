import { useState } from 'react'
import type { DecidedChange, PendingChange } from '@stetpad/crdt'

const clip = (s: string, n = 80): string => (s.length > n ? s.slice(0, n) + '…' : s)

/** A decided change: a badge in the chat; click it to see exactly what was changed. */
function DecidedItem({ c }: { c: DecidedChange }) {
  const [open, setOpen] = useState(false)
  const ok = c.decision === 'accept'
  const brief = c.inserted || c.deleted || c.insertedBlocks[0] || c.deletedBlocks[0] || ''
  return (
    <li className="decided" data-decision={c.decision}>
      <button className="decided-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={'badge ' + (ok ? 'ok' : 'no')}>{ok ? '✓ 已接受' : '✗ 已拒绝'}</span>
        <span className="muted small">{clip(brief, 30)}</span>
        <span className="muted small">{open ? '收起' : '查看修改'}</span>
      </button>
      {open && (
        <div className="decided-detail">
          {c.deletedBlocks.map((b, i) => <div key={'d' + i}><span className="tag del">删除段落</span> <del>{b}</del></div>)}
          {c.insertedBlocks.map((b, i) => <div key={'i' + i}><span className="tag ins">新增段落</span> <ins>{b}</ins></div>)}
          {(c.deleted || c.inserted) && (
            <div>
              {c.deleted && <del>{c.deleted}</del>}
              {c.deleted && c.inserted && ' → '}
              {c.inserted && <ins>{c.inserted}</ins>}
            </div>
          )}
          {c.reason && <div className="reason">{c.reason}</div>}
        </div>
      )}
    </li>
  )
}

/** The pending changes of one AI run, with accept/reject right in the chat (like Cursor). */
export function RunChanges({ changes, decided = [], blockText, onDecide, onFocus, canDecide = true }: {
  canDecide?: boolean
  changes: PendingChange[]
  decided?: DecidedChange[]
  blockText: (id: string) => string
  onDecide: (ids: string[], d: 'accept' | 'reject') => void
  onFocus: (id: string) => void
}) {
  if (changes.length === 0 && decided.length === 0) return null
  const all = changes.map((c) => c.id)
  return (
    <div className="run-changes">
      {decided.length > 0 && <ul>{decided.map((c) => <DecidedItem key={c.id} c={c} />)}</ul>}
      {changes.length > 0 && <div className="row between">
        <strong className="small">{changes.length} 处待确认</strong>
        {canDecide && (
          <span className="row">
            <button onClick={() => onDecide(all, 'accept')}>全部接受</button>
            <button onClick={() => onDecide(all, 'reject')}>全部拒绝</button>
          </span>
        )}
      </div>}
      <ul>
        {changes.map((c) => (
          <li key={c.id}>
            <button className="change-body" onClick={() => onFocus(c.id)}>
              {c.deletedBlocks.map((b) => <div key={b}><span className="tag del">删除段落</span> <del>{clip(blockText(b))}</del></div>)}
              {c.insertedBlocks.map((b) => <div key={b}><span className="tag ins">新增段落</span> <ins>{clip(blockText(b))}</ins></div>)}
              {(c.deleted || c.inserted) && (
                <div>
                  {c.deleted && <del>{clip(c.deleted)}</del>}
                  {c.deleted && c.inserted && ' → '}
                  {c.inserted && <ins>{clip(c.inserted)}</ins>}
                </div>
              )}
              {c.reason && <div className="reason">{c.reason}</div>}
            </button>
            {canDecide && (
              <div className="row">
                <button onClick={() => onDecide([c.id], 'accept')} aria-label="接受这条修订">接受</button>
                <button onClick={() => onDecide([c.id], 'reject')} aria-label="拒绝这条修订">拒绝</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ChangesPanel({ changes, blockText, onDecide, onFocus, canDecide = true }: {
  canDecide?: boolean
  changes: PendingChange[]
  blockText: (id: string) => string
  onDecide: (ids: string[], d: 'accept' | 'reject') => void
  onFocus: (id: string) => void
}) {
  if (changes.length === 0) {
    return <p className="muted pad">没有待处理的修订。AI 的修改、以及你在修订模式下的修改，会列在这里。</p>
  }
  const all = changes.map((c) => c.id)
  const authors = [...new Set(changes.map((c) => c.author))]
  return (
    <div className="changes">
      <div className="row between pad">
        <strong>{changes.length} 条待处理</strong>
        {canDecide && (
          <span className="row">
            <button onClick={() => onDecide(all, 'accept')}>全部接受</button>
            <button onClick={() => onDecide(all, 'reject')}>全部拒绝</button>
          </span>
        )}
      </div>
      {authors.length > 1 && canDecide && (
        <div className="row pad wrap">
          {authors.map((a) => {
            const ids = changes.filter((c) => c.author === a).map((c) => c.id)
            return (
              <span key={a} className="chip">
                {a}（{ids.length}）
                <button className="link" onClick={() => onDecide(ids, 'accept')}>接受</button>
                <button className="link" onClick={() => onDecide(ids, 'reject')}>拒绝</button>
              </span>
            )
          })}
        </div>
      )}
      <ul>
        {changes.map((c) => (
          <li key={c.id}>
            <button className="change-body" onClick={() => onFocus(c.id)}>
              {c.deletedBlocks.map((b) => <div key={b}><span className="tag del">删除段落</span> <del>{clip(blockText(b))}</del></div>)}
              {c.insertedBlocks.map((b) => <div key={b}><span className="tag ins">新增段落</span> <ins>{clip(blockText(b))}</ins></div>)}
              {(c.deleted || c.inserted) && (
                <div>
                  {c.deleted && <del>{clip(c.deleted)}</del>}
                  {c.deleted && c.inserted && ' → '}
                  {c.inserted && <ins>{clip(c.inserted)}</ins>}
                </div>
              )}
              {c.reason && <div className="reason">{c.reason}</div>}
              <div className="muted small">{c.author}</div>
            </button>
            {canDecide && (
              <div className="row">
                <button onClick={() => onDecide([c.id], 'accept')} aria-label="接受这条修订">接受</button>
                <button onClick={() => onDecide([c.id], 'reject')} aria-label="拒绝这条修订">拒绝</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
