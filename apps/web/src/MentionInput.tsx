import { Sparkles } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { isImeComposing } from './lib/keyboard'

/** The text being typed after an `@` at the start of a word, if the caret is in one. */
function triggerAt(value: string, caret: number): { start: number; query: string } | null {
  const m = value.slice(0, caret).match(/(^|\s)@([^\s@]*)$/)
  if (!m) return null
  return { start: caret - m[2]!.length - 1, query: m[2]! }
}

const MENTION_RE = /(^|[\s(（])@(AI)(?=$|[\s,，。!！?？;；)）]|\.(?:\s|$))/g

/** Comment text as React nodes: `@AI` highlighted, everything else plain text. */
export function renderMentions(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(MENTION_RE)) {
    const start = m.index + m[1]!.length
    if (start > last) out.push(text.slice(last, start))
    out.push(<span key={start} className="mention mention-ai">{`@${m[2]}`}</span>)
    last = start + 1 + m[2]!.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/**
 * A single-line input with @AI autocomplete. Typing `@` at the start of a word
 * opens a one-item list that asks the AI assistant to answer the comment.
 * Enter submits the form only when the list is closed.
 */
export function MentionInput({ value, onChange, onKeyDown, onBlur, onSelect, className, ...rest }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string
  onChange: (v: string) => void
}) {
  const inner = useRef<HTMLInputElement>(null)
  const [caret, setCaret] = useState(value.length)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [pendingCaret, setPendingCaret] = useState<number | null>(null)

  const trigger = triggerAt(value, caret)
  const key = trigger ? `${trigger.start}:${trigger.query}` : ''
  const showAi = !!trigger && 'ai'.includes(trigger.query.toLowerCase())
  const open = showAi && dismissed !== key

  useEffect(() => {
    if (pendingCaret === null) return
    inner.current?.setSelectionRange(pendingCaret, pendingCaret)
    setPendingCaret(null)
  }, [pendingCaret])

  const pick = (): void => {
    if (!trigger) return
    const insert = '@AI '
    const next = value.slice(0, trigger.start) + insert + value.slice(caret)
    const pos = trigger.start + insert.length
    onChange(next)
    setCaret(pos)
    setPendingCaret(pos)
  }

  const handleKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && isImeComposing(e.nativeEvent)) return
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pick()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setDismissed(key)
        return
      }
    }
    onKeyDown?.(e)
  }

  return (
    <span className="mention-field">
      <input
        {...rest}
        ref={inner}
        className={className}
        value={value}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onChange={(e) => {
          setCaret(e.target.selectionStart ?? e.target.value.length)
          onChange(e.target.value)
        }}
        onSelect={(e) => {
          setCaret(e.currentTarget.selectionStart ?? value.length)
          onSelect?.(e)
        }}
        onKeyDown={handleKey}
        onBlur={(e) => {
          setDismissed(key)
          onBlur?.(e)
        }}
      />
      {open && (
        <ul className="mention-list" role="listbox" aria-label="提及">
          <li role="option" aria-selected data-active onMouseDown={(e) => e.preventDefault()} onClick={pick} className="mention-ai-item">
            <Sparkles className="size-3.5 shrink-0" />
            <span className="truncate">AI 助手</span>
            <span className="truncate text-muted-foreground">请 AI 回复这条评论</span>
          </li>
        </ul>
      )}
    </span>
  )
}
