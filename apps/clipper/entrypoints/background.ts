import { buildSourceHeaderBlocks, collectImageUrls, MAX_IMPORT_BLOCKS, type Block } from '@stetpad/clip'
import { browser } from 'wxt/browser'
import {
  appendClipDoc,
  createClipDoc,
  createEmptyDoc,
  exchangePair,
  resolveProfile,
  startDocAiRun,
  startFolderAiRun,
} from '../src/lib/api'
import { clipOverflowNotice } from '../src/lib/i18n'
import { localizeBlockImages } from '../src/lib/images'
import { extractActiveTab } from '../src/lib/inject'
import { getPendingPair, getPrefs, getProfiles, savePrefs, saveProfile, setPendingPair } from '../src/lib/storage'
import type { ClipExecutionRequest, ClipExecutionResult } from '../src/lib/types'

const MENU_SELECTION = 'stetpad-clip-selection'
const MENU_PAGE = 'stetpad-clip-page'

let badgeTimer: ReturnType<typeof setTimeout> | undefined

function flashBadge(text: string, color: string, notice?: string): void {
  clearTimeout(badgeTimer)
  void browser.action.setBadgeText({ text })
  void browser.action.setBadgeBackgroundColor({ color })
  void browser.action.setTitle({ title: notice ?? browser.runtime.getManifest().name })
  if (notice) return
  badgeTimer = setTimeout(() => {
    void browser.action.setBadgeText({ text: '' })
  }, 3500)
}

