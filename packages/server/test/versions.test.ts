import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Store, sqliteSql } from '../src/db'

describe('version thinning', () => {
  let dir: string
  let store: Store
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aiw-versions-'))
    store = new Store(await sqliteSql(dir))
    await store.init()
  })
  afterAll(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps unnamed manual and named versions while thinning old automatic versions', async () => {
    const doc = await store.createDoc('u', 'History', new Uint8Array())
    const hour = Math.floor(Date.now() / 3600_000) * 3600_000 - 48 * 3600_000
    const add = (trigger: string, createdAt: number, label?: string) => store.addVersion({
      documentId: doc.id, state: new Uint8Array(), content: {}, author: 'u', wordCount: 0, trigger, createdAt, label,
    })
    const manual = await add('manual', hour + 1000)
    const named = await add('auto', hour + 2000, 'Keep me')
    const olderAuto = await add('auto', hour + 3000)
    const newestAuto = await add('auto', hour + 4000)
    const recent = await add('auto', Date.now())
    const recentOlder = await add('auto', Date.now() - 1000)
    const previousHour = await add('auto', hour - 1000)

    await store.pruneVersions(doc.id)

    const ids = (await store.listVersions(doc.id)).map((v) => v.id)
    expect(ids).toContain(manual)
    expect(ids).toEqual(expect.arrayContaining([named, newestAuto, recent, recentOlder, previousHour]))
    expect(ids).not.toContain(olderAuto)
    expect(await store.pruneVersions(doc.id)).toBe(0)
  })

  it('does nothing for a document without versions', async () => {
    const doc = await store.createDoc('u', 'Empty history', new Uint8Array())
    expect(await store.pruneVersions(doc.id)).toBe(0)
    expect(await store.listVersions(doc.id)).toEqual([])
  })
})
