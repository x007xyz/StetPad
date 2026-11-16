import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export interface User { id: string; email: string }
/** What a share link lets its holder do. `suggest`: edits are recorded as suggestions. */
export type ShareRole = 'edit' | 'suggest' | 'view'
export type SpaceRole = 'owner' | 'editor' | 'viewer'
export interface DocRow { id: string; user_id: string; space_id: string | null; folder_id: string | null; title: string; created_at: number; updated_at: number }
/** A single-level group of documents. Scoped like documents: to its creator, or to a space. */
export interface FolderRow { id: string; user_id: string; space_id: string | null; name: string; created_at: number }
export interface VersionRow {
  id: string; document_id: string; label: string | null; trigger: string; author: string
  word_count: number; created_at: number
}
export interface RunRow {
  id: string; document_id: string; user_id: string; instruction: string; model: string
  status: string; summary: string | null; usage_json: string | null; created_at: number; chat_id?: string | null
}
/** One conversation with the AI about a document. An empty title means "not named yet". */
export interface ChatRow { id: string; document_id: string; title: string; created_at: number; updated_at: number; n?: number }
export interface SpaceRow { id: string; name: string; owner_id: string; role: SpaceRole }
type Bytes = Uint8Array

/** The few things the store needs from a database. `?` marks a parameter. */
export interface Sql {
  exec(sql: string): Promise<void>
  run(sql: string, params?: unknown[]): Promise<void>
  all<T>(sql: string, params?: unknown[]): Promise<T[]>
  close(): Promise<void>
  /** Column types that differ between engines. */
  types: { blob: string; serial: string; int: string }
}

export async function sqliteSql(dataDir: string): Promise<Sql> {
  const { default: Database } = await import('better-sqlite3')
  mkdirSync(dataDir, { recursive: true })
  // The file was called ai-writer.sqlite before the rename to Stetpad. Move it (and its WAL files) so existing data is kept.
  const oldDb = join(dataDir, 'ai-writer.sqlite')
  const newDb = join(dataDir, 'stetpad.sqlite')
  if (!existsSync(newDb) && existsSync(oldDb)) {
    renameSync(oldDb, newDb)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(oldDb + suffix)) renameSync(oldDb + suffix, newDb + suffix)
    }
  }
  const db = new Database(newDb)
  db.pragma('journal_mode = WAL')
  const bind = (p: unknown[] = []): unknown[] => p.map((v) => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v) : v))
  return {
    types: { blob: 'blob', serial: 'integer primary key autoincrement', int: 'integer' },
    exec: async (sql) => void db.exec(sql),
    run: async (sql, params) => void db.prepare(sql).run(...bind(params)),
    all: async <T>(sql: string, params?: unknown[]) => db.prepare(sql).all(...bind(params)) as T[],
    close: async () => void db.close(),
  }
}

const numbered = (sql: string): string => {
  let i = 0
  return sql.replace(/\?/g, () => `$${++i}`)
}

/** PostgreSQL, through any client with a `query(text, params)` method (pg Pool, PGlite). */
export function postgresSql(client: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; end?: () => Promise<void>; close?: () => Promise<void> }): Sql {
  // bigint columns arrive as strings from pg; every one we store fits a double.
  const fix = <T>(rows: unknown[]): T[] =>
    rows.map((r) => {
      const o = r as Record<string, unknown>
      for (const k of Object.keys(o)) {
        if ((typeof o[k] === 'string' || typeof o[k] === 'bigint') && /^(created_at|updated_at|seq|word_count|input_tokens|output_tokens|runs|n)$/.test(k)) o[k] = Number(o[k])
      }
      return o as T
    })
  return {
    types: { blob: 'bytea', serial: 'bigserial primary key', int: 'bigint' },
    exec: async (sql) => {
      for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) await client.query(stmt)
    },
    run: async (sql, params) => void (await client.query(numbered(sql), params)),
    all: async <T>(sql: string, params?: unknown[]) => fix<T>((await client.query(numbered(sql), params)).rows),
    close: async () => void (await (client.end ?? client.close)?.call(client)),
  }
}

