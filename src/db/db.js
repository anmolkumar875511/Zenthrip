import Database from 'better-sqlite3'
import { SCHEMA, SCHEMA_VERSION } from './schema.js'

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
  db.transaction(() => {
    db.exec(SCHEMA)
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
  })()
}
