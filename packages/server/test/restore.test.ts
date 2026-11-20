import { blockText, content, findBlock, insertBlock, listChanges, projectBlocks, trackedDelete, trackedInsert, trackedReplace } from '@stetpad/crdt'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyBlocks } from '../src/content'

const fixture = () => {
  const doc = new Y.Doc()
  insertBlock(doc, 0, 'a', '', 'paragraph', {}, [{ insert: 'old A' }])
  insertBlock(doc, 1, 'b', '', 'paragraph', {}, [{ insert: 'settled B' }])
  const target = projectBlocks(doc, 'revised')
  return { doc, target }
}

describe('partial version restore', () => {
  it('clears suggestions only on selected blocks, including a change shared with another block', () => {
    const { doc, target } = fixture()
    const changeId = trackedReplace(doc, blockText(findBlock(doc, 'a')!), 0, 5, 'suggested A', { author: 'AI' })
    const text = blockText(findBlock(doc, 'b')!)
    trackedInsert(doc, text, 9, 'suggested B', { author: 'AI' }, { changeId })
    trackedDelete(doc, text, 0, 9, { author: 'AI' }, { changeId })
    const b = findBlock(doc, 'b')
    applyBlocks(doc, target, ['a'])
    expect(findBlock(doc, 'b')).toBe(b)
    expect(projectBlocks(doc, 'original').map((x) => x.text)).toEqual(['old A', 'settled B'])
    expect(projectBlocks(doc, 'revised').map((x) => x.text)).toEqual(['old A', 'suggested B'])
    expect(listChanges(doc)).toMatchObject([{ id: changeId, inserted: 'suggested B', deleted: 'settled B' }])
  })

  it('appends a selected block that no longer exists', () => {
    const { doc, target } = fixture()
    content(doc).delete(0, 1)
    applyBlocks(doc, target, ['a'])
    expect(projectBlocks(doc, 'revised').map((x) => x.blockId)).toEqual(['b', 'a'])
    expect(projectBlocks(doc, 'original')[1]!.text).toBe('old A')
  })

  it('leaves the document unchanged for block IDs absent from the version', () => {
    const { doc, target } = fixture()
    trackedReplace(doc, blockText(findBlock(doc, 'b')!), 0, 9, 'suggested B', { author: 'AI' })
    const before = Y.encodeStateAsUpdate(doc)
    applyBlocks(doc, target, ['missing'])
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })

  it('keeps empty selections as full restores', () => {
    const { doc, target } = fixture()
    trackedReplace(doc, blockText(findBlock(doc, 'b')!), 0, 9, 'suggested B', { author: 'AI' })
    applyBlocks(doc, target, [])
    expect(listChanges(doc)).toEqual([])
    expect(projectBlocks(doc, 'revised').map((x) => x.text)).toEqual(['old A', 'settled B'])
  })
})
