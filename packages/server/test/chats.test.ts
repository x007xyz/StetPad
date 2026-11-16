import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Store, sqliteSql } from '../src/db'

const open = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiw-chats-'))
  const sql = await sqliteSql(dir)
  return { sql, store: new Store(sql), dir }
}
const run = (documentId: string, instruction: string, chatId?: string) => ({ documentId, userId: 'local', instruction, scope: { blockIds: ['b1'] }, model: 'm', chatId })

describe('AI chats', () => {
  it('keeps runs of different chats apart and names a chat from its first message', async () => {
    const { store } = await open()
    await store.init()
    const a = await store.createChat('d1')
    const b = await store.createChat('d1')
    await store.createRun(run('d1', 'make it shorter please', a.id))
    await store.createRun(run('d1', 'translate', b.id))
    await store.createRun(run('d1', 'second in a', a.id))
    expect((await store.listRuns('d1', 30, a.id)).map((r) => r.instruction)).toEqual(['make it shorter please', 'second in a'])
    expect((await store.listRuns('d1', 30, b.id)).map((r) => r.instruction)).toEqual(['translate'])
    expect((await store.listRuns('d1')).length).toBe(3)
    const chats = await store.listChats('d1')
    expect(chats.find((c) => c.id === a.id)).toMatchObject({ title: 'make it shorter please', n: 2 })
    await store.renameChat(a.id, 'mine')
    await store.createRun(run('d1', 'third', a.id))
    expect((await store.getChat(a.id))!.title).toBe('mine')
  })

  it('deleting a chat removes its runs only', async () => {
    const { store } = await open()
    await store.init()
    const a = await store.createChat('d1')
    const b = await store.createChat('d1')
    const ra = await store.createRun(run('d1', 'x', a.id))
    const rb = await store.createRun(run('d1', 'y', b.id))
    await store.addEvent(ra, 1, 't', {})
    await store.deleteChat(a.id)
    expect(await store.getRun(ra)).toBeNull()
    expect(await store.eventsAfter(ra, 0)).toEqual([])
    expect(await store.getRun(rb)).not.toBeNull()
    expect((await store.listChats('d1')).map((c) => c.id)).toEqual([b.id])
  })

  it('moves runs from before chats existed into one default chat per document, without loss', async () => {
    const { sql, dir } = await open()
    // The old schema: no chat table, no chat_id column.
    await sql.exec(`create table ai_runs(id text primary key, document_id text not null, user_id text not null, instruction text not null, scope_json text, model text not null, status text not null, summary text, usage_json text, created_at integer not null)`)
    for (const [id, doc, at] of [['r1', 'd1', 100], ['r2', 'd1', 200], ['r3', 'd2', 150]] as const) {
      await sql.run('insert into ai_runs(id, document_id, user_id, instruction, scope_json, model, status, summary, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, doc, 'local', 'ask ' + id, '{"blockIds":["b"]}', 'm', 'done', 'sum', at])
    }
    const store = new Store(sql)
    await store.init()
    await store.init() // repeating changes nothing
    const chats1 = await store.listChats('d1')
    expect(chats1).toHaveLength(1)
    expect(chats1[0]).toMatchObject({ title: 'ask r1', n: 2, created_at: 100, updated_at: 200 })
    expect(await store.listChats('d2')).toHaveLength(1)
    const runs = await store.listRuns('d1', 30, chats1[0]!.id)
    expect(runs.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(runs[0]).toMatchObject({ summary: 'sum', scope_json: '{"blockIds":["b"]}' })
    void dir
  })
})
