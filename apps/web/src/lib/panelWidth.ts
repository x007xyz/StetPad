export function clampPanelWidth(width: number, available: number): number {
  const preferred = Number.isFinite(width) && width > 0 ? width : 340
  return Math.max(0, Math.min(760, Math.max(300, preferred), available - 360))
}
