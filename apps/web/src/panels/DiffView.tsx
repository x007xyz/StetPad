import { diffWords } from '@stetpad/crdt'
import type { ReactNode } from 'react'
import type { RichBlock } from '../api'

export interface DiffRow {
  id: string
  left?: { type: string; text: string; attrs?: Record<string, unknown>; delta?: RichBlock['delta'] }
  right?: { type: string; text: string; attrs?: Record<string, unknown>; delta?: RichBlock['delta'] }
  actions?: ReactNode
}

const label = (b?: { type: string; attrs?: Record<string, unknown> }): string =>
  !b ? '' : b.type === 'heading' ? `H${String(b.attrs?.level ?? 1)}` : ({
    paragraph: '', bulletItem: '•', orderedItem: '1.', taskItem: '☐', quote: '❝', callout: '提示', codeBlock: '代码', divider: '—', image: '图片', table: '表格',
  } as Record<string, string>)[b.type] ?? b.type

/** Pair up two block lists by block id (longest common subsequence). */
export function alignBlocks(a: RichBlock[], b: RichBlock[]): DiffRow[] {
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i]!.blockId === b[j]!.blockId ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i]!.blockId === b[j]!.blockId) {
      rows.push({ id: a[i]!.blockId, left: a[i], right: b[j] })
      i++
      j++
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      rows.push({ id: 'r' + b[j]!.blockId, right: b[j] })
      j++
    } else {
      rows.push({ id: 'l' + a[i]!.blockId, left: a[i] })
      i++
    }
  }
  return rows
}

export const rowChanged = (r: DiffRow): boolean =>
  !r.left || !r.right || r.left.text !== r.right.text || r.left.type !== r.right.type ||
  JSON.stringify(r.left.delta) !== JSON.stringify(r.right.delta) ||
  JSON.stringify(r.left.attrs ?? {}) !== JSON.stringify(r.right.attrs ?? {})

/** Two versions of a document side by side, aligned block by block. */
export function DiffView({ rows, leftTitle, rightTitle, onlyChanged }: { rows: DiffRow[]; leftTitle: string; rightTitle: string; onlyChanged?: boolean }) {
  const shown = onlyChanged ? rows.filter(rowChanged) : rows
  const changed = rows.filter(rowChanged).length
  return (
    <div className="diff">
      <div className="diff-head">
        <div>{leftTitle}</div>
        <div>{rightTitle}</div>
      </div>
      {changed === 0 && <p className="muted pad">两边内容相同。</p>}
      {shown.map((r) => {
        const changedRow = rowChanged(r)
        const ops = changedRow && r.left && r.right ? diffWords(r.left.text, r.right.text) : null
        return (
          <div key={r.id} className={'diff-row' + (changedRow ? ' changed' : '')} data-diff-changed={changedRow || undefined}>
            <div className={'diff-cell' + (!r.left ? ' absent' : !r.right ? ' removed' : '')}>
              {r.left && <span className="kind">{label(r.left)}</span>}
              {r.left && (ops ? ops.filter((o) => o.type !== 'insert').map((o, k) => (o.type === 'delete' ? <del key={k}>{o.text}</del> : <span key={k}>{o.text}</span>)) : r.left.text)}
            </div>
            <div className={'diff-cell' + (!r.right ? ' absent' : !r.left ? ' added' : '')}>
              {r.right && <span className="kind">{label(r.right)}</span>}
              {r.right && (ops ? ops.filter((o) => o.type !== 'delete').map((o, k) => (o.type === 'insert' ? <ins key={k}>{o.text}</ins> : <span key={k}>{o.text}</span>)) : r.right.text)}
              {r.actions && <div className="diff-actions">{r.actions}</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
