import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { projectBlocks } from '@stetpad/crdt'
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import { AgentRuntime, cleanContext, contextNote, LimitError, PRESETS } from './agent'
import { Collab, type VersionContent } from './collab'
import { applyBlocks, blocksToDocx, blocksToHtml, blocksToMarkdown, docFromBlocks, fileToBlocks, type Block } from './content'
import { openPostgres, sqliteSql, Store, type DocRow, type FolderRow, type Sql, type SpaceRole, type User } from './db'
import { ExternalAgents, parseAgentDefs, parseStoredAgents, type AgentDef } from './external'
import { generateText } from 'ai'
import {
  BUILTIN_ENDPOINTS,
  builtinKey,
  customKey,
  customKeyName,
  describeProviders,
  isPrivateHost,
  listModels,
  modelPrice,
  parseCustomProviders,
  parseExtraModels,
  parseIdList,
  parsePrices,
  parseStored,
  parseStoredProviders,
  providerKeyNames,
  resolveModel,
  type CustomProviderInput,
  type ModelScope,
} from './models'
import { discoverModels, fetchBalance } from './provider-api'
import { catalogFor } from './provider-catalog'
import { CloudSync } from './sync'

export interface ServerConfig {
  /** `local`: one user, one fixed token (desktop app). `web`: accounts. */
  mode: 'local' | 'web'
  dataDir: string
  port: number
  host?: string
  /** Built web app to serve. */
  staticDir?: string
  /** Local mode only. Generated when absent. */
  token?: string
  /** Encrypts saved secrets at rest. The desktop app passes the OS keychain. */
  secrets?: { encrypt: (plain: string) => string; decrypt: (stored: string) => string }
  /** PostgreSQL connection string. Without it, a SQLite file in `dataDir`. */
  databaseUrl?: string
  /** An already opened database (tests). */
  sql?: Sql
  /** Tokens one user may spend per day (web mode). 0: unlimited. */
  dailyTokenLimit?: number
  /** How to start the MCP bridge for external agents: command and leading arguments. */
  mcpCommand?: { command: string; args: string[]; env?: Record<string, string> }
}

export interface RunningServer {
  port: number
  token: string | null
  close: () => Promise<void>
}

