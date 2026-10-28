// Whole schema, created on first run. Later phases only ADD to it (see user_version).
// (The SQL lives in a JS string so the bundler never has to copy a .sql file around.)
export const V1 = `
CREATE TABLE IF NOT EXISTS folders (
  id        INTEGER PRIMARY KEY,
  path      TEXT    NOT NULL UNIQUE,
  added_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id               INTEGER PRIMARY KEY,
  name             TEXT    NOT NULL,
  rank             INTEGER NOT NULL,               -- lower = earlier = wins
  enabled          INTEGER NOT NULL DEFAULT 1,
  trigger_json     TEXT    NOT NULL,               -- {"type":"arrival"} or {"type":"schedule",...}
  condition_json   TEXT    NOT NULL,               -- condition tree
  actions_json     TEXT    NOT NULL,               -- ordered action list
  folder_ids_json  TEXT    NOT NULL DEFAULT '[]'   -- [] = all watched folders
);

-- Journal-then-act ledger (status: pending | done | failed | skipped | loop_broken):
CREATE TABLE IF NOT EXISTS ledger (
  id        INTEGER PRIMARY KEY,
  sweep_id  TEXT    NOT NULL,
  ts        INTEGER NOT NULL,
  rule_id   INTEGER,
  op        TEXT    NOT NULL,
  src       TEXT    NOT NULL,
  dest      TEXT,
  status    TEXT    NOT NULL,
  error     TEXT,
  undone    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ledger_sweep  ON ledger(sweep_id);
CREATE INDEX IF NOT EXISTS idx_ledger_status ON ledger(status);

CREATE TABLE IF NOT EXISTS fingerprints (
  path     TEXT    NOT NULL,
  size     INTEGER NOT NULL,
  mtime    INTEGER NOT NULL,
  rule_id  INTEGER NOT NULL,
  PRIMARY KEY (path, size, mtime, rule_id)
);
`

// Version 2: undo diagnostics, step details (script output), and a key/value settings table.
//   undone: 0 = not undone, 1 = undone, 2 = undo in progress (lets recovery finish or roll back after a crash)
export const V2 = `
ALTER TABLE ledger ADD COLUMN undo_error TEXT;
ALTER TABLE ledger ADD COLUMN detail TEXT;
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_ts ON ledger(ts);
`

/** Applied in order; each one runs once, inside a transaction, and bumps PRAGMA user_version. */
export const MIGRATIONS = [
  { version: 1, sql: V1 },
  { version: 2, sql: V2 }
]
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version
