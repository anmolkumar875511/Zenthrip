import Database from 'better-sqlite3'
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js'

/** Open (or create) the database. WAL + synchronous=FULL = durable, crash-safe commits. */
export function openDb(file = ':memory:') {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = FULL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

function migrate(db) {
  const current = db.pragma('user_version', { simple: true })
  if (current >= SCHEMA_VERSION) return
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    db.transaction(() => {
      db.exec(m.sql)
      db.pragma(`user_version = ${m.version}`)
    })()
  }
}

/** PRAGMA integrity_check: returns 'ok' or a list of problems. */
export function integrityCheck(db) {
  const rows = db.pragma('integrity_check')
  const msgs = rows.map((r) => r.integrity_check)
  return msgs.length === 1 && msgs[0] === 'ok' ? 'ok' : msgs.join('; ')
}
