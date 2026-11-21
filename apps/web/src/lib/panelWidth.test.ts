import { describe, expect, it } from 'vitest'
import { clampPanelWidth } from './panelWidth'

describe('clampPanelWidth', () => {
  it('leaves 360px for the editor with the workspace sidebar open at 1024px', () => {
    expect(clampPanelWidth(760, 784)).toBe(424)
  })

  it('also reserves space for a pinned outline', () => {
    expect(clampPanelWidth(760, 784 - 240)).toBe(184)
  })

  it('restores the preferred width when space becomes available again', () => {
    const preferred = 760
    expect(clampPanelWidth(preferred, 784)).toBe(424)
    expect(clampPanelWidth(preferred, 1200)).toBe(760)
  })

  it('bounds ordinary preferences without expanding them on larger windows', () => {
    expect(clampPanelWidth(340, 1440)).toBe(340)
    expect(clampPanelWidth(1000, 1440)).toBe(760)
    expect(clampPanelWidth(20, 1440)).toBe(300)
  })

  it('handles empty, invalid and unavailable measurements', () => {
    expect(clampPanelWidth(0, 784)).toBe(340)
    expect(clampPanelWidth(NaN, 784)).toBe(340)
    expect(clampPanelWidth(Infinity, 784)).toBe(340)
    expect(clampPanelWidth(760, 0)).toBe(0)
  })
})
