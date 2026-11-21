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

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => sameValue(value, b[i]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  return Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
}

export const rowChanged = (r: DiffRow): boolean =>
  !r.left || !r.right || r.left.text !== r.right.text || r.left.type !== r.right.type ||
  !sameValue(r.left.delta, r.right.delta) ||
  !sameValue(r.left.attrs ?? {}, r.right.attrs ?? {})

function richText(block: NonNullable<DiffRow['left']>): ReactNode {
  return block.delta?.map(({ insert, attributes: marks = {} }, i) => {
    let text: ReactNode = insert
    if (marks.bold) text = <strong>{text}</strong>
    if (marks.italic) text = <em>{text}</em>
    if (marks.underline) text = <u>{text}</u>
    if (marks.strike) text = <s>{text}</s>
    if (marks.code) text = <code>{text}</code>
    if (marks.highlight) text = <mark>{text}</mark>
    const href = (marks.link as { href?: unknown } | undefined)?.href
    if (typeof href === 'string' && /^(https?:|mailto:|tel:|\/|#)/i.test(href)) {
      text = <a className="underline" href={href} target="_blank" rel="noopener noreferrer">{text}</a>
    }
    return <span key={i}>{text}</span>
  }) ?? block.text
}

/** Two versions of a document side by side, aligned block by block. */
export function DiffView({ rows, leftTitle, rightTitle, onlyChanged, skipTitleTranslation }: { rows: DiffRow[]; leftTitle: string; rightTitle: string; onlyChanged?: boolean; skipTitleTranslation?: boolean }) {
  const shown = onlyChanged ? rows.filter(rowChanged) : rows
  const changed = rows.filter(rowChanged).length
  return (
    <div className="diff">
      <div className="diff-head" data-i18n-skip={skipTitleTranslation || undefined}>
        <div>{leftTitle}</div>
        <div>{rightTitle}</div>
      </div>
      {changed === 0 && <p className="muted pad">两边内容相同。</p>}
      {shown.map((r) => {
        const changedRow = rowChanged(r)
        const formattingOnly = changedRow && r.left && r.right && r.left.text === r.right.text
        const ops = changedRow && !formattingOnly && r.left && r.right ? diffWords(r.left.text, r.right.text) : null
        return (
          <div key={r.id} className={'diff-row' + (changedRow ? ' changed' : '')} data-diff-changed={changedRow || undefined}>
            <div className={'diff-cell' + (!r.left ? ' absent' : !r.right ? ' removed' : '')}>
              {r.left && <span className="kind">{label(r.left)}</span>}
              {r.left && <span className="doc-text">{formattingOnly ? richText(r.left) : ops ? ops.filter((o) => o.type !== 'insert').map((o, k) => (o.type === 'delete' ? <del key={k}>{o.text}</del> : <span key={k}>{o.text}</span>)) : r.left.text}</span>}
            </div>
            <div className={'diff-cell' + (!r.right ? ' absent' : !r.left ? ' added' : '')}>
              {r.right && <span className="kind">{label(r.right)}</span>}
              {r.right && <span className="doc-text">{formattingOnly ? richText(r.right) : ops ? ops.filter((o) => o.type !== 'delete').map((o, k) => (o.type === 'insert' ? <ins key={k}>{o.text}</ins> : <span key={k}>{o.text}</span>)) : r.right.text}</span>}
              {formattingOnly && <div className="muted small">仅格式变化</div>}
              {r.actions && <div className="diff-actions">{r.actions}</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
