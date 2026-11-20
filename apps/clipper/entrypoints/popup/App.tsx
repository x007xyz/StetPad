import { collectImageUrls } from '@stetpad/clip'
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FilePlus2,
  FileText,
  Laptop,
  Loader2,
  Settings2,
  Sparkles,
  Unplug,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { browser } from 'wxt/browser'
import {
  discoverDesktopUrl,
  exchangePair,
  getMe,
  getModels,
  listDocs,
  listFolders,
  requestLocalPair,
  resolveProfile,
} from '../../src/lib/api'
import { extractActiveTab } from '../../src/lib/inject'
import { detectBrowserName, generatePkcePair, parseConnectionCode, randomHex } from '../../src/lib/pkce'
import {
  getPendingPair,
  getPrefs,
  getProfiles,
  removeProfile,
  savePrefs,
  saveProfile,
  setPendingPair,
} from '../../src/lib/storage'
import type {
  ClipExecutionRequest,
  ClipExecutionResult,
  ClipperPrefs,
  ClipperProfile,
  DocItem,
  ExtractedPage,
  FolderItem,
  ModelItem,
  WorkflowKind,
} from '../../src/lib/types'

const AI_PRESETS = [
  { label: '融入当前文稿', instruction: '请阅读附件里的网页剪藏，将其中的核心事实与观点自然融入当前文档的合适位置（以修订形式插入）。' },
  { label: '更新数据与论据', instruction: '请对比附件中的最新数据或论据，核查当前文档里的相关表述并提议更新修订。' },
  { label: '提炼核心摘要', instruction: '请根据附件中的网页剪藏，在文档末尾提炼一份结构化的要点摘要（以修订形式插入）。' },
  { label: '翻译并整理', instruction: '请将附件中的关键内容准确翻译为中文并整理成清晰的要点段落，以修订形式插入文档。' },
]

