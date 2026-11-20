import { useEffect, useRef, useState } from 'react'
import { drawioBaseUrl, drawioEditorUrl, parseDrawioMessage, uploadPng } from './drawio'

export interface DrawioEditorProps {
  open: boolean
  docId: string
  blockId: string | null
  xml: string
  onClose(): void
  /** Called with the block, the saved XML and the uploaded PNG url. */
  onSaved(blockId: string, xml: string, preview: string): void
}

const INIT_TIMEOUT_MS = 20_000
const SAVE_TIMEOUT_MS = 60_000

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Full-screen draw.io editor in an iframe, speaking the JSON postMessage
 * protocol. Escape does not close it: draw.io uses Escape itself.
 */
export function DrawioEditor(props: DrawioEditorProps) {
  const { open } = props
  const [base, setBase] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  // The message handler reads the latest props and the save state without re-subscribing.
  const latest = useRef(props)
  latest.current = props
  const saving = useRef(false)
  const exitAfterSave = useRef(false)
  // Set by draw.io's autosave events: the diagram has changes that are not saved to the document.
  const dirty = useRef(false)

  // Each time it opens, start from scratch.
  useEffect(() => {
    if (!open) return
    setBase(null)
    setReady(false)
    setTimedOut(false)
    setBusy(false)
    setNotice(null)
    saving.current = false
    dirty.current = false
    let alive = true
    void drawioBaseUrl().then((b) => {
      if (alive) setBase(b)
    })
    return () => {
      alive = false
    }
  }, [open])

  // No `init` within 20 s: the editor could not be loaded.
  useEffect(() => {
    if (!open || !base || ready) return
    const t = window.setTimeout(() => setTimedOut(true), INIT_TIMEOUT_MS)
    return () => window.clearTimeout(t)
  }, [open, base, ready])

  useEffect(() => {
    if (!open || !base) return
    const origin = new URL(base).origin
    const send = (msg: Record<string, unknown>): void => {
      frameRef.current?.contentWindow?.postMessage(JSON.stringify(msg), origin)
    }
    let saveTimer = 0
    const endSave = (): void => {
      window.clearTimeout(saveTimer)
      saving.current = false
      setBusy(false)
    }
    const onMessage = (e: MessageEvent): void => {
      const frame = frameRef.current
      // Only our own iframe, from the draw.io origin we configured.
      if (!frame || e.source !== frame.contentWindow || e.origin !== origin) return
      const msg = parseDrawioMessage(e.data)
      if (!msg) return
      const cur = latest.current
      if (msg.event === 'init') {
        setReady(true)
        send({ action: 'load', xml: cur.xml || '', autosave: 1, title: 'draw.io' })
      } else if (msg.event === 'autosave') {
        // Only a mark: the document is written when the user saves in draw.io.
        dirty.current = true
      } else if (msg.event === 'save' && typeof msg.xml === 'string') {
        if (saving.current) return
        saving.current = true
        exitAfterSave.current = msg.exit === true
        setBusy(true)
        setNotice(null)
        saveTimer = window.setTimeout(() => {
          endSave()
          setNotice('保存超时，请重试')
        }, SAVE_TIMEOUT_MS)
        send({ action: 'export', format: 'xmlpng', spinKey: 'saving', scale: 2, border: 10, xml: msg.xml })
      } else if (msg.event === 'export' && typeof msg.data === 'string') {
        const sourceXml = typeof msg.xml === 'string' ? msg.xml : ''
        const id = cur.blockId
        if (!id) {
          endSave()
          setNotice('找不到这个图，修改未保存')
          return
        }
        uploadPng(cur.docId, msg.data).then(
          (url) => {
            window.clearTimeout(saveTimer)
            dirty.current = false
            latest.current.onSaved(id, sourceXml, url)
            endSave()
            if (exitAfterSave.current) latest.current.onClose()
          },
          (err: unknown) => {
            endSave()
            setNotice(message(err))
          },
        )
      } else if (msg.event === 'exit') {
        cur.onClose()
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      window.clearTimeout(saveTimer)
    }
  }, [open, base])

  if (!open) return null

  // Closing with unsaved changes asks first.
  const requestClose = (): void => {
    if (dirty.current && !window.confirm('有未保存的修改，确定关闭？')) return
    props.onClose()
  }

  return (
    <div className="drawio-modal" role="dialog" aria-modal="true" aria-label="draw.io 编辑器">
      <header className="drawio-bar">
        <span className="drawio-title">draw.io</span>
        {busy && <span className="drawio-note">正在保存…</span>}
        {notice && <span className="drawio-error">{notice}</span>}
        <span className="drawio-spacer" />
        <button type="button" className="drawio-close" onClick={requestClose}>
          关闭
        </button>
      </header>
      <div className="drawio-body">
        {base && <iframe ref={frameRef} className="drawio-iframe" title="draw.io" src={drawioEditorUrl(base)} />}
        {!ready && (
          <div className="drawio-loading">
            {timedOut ? (
              <>
                <p>无法加载 draw.io 编辑器（需要联网，或在设置里配置 AIW_DRAWIO_URL）</p>
                <button type="button" className="drawio-close" onClick={props.onClose}>
                  关闭
                </button>
              </>
            ) : (
              <p>正在加载 draw.io…</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
