import type { AssetFiles } from './assets'
import type { Store } from './db'

/**
 * A file named by a document. Documents refer to uploads only by `/files/<id>` inside block attributes, and
 * Yjs writes attribute strings as literal UTF-8, so scanning the raw bytes finds every reference.
 */
const REFERENCE = /\/files\/([\w-]{16,64})/g

/** The immediate collection after a document is deleted skips files younger than this. */
const TARGETED_MIN_AGE_MS = 10 * 60 * 1000

/** Asset ids named in some byte blobs (a document's, or every document's). Over-matches are harmless. */
export function referencedAssetIds(blobs: Uint8Array[]): Set<string> {
  const found = new Set<string>()
  for (const bytes of blobs) {
    for (const m of Buffer.from(bytes).toString('latin1').matchAll(REFERENCE)) found.add(m[1]!)
  }
  return found
}

/**
 * Removes asset files that no document refers to, with their rows.
 *
 * A file is referenced if any document mentions it in its current state, its pending updates, or any version,
 * whichever document owns the asset row. The scan may over-retain (deleted text still in history) but never
 * under-retains.
 *
 * Candidates are assets older than `graceMs`, or exactly `onlyIds` (ignoring the grace period) when given.
 */
export async function collectAssets(
  store: Store,
  files: AssetFiles,
  opts: {
    graceMs: number
    onlyIds?: string[]
    now?: number
    /** Documents open in memory right now: their newest edits may not be saved yet. */
    live?: () => Promise<Uint8Array[]>
  },
): Promise<{ scanned: number; removed: string[] }> {
  let candidates: { id: string; storage: string }[]
  if (opts.onlyIds) {
    if (opts.onlyIds.length === 0) return { scanned: 0, removed: [] }
    // A file created or reused (dedup) moments ago may be referenced by an edit still on its way from a
    // browser. Leave those to the periodic run, which waits out the full grace period.
    const recent = (opts.now ?? Date.now()) - TARGETED_MIN_AGE_MS
    candidates = await store.assetsByIds(opts.onlyIds, recent)
  } else {
    candidates = await store.listAssetCandidates((opts.now ?? Date.now()) - opts.graceMs)
  }
  if (candidates.length === 0) {
    console.log('[assets-gc] scanned 0, removed 0')
    return { scanned: 0, removed: [] }
  }

  // Only ids that are candidates are kept in memory, whatever the size of the document set.
  const wanted = new Set(candidates.map((c) => c.id))
  const referenced = new Set<string>()
  for (const id of referencedAssetIds((await opts.live?.()) ?? [])) if (wanted.has(id)) referenced.add(id)
  for await (const blobs of store.documentBytes()) {
    if (referenced.size === wanted.size) break
    for (const id of referencedAssetIds(blobs)) if (wanted.has(id)) referenced.add(id)
    if (referenced.size === wanted.size) break
  }

  const removed: string[] = []
  for (const c of candidates) {
    if (referenced.has(c.id)) continue
    await files.remove(c.id)
    await store.deleteAssetRow(c.id)
    removed.push(c.id)
  }
  console.log(`[assets-gc] scanned ${candidates.length}, removed ${removed.length}`)
  return { scanned: candidates.length, removed }
}
