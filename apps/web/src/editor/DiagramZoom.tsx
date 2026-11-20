/**
 * Full-screen view of one diagram: a Mermaid SVG or a KaTeX formula.
 * Esc, the backdrop or the close button closes it. The mouse wheel zooms
 * around the pointer, dragging pans, and the two buttons fit the window or
 * show it at 100%. Plain DOM, so the node view in diagram.ts can call it.
 */

const MIN_SCALE = 0.05
const MAX_SCALE = 30

export function openDiagramZoom(source: Element): void {
  // One overlay at a time: a second click (or a double click) must not stack another on top.
  if (document.querySelector('.dz-overlay')) return
  // Natural size of the diagram: the viewBox for an SVG, the laid-out box otherwise.
  const content = source.cloneNode(true) as Element
  let w = 0
  let h = 0
  if (content instanceof SVGSVGElement) {
    const vb = content.viewBox.baseVal
    const box = source.getBoundingClientRect()
    w = vb?.width || box.width
    h = vb?.height || box.height
    content.setAttribute('width', String(w))
    content.setAttribute('height', String(h))
    content.style.maxWidth = 'none'
    content.style.width = `${w}px`
    content.style.height = `${h}px`
  } else {
    const box = source.getBoundingClientRect()
    w = box.width
    h = box.height
    if (content instanceof HTMLElement) content.style.margin = '0'
  }
  if (!w || !h) return

  const overlay = document.createElement('div')
  overlay.className = 'dz-overlay'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', '放大查看')

  const bar = document.createElement('div')
  bar.className = 'dz-bar'
  const button = (label: string): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'dz-btn'
    b.textContent = label
    return b
  }
  const hint = document.createElement('span')
  hint.className = 'dz-hint'
  hint.textContent = '滚轮缩放 · 拖动平移 · Esc 关闭'
  const fitBtn = button('适应窗口')
  const oneBtn = button('100%')
  const closeBtn = button('×')
  closeBtn.setAttribute('aria-label', '关闭')
  bar.append(hint, fitBtn, oneBtn, closeBtn)

  const stage = document.createElement('div')
  stage.className = 'dz-stage'
  const canvas = document.createElement('div')
  canvas.className = 'dz-canvas'
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  canvas.append(content)
  stage.append(canvas)
  overlay.append(bar, stage)

  let scale = 1
  let tx = 0
  let ty = 0
  const apply = (): void => {
    canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
  }
  const fit = (): void => {
    const pad = 48
    scale = Math.min((stage.clientWidth - pad) / w, (stage.clientHeight - pad) / h)
    scale = Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE)
    tx = (stage.clientWidth - w * scale) / 2
    ty = (stage.clientHeight - h * scale) / 2
    apply()
  }
  const actual = (): void => {
    scale = 1
    tx = (stage.clientWidth - w) / 2
    ty = (stage.clientHeight - h) / 2
    apply()
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  }
  const close = (): void => {
    document.removeEventListener('keydown', onKey, true)
    overlay.remove()
  }

  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const next = Math.min(Math.max(scale * Math.exp(-e.deltaY * 0.0015), MIN_SCALE), MAX_SCALE)
      // Keep the content under the pointer where it is.
      const r = stage.getBoundingClientRect()
      const px = e.clientX - r.left
      const py = e.clientY - r.top
      tx = px - (px - tx) * (next / scale)
      ty = py - (py - ty) * (next / scale)
      scale = next
      apply()
    },
    { passive: false },
  )

  // Dragging pans. A drag that ends on the backdrop is not a click, so it does not close the view.
  let drag: { x: number; y: number } | null = null
  let moved = false
  const move = (e: PointerEvent): void => {
    if (!drag) return
    const dx = e.clientX - drag.x
    const dy = e.clientY - drag.y
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
    tx += dx
    ty += dy
    drag = { x: e.clientX, y: e.clientY }
    apply()
  }
  const up = (): void => {
    drag = null
    stage.classList.remove('dragging')
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    drag = { x: e.clientX, y: e.clientY }
    moved = false
    stage.classList.add('dragging')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  })

  // A click on the empty area (backdrop, stage or bar, not the diagram) closes the view.
  overlay.addEventListener('click', (e) => {
    if (moved) {
      moved = false
      return
    }
    const target = e.target as Element
    if (target === overlay || target === stage || target === bar || target === hint) close()
  })

  fitBtn.addEventListener('click', fit)
  oneBtn.addEventListener('click', actual)
  closeBtn.addEventListener('click', close)

  document.addEventListener('keydown', onKey, true)
  document.body.append(overlay)
  fit()
  closeBtn.focus()
}
