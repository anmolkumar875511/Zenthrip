// Whole schema, created on first run. Later phases only ADD to it (see user_version).
// (The SQL lives in a JS string so the bundler never has to copy a .sql file around.)
export const SCHEMA_VERSION = 1

export const SCHEMA = `
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
  trigger_json     TEXT    NOT NULL,               -- {"type":"arrival"} (schedules arrive in Phase 6)
  condition_json   TEXT    NOT NULL,               -- condition tree
  actions_json     TEXT    NOT NULL,               -- ordered action list
  folder_ids_json  TEXT    NOT NULL DEFAULT '[]'   -- [] = all watched folders
);

-- Used from Phase 5 onward (journal-then-act ledger):
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
