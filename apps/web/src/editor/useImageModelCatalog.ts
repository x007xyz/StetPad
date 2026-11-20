import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

interface ImageModel { id: string; label: string; price?: string }
interface ImageModelsResponse { models: ImageModel[]; default: string | null }

export function useImageModelCatalog(open: boolean, mode: 'generate' | 'edit', setError: (error: string) => void) {
  const [models, setModels] = useState<ImageModel[] | null>(null)
  const [modelId, setModelId] = useState('')
  const generationLoaded = useRef(false)

  useEffect(() => {
    // Generation caches a successful load; editing refreshes on every open.
    if (!open || (mode === 'generate' && generationLoaded.current)) return
    if (mode === 'edit') setModels(null)

    const controller = new AbortController()
    const path = mode === 'generate' ? '/image-models' : '/image-edit-models'
    api<ImageModelsResponse>(path, { signal: controller.signal })
      .then((catalog) => {
        if (controller.signal.aborted) return
        if (mode === 'generate') generationLoaded.current = true
        setModels(catalog.models)
        setModelId(catalog.default ?? catalog.models[0]?.id ?? '')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setModels([])
        setError(error instanceof Error ? error.message : String(error))
      })

    return () => controller.abort()
  }, [open, mode, setError])

  return { models, modelId, setModelId }
}