type Access = 'owner' | 'editor' | 'viewer'
type Env = { Variables: { user: User; token: string } }
const canWrite = (a: Access | null): boolean => a === 'owner' || a === 'editor'
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const sql = config.sql ?? (config.databaseUrl ? await openPostgres(config.databaseUrl) : await sqliteSql(config.dataDir))
  const store = new Store(sql)
  await store.init()
  await store.interruptStaleRuns()
  const localToken = config.mode === 'local' ? (config.token ?? randomBytes(32).toString('hex')) : null
  const localUser = config.mode === 'local' ? await store.ensureLocalUser() : null
  const seal = (plain: string): string => (plain && config.secrets ? config.secrets.encrypt(plain) : plain)
  const unseal = (stored: string): string => (config.secrets ? config.secrets.decrypt(stored) : stored)

  const userByToken = async (token: string): Promise<User | null> => {
    if (!token) return null
    if (config.mode === 'local') return token === localToken ? localUser : null
    return store.userBySession(token)
  }
  /** What this user may do with this document: its creator, or a member of its space. */
  const accessTo = async (user: User, doc: DocRow): Promise<Access | null> => {
    if (doc.user_id === user.id) return 'owner'
    if (!doc.space_id) return null
    const role = await store.spaceRole(doc.space_id, user.id)
    return role
  }

  const collab = new Collab(store, async (token, documentId) => {
    if (token.startsWith('share:')) {
      const share = await store.getShare(token.slice(6))
      if (!share || share.document_id !== documentId) return null
      return { user: { id: `guest:${share.token.slice(0, 6)}`, email: 'guest' }, readOnly: share.role === 'view', suggestOnly: share.role === 'suggest' }
    }
    const user = await userByToken(token)
    const doc = await store.getDoc(documentId)
    const access = user && doc ? await accessTo(user, doc) : null
    return user && access ? { user, readOnly: access === 'viewer' } : null
  })

  const keysFor = async (userId: string): Promise<ModelScope> => {
    const saved = new Map<string, string>()
    for (const { keyName } of providerKeyNames()) {
      const stored = await store.getSetting(userId, `key:${keyName}`)
      if (!stored) continue
      try {
        saved.set(keyName, unseal(stored))
      } catch {
        // An unreadable saved key is treated as absent.
      }
    }
    const custom = parseStoredProviders(await store.getSetting(userId, 'custom-providers'))
    for (const p of custom) {
      const stored = await store.getSetting(userId, `key:${customKeyName(p.id)}`)
      if (!stored) continue
      try {
        saved.set(customKeyName(p.id), unseal(stored))
      } catch {
        // An unreadable saved key is treated as absent.
      }
    }
    const disabledProviders = new Set(parseStored(await store.getSetting(userId, 'disabled-providers'), [] as string[], (v) => parseIdList(v, '')))
    const disabledModels = new Set(parseStored(await store.getSetting(userId, 'disabled-models'), [] as string[], (v) => parseIdList(v, '')))
    const extra = parseStored(await store.getSetting(userId, 'extra-models'), {}, parseExtraModels)
    const prices = parseStored(await store.getSetting(userId, 'model-prices'), {}, parsePrices)
    return { key: (name) => saved.get(name) ?? null, custom, disabledProviders, disabledModels, extra, prices }
  }
  const agent = new AgentRuntime(store, collab, keysFor, config.mode === 'web' ? (config.dailyTokenLimit ?? 0) : 0)
  const sync = new CloudSync(store, collab, unseal)
  const external = new ExternalAgents(collab)

  const app = new Hono<Env>()
  let port = config.port

  if (config.mode === 'local') {
    // Only requests addressed to this loopback service are served.
    app.use('*', async (c, next) => {
      const host = c.req.header('host') ?? ''
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return c.text('forbidden', 403)
      await next()
    })
  }

  app.get('/api/config', (c) => c.json({ mode: config.mode }))

  app.post('/api/auth/register', async (c) => {
    if (config.mode !== 'web') return c.json({ error: 'not available' }, 404)
    const { email, password } = await c.req.json<{ email: string; password: string }>()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email ?? '') || (password ?? '').length < 8) {
      return c.json({ error: '请输入有效邮箱和至少 8 位的密码' }, 400)
    }
    const user = await store.register(email.toLowerCase(), password)
    if (!user) return c.json({ error: '该邮箱已注册' }, 409)
    return c.json({ token: await store.createSession(user.id), user })
  })
  app.post('/api/auth/login', async (c) => {
    if (config.mode !== 'web') return c.json({ error: 'not available' }, 404)
    const { email, password } = await c.req.json<{ email: string; password: string }>()
    const user = await store.login((email ?? '').toLowerCase(), password ?? '')
    if (!user) return c.json({ error: '邮箱或密码不正确' }, 401)
    return c.json({ token: await store.createSession(user.id), user })
  })

  // A share link names its own document and role; no account is needed to use it.
  app.get('/api/share/:token', async (c) => {
    const share = await store.getShare(c.req.param('token'))
    const doc = share && (await store.getDoc(share.document_id))
    if (!share || !doc) return c.json({ error: '链接无效或已被撤销' }, 404)
    return c.json({ docId: doc.id, title: doc.title, role: share.role })
  })

  // Uploaded images. The id is unguessable; that is the access control.
  app.get('/files/:id', async (c) => {
    const asset = await store.getAsset(c.req.param('id'))
    if (!asset) return c.text('not found', 404)
    return c.body(asset.data as unknown as ArrayBuffer, 200, {
      'content-type': asset.mime,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=31536000, immutable',
    })
  })

  const api = new Hono<Env>()
  api.use('*', async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    const user = await userByToken(token)
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    c.set('user', user)
    c.set('token', token)
    await next()
  })

  /** The document and what the caller may do with it; null if they may not see it. */
  const docFor = async (c: Context<Env>, id: string, need: 'read' | 'write' | 'own' = 'read') => {
    const doc = await store.getDoc(id)
    const access = doc ? await accessTo(c.get('user'), doc) : null
    if (!doc || !access) return null
    if (need === 'write' && !canWrite(access)) return null
    if (need === 'own' && access !== 'owner') return null
    return { doc, access }
  }
  const notFound = (c: Context<Env>) => c.json({ error: 'not found' }, 404)

  api.get('/me', (c) => c.json({ user: c.get('user'), mode: config.mode }))
  api.post('/auth/logout', async (c) => {
    if (config.mode === 'web') await store.deleteSession(c.get('token'))
    return c.json({ ok: true })
  })

  // --- team spaces
  api.get('/spaces', async (c) => c.json(await store.listSpaces(c.get('user').id)))
  api.post('/spaces', async (c) => {
    const { name } = await c.req.json<{ name: string }>()
    if (!name?.trim()) return c.json({ error: '请填写空间名称' }, 400)
    return c.json({ id: await store.createSpace(c.get('user').id, name.trim().slice(0, 60)) })
  })
  api.get('/spaces/:sid/members', async (c) => {
    const sid = c.req.param('sid')
    if (!(await store.spaceRole(sid, c.get('user').id))) return notFound(c)
    return c.json(await store.listMembers(sid))
  })
  api.post('/spaces/:sid/members', async (c) => {
    const sid = c.req.param('sid')
    if ((await store.spaceRole(sid, c.get('user').id)) !== 'owner') return notFound(c)
    const { email, role } = await c.req.json<{ email: string; role: SpaceRole }>()
    if (role !== 'editor' && role !== 'viewer') return c.json({ error: 'bad role' }, 400)
    const member = await store.userByEmail((email ?? '').toLowerCase())
    if (!member) return c.json({ error: '没有找到这个邮箱的账号，对方需要先注册' }, 404)
    if (member.id === c.get('user').id) return c.json({ error: '不能修改自己的角色' }, 400)
    await store.setMember(sid, member.id, role)
    return c.json({ ok: true })
  })
  api.delete('/spaces/:sid/members/:uid', async (c) => {
    const sid = c.req.param('sid')
    const uid = c.req.param('uid')
    if ((await store.spaceRole(sid, c.get('user').id)) !== 'owner' || uid === c.get('user').id) return notFound(c)
    await store.removeMember(sid, uid)
    for (const d of await store.listDocs(uid, sid)) collab.hocuspocus.closeConnections(d.id)
    return c.json({ ok: true })
  })

  // --- documents
  const spaceForCreate = async (c: Context<Env>, spaceId?: string | null): Promise<string | null | false> => {
    if (!spaceId) return null
    const role = await store.spaceRole(spaceId, c.get('user').id)
    return role === 'owner' || role === 'editor' ? spaceId : false
  }
  api.get('/docs', async (c) => {
    const space = c.req.query('space') || null
    if (space && !(await store.spaceRole(space, c.get('user').id))) return notFound(c)
    return c.json(await store.listDocs(c.get('user').id, space))
  })
  api.post('/docs', async (c) => {
    const body = await c.req.json<{ title?: string; spaceId?: string; empty?: boolean; folderId?: string }>().catch(() => ({} as { title?: string; spaceId?: string; empty?: boolean; folderId?: string }))
    const space = await spaceForCreate(c, body.spaceId)
    if (space === false) return notFound(c)
    const folder = body.folderId ? await folderFor(c, body.folderId, 'write') : null
    if (body.folderId && (!folder || (folder.folder.space_id ?? null) !== space)) return notFound(c)
    // `empty`: no initial paragraph. Used when the content will arrive by sync.
    const state = Y.encodeStateAsUpdate(body.empty ? new Y.Doc() : docFromBlocks([]))
    const doc = await store.createDoc(c.get('user').id, body.title?.trim() || '未命名文档', state, space)
    if (folder) await store.setDocFolder(doc.id, folder.folder.id)
    return c.json(folder ? { ...doc, folder_id: folder.folder.id } : doc)
  })
  api.get('/docs/:id', async (c) => {
    const d = await docFor(c, c.req.param('id'))
    return d ? c.json({ ...d.doc, access: d.access, sync: sync.status(d.doc.id) }) : notFound(c)
  })
  api.patch('/docs/:id', async (c) => {
    const d = await docFor(c, c.req.param('id'), 'write')
    if (!d) return notFound(c)
    const { title } = await c.req.json<{ title: string }>()
    await store.renameDoc(d.doc.id, (title ?? '').trim() || '未命名文档')
    return c.json({ ok: true })
  })
  api.delete('/docs/:id', async (c) => {
    const d = await docFor(c, c.req.param('id'), 'own')
    if (!d) return notFound(c)
    await sync.stop(d.doc.id)
    await store.deleteDoc(d.doc.id)
    return c.json({ ok: true })
  })

  // --- folders (one level; scoped like documents)
  /** The folder and what the caller may do with it; null if they may not see it. */
  const folderFor = async (c: Context<Env>, id: string, need: 'read' | 'write' = 'read'): Promise<{ folder: FolderRow; access: Access } | null> => {
    const folder = await store.getFolder(id)
    if (!folder) return null
    const user = c.get('user')
    const access: Access | null = folder.user_id === user.id ? 'owner' : folder.space_id ? await store.spaceRole(folder.space_id, user.id) : null
    if (!access || (need === 'write' && !canWrite(access))) return null
    return { folder, access }
  }
  api.get('/folders', async (c) => {
    const space = c.req.query('space') || null
    if (space && !(await store.spaceRole(space, c.get('user').id))) return notFound(c)
    return c.json(await store.listFolders(c.get('user').id, space))
  })
  api.post('/folders', async (c) => {
    const body = await c.req.json<{ name?: string; spaceId?: string }>().catch(() => ({} as { name?: string; spaceId?: string }))
    const space = await spaceForCreate(c, body.spaceId)
    if (space === false) return notFound(c)
    return c.json(await store.createFolder(c.get('user').id, body.name?.trim().slice(0, 80) || '新建文件夹', space))
  })
  api.get('/folders/:id', async (c) => {
    const f = await folderFor(c, c.req.param('id'))
    return f ? c.json({ ...f.folder, access: f.access, docs: await store.listFolderDocs(f.folder.id) }) : notFound(c)
  })
  api.patch('/folders/:id', async (c) => {
    const f = await folderFor(c, c.req.param('id'), 'write')
    if (!f) return notFound(c)
    const { name } = await c.req.json<{ name: string }>()
    await store.renameFolder(f.folder.id, (name ?? '').trim().slice(0, 80) || '新建文件夹')
    return c.json({ ok: true })
  })
  api.delete('/folders/:id', async (c) => {
    const f = await folderFor(c, c.req.param('id'), 'write')
    if (!f) return notFound(c)
    if (agent.activeRun(AgentRuntime.folderKey(f.folder.id))) return c.json({ error: 'AI 任务运行中，暂不能删除' }, 409)
    await store.deleteFolder(f.folder.id) // its documents move to the root
    return c.json({ ok: true })
  })
  api.put('/docs/:id/folder', async (c) => {
    const d = await docFor(c, c.req.param('id'), 'write')
    if (!d) return notFound(c)
    const { folderId } = await c.req.json<{ folderId: string | null }>()
    if (folderId) {
      const f = await folderFor(c, folderId, 'write')
      // A document only moves within its own scope: the same space, or the personal area.
      if (!f || (f.folder.space_id ?? null) !== (d.doc.space_id ?? null)) return notFound(c)
    }
    if (d.doc.folder_id && agent.activeRun(AgentRuntime.folderKey(d.doc.folder_id))) return c.json({ error: 'AI 任务运行中，暂不能移动文档' }, 409)
    await store.setDocFolder(d.doc.id, folderId || null)
    return c.json({ ok: true })
  })

  // --- images
  api.post('/docs/:id/assets', async (c) => {
    const d = await docFor(c, c.req.param('id'), 'write')
    if (!d) return notFound(c)
    const file = (await c.req.formData()).get('file')
    if (!(file instanceof File)) return c.json({ error: '没有收到文件' }, 400)
    if (!IMAGE_TYPES.has(file.type)) return c.json({ error: '只支持 PNG、JPEG、GIF、WebP 图片' }, 415)
    if (file.size > 8 * 1024 * 1024) return c.json({ error: '图片超过 8MB' }, 413)
    const id = await store.addAsset(d.doc.id, file.type, new Uint8Array(await file.arrayBuffer()))
    return c.json({ url: `/files/${id}` })
  })

  // --- share links
  api.get('/docs/:id/shares', async (c) => {
    const d = await docFor(c, c.req.param('id'), 'write')
    return d ? c.json(await store.listShares(d.doc.id)) : notFound(c)
  })
  api.post('/docs/:id/shares', async (c) => {
    const d = await docFor(c, c.req.param('id'), 'write')
    if (!d) return notFound(c)
    const { role } = await c.req.json<{ role: string }>()
    if (role !== 'edit' && role !== 'suggest' && role !== 'view') return c.json({ error: 'bad role' }, 400)
    return c.json({ token: await store.createShare(d.doc.id, role), role })
  })
  api.delete('/shares/:token', async (c) => {
    const share = await store.getShare(c.req.param('token'))
    if (!share || !(await docFor(c, share.document_id, 'write'))) return notFound(c)
    await store.deleteShare(share.token)
    collab.hocuspocus.closeConnections(share.document_id) // holders must reconnect and are refused
    return c.json({ ok: true })
  })

  // --- versions
  api.get('/docs/:id/versions', async (c) => {
    const d = await docFor(c, c.req.param('id'))
    return d ? c.json(await store.listVersions(d.doc.id)) : notFound(c)
  })
  api.post('/docs/:id/versions', async (c) => {
    const d = await docFor(c, c.req.param('id'), 'write')
    if (!d) return notFound(c)
    const { label, trigger } = await c.req.json<{ label?: string; trigger?: string }>().catch(() => ({} as { label?: string; trigger?: string }))
    const id = await collab.snapshot(d.doc.id, trigger === 'reviewed' ? 'reviewed' : 'manual', c.get('user').email, label?.trim() || undefined)
    return c.json({ id })
  })
  const versionFor = async (c: Context<Env>, id: string, need: 'read' | 'write') => {
    const v = await store.getVersion(id)
    return v && (await docFor(c, v.document_id, need)) ? v : null
  }
  api.get('/versions/:vid', async (c) => {
    const v = await versionFor(c, c.req.param('vid'), 'read')
    if (!v) return notFound(c)
    const { content_json, ...meta } = v
    return c.json({ ...meta, content: JSON.parse(content_json) as VersionContent })
  })
  api.patch('/versions/:vid', async (c) => {
    const v = await versionFor(c, c.req.param('vid'), 'write')
    if (!v) return notFound(c)
    const { label } = await c.req.json<{ label: string }>()
    await store.labelVersion(v.id, (label ?? '').trim())
    return c.json({ ok: true })
  })
  api.post('/versions/:vid/restore', async (c) => {
    const v = await versionFor(c, c.req.param('vid'), 'write')
    if (!v) return notFound(c)
    if (agent.activeRun(v.document_id)) return c.json({ error: 'AI 任务运行中，暂不能恢复' }, 409)
    const who = c.get('user').email
    // The current text is saved first; restoring never discards history.
    await collab.snapshot(v.document_id, 'before-restore', who)
    const target = (JSON.parse(v.content_json) as VersionContent).revised
    const { blockIds } = await c.req.json<{ blockIds?: string[] }>().catch(() => ({} as { blockIds?: string[] }))
    await collab.withDoc(v.document_id, (doc) => {
      if (!blockIds?.length) return applyBlocks(doc, target)
      // Restore only the chosen blocks: everything else keeps its current content.
      const chosen = new Map(target.filter((b) => blockIds.includes(b.blockId)).map((b) => [b.blockId, b]))
      const merged = projectBlocks(doc, 'revised').map((b) => chosen.get(b.blockId) ?? b)
      const have = new Set(merged.map((b) => b.blockId))
      for (const b of chosen.values()) if (!have.has(b.blockId)) merged.push(b) // a block that no longer exists comes back at the end
      applyBlocks(doc, merged)
    })
    await collab.snapshot(v.document_id, 'restore', who)
    return c.json({ ok: true })
  })

  // --- import and export
  api.post('/import/preview', async (c) => {
    const form = await c.req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return c.json({ error: '没有收到文件' }, 400)
    try {
      const keys = await keysFor(c.get('user').id)
      const visionId = listModels(keys).find((m) => /^(anthropic|openai|google):/.test(m.id) || m.id.startsWith('openrouter:anthropic/'))?.id
      const ocr = visionId
        ? async (png: Uint8Array): Promise<string> =>
            (await generateText({ model: resolveModel(visionId, keys), messages: [{ role: 'user', content: [{ type: 'image', image: png }, { type: 'text', text: 'Transcribe all text on this page exactly. Output Markdown: use #/##/### for headings, - for bullets, blank lines between paragraphs. Output only the transcription.' }] }] })).text
        : undefined
      const blocks = await fileToBlocks(file.name, new Uint8Array(await file.arrayBuffer()), { ocr })
      if (blocks.length === 0) return c.json({ error: '没有解析出任何内容' }, 422)
      const heading = blocks.find((b) => b.type === 'heading')
      const title = (heading?.delta.map((d) => d.insert).join('') || file.name.replace(/\.[^.]+$/, '')).slice(0, 80)
      return c.json({ title, blocks })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : '解析失败' }, 422)
    }
  })
  api.post('/import/create', async (c) => {
    const { title, blocks, spaceId } = await c.req.json<{ title: string; blocks: Block[]; spaceId?: string }>()
    if (!Array.isArray(blocks)) return c.json({ error: 'bad request' }, 400)
    const space = await spaceForCreate(c, spaceId)
    if (space === false) return notFound(c)
    const user = c.get('user')
    const doc = await store.createDoc(user.id, (title ?? '').trim() || '导入的文档', Y.encodeStateAsUpdate(docFromBlocks(blocks)), space)
    await collab.snapshot(doc.id, 'import', user.email)
    return c.json(doc)
  })
  api.get('/docs/:id/export', async (c) => {
    const d = await docFor(c, c.req.param('id'))
    if (!d) return notFound(c)
    const { doc } = d
    const view = c.req.query('view') === 'original' ? 'original' : 'revised'
    const format = c.req.query('format') ?? 'md'
    const blocks = await collab.withDoc(doc.id, (y) => projectBlocks(y, view))
    if (format === 'md') return c.text(blocksToMarkdown(blocks))
    if (format === 'html') return c.html(blocksToHtml(blocks, doc.title))
    if (format === 'docx') {
      const bytes = await blocksToDocx(blocks, doc.title)
      return c.body(bytes as unknown as ArrayBuffer, 200, { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    }
    if (format === 'json') {
      // Document package: content plus every version, for backup and moving between installs.
      const versions = []
      for (const v of await store.listVersions(doc.id)) versions.push({ ...v, content: JSON.parse((await store.getVersion(v.id))!.content_json) })
      return c.json({ format: 'stetpad-package', version: 1, title: doc.title, blocks, versions })
    }
    return c.json({ error: 'unknown format' }, 400)
  })

  // --- models, settings, usage
  api.get('/models', async (c) => {
    const user = c.get('user')
    const scope = await keysFor(user.id)
    const models = listModels(scope)
    const saved = await store.getSetting(user.id, 'model')
    const providers = []
    for (const p of providerKeyNames()) providers.push({ ...p, hasSavedKey: !!(await store.getSetting(user.id, `key:${p.keyName}`)) })
    // Keys of custom providers are never returned, only whether one is saved.
    const customProviders = scope.custom.map((p) => ({ id: p.id, name: p.name, baseURL: p.baseURL, currency: p.currency ?? '', models: p.models, hasKey: !!scope.key(customKeyName(p.id)) }))
    // External agents exist only in the desktop app; the web server never lists or starts them.
    const userAgents = config.mode === 'local' ? parseStoredAgents(await store.getSetting(user.id, 'external-agents')) : []
    return c.json({
      models,
      default: models.find((m) => m.id === saved)?.id ?? models[0]?.id ?? null,
      providers,
      providerList: describeProviders(scope),
      customProviders,
      presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label })),
      externalAgents: config.mode === 'local' ? external.available(userAgents) : [],
      ...(config.mode === 'local' ? { externalAgentsAll: external.all(userAgents) } : {}),
    })
  })
  api.get('/settings', async (c) => c.json({ preferences: (await store.getSetting(c.get('user').id, 'preferences')) ?? '' }))
  api.put('/settings', async (c) => {
    const body = await c.req.json<{ preferences?: string; model?: string; keys?: Record<string, string>; customProviders?: unknown; externalAgents?: unknown; disabledProviders?: unknown; disabledModels?: unknown; extraModels?: unknown; modelPrices?: unknown }>()
    const uid = c.get('user').id
    if (body.externalAgents !== undefined && config.mode === 'web') return c.json({ error: '外部 Agent 只能在桌面版中设置' }, 403)
    // Validate everything before writing anything.
    let custom: CustomProviderInput[] | null = null
    if (body.customProviders !== undefined) {
      try {
        custom = parseCustomProviders(body.customProviders, config.mode === 'web')
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : '自定义提供商的格式不正确' }, 400)
      }
    }
    // Provider switches, added models and prices are validated before anything is written.
    const parsedLists: [string, unknown][] = []
    try {
      if (body.disabledProviders !== undefined) parsedLists.push(['disabled-providers', parseIdList(body.disabledProviders, '停用的提供商')])
      if (body.disabledModels !== undefined) parsedLists.push(['disabled-models', parseIdList(body.disabledModels, '停用的模型')])
      if (body.extraModels !== undefined) parsedLists.push(['extra-models', parseExtraModels(body.extraModels)])
      if (body.modelPrices !== undefined) parsedLists.push(['model-prices', parsePrices(body.modelPrices)])
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : '设置的格式不正确' }, 400)
    }
    let agentList: AgentDef[] | null = null
    if (body.externalAgents !== undefined) {
      try {
        agentList = parseAgentDefs(body.externalAgents)
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : '外部 Agent 的格式不正确' }, 400)
      }
    }
    for (const [key, value] of parsedLists) await store.setSetting(uid, key, JSON.stringify(value))
    if (typeof body.preferences === 'string') await store.setSetting(uid, 'preferences', body.preferences)
    if (typeof body.model === 'string') await store.setSetting(uid, 'model', body.model)
    const allowed = new Set(providerKeyNames().map((p) => p.keyName))
    for (const [k, v] of Object.entries(body.keys ?? {})) {
      // Keys are write-only: they can be replaced or cleared, never read back.
      if (allowed.has(k) && typeof v === 'string') await store.setSetting(uid, `key:${k}`, seal(v.trim()))
    }
    if (custom) {
      // The list is complete: providers left out lose their models and their key.
      const previous = parseStoredProviders(await store.getSetting(uid, 'custom-providers'))
      const kept = new Set(custom.map((p) => p.id))
      for (const p of custom) {
        // A missing or blank key keeps the one already saved.
        const key = p.apiKey?.trim()
        if (key) await store.setSetting(uid, `key:${customKeyName(p.id)}`, seal(key))
      }
      for (const old of previous) {
        if (!kept.has(old.id)) await store.setSetting(uid, `key:${customKeyName(old.id)}`, '')
      }
      await store.setSetting(uid, 'custom-providers', JSON.stringify(custom.map(({ id, name, baseURL, currency, preset, models }) => ({ id, name, baseURL, ...(currency ? { currency } : {}), ...(preset ? { preset } : {}), models }))))
    }
    if (agentList) {
      // The list is complete: agents left out are removed.
      await store.setSetting(uid, 'external-agents', JSON.stringify(agentList))
    }
    return c.json({ ok: true })
  })
  api.get('/usage', async (c) => {
    const uid = c.get('user').id
    const scope = await keysFor(uid)
    // Cost is estimated from the prices the user set on custom models; other models have none.
    const days = (await store.usage(uid)).map((d) => {
      const price = modelPrice(d.model, scope)
      return { ...d, cost: price ? (d.input_tokens * price.input + d.output_tokens * price.output) / 1e6 : null, currency: price?.currency ?? null }
    })
    const totals: Record<string, number> = {}
    for (const d of days) if (d.cost !== null && d.currency) totals[d.currency] = (totals[d.currency] ?? 0) + d.cost
    return c.json({ days, totals, today: await store.tokensToday(uid), dailyLimit: config.mode === 'web' ? (config.dailyTokenLimit ?? 0) : 0 })
  })

  // Ready-made provider presets for the "add provider" picker (no secrets; safe to return to any user).
  api.get('/providers/catalog', (c) => c.json({ catalog: catalogFor(config.mode) }))

  // Resolves the endpoint and key of a provider: a built-in one by name, or a custom one by id.
  // A draft (unsaved) endpoint and key may be passed so the settings form can test before saving.
  const providerTarget = async (
    uid: string,
    body: { provider?: string; baseURL?: string; apiKey?: string },
  ): Promise<{ baseURL: string; key: string; auth: 'bearer' | 'anthropic' | 'google' } | { error: string }> => {
    const scope = await keysFor(uid)
    const name = body.provider ?? ''
    let baseURL = ''
    let key = body.apiKey?.trim() ?? ''
    let auth: 'bearer' | 'anthropic' | 'google' = 'bearer'
    if (name.startsWith('custom-')) {
      const saved = scope.custom.find((p) => `custom-${p.id}` === name)
      baseURL = (body.baseURL?.trim() || saved?.baseURL) ?? ''
      if (!key) key = customKey(name.slice('custom-'.length), scope) ?? ''
    } else if (name === '') {
      baseURL = body.baseURL?.trim() ?? ''
    } else {
      const ep = BUILTIN_ENDPOINTS[name]
      if (!ep) return { error: '这个提供商不支持查询' }
      baseURL = ep.baseURL
      auth = ep.auth
      if (!key) key = builtinKey(name, scope) ?? ''
    }
    let url: URL
    try {
      url = new URL(baseURL)
    } catch {
      return { error: '请先填写有效的端点地址' }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: '端点必须是 http(s) 地址' }
    if (config.mode === 'web' && isPrivateHost(url.hostname)) return { error: '网页版不允许访问本机或内网地址' }
    return { baseURL: url.href.replace(/\/+$/, ''), key, auth }
  }
  api.post('/providers/models', async (c) => {
    const body = await c.req.json<{ provider?: string; baseURL?: string; apiKey?: string }>().catch(() => ({}))
    const target = await providerTarget(c.get('user').id, body)
    if ('error' in target) return c.json({ error: target.error }, 400)
    try {
      return c.json({ models: await discoverModels(target.baseURL, target.auth, target.key) })
    } catch (err) {
      return c.json({ error: `获取模型列表失败：${err instanceof Error ? err.message : '未知错误'}` }, 502)
    }
  })
  // Sends a tiny request through the saved configuration, so a wrong key or endpoint shows up before a real run.
  api.post('/providers/test', async (c) => {
    const body = await c.req.json<{ modelId?: string }>().catch(() => ({}) as { modelId?: string })
    if (typeof body.modelId !== 'string' || !body.modelId) return c.json({ error: '请先选择一个模型' }, 400)
    const scope = await keysFor(c.get('user').id)
    const started = Date.now()
    try {
      await generateText({ model: resolveModel(body.modelId, scope), prompt: 'Reply with the single word: ok', maxOutputTokens: 16, abortSignal: AbortSignal.timeout(30_000) })
      return c.json({ ok: true, ms: Date.now() - started })
    } catch (err) {
      return c.json({ ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message.slice(0, 300) : '请求失败' })
    }
  })
  api.post('/providers/balance', async (c) => {
    const body = await c.req.json<{ provider?: string; baseURL?: string; apiKey?: string }>().catch(() => ({}))
    const target = await providerTarget(c.get('user').id, body)
    if ('error' in target) return c.json({ error: target.error }, 400)
    try {
      return c.json(await fetchBalance(target.baseURL, target.key))
    } catch (err) {
      return c.json({ error: `查询余额失败：${err instanceof Error ? err.message : '未知错误'}` }, 502)
    }
  })

  // --- agent runs
  api.get('/docs/:id/runs', async (c) => {
    const d = await docFor(c, c.req.param('id'))
    if (!d) return notFound(c)
    const chatId = c.req.query('chat') || null
    const chat = chatId ? await store.getChat(chatId) : null
    if (chatId && chat?.document_id !== d.doc.id) return notFound(c)
    const active = agent.activeRun(d.doc.id)
    return c.json({
      active,
      activeChat: active && active !== 'starting' ? ((await store.getRun(active))?.chat_id ?? null) : null,
      knownRunIds: await store.runIds(d.doc.id),
      runs: (await store.listRuns(d.doc.id, 30, chatId)).map((r) => ({ id: r.id, instruction: r.instruction, model: r.model, status: r.status, summary: r.summary, created_at: r.created_at })),
    })
  })
  // --- AI chats: several conversations per document
  api.get('/docs/:id/chats', async (c) => {
    const d = await docFor(c, c.req.param('id'))
    if (!d) return notFound(c)
    return c.json({ chats: (await store.listChats(d.doc.id)).map((x) => ({ id: x.id, title: x.title, created_at: x.created_at, updated_at: x.updated_at, runs: x.n ?? 0 })) })
  })
  api.post('/docs/:id/chats', async (c) => {
    const d = await docFor(c, c.req.param('id'), 'write')
    if (!d) return notFound(c)
    const body = await c.req.json<{ title?: string }>().catch(() => ({}) as { title?: string })
    const x = await store.createChat(d.doc.id, (body.title ?? '').trim().slice(0, 80))
    return c.json({ chat: { id: x.id, title: x.title, created_at: x.created_at, updated_at: x.updated_at, runs: 0 } })
  })
  const chatFor = async (c: Context<Env>, id: string, need: 'read' | 'write' = 'write') => {
    const x = await store.getChat(id)
    return x && (await docFor(c, x.document_id, need)) ? x : null
  }
  api.patch('/chats/:cid', async (c) => {
    const x = await chatFor(c, c.req.param('cid'))
    if (!x) return notFound(c)
    const body = await c.req.json<{ title?: string }>().catch(() => ({}) as { title?: string })
    const title = (body.title ?? '').trim().slice(0, 80)
    if (!title) return c.json({ error: '标题不能为空' }, 400)
    await store.renameChat(x.id, title)
    return c.json({ ok: true })
  })
  api.delete('/chats/:cid', async (c) => {
    const x = await chatFor(c, c.req.param('cid'))
    if (!x) return notFound(c)
    const active = agent.activeRun(x.document_id)
    if (active && active !== 'starting' && (await store.getRun(active))?.chat_id === x.id) return c.json({ error: '这个对话里有任务正在运行，请先停止' }, 409)
    await store.deleteChat(x.id)
    return c.json({ ok: true })
  })
  api.post('/docs/:id/runs', async (c) => {
    const d = await docFor(c, c.req.param('id'), 'write')
    if (!d) return notFound(c)
    const body = await c.req.json<{ chatId?: string; instruction?: string; modelId?: string; preset?: string; selection?: { blockIds: string[]; text?: string }; context?: unknown }>()
    const user = c.get('user')
    const modelId = body.modelId ?? (await store.getSetting(user.id, 'model')) ?? listModels(await keysFor(user.id))[0]?.id
    if (!modelId) return c.json({ error: '没有可用的模型，请先在设置里配置密钥' }, 400)
    if (!body.instruction?.trim() && !body.preset) return c.json({ error: '请输入指令' }, 400)
    const context = cleanContext(body.context)
    const typed = body.instruction?.trim() ?? ''
    let chat = body.chatId ? await store.getChat(body.chatId) : null
    if (body.chatId && chat?.document_id !== d.doc.id) return c.json({ error: '对话不存在' }, 404)
    // No chat named: continue the latest one, or open the first.
    chat ??= (await store.listChats(d.doc.id))[0] ?? (await store.createChat(d.doc.id))
    try {
      const runId = await agent.start({
        documentId: d.doc.id,
        chatId: chat.id,
        userId: user.id,
        instruction: context.length ? `${typed}\n${contextNote(context)}`.trim() : typed,
        context,
        modelId,
        preset: body.preset,
        selection: body.selection,
      })
      return c.json({ runId, chatId: chat.id })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, err instanceof LimitError ? 429 : 409)
    }
  })
  // Runs over a whole folder are filed under `folder:<id>`.
  api.get('/folders/:id/runs', async (c) => {
    const f = await folderFor(c, c.req.param('id'))
    if (!f) return notFound(c)
    const key = AgentRuntime.folderKey(f.folder.id)
    return c.json({
      active: agent.activeRun(key),
      runs: (await store.listRuns(key)).map((r) => ({ id: r.id, instruction: r.instruction, model: r.model, status: r.status, summary: r.summary, created_at: r.created_at })),
    })
  })
  api.post('/folders/:id/runs', async (c) => {
    const f = await folderFor(c, c.req.param('id'), 'write')
    if (!f) return notFound(c)
    const body = await c.req.json<{ instruction?: string; modelId?: string; context?: unknown }>()
    const user = c.get('user')
    const modelId = body.modelId ?? (await store.getSetting(user.id, 'model')) ?? listModels(await keysFor(user.id))[0]?.id
    if (!modelId) return c.json({ error: '没有可用的模型，请先在设置里配置密钥' }, 400)
    if (!body.instruction?.trim()) return c.json({ error: '请输入指令' }, 400)
    const context = cleanContext(body.context)
    const typed = body.instruction.trim()
    try {
      const runId = await agent.startFolder({
        folderId: f.folder.id,
        userId: user.id,
        instruction: context.length ? `${typed}\n${contextNote(context)}`.trim() : typed,
        context,
        modelId,
      })
      return c.json({ runId })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, err instanceof LimitError ? 429 : 409)
    }
  })
  const runFor = async (c: Context<Env>, id: string) => {
    const r = await store.getRun(id)
    if (r?.document_id.startsWith('folder:')) return (await folderFor(c, r.document_id.slice(7))) ? r : null
    return r && (await docFor(c, r.document_id)) ? r : null
  }
  api.post('/runs/:rid/cancel', async (c) => {
    const r = await runFor(c, c.req.param('rid'))
    if (!r) return notFound(c)
    return c.json({ cancelled: agent.cancel(r.id) })
  })
  api.get('/runs/:rid/events', async (c) => {
    const r = await runFor(c, c.req.param('rid'))
    if (!r) return notFound(c)
    const after = Number(c.req.query('after') ?? 0) || 0
    return streamSSE(c, async (stream) => {
      let done = false
      let wake: (() => void) | null = null
      const queue: { seq: number; type: string; payload: unknown }[] = []
      const off = await agent.subscribe(r.id, after, (e) => {
        queue.push(e)
        wake?.()
      })
      stream.onAbort(() => {
        done = true
        wake?.()
      })
      try {
        while (!done) {
          while (queue.length) {
            const e = queue.shift()!
            await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e.payload) })
            if (e.type === 'run.finished') done = true
          }
          if (done) break
          if (!agent.isRunning(r.id)) break // finished or interrupted before we subscribed
          await new Promise<void>((resolve) => {
            wake = resolve
            setTimeout(resolve, 15_000)
          })
          wake = null
          if (!queue.length && !done) await stream.writeSSE({ event: 'ping', data: '{}' })
        }
      } finally {
        off()
      }
    })
  })

  if (config.mode === 'local') {
    // --- external agents (ACP): the user's own agent edits this document through MCP
    api.post('/docs/:id/external-runs', async (c) => {
      const d = await docFor(c, c.req.param('id'), 'write')
      if (!d) return notFound(c)
      const { agent: agentId, prompt } = await c.req.json<{ agent: string; prompt: string }>()
      if (!config.mcpCommand) return c.json({ error: '这个安装没有配置外部 Agent 的桥接程序' }, 501)
      if (!prompt?.trim()) return c.json({ error: '请输入指令' }, 400)
      const userAgents = parseStoredAgents(await store.getSetting(c.get('user').id, 'external-agents'))
      try {
        const id = await external.start(agentId, prompt.trim(), d.doc.id, {
          ...config.mcpCommand,
          args: [...config.mcpCommand.args, '--url', `http://127.0.0.1:${port}`, '--token', localToken!, '--doc', d.doc.id],
        }, userAgents)
        return c.json({ id })
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 409)
      }
    })
    api.get('/external-runs/:eid', (c) => {
      const run = external.get(c.req.param('eid'))
      return run ? c.json(run) : notFound(c)
    })
    api.post('/external-runs/:eid/cancel', (c) => c.json({ cancelled: external.cancel(c.req.param('eid')) }))

    // --- cloud sync
    api.get('/cloud', async (c) => {
      const uid = c.get('user').id
      return c.json({ url: await store.getSetting(uid, 'cloud:url'), email: await store.getSetting(uid, 'cloud:email') })
    })
    api.post('/cloud/login', async (c) => {
      const { url, email, password } = await c.req.json<{ url: string; email: string; password: string }>()
      const base = (url ?? '').replace(/\/$/, '')
      if (!/^https?:\/\//.test(base)) return c.json({ error: '请输入云端地址，例如 https://writer.example.com' }, 400)
      try {
        const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
        const body = (await res.json()) as { token?: string; error?: string }
        if (!res.ok || !body.token) return c.json({ error: body.error ?? '登录失败' }, 401)
        const uid = c.get('user').id
        await store.setSetting(uid, 'cloud:url', base)
        await store.setSetting(uid, 'cloud:email', email)
        await store.setSetting(uid, 'cloud:token', seal(body.token))
        return c.json({ ok: true })
      } catch {
        return c.json({ error: '无法连接云端' }, 502)
      }
    })
    api.post('/cloud/logout', async (c) => {
      const uid = c.get('user').id
      for (const k of ['cloud:url', 'cloud:email', 'cloud:token']) await store.setSetting(uid, k, '')
      return c.json({ ok: true })
    })
    api.post('/docs/:id/sync', async (c) => {
      const d = await docFor(c, c.req.param('id'), 'own')
      if (!d) return notFound(c)
      const uid = c.get('user').id
      const url = await store.getSetting(uid, 'cloud:url')
      const sealed = await store.getSetting(uid, 'cloud:token')
      if (!url || !sealed) return c.json({ error: '请先登录云端' }, 400)
      if (!(await store.getSyncLink(d.doc.id))) {
        const res = await fetch(`${url}/api/docs`, { method: 'POST', headers: { authorization: `Bearer ${unseal(sealed)}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: d.doc.title, empty: true }) })
        if (!res.ok) return c.json({ error: '在云端创建文档失败，可能需要重新登录' }, 502)
        const cloud = (await res.json()) as { id: string }
        await store.setSyncLink(d.doc.id, url, cloud.id, sealed)
      }
      await sync.start(d.doc.id)
      return c.json({ ok: true, cloudDocId: (await store.getSyncLink(d.doc.id))!.cloud_doc_id })
    })
    api.delete('/docs/:id/sync', async (c) => {
      const d = await docFor(c, c.req.param('id'), 'own')
      if (!d) return notFound(c)
      await sync.stop(d.doc.id)
      await store.deleteSyncLink(d.doc.id)
      return c.json({ ok: true })
    })
  }

  app.route('/api', api)

  // --- the web app
  if (config.staticDir && existsSync(config.staticDir)) {
    const root = config.staticDir
    app.use('/assets/*', serveStatic({ root }))
    app.use('/favicon.svg', serveStatic({ root }))
    const index = (): string => readFileSync(join(root, 'index.html'), 'utf8')
    app.get('*', (c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'not found' }, 404) : c.html(index())))
  }

  const wss = new WebSocketServer({ noServer: true })
  const http = await new Promise<HttpServer>((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: config.host ?? '127.0.0.1', port: config.port }, (info) => {
      port = info.port
      resolve(s as HttpServer)
    })
  })
  http.on('upgrade', (req: IncomingMessage, socket, head) => {
    const host = req.headers.host ?? ''
    const url = new URL(req.url ?? '/', `http://${host || 'localhost'}`)
    const hostOk = config.mode !== 'local' || host === `127.0.0.1:${port}` || host === `localhost:${port}`
    if (url.pathname !== '/collab' || !hostOk) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
      // Hocuspocus is transport-agnostic: hand it the socket and forward frames.
      const client = collab.hocuspocus.handleConnection(ws, new Request(url, { headers }))
      ws.on('message', (data: Buffer) => client.handleMessage(new Uint8Array(data)))
      ws.on('close', (code: number, reason: Buffer) =>
        client.handleClose({ code, reason: reason.toString() } as unknown as CloseEvent),
      )
    })
  })
  if (config.mode === 'local') await sync.startAll()

  return {
    port,
    token: localToken,
    close: async () => {
      external.stopAll()
      await sync.stopAll()
      collab.hocuspocus.flushPendingStores()
      await new Promise((r) => setTimeout(r, 50))
      // Open sockets (collaborators, a cloud bridge) would keep the server from closing.
      for (const client of wss.clients) client.terminate()
      wss.close()
      const closed = new Promise<void>((r) => http.close(() => r()))
      http.closeAllConnections?.()
      await closed
      await store.close()
    },
  }
}