function nowLabel(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function executeClip(req: ClipExecutionRequest): Promise<ClipExecutionResult> {
  const profiles = await getProfiles()
  const rawProfile = profiles[req.profileId]
  if (!rawProfile) throw new Error('尚未连接到 Stetpad，请先在插件中完成配对')
  const profile = await resolveProfile(rawProfile)

  await savePrefs({
    activeProfile: req.profileId,
    workflow: req.workflow,
    folderId: req.folderId ?? '',
    docId: req.docId ?? '',
    localizeImages: req.localizeImages,
    asSuggestion: req.asSuggestion,
    ...(req.aiScope ? { aiScope: req.aiScope } : {}),
    ...(req.modelId ? { modelId: req.modelId } : {}),
  })

  if (req.workflow === 'ai') {
    const instruction = req.aiInstruction?.trim()
    if (!instruction) throw new Error('请填写 AI 处理指令')
    const header = `标题：${req.title}\n来源：${req.url}${req.author ? `\n作者：${req.author}` : ''}${req.note.trim() ? `\n批注：${req.note.trim()}` : ''}`
    const context = [
      {
        kind: 'clip',
        label: req.title.slice(0, 120),
        url: req.url,
        text: `${header}\n\n${req.markdown}`,
        blockIds: [],
      },
    ]
    if (req.aiScope === 'folder') {
      if (!req.folderId) throw new Error('请选择目标资料夹')
      const res = await startFolderAiRun(profile, req.folderId, {
        instruction,
        modelId: req.modelId || undefined,
        context,
      })
      return {
        ok: true,
        folderId: req.folderId,
        runId: res.runId,
        uploadedImages: 0,
        skippedImages: 0,
        workflow: 'ai',
        mode: profile.mode,
        baseUrl: profile.baseUrl,
      }
    }
    if (!req.docId) throw new Error('请选择目标文档')
    const res = await startDocAiRun(profile, req.docId, {
      instruction,
      modelId: req.modelId || undefined,
      context,
    })
    return {
      ok: true,
      docId: req.docId,
      runId: res.runId,
      uploadedImages: 0,
      skippedImages: 0,
      workflow: 'ai',
      mode: profile.mode,
      baseUrl: profile.baseUrl,
    }
  }

  const headerBlocks = buildSourceHeaderBlocks({
    url: req.url,
    title: req.title,
    author: req.author,
    siteName: req.siteName,
    publishedAt: req.publishedAt,
    clippedAt: nowLabel(),
    note: req.note,
  })
  const omittedBlockCount = Math.max(0, headerBlocks.length + req.blocks.length - MAX_IMPORT_BLOCKS)
  const combined: Block[] = [...headerBlocks, ...req.blocks.slice(0, MAX_IMPORT_BLOCKS - headerBlocks.length)]
  const hasExternalImages = req.localizeImages && collectImageUrls(combined).length > 0

  if (req.workflow === 'append') {
    if (!req.docId) throw new Error('请选择要追加的目标文档')
    let finalBlocks = combined
    let uploadedImages = 0
    let skippedImages = 0
    if (hasExternalImages) {
      const loc = await localizeBlockImages(combined, { tabId: req.tabId, docId: req.docId, profile })
      finalBlocks = loc.blocks
      uploadedImages = loc.uploadedImages
      skippedImages = loc.skippedImages
    }
    const res = await appendClipDoc(profile, req.docId, {
      blocks: finalBlocks,
      asSuggestion: req.asSuggestion,
      author: '网页剪藏',
      reason: `剪藏自 ${req.siteName || req.url}`.slice(0, 120),
    })
    return {
      ok: true,
      docId: req.docId,
      changeId: res.changeId,
      uploadedImages,
      skippedImages,
      omittedBlockCount,
      workflow: 'append',
      mode: profile.mode,
      baseUrl: profile.baseUrl,
    }
  }

  // workflow === 'create'
  let docId: string
  let uploadedImages = 0
  let skippedImages = 0

  if (hasExternalImages) {
    const empty = await createEmptyDoc(profile, {
      title: req.title,
      folderId: req.folderId || undefined,
    })
    docId = empty.id
    const loc = await localizeBlockImages(combined, { tabId: req.tabId, docId, profile })
    uploadedImages = loc.uploadedImages
    skippedImages = loc.skippedImages
    await appendClipDoc(profile, docId, {
      blocks: loc.blocks,
      asSuggestion: false,
      author: '网页剪藏',
      reason: '新建剪藏文档',
    })
  } else {
    const created = await createClipDoc(profile, {
      title: req.title,
      blocks: combined,
      folderId: req.folderId || undefined,
    })
    docId = created.id
  }

  let runId: string | undefined
  if (req.runAiAfterCreate) {
    const run = await startDocAiRun(profile, docId, {
      instruction:
        req.aiInstruction?.trim() ||
        '请通读这篇剪藏内容，在文首用一段 callout 或列表提炼核心要点摘要（以修订形式插入），并顺手修正明显的网页抓取断句错误，保持原意不变。',
      modelId: req.modelId || undefined,
      context: [],
    })
    runId = run.runId
  }

  return {
    ok: true,
    docId,
    folderId: req.folderId || undefined,
    runId,
    uploadedImages,
    skippedImages,
    omittedBlockCount,
    workflow: 'create',
    mode: profile.mode,
    baseUrl: profile.baseUrl,
  }
}

let pollingActive = false
async function pollPendingPair(): Promise<void> {
  if (pollingActive) return
  pollingActive = true
  try {
    for (let i = 0; i < 90; i++) {
      const pending = await getPendingPair()
      if (!pending) return
      try {
        const res = await exchangePair(pending.baseUrl, pending.code, pending.verifier)
        if (res.status === 'approved') {
          await saveProfile({
            id: 'local',
            mode: 'local',
            baseUrl: pending.baseUrl,
            token: res.token,
            email: res.user.email,
          })
          await savePrefs({ activeProfile: 'local' })
          await setPendingPair(null)
          flashBadge('✓', '#2b8a3e')
          return
        }
      } catch {
        // Ignore transient errors while waiting for user approval; 404/403 after expiry will clear on next tick.
      }
      await new Promise((r) => setTimeout(r, 1300))
    }
  } finally {
    pollingActive = false
  }
}

function registerContextMenus(): void {
  if (!browser.contextMenus) return
  void browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id: MENU_SELECTION,
      title: '剪藏选中内容到 Stetpad',
      contexts: ['selection'],
    })
    browser.contextMenus.create({
      id: MENU_PAGE,
      title: '剪藏当前网页到 Stetpad',
      contexts: ['page'],
    })
  })
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    registerContextMenus()
  })

  if (browser.contextMenus) {
    browser.contextMenus.onClicked.addListener((info, tab) => {
      if ((info.menuItemId !== MENU_SELECTION && info.menuItemId !== MENU_PAGE) || !tab?.id) return
      const tabId = tab.id
      void (async () => {
        try {
          const profiles = await getProfiles()
          const prefs = await getPrefs()
          const profileId = profiles.local ? 'local' : null
          if (!profileId) {
            flashBadge('!', '#D63F2A')
            return
          }
          const page = await extractActiveTab(tabId)
          const useSelection = info.menuItemId === MENU_SELECTION && page.hasSelection
          const blocks = useSelection ? page.selectionBlocks : page.articleBlocks
          const markdown = useSelection ? page.selectionMarkdown : page.articleMarkdown
          if (blocks.length === 0) {
            flashBadge('!', '#D63F2A')
            return
          }
          const result = await executeClip({
            tabId,
            profileId,
            workflow: 'create',
            sourceKind: useSelection ? 'selection' : 'article',
            title: page.title,
            note: '',
            url: page.url,
            author: page.author,
            siteName: page.siteName,
            publishedAt: page.publishedAt,
            blocks,
            markdown,
            folderId: prefs.folderId || undefined,
            localizeImages: prefs.localizeImages,
            asSuggestion: prefs.asSuggestion,
          })
          if (result.omittedBlockCount) flashBadge('!', '#a15c00', clipOverflowNotice(result.omittedBlockCount))
          else flashBadge('✓', '#2b8a3e')
        } catch (err) {
          console.error('context menu clip failed', err)
          flashBadge('!', '#D63F2A')
        }
      })()
    })
  }

  browser.runtime.onMessage.addListener((msg: unknown) => {
    if (!msg || typeof msg !== 'object') return undefined
    const m = msg as { type?: string; payload?: ClipExecutionRequest }
    if (m.type === 'stetpad:clip' && m.payload) {
      return executeClip(m.payload)
        .then((result) => {
          flashBadge('✓', '#2b8a3e')
          return { ok: true as const, result }
        })
        .catch((err) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }))
    }
    if (m.type === 'stetpad:poll-pair') {
      void pollPendingPair()
      return Promise.resolve({ ok: true })
    }
    return undefined
  })
})
