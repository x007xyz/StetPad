import { diffWords } from '@stetpad/crdt'
import { useMemo, type ReactNode } from 'react'
import type { RichBlock } from '../api'

export interface DiffRow {
  id: string
  left?: { type: string; text: string; attrs?: Record<string, unknown>; delta?: RichBlock['delta'] }
  right?: { type: string; text: string; attrs?: Record<string, unknown>; delta?: RichBlock['delta'] }
  actions?: ReactNode
}

const label = (b?: { type: string; attrs?: Record<string, unknown> }): string =>
  !b ? '' : b.type === 'heading' ? `H${String(b.attrs?.level ?? 1)}` : b.type === 'taskItem' ? (b.attrs?.checked ? '☑' : '☐') : ({
    paragraph: '', bulletItem: '•', orderedItem: '1.', quote: '❝', callout: '提示', codeBlock: '代码', divider: '—', image: '图片', table: '表格',
  } as Record<string, string>)[b.type] ?? b.type

/** Pair up two block lists by block id (longest common subsequence). */
export function alignBlocks(a: RichBlock[], b: RichBlock[]): DiffRow[] {
  const n = a.length
  const m = b.length
  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < n && j < m && a[i]!.blockId === b[j]!.blockId) {
    rows.push({ id: a[i]!.blockId, left: a[i++], right: b[j++] })
  }
  if (i === n || j === m) {
    while (j < m) rows.push({ id: 'r' + b[j]!.blockId, right: b[j++] })
    while (i < n) rows.push({ id: 'l' + a[i]!.blockId, left: a[i++] })
    return rows
  }

  const rightIndex = new Map<string, number>()
  for (let k = j; k < m; k++) {
    const id = b[k]!.blockId
    rightIndex.set(id, rightIndex.has(id) ? -1 : k)
  }
  const leftAtRight = new Int32Array(m - j)
  const suffixLength = new Int32Array(n - i)
  const counts = new Int32Array(Math.min(n - i, m - j) + 1)
  const tails: number[] = []
  // With unique matches, the LCS is an increasing subsequence of right indices.
  // Reverse both axes to get the length starting at each match.
  for (let k = n - 1; k >= i; k--) {
    const right = rightIndex.get(a[k]!.blockId)
    if (right === undefined) continue
    if (right < 0 || leftAtRight[right - j]) {
      appendRepeatedIdAlignment(a, b, i, j, rows)
      return rows
    }
    leftAtRight[right - j] = k + 1
    const reverseRight = m - right
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (tails[mid]! < reverseRight) lo = mid + 1
      else hi = mid
    }
    tails[lo] = reverseRight
    suffixLength[k - i] = lo + 1
    counts[lo + 1]!++
  }

  const leftStart = i
  const rightStart = j
  let best = tails.length
  while (i < n || j < m) {
    const matchLeft = (leftAtRight[j - rightStart] ?? 0) - 1
    const rank = matchLeft >= i ? suffixLength[matchLeft - leftStart]! : 0
    if (i < n && j < m && a[i]!.blockId === b[j]!.blockId) {
      counts[best]!--
      best--
      rows.push({ id: a[i]!.blockId, left: a[i++], right: b[j++] })
    } else if (j < m && (rank === 0 || rank !== best || counts[best]! > 1)) {
      // Skip right on ties, unless it removes the only remaining optimal start.
      if (rank) counts[rank]!--
      rows.push({ id: 'r' + b[j]!.blockId, right: b[j++] })
    } else {
      const right = rightIndex.get(a[i]!.blockId)
      if (right !== undefined && right >= j) counts[suffixLength[i - leftStart]!]!--
      rows.push({ id: 'l' + a[i]!.blockId, left: a[i++] })
    }
  }
  return rows
}

function appendRepeatedIdAlignment(a: RichBlock[], b: RichBlock[], i: number, j: number, rows: DiffRow[]): void {
  const lengths = new Uint32Array(b.length - j + 1)
  const crossings = new Uint32Array(lengths.length)
  const rightOffset = j

  function append(left: number, leftEnd: number, right: number, rightEnd: number): void {
    if (leftEnd - left <= 1 || right === rightEnd) {
      if (leftEnd - left === 1) {
        while (right < rightEnd && a[left]!.blockId !== b[right]!.blockId) {
          rows.push({ id: 'r' + b[right]!.blockId, right: b[right++] })
        }
        if (right < rightEnd) rows.push({ id: a[left]!.blockId, left: a[left++], right: b[right++] })
      }
      while (right < rightEnd) rows.push({ id: 'r' + b[right]!.blockId, right: b[right++] })
      while (left < leftEnd) rows.push({ id: 'l' + a[left]!.blockId, left: a[left++] })
      return
    }

    // Track where the original match/right/left traceback reaches the middle
    // row, then trace each half separately using the same two scratch rows.
    const mid = left + ((leftEnd - left) >>> 1)
    const end = rightEnd - rightOffset
    const start = right - rightOffset
    lengths.fill(0, start, end + 1)
    crossings[end] = rightEnd
    for (let k = leftEnd - 1; k >= left; k--) {
      let diagonalLength = 0
      let diagonalCrossing = rightEnd
      for (let col = end - 1; col >= start; col--) {
        const belowLength = lengths[col]!
        const belowCrossing = crossings[col]!
        if (a[k]!.blockId === b[col + rightOffset]!.blockId) {
          lengths[col] = diagonalLength + 1
          if (k < mid) crossings[col] = diagonalCrossing
        } else if (lengths[col + 1]! >= belowLength) {
          lengths[col] = lengths[col + 1]!
          if (k < mid) crossings[col] = crossings[col + 1]!
        }
        if (k === mid) crossings[col] = col + rightOffset
        diagonalLength = belowLength
        diagonalCrossing = belowCrossing
      }
    }
    const split = crossings[start]!
    append(left, mid, right, split)
    append(mid, leftEnd, split, rightEnd)
  }

  append(i, a.length, j, b.length)
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
  const changedRows = useMemo(() => new Set(rows.filter(rowChanged)), [rows])
  const shown = onlyChanged ? rows.filter((r) => changedRows.has(r)) : rows
  return (
    <div className="diff">
      <div className="diff-head" data-i18n-skip={skipTitleTranslation || undefined}>
        <div>{leftTitle}</div>
        <div>{rightTitle}</div>
      </div>
      {changedRows.size === 0 && <p className="muted pad">两边内容相同。</p>}
      {shown.map((r) => {
        const changedRow = changedRows.has(r)
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