export async function openPostgres(url: string): Promise<Sql> {
  const { default: pg } = await import('pg')
  return postgresSql(new pg.Pool({ connectionString: url }))
}

/** A short title taken from the first message of a chat. */
export function chatTitle(instruction: string): string {
  const t = instruction.replace(/\s+/g, ' ').trim()
  return t.length > 30 ? t.slice(0, 30) + '…' : t
}

/**
 * Storage. Every query goes through this class; the engine underneath is
 * SQLite (desktop, single-node) or PostgreSQL (cloud).
 */
export class Store {
  private last = 0
  constructor(private sql: Sql) {}

  /** Strictly increasing timestamps, so "latest" is never ambiguous. */
  private now(): number {
    this.last = Math.max(Date.now(), this.last + 1)
    return this.last
  }
  private async one<T>(sql: string, params?: unknown[]): Promise<T | null> {
    return (await this.sql.all<T>(sql, params))[0] ?? null
  }

  async init(): Promise<void> {
    const { blob, serial, int } = this.sql.types
    await this.sql.exec(`
      create table if not exists users(id text primary key, email text unique not null, pw_hash text, created_at ${int} not null);
      create table if not exists sessions(token text primary key, user_id text not null, created_at ${int} not null);
      create table if not exists spaces(id text primary key, name text not null, owner_id text not null, created_at ${int} not null);
      create table if not exists memberships(space_id text not null, user_id text not null, role text not null, primary key(space_id, user_id));
      create table if not exists documents(id text primary key, user_id text not null, space_id text, title text not null, state ${blob}, created_at ${int} not null, updated_at ${int} not null);
      create table if not exists doc_updates(seq ${serial}, document_id text not null, data ${blob} not null);
      create index if not exists doc_updates_doc on doc_updates(document_id, seq);
      create table if not exists versions(id text primary key, document_id text not null, state ${blob} not null, content_json text not null, label text, trigger text not null, author text not null, word_count ${int} not null, created_at ${int} not null);
      create index if not exists versions_doc on versions(document_id, created_at);
      create table if not exists ai_runs(id text primary key, document_id text not null, user_id text not null, instruction text not null, scope_json text, model text not null, status text not null, summary text, usage_json text, created_at ${int} not null);
      create index if not exists runs_doc on ai_runs(document_id, created_at);
      create table if not exists ai_chats(id text primary key, document_id text not null, title text not null, created_at ${int} not null, updated_at ${int} not null);
      create index if not exists chats_doc on ai_chats(document_id, updated_at);
      create table if not exists ai_events(run_id text not null, seq ${int} not null, type text not null, payload_json text not null, created_at ${int} not null, primary key(run_id, seq));
      create table if not exists shares(token text primary key, document_id text not null, role text not null, created_at ${int} not null);
      create table if not exists assets(id text primary key, document_id text not null, mime text not null, data ${blob} not null, created_at ${int} not null);
      create table if not exists usage_ledger(user_id text not null, day text not null, model text not null, input_tokens ${int} not null, output_tokens ${int} not null, runs ${int} not null, primary key(user_id, day, model));
      create table if not exists sync_links(document_id text primary key, cloud_url text not null, cloud_doc_id text not null, token text not null);
      create table if not exists settings(user_id text not null, key text not null, value text not null, primary key(user_id, key));
      create table if not exists folders(id text primary key, user_id text not null, space_id text, name text not null, created_at ${int} not null)
    `)
    // Columns added after the first release. Each statement fails harmlessly when the column exists.
    for (const stmt of [
      'alter table documents add column space_id text',
      'alter table documents add column folder_id text',
      'alter table ai_runs add column chat_id text',
      'create index if not exists runs_chat on ai_runs(chat_id, created_at)',
    ]) {
      await this.sql.exec(stmt).catch(() => {})
    }
    await this.migrateRunsToChats()
  }
  /** Runs from before conversations existed go into one chat per document. Safe to repeat. */
  private async migrateRunsToChats(): Promise<void> {
    const docs = await this.sql.all<{ document_id: string }>('select distinct document_id from ai_runs where chat_id is null')
    for (const { document_id } of docs) {
      const first = await this.one<{ instruction: string; created_at: number }>('select instruction, created_at from ai_runs where document_id = ? and chat_id is null order by created_at limit 1', [document_id])
      const last = await this.one<{ created_at: number }>('select created_at from ai_runs where document_id = ? and chat_id is null order by created_at desc limit 1', [document_id])
      const id = randomUUID()
      await this.sql.run('insert into ai_chats(id, document_id, title, created_at, updated_at) values (?, ?, ?, ?, ?)',
        [id, document_id, chatTitle(first?.instruction ?? ''), first?.created_at ?? this.now(), last?.created_at ?? this.now()])
      await this.sql.run('update ai_runs set chat_id = ? where document_id = ? and chat_id is null', [id, document_id])
    }
  }
  close(): Promise<void> {
    return this.sql.close()
  }

