import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Backup for SQLite installs: a consistent copy of the whole database, taken
 * while the server runs, then opened and checked.
 *
 *   tsx scripts/backup.ts [data dir] [backup dir] [--keep 14]
 *
 * To restore, stop the server and copy a backup file over `stetpad.sqlite`.
 * PostgreSQL installs use `pg_dump` / `pg_restore` instead.
 */
const args = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--keep')
const keepAt = process.argv.indexOf('--keep')
const keep = keepAt >= 0 ? Number(process.argv[keepAt + 1]) : 14
const dataDir = resolve(args[0] ?? process.env.AIW_DATA_DIR ?? '.data')
const outDir = resolve(args[1] ?? join(dataDir, 'backups'))
const source = join(dataDir, 'stetpad.sqlite')
if (!existsSync(source)) {
  console.error(`no database at ${source}`)
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const dest = join(outDir, `stetpad-${stamp}.sqlite`)
const db = new Database(source, { readonly: true })
await db.backup(dest)
db.close()

// A backup that cannot be opened is not a backup.
const check = new Database(dest, { readonly: true })
const ok = (check.pragma('integrity_check', { simple: true }) as string) === 'ok'
const docs = (check.prepare('select count(*) as n from documents').get() as { n: number }).n
check.close()
if (!ok) {
  unlinkSync(dest)
  console.error('backup failed its integrity check and was removed')
  process.exit(1)
}
const old = readdirSync(outDir).filter((f) => /^(stetpad|ai-writer)-.*\.sqlite$/.test(f)).sort().reverse().slice(keep)
for (const f of old) unlinkSync(join(outDir, f))
console.log(`backup written: ${dest} (${statSync(dest).size} bytes, ${docs} documents); ${old.length} old backup(s) removed`)
