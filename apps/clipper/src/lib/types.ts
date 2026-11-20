import type { Block } from '@stetpad/clip'

export interface ExtractedPage {
  url: string
  title: string
  author?: string
  siteName?: string
  publishedAt?: string
  excerpt?: string
  articleBlocks: Block[]
  articleMarkdown: string
  selectionBlocks: Block[]
  selectionMarkdown: string
  hasSelection: boolean
}

export interface ClipperProfile {
  id: 'local'
  mode: 'local'
  baseUrl: string
  token: string
  email: string
}

export type WorkflowKind = 'create' | 'append' | 'ai'

export interface ClipperPrefs {
  activeProfile: 'local'
  workflow: WorkflowKind
  folderId: string
  docId: string
  localizeImages: boolean
  asSuggestion: boolean
  aiScope: 'doc' | 'folder'
  modelId: string
}

export interface PendingPair {
  baseUrl: string
  code: string
  verifier: string
  startedAt: number
}

export interface FolderItem {
  id: string
  name: string
}

export interface DocItem {
  id: string
  title: string
  folder_id: string | null
  updated_at: number
}

export interface ModelItem {
  id: string
  provider: string
  label: string
  verified: boolean
}

export interface ClipExecutionRequest {
  tabId: number
  profileId: 'local'
  workflow: WorkflowKind
  sourceKind: 'article' | 'selection'
  title: string
  note: string
  url: string
  author?: string
  siteName?: string
  publishedAt?: string
  blocks: Block[]
  markdown: string
  folderId?: string
  docId?: string
  localizeImages: boolean
  asSuggestion: boolean
  runAiAfterCreate?: boolean
  aiScope?: 'doc' | 'folder'
  aiInstruction?: string
  modelId?: string
}

export interface ClipExecutionResult {
  ok: true
  docId?: string
  folderId?: string
  runId?: string
  changeId?: string | null
  uploadedImages: number
  skippedImages: number
  workflow: WorkflowKind
  mode: 'local'
  baseUrl: string
}
