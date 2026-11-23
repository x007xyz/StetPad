import { compact, projectBlocks, type RichBlock } from '@stetpad/crdt'
import { Hocuspocus } from '@hocuspocus/server'
import * as Y from 'yjs'
import type { Store, User } from './db'

export interface VersionContent {
  revised: RichBlock[]
  original: RichBlock[]
}

function tableCellText(rows: unknown): string[] {
  if (typeof rows !== 'string') return []
  try {
    const grid: unknown = JSON.parse(rows)
    return Array.isArray(grid)
      ? grid.flatMap((row: unknown) => Array.isArray(row) ? row.filter((cell): cell is string => typeof cell === 'string') : [])
      : []
  } catch {
    return []
  }
}

/** The revised document text, with blocks and table cells separated by newlines. Kept for search. */
export function docPlainText(doc: Y.Doc): string {
  return projectBlocks(doc, 'revised').map((b) =>
    b.type === 'table' ? [b.text, ...tableCellText(b.attrs.rows)].filter(Boolean).join('\n') : b.text,
  ).join('\n')
}

/**
 * The collaboration service. Every participant (the desktop app over WebSocket,
 * agents in process) works on the same Y.Doc. This process is the single replica
 * that settles decisions and removes decided text.
 */
export class Collab {
  hocuspocus: Hocuspocus
  private compacting = new Set<string>()
  private lastAuto = new Map<string, number>()

  constructor(
    private store: Store,
    /** Who the token is, and whether it may use this document. Null: no access. */
    private authorize: (token: string, documentId: string) => Promise<{ user: User; readOnly: boolean } | null>,
  ) {
    this.hocuspocus = new Hocuspocus({
      debounce: 800,
      maxDebounce: 5000,
      onAuthenticate: async ({ token, documentName, connectionConfig }) => {
        const access = await this.authorize(token, documentName)
        if (!access) throw new Error('forbidden')
        // Enforced here, not in the page: a read-only connection cannot write.
        connectionConfig.readOnly = access.readOnly
        return { user: access.user }
      },
      onLoadDocument: async ({ documentName, document }) => {
        const { state, updates } = await this.store.loadState(documentName)
        if (state) Y.applyUpdate(document, state)
        for (const u of updates) Y.applyUpdate(document, u)
      },
      onChange: async ({ documentName, document, update, transactionOrigin }) => {
        // Every change is on disk before the debounced snapshot runs.
        void this.store.appendUpdate(documentName, update).catch((e) => console.error('appendUpdate failed', e))
        if (transactionOrigin === 'compactor' || this.compacting.has(documentName)) return
        this.compacting.add(documentName)
        queueMicrotask(() => {
          try {
            compact(document)
          } finally {
            this.compacting.delete(documentName)
          }
        })
      },
      onStoreDocument: async ({ documentName, document }) => {
        // A document purged while it was open is not written back: that would recreate its rows.
        if (!(await this.store.getDocAny(documentName))) return
        const upTo = await this.store.lastUpdateSeq(documentName)
        await this.store.saveState(documentName, Y.encodeStateAsUpdate(document), upTo)
        await this.store.setDocText(documentName, docPlainText(document))
        // A version every few minutes of activity, in addition to the explicit triggers.
        const last = this.lastAuto.get(documentName) ?? 0
        if (Date.now() - last > 5 * 60_000) {
          this.lastAuto.set(documentName, Date.now())
          if (last) {
            await this.snapshotDoc(documentName, document, 'auto', 'system')
            await this.store.pruneVersions(documentName)
          }
        }
      },
    })
  }

  /** Run `fn` against the live document, as a participant inside the server. */
  async withDoc<T>(documentId: string, fn: (doc: Y.Doc) => T | Promise<T>): Promise<T> {
    const conn = await this.hocuspocus.openDirectConnection(documentId, { user: { id: 'server' } })
    try {
      return await fn(conn.document as unknown as Y.Doc)
    } finally {
      await conn.disconnect({ unloadImmediately: false })
    }
  }

  /** A long-lived handle (agent runs). The caller must close it. */
  async open(documentId: string): Promise<{ doc: Y.Doc; close: () => Promise<void> }> {
    const conn = await this.hocuspocus.openDirectConnection(documentId, { user: { id: 'agent' } })
    return { doc: conn.document as unknown as Y.Doc, close: () => conn.disconnect({ unloadImmediately: false }) }
  }

  /** Save a version unless nothing changed since the last one. */
  async snapshot(documentId: string, trigger: string, author: string, label?: string): Promise<string | null> {
    return this.withDoc(documentId, (doc) => this.snapshotDoc(documentId, doc, trigger, author, label))
  }

  async snapshotDoc(documentId: string, doc: Y.Doc, trigger: string, author: string, label?: string): Promise<string | null> {
    const content: VersionContent = { revised: projectBlocks(doc, 'revised'), original: projectBlocks(doc, 'original') }
    const state = Y.encodeStateAsUpdate(doc)
    if (!label && (await this.store.latestVersionContent(documentId)) === JSON.stringify(content)) return null
    return this.store.addVersion({
      documentId,
      state,
      content,
      label,
      trigger,
      author,
      wordCount: content.revised.reduce((n, b) => n + b.text.length, 0),
    })
  }
}
