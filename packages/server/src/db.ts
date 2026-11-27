import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export interface User { id: string; email: string }
export interface ClipperTokenRow { id: string; user_id: string; name: string; created_at: number; last_used_at: number }
/** `space_id` is a legacy column from the team-space era: it is always null for new rows and is no longer used for scoping. */
export interface DocRow { id: string; user_id: string; space_id: string | null; folder_id: string | null; title: string; created_at: number; updated_at: number }
/** A single-level group of documents, owned by its creator. */
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
/** A document in the trash, with when it was deleted (ms). */
export type TrashedDocRow = DocRow & { deleted_at: number }
/** Half-open UTF-16 offsets into the original display string. */
type MatchRange = [start: number, end: number]
/** One search hit. The snippet is empty when only the title matched. */
export interface SearchHit {
  id: string; title: string; space_id: string | null; folder_id: string | null; updated_at: number
  snippet: string; titleMatch: boolean; titleMatches: MatchRange[]; snippetMatches: MatchRange[]
}
type Bytes = Uint8Array
const SEARCH_TEXT_VERSION = 2

/** The few things the store needs from a database. `?` marks a parameter. */
export interface Sql {
  exec(sql: string): Promise<void>
  run(sql: string, params?: unknown[]): Promise<void>
  all<T>(sql: string, params?: unknown[]): Promise<T[]>
  close(): Promise<void>
  /** Column types for the SQLite engine. */
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
  db.function('search_fold', { deterministic: true }, (value: string | null) => value === null ? null : foldSearchText(value))
  const bind = (p: unknown[] = []): unknown[] => p.map((v) => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v) : v))
  return {
    types: { blob: 'blob', serial: 'integer primary key autoincrement', int: 'integer' },
    exec: async (sql) => void db.exec(sql),
    run: async (sql, params) => void db.prepare(sql).run(...bind(params)),
    all: async <T>(sql: string, params?: unknown[]) => db.prepare(sql).all(...bind(params)) as T[],
    close: async () => void db.close(),
  }
}

/** A short title taken from the first message of a chat. */
export function chatTitle(instruction: string): string {
  const t = instruction.replace(/\s+/g, ' ').trim()
  return t.length > 30 ? t.slice(0, 30) + '…' : t
}

function foldSearchText(text: string): string {
  return text.toLowerCase().replace(/ς/g, 'σ')
}

function* matchRanges(text: string, query: string): Generator<MatchRange> {
  const folded = foldSearchText(text)
  // Lowercasing can expand one character (e.g. İ to i + ◌̇); map back to whole source characters.
  let sourceStart = 0
  let sourceEnd = 0
  let foldedEnd = 0
  const advance = (): void => {
    sourceStart = sourceEnd
    const ch = String.fromCodePoint(text.codePointAt(sourceEnd)!)
    sourceEnd += ch.length
    foldedEnd += foldSearchText(ch).length
  }
  for (let at = folded.indexOf(query); at >= 0; at = folded.indexOf(query, at + query.length)) {
    const end = at + query.length
    if (folded.length === text.length) {
      yield [at, end]
    } else {
      while (foldedEnd <= at) advance()
      const start = sourceStart
      while (foldedEnd < end) advance()
      yield [start, sourceEnd]
    }
  }
}

function displayMatches(text: string, query: string): MatchRange[] {
  const ranges: MatchRange[] = []
  for (const range of matchRanges(text, query)) {
    const previous = ranges.at(-1)
    if (previous && range[0] < previous[1]) previous[1] = range[1]
    else ranges.push(range)
  }
  return ranges
}

function searchSnippet(text: string, query: string): Pick<SearchHit, 'snippet' | 'snippetMatches'> {
  const { value: first, done } = matchRanges(text, query).next()
  if (done) return { snippet: '', snippetMatches: [] }
  const start = Math.max(0, first[0] - 40)
  const end = Math.min(text.length, first[1] + 60)
  const excerpt = text.slice(start, end).trim()
  const compact = (part: string): string => part.replace(/\s+/g, ' ')
  const snippetMatches: MatchRange[] = []
  let snippet = start > 0 ? '…' : ''
  let copied = 0
  for (const [from, to] of displayMatches(excerpt, query)) {
    snippet += compact(excerpt.slice(copied, from))
    const displayStart = snippet.length
    snippet += compact(excerpt.slice(from, to))
    snippetMatches.push([displayStart, snippet.length])
    copied = to
  }
  snippet += compact(excerpt.slice(copied)) + (end < text.length ? '…' : '')
  return { snippet, snippetMatches }
}

