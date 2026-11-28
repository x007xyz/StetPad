import { physicalBlockTextLookup } from '@stetpad/crdt'
import { useLayoutEffect, useMemo } from 'react'
import type * as Y from 'yjs'

export function useBlockPreview(doc: Y.Doc): (id: string) => string | undefined {
  const lookup = useMemo(() => {
    let read: ReturnType<typeof physicalBlockTextLookup> | undefined
    return {
      text: (id: string) => (read ??= physicalBlockTextLookup(doc))(id),
      invalidate: () => { read = undefined },
    }
  }, [doc])
  useLayoutEffect(() => {
    doc.on('afterTransaction', lookup.invalidate)
    return () => {
      doc.off('afterTransaction', lookup.invalidate)
      lookup.invalidate()
    }
  }, [doc, lookup])
  return lookup.text
}
