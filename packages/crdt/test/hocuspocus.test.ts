import { HocuspocusProvider } from '@hocuspocus/provider'
import { Server } from '@hocuspocus/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  blockText,
  compact,
  decide,
  findBlock,
  insertBlock,
  listChanges,
  originalDoc,
  proposeReplace,
  readBlock,
  revisedDoc,
  typeText,
} from '../src'

/**
 * The same model over a real collaboration server: two people connected by
 * WebSocket, and the agent writing from inside the server process.
 */

const until = async (check: () => boolean, what: string, ms = 5000) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

let server: Server
let url: string
const providers: HocuspocusProvider[] = []

beforeAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server = new Server({ port: 0, address: '127.0.0.1', stopOnSignals: false, quiet: true } as any)
  await server.listen()
  url = `ws://127.0.0.1:${server.address.port}`
})

afterAll(async () => {
  for (const p of providers) p.destroy()
  await server.destroy()
})

function connect(name: string): Y.Doc {
  const doc = new Y.Doc()
  providers.push(new HocuspocusProvider({ url, name, document: doc }))
  return doc
}

describe('agent as a server-side collaborator (Hocuspocus)', () => {
  it('proposes while two people edit; one of them accepts; everyone converges', async () => {
    const ann = connect('doc-1')
    const bob = connect('doc-1')
    insertBlock(ann, 0, 'b1', 'The quick brown fox jumps over the lazy dog.')
    await until(() => !!findBlock(bob, 'b1'), 'bob receives the block')

    // The agent opens the document inside the server process: no socket, no lock.
    const agent = await server.hocuspocus.openDirectConnection('doc-1')
    const base = readBlock(agent.document!, 'b1')!
    expect(base.text).toBe('The quick brown fox jumps over the lazy dog.')

    // While the model is "thinking", both people keep typing in the same block.
    typeText(ann, blockText(findBlock(ann, 'b1')!), 0, 'Yesterday, ', { author: 'ann', tracking: false })
    const bobText = blockText(findBlock(bob, 'b1')!)
    typeText(bob, bobText, bobText.length, ' Twice.', { author: 'bob', tracking: false })
    await until(
      () => readBlock(agent.document!, 'b1')!.text === 'Yesterday, The quick brown fox jumps over the lazy dog. Twice.',
      'server has both edits',
    )

    // The proposal was computed against the stale read; it still lands exactly.
    let failed = -1
    await agent.transact((doc) => {
      const r = proposeReplace(doc, base, 'The fast brown fox leaps over the lazy dog.', {
        author: 'agent:test',
        runId: 'run-1',
      })
      failed = r.failed.length
    })
    expect(failed).toBe(0)

    const want = {
      revised: [{ blockId: 'b1', text: 'Yesterday, The fast brown fox leaps over the lazy dog. Twice.' }],
      original: [{ blockId: 'b1', text: 'Yesterday, The quick brown fox jumps over the lazy dog. Twice.' }],
    }
    for (const d of [ann, bob]) {
      await until(() => listChanges(d).length === 2, 'client sees two suggestions')
      expect({ revised: revisedDoc(d), original: originalDoc(d) }).toEqual(want)
      expect(listChanges(d).every((c) => c.author === 'agent:test' && c.runId === 'run-1')).toBe(true)
    }

    // Bob accepts the first suggestion and rejects the second, from his client.
    const [first, second] = listChanges(bob)
    decide(bob, first!.id, 'accept')
    decide(bob, second!.id, 'reject')
    await until(() => listChanges(agent.document!).length === 0, 'server sees the decisions')

    // Only the server makes them permanent.
    await agent.transact((doc) => compact(doc))
    const final = 'Yesterday, The fast brown fox jumps over the lazy dog. Twice.'
    for (const d of [ann, bob]) {
      await until(() => blockText(findBlock(d, 'b1')!).toString() === final, 'client receives the cleanup')
      expect(listChanges(d)).toEqual([])
    }
    await agent.disconnect()
  })
})