/**
 * Storage. Every query goes through this class; the engine underneath is
 * SQLite, embedded in the desktop app.
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
      create table if not exists assets(id text primary key, document_id text not null, mime text not null, data ${blob} not null, created_at ${int} not null);
      create table if not exists usage_ledger(user_id text not null, day text not null, model text not null, input_tokens ${int} not null, output_tokens ${int} not null, runs ${int} not null, primary key(user_id, day, model));
      create table if not exists settings(user_id text not null, key text not null, value text not null, primary key(user_id, key));
      create table if not exists folders(id text primary key, user_id text not null, space_id text, name text not null, created_at ${int} not null);
      create table if not exists clipper_tokens(id text primary key, user_id text not null, name text not null, token_hash text unique not null, created_at ${int} not null, last_used_at ${int} not null)
    `)
    // Columns added after the first release. Each statement fails harmlessly when the column exists.
    for (const stmt of [
      'alter table documents add column space_id text',
      'alter table documents add column folder_id text',
      'alter table ai_runs add column chat_id text',
      'create index if not exists runs_chat on ai_runs(chat_id, created_at)',
      // Asset bytes moved to the filesystem (storage 'fs'). Legacy rows keep storage null and their bytes in `data`.
      `alter table assets add column size ${int}`,
      'alter table assets add column name text',
      'alter table assets add column storage text',
      'alter table assets add column sha256 text',
      // Trash (soft delete) and the plain text kept for search.
      `alter table documents add column deleted_at ${int}`,
      'alter table documents add column text_content text',
      `alter table documents add column search_text_version ${int} not null default 0`,
    ]) {
      await this.sql.exec(stmt).catch(() => {})
    }
    // After the column above exists, so the index can be built on it. Repeats are harmless.
    await this.sql.exec('create index if not exists assets_sha256 on assets(sha256)').catch(() => {})
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

  // --- the local user
  async ensureLocalUser(): Promise<User> {
    const u = await this.one<User>('select id, email from users where id = ?', ['local'])
    if (u) return u
    await this.sql.run('insert into users(id, email, created_at) values (?, ?, ?)', ['local', 'local@device', this.now()])
    return { id: 'local', email: 'local@device' }
  }

  // --- documents
  private static DOC = 'id, user_id, space_id, folder_id, title, created_at, updated_at'
  /** The user's documents that are not in the trash. */
  listDocs(userId: string): Promise<DocRow[]> {
    return this.sql.all<DocRow>(`select ${Store.DOC} from documents where user_id = ? and deleted_at is null order by updated_at desc`, [userId])
  }
  /** A live (not trashed) document. */
  getDoc(id: string): Promise<DocRow | null> {
    return this.one<DocRow>(`select ${Store.DOC} from documents where id = ? and deleted_at is null`, [id])
  }
  /** A document whether or not it is in the trash. For restore, purge and the collector. */
  getDocAny(id: string): Promise<(DocRow & { deleted_at: number | null }) | null> {
    return this.one(`select ${Store.DOC}, deleted_at from documents where id = ?`, [id])
  }
  /** Moves a document to the trash. Its content, versions and assets stay until it is purged. */
  async trashDoc(id: string): Promise<void> {
    await this.sql.run('update documents set deleted_at = ? where id = ?', [this.now(), id])
  }
  /** Takes a document out of the trash. A folder that no longer exists is dropped. */
  async restoreDoc(id: string): Promise<void> {
    await this.sql.run('update documents set deleted_at = null, updated_at = ? where id = ?', [this.now(), id])
    await this.sql.run('update documents set folder_id = null where id = ? and folder_id is not null and folder_id not in (select id from folders)', [id])
  }
  /** The user's trash: their deleted documents, newest deletion first. */
  listTrash(userId: string): Promise<TrashedDocRow[]> {
    return this.sql.all<TrashedDocRow>(`select ${Store.DOC}, deleted_at from documents where user_id = ? and deleted_at is not null order by deleted_at desc`, [userId])
  }
  /** Ids of documents trashed before `cutoff` (ms): the auto-purge candidates. */
  async trashedBefore(cutoff: number): Promise<string[]> {
    return (await this.sql.all<{ id: string }>('select id from documents where deleted_at is not null and deleted_at < ?', [cutoff])).map((r) => r.id)
  }

  // --- search and plain text
  /** The documents a user may read: their own. */
  private static SCOPE = 'user_id = ?'
  private static NEEDS_TEXT = '(text_content is null or search_text_version <> ?)'
  /** Stores the plain text of a document, as saved by the collaboration service. */
  setDocText(id: string, text: string): Promise<void> {
    return this.sql.run('update documents set text_content = ?, search_text_version = ? where id = ?', [text, SEARCH_TEXT_VERSION, id])
  }
  /** Fills missing or outdated plain text without replacing a value already written by the current extractor. */
  fillDocText(id: string, text: string): Promise<void> {
    return this.sql.run(
      `update documents set text_content = ?, search_text_version = ? where id = ? and ${Store.NEEDS_TEXT}`,
      [text, SEARCH_TEXT_VERSION, id, SEARCH_TEXT_VERSION],
    )
  }
  /** Live documents the user can read with missing or outdated search text. */
  async docsNeedingText(userId: string): Promise<string[]> {
    return (await this.sql.all<{ id: string }>(
      `select id from documents where ${Store.NEEDS_TEXT} and deleted_at is null and ${Store.SCOPE}`,
      [SEARCH_TEXT_VERSION, userId],
    )).map((r) => r.id)
  }
  /**
   * Live documents the user can read whose title or text contains `q` (case-insensitive substring).
   * Title matches first, then most recently updated. At most 30.
   */
  async searchDocs(userId: string, q: string): Promise<SearchHit[]> {
    const query = foldSearchText(q)
    if (!query) return []
    const rows = await this.sql.all<DocRow & { text_content: string | null; title_match: number }>(
      `select * from (
        select ${Store.DOC}, text_content, instr(search_fold(title), ?) > 0 as title_match
        from documents where deleted_at is null and ${Store.SCOPE}
      ) where title_match or instr(search_fold(text_content), ?) > 0
      order by title_match desc, updated_at desc limit 30`,
      [query, userId, query],
    )
    return rows.map((row) => ({
      id: row.id, title: row.title, space_id: row.space_id, folder_id: row.folder_id, updated_at: row.updated_at,
      titleMatch: Boolean(row.title_match),
      titleMatches: row.title_match ? displayMatches(row.title, query) : [],
      ...searchSnippet(row.text_content ?? '', query),
    }))
  }

  async createDoc(userId: string, title: string, state: Bytes): Promise<DocRow> {
    const id = randomUUID()
    const now = this.now()
    await this.sql.run('insert into documents(id, user_id, title, state, created_at, updated_at) values (?, ?, ?, ?, ?, ?)', [id, userId, title, state, now, now])
    return { id, user_id: userId, space_id: null, folder_id: null, title, created_at: now, updated_at: now }
  }
  renameDoc(id: string, title: string): Promise<void> {
    return this.sql.run('update documents set title = ?, updated_at = ? where id = ?', [title, this.now(), id])
  }
  /**
   * Deletes the document. Its asset rows stay: whether a file is still in use is decided by the garbage
   * collector (gc.ts), which needs to see every document. Returns the ids of its filesystem assets so the
   * caller can run a targeted collection.
   */
  async deleteDoc(id: string): Promise<string[]> {
    const assetIds = await this.listAssetIds(id)
    await this.sql.run('delete from ai_events where run_id in (select id from ai_runs where document_id = ?)', [id])
    for (const t of ['ai_runs', 'ai_chats', 'versions', 'doc_updates']) await this.sql.run(`delete from ${t} where document_id = ?`, [id])
    await this.sql.run('delete from documents where id = ?', [id])
    return assetIds
  }

  // --- folders
  private static FOLDER = 'id, user_id, space_id, name, created_at'
  async createFolder(userId: string, name: string): Promise<FolderRow> {
    const id = randomUUID()
    const now = this.now()
    await this.sql.run('insert into folders(id, user_id, name, created_at) values (?, ?, ?, ?)', [id, userId, name, now])
    return { id, user_id: userId, space_id: null, name, created_at: now }
  }
  getFolder(id: string): Promise<FolderRow | null> {
    return this.one<FolderRow>(`select ${Store.FOLDER} from folders where id = ?`, [id])
  }
  listFolders(userId: string): Promise<FolderRow[]> {
    return this.sql.all<FolderRow>(`select ${Store.FOLDER} from folders where user_id = ? order by created_at`, [userId])
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
    return this.sql.all<DocRow>(`select ${Store.DOC} from documents where folder_id = ? and deleted_at is null order by created_at, id`, [folderId])
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
  async addVersion(v: { documentId: string; state: Bytes; content: unknown; label?: string | null; trigger: string; author: string; wordCount: number; createdAt?: number }): Promise<string> {
    const id = randomUUID()
    await this.sql.run('insert into versions(id, document_id, state, content_json, label, trigger, author, word_count, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, v.documentId, v.state, JSON.stringify(v.content), v.label ?? null, v.trigger, v.author, v.wordCount, v.createdAt ?? this.now()])
    return id
  }
  /** The CRDT state saved with a version (null for versions without one). */
  async getVersionState(id: string): Promise<Bytes | null> {
    const r = await this.one<{ state: Bytes | null }>('select state from versions where id = ?', [id])
    return r?.state ? new Uint8Array(r.state) : null
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
    const rows = await this.sql.all<{ id: string; label: string | null; created_at: number }>("select id, label, created_at from versions where document_id = ? and trigger = 'auto' order by created_at desc", [documentId])
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
  /** Tokens the user has used today (UTC day), for the usage page. */
  async tokensToday(userId: string): Promise<number> {
    const day = new Date().toISOString().slice(0, 10)
    const rows = await this.sql.all<{ input_tokens: number; output_tokens: number }>('select input_tokens, output_tokens from usage_ledger where user_id = ? and day = ?', [userId, day])
    return rows.reduce((n, r) => n + r.input_tokens + r.output_tokens, 0)
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
  /** Metadata of an asset. `storage` is 'fs' for files on disk, 'db' for legacy rows whose bytes are in the table. */
  async getAssetMeta(id: string): Promise<{ id: string; document_id: string; mime: string; size: number; name: string | null; storage: 'fs' | 'db' } | null> {
    const r = await this.one<{ id: string; document_id: string; mime: string; size: unknown; name: string | null; storage: string | null }>(
      "select id, document_id, mime, coalesce(size, length(data)) as size, name, storage from assets where id = ?",
      [id],
    )
    if (!r) return null
    return { id: r.id, document_id: r.document_id, mime: r.mime, size: Number(r.size), name: r.name, storage: r.storage === 'fs' ? 'fs' : 'db' }
  }
  /** Bytes of a legacy asset whose data lives in the table. Null for filesystem assets and unknown ids. */
  async getAssetData(id: string): Promise<Bytes | null> {
    const r = await this.one<{ data: Bytes }>("select data from assets where id = ? and coalesce(storage, 'db') = 'db'", [id])
    return r ? new Uint8Array(r.data) : null
  }
  /** Ids of the filesystem assets of a document. */
  async listAssetIds(documentId: string): Promise<string[]> {
    return (await this.sql.all<{ id: string }>("select id from assets where document_id = ? and storage = 'fs'", [documentId])).map((r) => r.id)
  }
  /** Records an asset whose bytes were already written to disk under `id`. `sha256` enables per-user dedup. */
  async addAssetRecord(documentId: string, a: { id: string; mime: string; size: number; name: string | null; sha256?: string | null }): Promise<void> {
    await this.sql.run(
      "insert into assets(id, document_id, mime, data, created_at, size, name, storage, sha256) values (?, ?, ?, ?, ?, ?, ?, 'fs', ?)",
      [a.id, documentId, a.mime, new Uint8Array(0), this.now(), a.size, a.name, a.sha256 ?? null],
    )
  }
  /** A filesystem asset of one user's documents with these bytes, if any. The caller checks the file still exists. */
  async findAssetByHash(userId: string, sha256: string): Promise<{ id: string } | null> {
    return this.one<{ id: string }>(
      "select a.id from assets a join documents d on d.id = a.document_id where d.user_id = ? and a.sha256 = ? and a.storage = 'fs' limit 1",
      [userId, sha256],
    )
  }
  /** Marks an asset as recently used, so the collector's grace period starts again. */
  touchAsset(id: string): Promise<void> {
    return this.sql.run('update assets set created_at = ? where id = ?', [this.now(), id])
  }
  /** Assets created before `before` (ms): the collector's candidates. `storage` is 'db' for legacy rows. */
  listAssetCandidates(before: number): Promise<{ id: string; storage: string }[]> {
    return this.sql.all<{ id: string; storage: string }>("select id, coalesce(storage, 'db') as storage from assets where created_at < ?", [before])
  }
  /** The given assets, by id (missing ids are skipped). */
  /** These assets, optionally only those created (or last reused) before `before` (ms). */
  assetsByIds(ids: string[], before?: number): Promise<{ id: string; storage: string }[]> {
    if (ids.length === 0) return Promise.resolve([])
    const age = before === undefined ? '' : ' and created_at < ?'
    return this.sql.all<{ id: string; storage: string }>(
      `select id, coalesce(storage, 'db') as storage from assets where id in (${ids.map(() => '?').join(', ')})${age}`,
      before === undefined ? ids : [...ids, before],
    )
  }
  deleteAssetRow(id: string): Promise<void> {
    return this.sql.run('delete from assets where id = ?', [id])
  }
  /**
   * Every byte blob that can name an asset, one document at a time: its snapshot, its pending updates and its
   * versions (the saved state and the content JSON). Pages through document ids so memory stays bounded.
   */
  async *documentBytes(): AsyncGenerator<Uint8Array[]> {
    let after = ''
    for (;;) {
      const page = await this.sql.all<{ id: string }>('select id from documents where id > ? order by id limit 50', [after])
      if (page.length === 0) return
      for (const { id } of page) {
        after = id
        yield await this.docBytes(id)
      }
    }
  }
  /** The byte blobs of one document (see documentBytes). */
  async docBytes(id: string): Promise<Uint8Array[]> {
    const enc = new TextEncoder()
    const parts: Uint8Array[] = []
    const row = await this.one<{ state: Bytes | null }>('select state from documents where id = ?', [id])
    if (row?.state) parts.push(new Uint8Array(row.state))
    for (const u of await this.sql.all<{ data: Bytes }>('select data from doc_updates where document_id = ?', [id])) parts.push(new Uint8Array(u.data))
    for (const v of await this.sql.all<{ state: Bytes | null; content_json: string }>('select state, content_json from versions where document_id = ?', [id])) {
      if (v.state) parts.push(new Uint8Array(v.state))
      parts.push(enc.encode(v.content_json))
    }
    return parts
  }

  // --- settings
  async getSetting(userId: string, key: string): Promise<string | null> {
    return (await this.one<{ value: string }>('select value from settings where user_id = ? and key = ?', [userId, key]))?.value ?? null
  }
  setSetting(userId: string, key: string, value: string): Promise<void> {
    return this.sql.run('insert into settings(user_id, key, value) values (?, ?, ?) on conflict(user_id, key) do update set value = excluded.value', [userId, key, value])
  }

  // --- browser clipper tokens
  private static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }
  async createClipperToken(userId: string, name: string): Promise<{ id: string; token: string; name: string; created_at: number }> {
    const id = randomUUID()
    const token = 'clp_' + randomBytes(24).toString('base64url')
    const clean = name.trim().slice(0, 60) || '浏览器插件'
    const now = this.now()
    await this.sql.run(
      'insert into clipper_tokens(id, user_id, name, token_hash, created_at, last_used_at) values (?, ?, ?, ?, ?, ?)',
      [id, userId, clean, Store.hashToken(token), now, now],
    )
    return { id, token, name: clean, created_at: now }
  }
  async userByClipperToken(token: string): Promise<User | null> {
    if (!token.startsWith('clp_')) return null
    const row = await this.one<{ id: string; email: string; token_id: string }>(
      'select u.id, u.email, t.id as token_id from clipper_tokens t join users u on u.id = t.user_id where t.token_hash = ?',
      [Store.hashToken(token)],
    )
    if (!row) return null
    await this.sql.run('update clipper_tokens set last_used_at = ? where id = ?', [this.now(), row.token_id])
    return { id: row.id, email: row.email }
  }
  listClipperTokens(userId: string): Promise<ClipperTokenRow[]> {
    return this.sql.all<ClipperTokenRow>(
      'select id, user_id, name, created_at, last_used_at from clipper_tokens where user_id = ? order by created_at desc',
      [userId],
    )
  }
  deleteClipperToken(userId: string, id: string): Promise<void> {
    return this.sql.run('delete from clipper_tokens where id = ? and user_id = ?', [id, userId])
  }
}