  // --- users and sessions
  private hash(pw: string, salt = randomBytes(16).toString('hex')): string {
    return salt + ':' + scryptSync(pw, salt, 32).toString('hex')
  }
  async ensureLocalUser(): Promise<User> {
    const u = await this.one<User>('select id, email from users where id = ?', ['local'])
    if (u) return u
    await this.sql.run('insert into users(id, email, created_at) values (?, ?, ?)', ['local', 'local@device', this.now()])
    return { id: 'local', email: 'local@device' }
  }
  async register(email: string, password: string): Promise<User | null> {
    if (await this.one('select 1 as x from users where email = ?', [email])) return null
    const id = randomUUID()
    await this.sql.run('insert into users(id, email, pw_hash, created_at) values (?, ?, ?, ?)', [id, email, this.hash(password), this.now()])
    return { id, email }
  }
  async login(email: string, password: string): Promise<User | null> {
    const row = await this.one<User & { pw_hash: string | null }>('select id, email, pw_hash from users where email = ?', [email])
    if (!row?.pw_hash) return null
    const [salt, want] = row.pw_hash.split(':') as [string, string]
    return timingSafeEqual(scryptSync(password, salt, 32), Buffer.from(want, 'hex')) ? { id: row.id, email: row.email } : null
  }
  userByEmail(email: string): Promise<User | null> {
    return this.one<User>('select id, email from users where email = ?', [email])
  }
  async createSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString('hex')
    await this.sql.run('insert into sessions(token, user_id, created_at) values (?, ?, ?)', [token, userId, this.now()])
    return token
  }
  deleteSession(token: string): Promise<void> {
    return this.sql.run('delete from sessions where token = ?', [token])
  }
  userBySession(token: string): Promise<User | null> {
    return this.one<User>('select u.id, u.email from sessions s join users u on u.id = s.user_id where s.token = ?', [token])
  }

  // --- team spaces
  async createSpace(ownerId: string, name: string): Promise<string> {
    const id = randomUUID()
    await this.sql.run('insert into spaces(id, name, owner_id, created_at) values (?, ?, ?, ?)', [id, name, ownerId, this.now()])
    await this.sql.run('insert into memberships(space_id, user_id, role) values (?, ?, ?)', [id, ownerId, 'owner'])
    return id
  }
  listSpaces(userId: string): Promise<SpaceRow[]> {
    return this.sql.all<SpaceRow>('select s.id, s.name, s.owner_id, m.role from spaces s join memberships m on m.space_id = s.id where m.user_id = ? order by s.created_at', [userId])
  }
  async spaceRole(spaceId: string, userId: string): Promise<SpaceRole | null> {
    return (await this.one<{ role: SpaceRole }>('select role from memberships where space_id = ? and user_id = ?', [spaceId, userId]))?.role ?? null
  }
  listMembers(spaceId: string): Promise<{ user_id: string; email: string; role: SpaceRole }[]> {
    return this.sql.all('select m.user_id, u.email, m.role from memberships m join users u on u.id = m.user_id where m.space_id = ? order by u.email', [spaceId])
  }
  setMember(spaceId: string, userId: string, role: SpaceRole): Promise<void> {
    return this.sql.run('insert into memberships(space_id, user_id, role) values (?, ?, ?) on conflict(space_id, user_id) do update set role = excluded.role', [spaceId, userId, role])
  }
  removeMember(spaceId: string, userId: string): Promise<void> {
    return this.sql.run('delete from memberships where space_id = ? and user_id = ?', [spaceId, userId])
  }

  // --- documents
  private static DOC = 'id, user_id, space_id, folder_id, title, created_at, updated_at'
  listDocs(userId: string, spaceId: string | null): Promise<DocRow[]> {
    return spaceId
      ? this.sql.all<DocRow>(`select ${Store.DOC} from documents where space_id = ? order by updated_at desc`, [spaceId])
      : this.sql.all<DocRow>(`select ${Store.DOC} from documents where user_id = ? and space_id is null order by updated_at desc`, [userId])
  }
  getDoc(id: string): Promise<DocRow | null> {
    return this.one<DocRow>(`select ${Store.DOC} from documents where id = ?`, [id])
  }
  async createDoc(userId: string, title: string, state: Bytes, spaceId: string | null = null): Promise<DocRow> {
    const id = randomUUID()
    const now = this.now()
    await this.sql.run('insert into documents(id, user_id, space_id, title, state, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)', [id, userId, spaceId, title, state, now, now])
    return { id, user_id: userId, space_id: spaceId, folder_id: null, title, created_at: now, updated_at: now }
  }
  renameDoc(id: string, title: string): Promise<void> {
    return this.sql.run('update documents set title = ?, updated_at = ? where id = ?', [title, this.now(), id])
  }
  async deleteDoc(id: string): Promise<void> {
    await this.sql.run('delete from ai_events where run_id in (select id from ai_runs where document_id = ?)', [id])
    for (const t of ['ai_runs', 'ai_chats', 'versions', 'shares', 'doc_updates', 'assets', 'sync_links']) await this.sql.run(`delete from ${t} where document_id = ?`, [id])
    await this.sql.run('delete from documents where id = ?', [id])
  }

  // --- folders
  private static FOLDER = 'id, user_id, space_id, name, created_at'
  async createFolder(userId: string, name: string, spaceId: string | null = null): Promise<FolderRow> {
    const id = randomUUID()
    const now = this.now()
    await this.sql.run('insert into folders(id, user_id, space_id, name, created_at) values (?, ?, ?, ?, ?)', [id, userId, spaceId, name, now])
    return { id, user_id: userId, space_id: spaceId, name, created_at: now }
  }
  getFolder(id: string): Promise<FolderRow | null> {
    return this.one<FolderRow>(`select ${Store.FOLDER} from folders where id = ?`, [id])
  }
  listFolders(userId: string, spaceId: string | null): Promise<FolderRow[]> {
    return spaceId
      ? this.sql.all<FolderRow>(`select ${Store.FOLDER} from folders where space_id = ? order by created_at`, [spaceId])
      : this.sql.all<FolderRow>(`select ${Store.FOLDER} from folders where user_id = ? and space_id is null order by created_at`, [userId])
  }
  renameFolder(id: string, name: string): Promise<void> {
    return this.sql.run('update folders set name = ? where id = ?', [name, id])
  }
  /** Deleting a folder never deletes documents: they move to the root. */
  async deleteFolder(id: string): Promise<void> {
    await this.sql.run('update documents set folder_id = null where folder_id = ?', [id])
    await this.sql.run('delete from folders where id = ?', [id])
  }
  setDocFolder(docId: string, folderId: string | null): Promise<void> {
    return this.sql.run('update documents set folder_id = ? where id = ?', [folderId, docId])
  }
  /** The documents of a folder in reading order. */
  listFolderDocs(folderId: string): Promise<DocRow[]> {
    return this.sql.all<DocRow>(`select ${Store.DOC} from documents where folder_id = ? order by created_at, id`, [folderId])
  }

  /**
   * A document is stored as a snapshot plus the updates made since. Updates
   * are appended as they happen, so a crash loses nothing that was acknowledged.
   */
  async loadState(id: string): Promise<{ state: Bytes | null; updates: Bytes[] }> {
    const row = await this.one<{ state: Bytes | null }>('select state from documents where id = ?', [id])
    const updates = await this.sql.all<{ data: Bytes }>('select data from doc_updates where document_id = ? order by seq', [id])
    return { state: row?.state ? new Uint8Array(row.state) : null, updates: updates.map((u) => new Uint8Array(u.data)) }
  }
  appendUpdate(id: string, update: Bytes): Promise<void> {
    return this.sql.run('insert into doc_updates(document_id, data) values (?, ?)', [id, update])
  }
  async lastUpdateSeq(id: string): Promise<number> {
    return Number((await this.one<{ n: number | null }>('select max(seq) as n from doc_updates where document_id = ?', [id]))?.n ?? 0)
  }
  /** Replace the snapshot and drop the updates it already contains. */
  async saveState(id: string, state: Bytes, upToSeq: number): Promise<void> {
    await this.sql.run('update documents set state = ?, updated_at = ? where id = ?', [state, this.now(), id])
    await this.sql.run('delete from doc_updates where document_id = ? and seq <= ?', [id, upToSeq])
  }

  // --- versions
  async addVersion(v: { documentId: string; state: Bytes; content: unknown; label?: string | null; trigger: string; author: string; wordCount: number }): Promise<string> {
    const id = randomUUID()
    await this.sql.run('insert into versions(id, document_id, state, content_json, label, trigger, author, word_count, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, v.documentId, v.state, JSON.stringify(v.content), v.label ?? null, v.trigger, v.author, v.wordCount, this.now()])
    return id
  }
  private static VER = 'id, document_id, label, trigger, author, word_count, created_at'
  listVersions(documentId: string): Promise<VersionRow[]> {
    return this.sql.all<VersionRow>(`select ${Store.VER} from versions where document_id = ? order by created_at desc`, [documentId])
  }
  getVersion(id: string): Promise<(VersionRow & { content_json: string }) | null> {
    return this.one(`select ${Store.VER}, content_json from versions where id = ?`, [id])
  }
  labelVersion(id: string, label: string): Promise<void> {
    return this.sql.run('update versions set label = ? where id = ?', [label, id])
  }
  async latestVersionContent(documentId: string): Promise<string | null> {
    return (await this.one<{ content_json: string }>('select content_json from versions where document_id = ? order by created_at desc limit 1', [documentId]))?.content_json ?? null
  }
  /** Thin out automatic versions: keep named ones, and one automatic version per hour once older than a day. */
  async pruneVersions(documentId: string): Promise<number> {
    const rows = await this.sql.all<{ id: string; label: string | null; created_at: number }>('select id, label, created_at from versions where document_id = ? order by created_at desc', [documentId])
    const cutoff = Date.now() - 24 * 3600_000
    const seen = new Set<number>()
    let removed = 0
    for (const r of rows) {
      if (r.label || r.created_at > cutoff) continue
      const hour = Math.floor(r.created_at / 3600_000)
      if (!seen.has(hour)) {
        seen.add(hour)
        continue
      }
      await this.sql.run('delete from versions where id = ?', [r.id])
      removed++
    }
    return removed
  }

  // --- agent runs
  async createRun(r: { documentId: string; userId: string; instruction: string; scope: unknown; model: string; chatId?: string | null }): Promise<string> {
    const id = randomUUID()
    const now = this.now()
    await this.sql.run('insert into ai_runs(id, document_id, user_id, instruction, scope_json, model, status, created_at, chat_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, r.documentId, r.userId, r.instruction, JSON.stringify(r.scope ?? null), r.model, 'running', now, r.chatId ?? null])
    if (r.chatId) {
      await this.sql.run('update ai_chats set updated_at = ? where id = ?', [now, r.chatId])
      // The first message names the chat, unless the user already did.
      const t = chatTitle(r.instruction)
      if (t) await this.sql.run("update ai_chats set title = ? where id = ? and title = ''", [t, r.chatId])
    }
    return id
  }
  finishRun(id: string, status: string, summary: string, usage: unknown): Promise<void> {
    return this.sql.run('update ai_runs set status = ?, summary = ?, usage_json = ? where id = ?', [status, summary, JSON.stringify(usage ?? null), id])
  }
  getRun(id: string): Promise<RunRow | null> {
    return this.one<RunRow>('select * from ai_runs where id = ?', [id])
  }
  async listRuns(documentId: string, limit = 30, chatId?: string | null): Promise<RunRow[]> {
    const rows = chatId
      ? await this.sql.all<RunRow>('select * from ai_runs where document_id = ? and chat_id = ? order by created_at desc limit ?', [documentId, chatId, limit])
      : await this.sql.all<RunRow>('select * from ai_runs where document_id = ? order by created_at desc limit ?', [documentId, limit])
    return rows.reverse()
  }
  /** Ids of every run the document has, whichever chat it belongs to. */
  async runIds(documentId: string): Promise<string[]> {
    return (await this.sql.all<{ id: string }>('select id from ai_runs where document_id = ?', [documentId])).map((r) => r.id)
  }

  // --- AI chats (conversations)
  async createChat(documentId: string, title = ''): Promise<ChatRow> {
    const id = randomUUID()
    const now = this.now()
    await this.sql.run('insert into ai_chats(id, document_id, title, created_at, updated_at) values (?, ?, ?, ?, ?)', [id, documentId, title, now, now])
    return { id, document_id: documentId, title, created_at: now, updated_at: now, n: 0 }
  }
  listChats(documentId: string): Promise<ChatRow[]> {
    return this.sql.all<ChatRow>('select c.id, c.document_id, c.title, c.created_at, c.updated_at, (select count(*) from ai_runs r where r.chat_id = c.id) as n from ai_chats c where c.document_id = ? order by c.updated_at desc', [documentId])
  }
  getChat(id: string): Promise<ChatRow | null> {
    return this.one<ChatRow>('select id, document_id, title, created_at, updated_at from ai_chats where id = ?', [id])
  }
  renameChat(id: string, title: string): Promise<void> {
    return this.sql.run('update ai_chats set title = ? where id = ?', [title, id])
  }
  /** Removes the conversation and its messages. The document, and any change still waiting for review, are not touched. */
  async deleteChat(id: string): Promise<void> {
    await this.sql.run('delete from ai_events where run_id in (select id from ai_runs where chat_id = ?)', [id])
    await this.sql.run('delete from ai_runs where chat_id = ?', [id])
    await this.sql.run('delete from ai_chats where id = ?', [id])
  }
  addEvent(runId: string, seq: number, type: string, payload: unknown): Promise<void> {
    return this.sql.run('insert into ai_events(run_id, seq, type, payload_json, created_at) values (?, ?, ?, ?, ?)', [runId, seq, type, JSON.stringify(payload), this.now()])
  }
  eventsAfter(runId: string, seq: number): Promise<{ seq: number; type: string; payload_json: string }[]> {
    return this.sql.all('select seq, type, payload_json from ai_events where run_id = ? and seq > ? order by seq', [runId, seq])
  }
  /** Runs left "running" by a crash are marked interrupted at startup. */
  interruptStaleRuns(): Promise<void> {
    return this.sql.run("update ai_runs set status = 'interrupted' where status = 'running'")
  }

  // --- usage
  addUsage(userId: string, model: string, input: number, output: number): Promise<void> {
    const day = new Date().toISOString().slice(0, 10)
    return this.sql.run(
      'insert into usage_ledger(user_id, day, model, input_tokens, output_tokens, runs) values (?, ?, ?, ?, ?, 1) on conflict(user_id, day, model) do update set input_tokens = usage_ledger.input_tokens + excluded.input_tokens, output_tokens = usage_ledger.output_tokens + excluded.output_tokens, runs = usage_ledger.runs + 1',
      [userId, day, model, input, output])
  }
  usage(userId: string, days = 30): Promise<{ day: string; model: string; input_tokens: number; output_tokens: number; runs: number }[]> {
    const from = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)
    return this.sql.all('select day, model, input_tokens, output_tokens, runs from usage_ledger where user_id = ? and day >= ? order by day desc, model', [userId, from])
  }
  async tokensToday(userId: string): Promise<number> {
    const day = new Date().toISOString().slice(0, 10)
    const rows = await this.sql.all<{ input_tokens: number; output_tokens: number }>('select input_tokens, output_tokens from usage_ledger where user_id = ? and day = ?', [userId, day])
    return rows.reduce((n, r) => n + r.input_tokens + r.output_tokens, 0)
  }

  // --- share links
  async createShare(documentId: string, role: ShareRole): Promise<string> {
    const token = randomBytes(24).toString('base64url')
    await this.sql.run('insert into shares(token, document_id, role, created_at) values (?, ?, ?, ?)', [token, documentId, role, this.now()])
    return token
  }
  getShare(token: string): Promise<{ token: string; document_id: string; role: ShareRole } | null> {
    return this.one('select token, document_id, role from shares where token = ?', [token])
  }
  listShares(documentId: string): Promise<{ token: string; role: ShareRole; created_at: number }[]> {
    return this.sql.all('select token, role, created_at from shares where document_id = ? order by created_at', [documentId])
  }
  deleteShare(token: string): Promise<void> {
    return this.sql.run('delete from shares where token = ?', [token])
  }

  // --- images
  async addAsset(documentId: string, mime: string, data: Bytes): Promise<string> {
    const id = randomBytes(24).toString('base64url')
    await this.sql.run('insert into assets(id, document_id, mime, data, created_at) values (?, ?, ?, ?, ?)', [id, documentId, mime, data, this.now()])
    return id
  }
  async getAsset(id: string): Promise<{ mime: string; data: Bytes } | null> {
    const r = await this.one<{ mime: string; data: Bytes }>('select mime, data from assets where id = ?', [id])
    return r ? { mime: r.mime, data: new Uint8Array(r.data) } : null
  }

  // --- cloud sync links (desktop)
  setSyncLink(documentId: string, cloudUrl: string, cloudDocId: string, token: string): Promise<void> {
    return this.sql.run('insert into sync_links(document_id, cloud_url, cloud_doc_id, token) values (?, ?, ?, ?) on conflict(document_id) do update set cloud_url = excluded.cloud_url, cloud_doc_id = excluded.cloud_doc_id, token = excluded.token', [documentId, cloudUrl, cloudDocId, token])
  }
  getSyncLink(documentId: string): Promise<{ document_id: string; cloud_url: string; cloud_doc_id: string; token: string } | null> {
    return this.one('select * from sync_links where document_id = ?', [documentId])
  }
  listSyncLinks(): Promise<{ document_id: string; cloud_url: string; cloud_doc_id: string; token: string }[]> {
    return this.sql.all('select * from sync_links')
  }
  deleteSyncLink(documentId: string): Promise<void> {
    return this.sql.run('delete from sync_links where document_id = ?', [documentId])
  }

  // --- settings
  async getSetting(userId: string, key: string): Promise<string | null> {
    return (await this.one<{ value: string }>('select value from settings where user_id = ? and key = ?', [userId, key]))?.value ?? null
  }
  setSetting(userId: string, key: string, value: string): Promise<void> {
    return this.sql.run('insert into settings(user_id, key, value) values (?, ?, ?) on conflict(user_id, key) do update set value = excluded.value', [userId, key, value])
  }
}
