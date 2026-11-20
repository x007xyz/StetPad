import { createElement } from 'react'

/** What a model can do. A model shows up in a purpose's picker only if it carries the matching capability. */
export type Capability = 'text' | 'vision' | 'image' | 'imageEdit' | 'audio'

/** Every new or discovered model starts with these. */
export const DEFAULT_CAPS: Capability[] = ['text', 'vision']

/** Display order of the chips. */
export const CAP_ORDER: Capability[] = ['text', 'vision', 'image', 'imageEdit', 'audio']

export const CAP_LABELS: Record<Capability, string> = { text: '文字', vision: '识图', image: '生图', imageEdit: '改图', audio: '转写' }

/** The purposes a model can be chosen for. 'text' is the default model, set with the provider and model selects. */
export type Role = 'text' | 'vision' | 'image' | 'imageEdit' | 'transcribe' | 'diagram'

/**
 * Capabilities from the server, in display order, unknown names dropped.
 * A missing list (an older server) means the defaults.
 */
export function normalizeCaps(v: unknown): Capability[] {
  return Array.isArray(v) ? CAP_ORDER.filter((c) => v.includes(c)) : [...DEFAULT_CAPS]
}

interface CapsPickerProps {
  caps: Capability[]
  onChange: (caps: Capability[]) => void
  disabled?: boolean
  label?: string
}

/** Five toggle chips, one per capability. Pressed state is exposed with aria-pressed. */
export function CapsPicker({ caps, onChange, disabled = false, label = '模型能力' }: CapsPickerProps) {
  return createElement(
    'div',
    { className: 'cap-picker', role: 'group', 'aria-label': label },
    CAP_ORDER.map((c) => {
      const on = caps.includes(c)
      return createElement(
        'button',
        {
          key: c,
          type: 'button',
          className: 'cap-chip',
          'aria-pressed': on,
          disabled,
          onClick: () => onChange(on ? caps.filter((x) => x !== c) : CAP_ORDER.filter((x) => x === c || caps.includes(x))),
        },
        CAP_LABELS[c],
      )
    }),
  )
}