function isLocalOrigin(origin: string): boolean {
  try {
    const u = new URL(origin)
    return (u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
  } catch {
    return false
  }
}

export function App() {
  const [view, setView] = useState<'loading' | 'connect' | 'clip' | 'done'>('loading')
  const [profiles, setProfiles] = useState<Partial<Record<'local', ClipperProfile>>>({})

  // Connection state
  const [desktopDetected, setDesktopDetected] = useState<string | null>(null)
  const [manualCode, setManualCode] = useState('')
  const [showManual, setShowManual] = useState(false)
  const [connBusy, setConnBusy] = useState('')
  const [connError, setConnError] = useState('')

  // Extraction state
  const [tabId, setTabId] = useState<number | null>(null)
  const [page, setPage] = useState<ExtractedPage | null>(null)
  const [extractError, setExtractError] = useState('')
  const [sourceKind, setSourceKind] = useState<'article' | 'selection'>('article')
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [showPreview, setShowPreview] = useState(false)

  // Target workspace data
  const [folders, setFolders] = useState<FolderItem[]>([])
  const [docs, setDocs] = useState<DocItem[]>([])
  const [models, setModels] = useState<ModelItem[]>([])
  const [workflow, setWorkflow] = useState<WorkflowKind>('create')
  const [folderId, setFolderId] = useState('')
  const [docId, setDocId] = useState('')
  const [docFilter, setDocFilter] = useState('')
  const [localizeImages, setLocalizeImages] = useState(true)
  const [asSuggestion, setAsSuggestion] = useState(true)
  const [runAiAfterCreate, setRunAiAfterCreate] = useState(false)
  const [aiScope, setAiScope] = useState<'doc' | 'folder'>('doc')
  const [aiInstruction, setAiInstruction] = useState(AI_PRESETS[0]!.instruction)
  const [modelId, setModelId] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [result, setResult] = useState<ClipExecutionResult | null>(null)

  const activeProfile = profiles.local

  const loadWorkspace = useCallback(async (raw: ClipperProfile, savedPrefs: ClipperPrefs) => {
    const p = await resolveProfile(raw)
    if (p.baseUrl !== raw.baseUrl) {
      setProfiles((cur) => ({ ...cur, [p.id]: p }))
    }
    const md = await getModels(p)
    setModels(md.models)
    setModelId((cur) => cur || savedPrefs.modelId || md.default || md.models[0]?.id || '')

    const [fl, dl] = await Promise.all([listFolders(p), listDocs(p)])
    setFolders(fl)
    setDocs(dl)
    setFolderId((cur) => (fl.some((f) => f.id === (cur || savedPrefs.folderId)) ? cur || savedPrefs.folderId : ''))
    setDocId((cur) => {
      const want = cur || savedPrefs.docId
      return dl.some((d) => d.id === want) ? want : dl[0]?.id ?? ''
    })
  }, [])

  const bootstrap = useCallback(async () => {
    const [profs, pfs, pending, desk] = await Promise.all([
      getProfiles(),
      getPrefs(),
      getPendingPair(),
      discoverDesktopUrl(),
    ])
    setDesktopDetected(desk)
    setWorkflow(pfs.workflow)
    setLocalizeImages(pfs.localizeImages)
    setAsSuggestion(pfs.asSuggestion)
    setAiScope(pfs.aiScope)

    // Complete pending PKCE pairing if user already approved in another tab or desktop dialog.
    let updatedProfs = { ...profs }
    if (pending) {
      try {
        const res = await exchangePair(pending.baseUrl, pending.code, pending.verifier)
        if (res.status === 'approved') {
          const bound: ClipperProfile = {
            id: 'local',
            mode: 'local',
            baseUrl: pending.baseUrl,
            token: res.token,
            email: res.user.email,
          }
          await saveProfile(bound)
          await setPendingPair(null)
          updatedProfs = { ...updatedProfs, local: bound }
          await savePrefs({ activeProfile: 'local' })
        }
      } catch {
        // Still pending or expired; user can trigger reconnect.
      }
    }

    setProfiles(updatedProfs)
    if (!updatedProfs.local) {
      setView('connect')
      return
    }
    setView('clip')

    // Run tab extraction and workspace loading concurrently.
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
    if (tab?.id) {
      setTabId(tab.id)
      void extractActiveTab(tab.id)
        .then((extracted) => {
          setPage(extracted)
          setTitle(extracted.title)
          setSourceKind(extracted.hasSelection ? 'selection' : 'article')
        })
        .catch((err) => {
          setExtractError(err instanceof Error ? err.message : '无法读取当前页面')
        })
    }

    try {
      await loadWorkspace(updatedProfs.local, pfs)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : '连接 Stetpad 失败，请检查服务是否启动')
    }
  }, [loadWorkspace])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  const connectDesktop = async () => {
    setConnError('')
    setConnBusy('desktop')
    try {
      const runningUrl = (await discoverDesktopUrl()) ?? desktopDetected
      if (runningUrl) {
        const res = await requestLocalPair(runningUrl, detectBrowserName())
        const bound: ClipperProfile = {
          id: 'local',
          mode: 'local',
          baseUrl: runningUrl,
          token: res.token,
          email: res.user.email,
        }
        await saveProfile(bound)
        await savePrefs({ activeProfile: 'local' })
        await bootstrap()
        return
      }
      // Desktop is not currently running: wake via stetpad://pair and poll.
      const { verifier, challenge } = await generatePkcePair()
      const code = randomHex(16)
      const name = detectBrowserName()
      const deep = `stetpad://pair?code=${encodeURIComponent(code)}&challenge=${encodeURIComponent(challenge)}&name=${encodeURIComponent(name)}`
      await browser.tabs.create({ url: deep })
      for (let i = 0; i < 45; i++) {
        const url = await discoverDesktopUrl()
        if (url) {
          await setPendingPair({ baseUrl: url, code, verifier, startedAt: Date.now() })
          const ex = await exchangePair(url, code, verifier).catch(() => ({ status: 'pending' as const }))
          if (ex.status === 'approved') {
            const bound: ClipperProfile = {
              id: 'local',
              mode: 'local',
              baseUrl: url,
              token: ex.token,
              email: ex.user.email,
            }
            await saveProfile(bound)
            await savePrefs({ activeProfile: 'local' })
            await setPendingPair(null)
            await bootstrap()
            return
          }
        }
        await new Promise((r) => setTimeout(r, 1200))
      }
      setConnError('等待桌面端授权超时，请确认 Stetpad 桌面应用已启动并点击“允许连接”。')
    } catch (err) {
      setConnError(err instanceof Error ? err.message : '连接桌面端失败')
    } finally {
      setConnBusy('')
    }
  }

  const connectManual = async () => {
    setConnError('')
    setConnBusy('manual')
    try {
      const parsed = parseConnectionCode(manualCode)
      if (!parsed) throw new Error('连接码格式无效，请在 Stetpad「设置 → 浏览器插件」中重新生成')
      if (!isLocalOrigin(parsed.url)) throw new Error('连接码地址必须是本机 Stetpad 桌面端')
      const candidate: ClipperProfile = {
        id: 'local',
        mode: 'local',
        baseUrl: parsed.url,
        token: parsed.token,
        email: '',
      }
      const me = await getMe(candidate)
      candidate.email = me.user.email
      await saveProfile(candidate)
      await savePrefs({ activeProfile: candidate.id })
      setManualCode('')
      await bootstrap()
    } catch (err) {
      setConnError(err instanceof Error ? err.message : '验证连接码失败')
    } finally {
      setConnBusy('')
    }
  }

  const disconnect = async () => {
    await removeProfile('local')
    setProfiles({})
  }

  const activeBlocks = useMemo(() => {
    if (!page) return []
    return sourceKind === 'selection' && page.hasSelection ? page.selectionBlocks : page.articleBlocks
  }, [page, sourceKind])

  const activeMarkdown = useMemo(() => {
    if (!page) return ''
    return sourceKind === 'selection' && page.hasSelection ? page.selectionMarkdown : page.articleMarkdown
  }, [page, sourceKind])

  const imageCount = useMemo(() => collectImageUrls(activeBlocks).length, [activeBlocks])
  const charCount = useMemo(() => activeMarkdown.trim().length, [activeMarkdown])

  const filteredDocs = useMemo(() => {
    const q = docFilter.trim().toLowerCase()
    return q ? docs.filter((d) => d.title.toLowerCase().includes(q)) : docs
  }, [docs, docFilter])

  const submit = async () => {
    if (!page || !tabId || !activeProfile) return
    setSubmitting(true)
    setSubmitError('')
    try {
      const payload: ClipExecutionRequest = {
        tabId,
        profileId: activeProfile.id,
        workflow,
        sourceKind,
        title: title.trim() || page.title,
        note,
        url: page.url,
        author: page.author,
        siteName: page.siteName,
        publishedAt: page.publishedAt,
        blocks: activeBlocks,
        markdown: activeMarkdown,
        folderId: folderId || undefined,
        docId: docId || undefined,
        localizeImages,
        asSuggestion,
        runAiAfterCreate: workflow === 'create' ? runAiAfterCreate : false,
        aiScope,
        aiInstruction,
        modelId: modelId || undefined,
      }
      const res = (await browser.runtime.sendMessage({ type: 'stetpad:clip', payload })) as
        | { ok: true; result: ClipExecutionResult }
        | { ok: false; error: string }
      if (!res?.ok) throw new Error(res?.error || '保存失败')
      setResult(res.result)
      setView('done')
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : '操作失败')
    } finally {
      setSubmitting(false)
    }
  }

  const openInStetpad = async () => {
    if (!result) return
    const q = result.docId ? `doc=${encodeURIComponent(result.docId)}` : result.folderId ? `folder=${encodeURIComponent(result.folderId)}` : ''
    await browser.tabs.create({ url: `stetpad://open${q ? '?' + q : ''}` })
  }

  if (view === 'loading') {
    return (
      <div className="flex min-h-[460px] items-center justify-center gap-2 text-[var(--muted)]">
        <Loader2 className="size-4 animate-spin" />
        <span>正在加载 Stetpad…</span>
      </div>
    )
  }

  if (view === 'connect') {
    return (
      <div className="flex flex-col gap-3 p-4">
        <header className="flex items-center justify-between border-b border-[var(--border)] pb-3">
          <div className="flex items-center gap-2">
            <StetpadLogo />
            <div>
              <h1 className="text-sm font-bold leading-tight">连接 Stetpad</h1>
              <p className="text-[11px] text-[var(--muted)]">连接本机 Stetpad 桌面应用后即可剪藏</p>
            </div>
          </div>
          {profiles.local && (
            <button
              type="button"
              onClick={() => void bootstrap()}
              className="rounded-md border border-[var(--border)] bg-[var(--card)] px-2.5 py-1 text-xs hover:bg-[var(--soft)]"
            >
              返回剪藏
            </button>
          )}
        </header>

        {/* Desktop card */}
        <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-semibold">
              <Laptop className="size-4" />
              <span>本机桌面端</span>
            </div>
            {profiles.local ? (
              <span className="rounded-full bg-[#e6f4ea] px-2 py-0.5 text-[11px] font-medium text-[var(--ok)]">已连接</span>
            ) : desktopDetected ? (
              <span className="text-[11px] text-[var(--ok)]">运行中</span>
            ) : (
              <span className="text-[11px] text-[var(--muted)]">未运行</span>
            )}
          </div>
          {profiles.local ? (
            <div className="mt-2 flex items-center justify-between text-xs text-[var(--muted)]">
              <span className="truncate">{profiles.local.baseUrl}</span>
              <button
                type="button"
                onClick={() => void disconnect()}
                className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
              >
                <Unplug className="size-3" /> 断开
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={!!connBusy}
              onClick={() => void connectDesktop()}
              className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--ink)] px-3 py-1.5 text-xs font-medium text-[var(--paper)] hover:opacity-90"
            >
              {connBusy === 'desktop' ? <Loader2 className="size-3.5 animate-spin" /> : <Laptop className="size-3.5" />}
              <span>{desktopDetected ? '一键连接桌面端' : '唤醒并连接桌面端'}</span>
            </button>
          )}
        </section>

        {/* Manual fallback */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2">
          <button
            type="button"
            onClick={() => setShowManual((v) => !v)}
            className="flex w-full items-center justify-between text-xs font-medium text-[var(--muted)]"
          >
            <span>使用连接码手动绑定（stetpad1:...）</span>
            {showManual ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
          {showManual && (
            <div className="mt-2 flex gap-1.5">
              <input
                type="text"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                placeholder="粘贴连接码…"
                className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--paper)] px-2 py-1 text-xs outline-none focus:border-[var(--ink)]"
              />
              <button
                type="button"
                disabled={!manualCode.trim() || !!connBusy}
                onClick={() => void connectManual()}
                className="rounded-lg border border-[var(--border)] bg-[var(--soft)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--border)]"
              >
                绑定
              </button>
            </div>
          )}
        </div>

        {connError && <p className="m-0 text-xs text-[var(--accent)]">{connError}</p>}
      </div>
    )
  }

  if (view === 'done' && result) {
    return (
      <div className="flex min-h-[460px] flex-col items-center justify-center gap-3 p-6 text-center">
        <CheckCircle2 className="size-10 text-[var(--ok)]" />
        <h2 className="m-0 text-base font-bold">
          {result.workflow === 'ai'
            ? 'AI 已开始处理剪藏内容'
            : result.workflow === 'append'
              ? result.changeId
                ? '已作为修订建议插入文档'
                : '已追加到目标文档'
              : '已保存到 Stetpad'}
        </h2>
        <p className="m-0 text-xs text-[var(--muted)]">
          {result.uploadedImages > 0 && `已转存 ${result.uploadedImages} 张图片。`}
          {result.skippedImages > 0 && `${result.skippedImages} 张图片保留原链接。`}
          {result.runId && ' AI 正在后台生成待审阅修订建议。'}
        </p>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => setView('clip')}
            className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--soft)]"
          >
            继续剪藏
          </button>
          <button
            type="button"
            onClick={() => void openInStetpad()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)]"
          >
            <span>在 Stetpad 中打开</span>
            <ExternalLink className="size-3.5" />
          </button>
        </div>
      </div>
    )
  }

  const canSubmit =
    !!page &&
    activeBlocks.length > 0 &&
    !submitting &&
    (workflow === 'create' ||
      (workflow === 'append' && !!docId) ||
      (workflow === 'ai' && !!aiInstruction.trim() && (aiScope === 'doc' ? !!docId : !!folderId)))

  return (
    <div className="flex flex-col gap-2.5 p-3.5">
      {/* Header with dual-profile switcher */}
      <header className="flex items-center justify-between gap-2 border-b border-[var(--border)] pb-2.5">
        <div className="flex items-center gap-2">
          <StetpadLogo />
          <span className="text-sm font-bold tracking-tight">Stetpad</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setView('connect')}
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 py-0.5 text-[11px] text-[var(--muted)] hover:bg-[var(--soft)]"
            title="管理桌面端连接"
          >
            <Laptop className="size-3" />
            <span>桌面端</span>
          </button>
          <button
            type="button"
            onClick={() => setView('connect')}
            aria-label="连接设置"
            className="rounded-lg p-1 text-[var(--muted)] hover:bg-[var(--soft)] hover:text-[var(--ink)]"
          >
            <Settings2 className="size-4" />
          </button>
        </div>
      </header>

      {extractError ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 text-xs text-[var(--accent)]">
          {extractError}
        </div>
      ) : !page ? (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-[var(--muted)]">
          <Loader2 className="size-3.5 animate-spin" />
          <span>正在提取网页正文…</span>
        </div>
      ) : (
        <>
          {/* Source mode + title + note */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex rounded-lg border border-[var(--border)] bg-[var(--soft)] p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setSourceKind('article')}
                className={`rounded-md px-2.5 py-0.5 font-medium ${
                  sourceKind === 'article' ? 'bg-[var(--card)] text-[var(--ink)] shadow-xs' : 'text-[var(--muted)]'
                }`}
              >
                智能正文 ({page.articleBlocks.length})
              </button>
              <button
                type="button"
                disabled={!page.hasSelection}
                onClick={() => setSourceKind('selection')}
                className={`rounded-md px-2.5 py-0.5 font-medium ${
                  sourceKind === 'selection' ? 'bg-[var(--card)] text-[var(--ink)] shadow-xs' : 'text-[var(--muted)]'
                }`}
              >
                当前选区 ({page.selectionBlocks.length})
              </button>
            </div>
            <button
              type="button"
              onClick={() => setShowPreview((v) => !v)}
              className="text-[11px] text-[var(--muted)] hover:text-[var(--ink)] hover:underline"
            >
              {showPreview ? '收起预览' : `${charCount} 字 · ${imageCount} 图`}
            </button>
          </div>

          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="文档标题"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-2.5 py-1.5 text-xs font-semibold outline-none focus:border-[var(--ink)]"
          />
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="添加随手批注（可选，将作为高亮备注附在开头）…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-2.5 py-1 text-xs outline-none focus:border-[var(--ink)]"
          />

          {showPreview && (
            <pre className="m-0 max-h-28 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-[var(--card)] p-2 font-sans text-[11px] text-[var(--muted)]">
              {activeMarkdown.slice(0, 1200)}
            </pre>
          )}

          {/* Workflow Tabs */}
          <div className="grid grid-cols-3 gap-1 rounded-xl border border-[var(--border)] bg-[var(--soft)] p-1 text-xs font-medium">
            {[
              { id: 'create' as const, label: '新建文档', Icon: FilePlus2 },
              { id: 'append' as const, label: '追加到文档', Icon: FileText },
              { id: 'ai' as const, label: '交给 AI', Icon: Sparkles },
            ].map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setWorkflow(id)}
                className={`flex items-center justify-center gap-1 rounded-lg py-1.5 ${
                  workflow === id ? 'bg-[var(--card)] text-[var(--ink)] shadow-xs' : 'text-[var(--muted)] hover:text-[var(--ink)]'
                }`}
              >
                <Icon className="size-3.5" />
                <span>{label}</span>
              </button>
            ))}
          </div>

          {/* Workflow Body */}
          <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
            <div className="grid grid-cols-1 gap-2">
              {workflow === 'create' || (workflow === 'ai' && aiScope === 'folder') ? (
                <label className="flex flex-col gap-0.5 text-[11px] text-[var(--muted)]">
                  <span>资料夹</span>
                  <select
                    value={folderId}
                    onChange={(e) => setFolderId(e.target.value)}
                    className="rounded-lg border border-[var(--border)] bg-[var(--paper)] px-2 py-1 text-xs text-[var(--ink)] outline-none"
                  >
                    {workflow === 'create' ? <option value="">根目录</option> : <option value="">请选择资料夹…</option>}
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className="flex flex-col gap-0.5 text-[11px] text-[var(--muted)]">
                  <span>筛选文档</span>
                  <input
                    type="text"
                    value={docFilter}
                    onChange={(e) => setDocFilter(e.target.value)}
                    placeholder="搜索标题…"
                    className="rounded-lg border border-[var(--border)] bg-[var(--paper)] px-2 py-1 text-xs text-[var(--ink)] outline-none"
                  />
                </label>
              )}
            </div>

            {workflow === 'create' && (
              <>
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={localizeImages}
                    onChange={(e) => setLocalizeImages(e.target.checked)}
                    className="accent-[var(--accent)]"
                  />
                  <span>转存图片到 Stetpad（防止外链防盗链裂图）</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={runAiAfterCreate}
                    onChange={(e) => setRunAiAfterCreate(e.target.checked)}
                    className="accent-[var(--accent)]"
                  />
                  <span>保存后让 AI 提炼要点并生成修订建议</span>
                </label>
                {runAiAfterCreate && models.length > 0 && (
                  <select
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    className="rounded-lg border border-[var(--border)] bg-[var(--paper)] px-2 py-1 text-xs outline-none"
                  >
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                        {m.verified ? '' : '（未验证）'}
                      </option>
                    ))}
                  </select>
                )}
              </>
            )}

            {workflow === 'append' && (
              <>
                <label className="flex flex-col gap-0.5 text-[11px] text-[var(--muted)]">
                  <span>目标文档</span>
                  <select
                    value={docId}
                    onChange={(e) => setDocId(e.target.value)}
                    className="rounded-lg border border-[var(--border)] bg-[var(--paper)] px-2 py-1 text-xs text-[var(--ink)] outline-none"
                  >
                    {filteredDocs.length === 0 && <option value="">当前空间暂无文档</option>}
                    {filteredDocs.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={asSuggestion}
                    onChange={(e) => setAsSuggestion(e.target.checked)}
                    className="accent-[var(--accent)]"
                  />
                  <span>作为待审阅修订插入（推荐，可在正文逐条接受）</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={localizeImages}
                    onChange={(e) => setLocalizeImages(e.target.checked)}
                    className="accent-[var(--accent)]"
                  />
                  <span>转存图片到 Stetpad</span>
                </label>
              </>
            )}

            {workflow === 'ai' && (
              <>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <div className="flex rounded-lg border border-[var(--border)] bg-[var(--paper)] p-0.5 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setAiScope('doc')}
                      className={`rounded-md px-2 py-0.5 ${aiScope === 'doc' ? 'bg-[var(--soft)] font-semibold' : 'text-[var(--muted)]'}`}
                    >
                      单篇文档
                    </button>
                    <button
                      type="button"
                      onClick={() => setAiScope('folder')}
                      className={`rounded-md px-2 py-0.5 ${aiScope === 'folder' ? 'bg-[var(--soft)] font-semibold' : 'text-[var(--muted)]'}`}
                    >
                      整个资料夹
                    </button>
                  </div>
                  <select
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    className="min-w-0 max-w-[190px] rounded-lg border border-[var(--border)] bg-[var(--paper)] px-2 py-1 text-xs outline-none"
                  >
                    {models.length === 0 && <option value="">请先配置模型密钥</option>}
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                        {m.verified ? '' : '（未验证）'}
                      </option>
                    ))}
                  </select>
                </div>

                {aiScope === 'doc' && (
                  <select
                    value={docId}
                    onChange={(e) => setDocId(e.target.value)}
                    className="rounded-lg border border-[var(--border)] bg-[var(--paper)] px-2 py-1 text-xs outline-none"
                  >
                    {filteredDocs.length === 0 && <option value="">当前空间暂无文档</option>}
                    {filteredDocs.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title}
                      </option>
                    ))}
                  </select>
                )}

                <div className="flex flex-wrap gap-1">
                  {AI_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => setAiInstruction(p.instruction)}
                      className="rounded-full border border-[var(--border)] bg-[var(--paper)] px-2 py-0.5 text-[11px] hover:bg-[var(--soft)]"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <textarea
                  rows={2}
                  value={aiInstruction}
                  onChange={(e) => setAiInstruction(e.target.value)}
                  placeholder="告诉 AI 如何利用这段网页资料修改目标文档…"
                  className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--paper)] px-2.5 py-1.5 text-xs outline-none focus:border-[var(--ink)]"
                />
              </>
            )}
          </div>

          {submitError && <p className="m-0 text-xs text-[var(--accent)]">{submitError}</p>}

          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => void submit()}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--accent)] py-2 text-xs font-semibold text-white hover:bg-[var(--accent-hover)]"
          >
            {submitting && <Loader2 className="size-3.5 animate-spin" />}
            <span>
              {submitting
                ? '正在处理…'
                : workflow === 'ai'
                  ? '发送给 AI 生成修订建议'
                  : workflow === 'append'
                    ? asSuggestion
                      ? '以修订建议插入文档'
                      : '直接追加到文档'
                    : '剪藏并新建文档'}
            </span>
          </button>
        </>
      )}
    </div>
  )
}

function StetpadLogo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#2A251F" />
      <rect x="6" y="6.5" width="9" height="1.8" rx="0.9" fill="#FBF6EC" />
      <rect x="6" y="11" width="11" height="1.8" rx="0.9" fill="#D63F2A" />
      <rect x="6" y="15.5" width="7.5" height="1.8" rx="0.9" fill="#FBF6EC" />
      <path d="M18.5 13.5L19.4 16L21.9 16.9L19.4 17.8L18.5 20.3L17.6 17.8L15.1 16.9L17.6 16L18.5 13.5Z" fill="#D63F2A" />
    </svg>
  )
}
