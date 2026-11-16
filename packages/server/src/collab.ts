import { addToChange, blocks, buildIndex, compact, elementId, idKey, newChangeId, projectBlocks, viewBlock, type CharId, type RichBlock } from '@stetpad/crdt'
import { Hocuspocus } from '@hocuspocus/server'
import * as Y from 'yjs'
import type { Store, User } from './db'

export interface VersionContent {
  revised: RichBlock[]
  original: RichBlock[]
}

/**
 * The collaboration service. Every participant (people over WebSocket, agents
 * in process) works on the same Y.Doc. This process is the single replica
 * that settles decisions and removes decided text, except for documents that
 * sync to a cloud server, where the cloud does it.
 */
export class Collab {
  hocuspocus: Hocuspocus
  /** Documents whose decisions are settled elsewhere (see sync.ts). */
  readonly settledElsewhere = new Set<string>()
  private compacting = new Set<string>()
  private lastAuto = new Map<string, number>()

  constructor(
    private store: Store,
    /** Who the token is, and what it may do with this document. Null: no access. */
    private authorize: (token: string, documentId: string) => Promise<{ user: User; readOnly: boolean; suggestOnly?: boolean } | null>,
  ) {
    this.hocuspocus = new Hocuspocus({
      debounce: 800,
      maxDebounce: 5000,
      onAuthenticate: async ({ token, documentName, connectionConfig }) => {
        const access = await this.authorize(token, documentName)
        if (!access) throw new Error('forbidden')
        // Enforced here, not in the page: a read-only connection cannot write.
        connectionConfig.readOnly = access.readOnly
        return { user: access.user, suggestOnly: !!access.suggestOnly }
      },
      // A suggest-only connection is checked before its update is applied.
      beforeSync: async ({ type, payload, context, document, documentName }) => {
        if (!context?.suggestOnly || (type !== 1 && type !== 2)) return
        this.checkSuggestion(document, documentName, payload)
      },
      onLoadDocument: async ({ documentName, document }) => {
        const { state, updates } = await this.store.loadState(documentName)
        if (state) Y.applyUpdate(document, state)
        for (const u of updates) Y.applyUpdate(document, u)
      },
      onChange: async ({ documentName, document, update, transactionOrigin }) => {
        // Every change is on disk before the debounced snapshot runs.
        void this.store.appendUpdate(documentName, update).catch((e) => console.error('appendUpdate failed', e))
        if (transactionOrigin === 'compactor' || this.compacting.has(documentName) || this.settledElsewhere.has(documentName)) return
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
        const upTo = await this.store.lastUpdateSeq(documentName)
        await this.store.saveState(documentName, Y.encodeStateAsUpdate(document), upTo)
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

  /**
   * What a "suggest" link may send. It may add text and its own suggestion
   * records. It may not remove existing document content, and it may not
   * decide a suggestion. A violating update is refused whole.
   *
   * Text it adds without recording it as a suggestion is recorded for it
   * shortly afterwards, so nothing from such a link enters the document unreviewed.
   */
  private checkSuggestion(doc: Y.Doc, documentName: string, payload: Uint8Array): void {
    const update = Y.decodeUpdate(payload) as unknown as {
      structs: { id: { client: number; clock: number }; length: number; parentSub?: string | null }[]
      ds: { clients: Map<number, { clock: number; len: number }[]> }
    }
    if (update.structs.some((st) => st.parentSub === 'decision' || st.parentSub === 'settled')) {
      throw new Error('a suggest-only link cannot accept or reject changes')
    }
    if (update.ds.clients.size > 0) {
      // Everything in the document that is not somebody's pending insertion is protected.
      const idx = buildIndex(doc)
      const guarded = new Set<string>()
      for (const el of blocks(doc)) {
        const e = elementId(el)
        if (!idx.ins.has(idKey(e.client, e.clock))) guarded.add(idKey(e.client, e.clock))
        for (const c of viewBlock(doc, el, idx)) if (c.ins.length === 0 && !c.removed) guarded.add(idKey(c.client, c.clock))
      }
      for (const [client, ranges] of update.ds.clients) {
        for (const r of ranges) {
          for (let i = 0; i < r.len; i++) {
            if (guarded.has(idKey(client, r.clock + i))) throw new Error('a suggest-only link cannot delete document content')
          }
        }
      }
    }
    // Only what this update adds. A sync message can also carry items the server already has.
    const fresh = new Set<string>()
    for (const st of update.structs) {
      const known = Y.getState(doc.store, st.id.client)
      for (let i = Math.max(0, known - st.id.clock); i < st.length; i++) fresh.add(idKey(st.id.client, st.id.clock + i))
    }
    if (fresh.size === 0) return
    setTimeout(() => {
      if (!this.hocuspocus.documents.has(documentName)) return
      const idx = buildIndex(doc)
      const loose: CharId[] = []
      for (const el of blocks(doc)) {
        for (const c of viewBlock(doc, el, idx)) {
          const k = idKey(c.client, c.clock)
          if (fresh.has(k) && !idx.ins.has(k)) loose.push({ client: c.client, clock: c.clock })
        }
      }
      if (loose.length) addToChange(doc, newChangeId(), 'ins', loose, { author: '访客' })
    }, 1200)
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

  /** A long-lived handle (agent runs, cloud sync). The caller must close it. */
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
