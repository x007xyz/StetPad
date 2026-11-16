import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import type { Collab } from './collab'
import type { Store } from './db'

/**
 * Desktop to cloud sync. A synced document exists on both servers; this
 * bridge joins the cloud copy as an ordinary collaborator and relays updates
 * both ways. Because the document is a CRDT there is nothing to resolve:
 * edits made offline on either side merge when the connection returns.
 *
 * While a document is synced, only the cloud settles accept/reject decisions.
 */
interface Bridge {
  provider: HocuspocusProvider
  close: () => Promise<void>
  status: () => string
}

export class CloudSync {
  private bridges = new Map<string, Bridge>()

  constructor(
    private store: Store,
    private collab: Collab,
    private decrypt: (stored: string) => string,
  ) {}

  async startAll(): Promise<void> {
    for (const link of await this.store.listSyncLinks()) {
      await this.start(link.document_id).catch((e) => console.error('sync start failed', e))
    }
  }

  status(documentId: string): string | null {
    return this.bridges.get(documentId)?.status() ?? null
  }

  async start(documentId: string): Promise<void> {
    if (this.bridges.has(documentId)) return
    const link = await this.store.getSyncLink(documentId)
    if (!link) return
    this.collab.settledElsewhere.add(documentId)
    const local = await this.collab.open(documentId)
    const remote = new Y.Doc()
    let state = 'connecting'
    const provider = new HocuspocusProvider({
      url: link.cloud_url.replace(/^http/, 'ws').replace(/\/$/, '') + '/collab',
      name: link.cloud_doc_id,
      document: remote,
      token: this.decrypt(link.token),
      onStatus: ({ status }) => (state = status === 'connected' ? state : 'offline'),
      onAuthenticationFailed: () => (state = 'refused'),
      onSynced: () => {
        state = 'synced'
        // Catch each side up on what the other did while apart.
        Y.applyUpdate(remote, Y.encodeStateAsUpdate(local.doc, Y.encodeStateVector(remote)), 'bridge')
        Y.applyUpdate(local.doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(local.doc)), 'bridge-remote')
      },
    })
    const up = (u: Uint8Array, origin: unknown): void => {
      if (origin !== 'bridge-remote') Y.applyUpdate(remote, u, 'bridge')
    }
    const down = (u: Uint8Array, origin: unknown): void => {
      if (origin !== 'bridge') Y.applyUpdate(local.doc, u, 'bridge-remote')
    }
    local.doc.on('update', up)
    remote.on('update', down)
    this.bridges.set(documentId, {
      provider,
      status: () => state,
      close: async () => {
        local.doc.off('update', up)
        remote.off('update', down)
        provider.destroy()
        remote.destroy()
        await local.close()
      },
    })
  }

  async stop(documentId: string): Promise<void> {
    const b = this.bridges.get(documentId)
    this.bridges.delete(documentId)
    this.collab.settledElsewhere.delete(documentId)
    await b?.close()
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.bridges.keys()]) await this.stop(id)
  }
}
