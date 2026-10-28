// The ledger: one row per file operation, written BEFORE the operation happens ("journal first, act second").
import { randomUUID } from 'node:crypto'

const toEntry = (r) => ({
  id: r.id,
  sweepId: r.sweep_id,
  ts: r.ts,
  ruleId: r.rule_id,
  ruleName: r.rule_name ?? null,
  op: r.op,
  src: r.src,
  dest: r.dest,
  status: r.status,
  error: r.error,
  undone: r.undone,
  undoError: r.undo_error,
  detail: r.detail ? JSON.parse(r.detail) : null
})

export function newSweepId(kind = 'm') {
  return `${kind}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
}

export function insertPending(db, { sweepId, ruleId = null, op, src, dest = null, detail = null }) {
  const info = db
    .prepare('INSERT INTO ledger (sweep_id, ts, rule_id, op, src, dest, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sweepId, Date.now(), ruleId, op, src, dest, 'pending', detail ? JSON.stringify(detail) : null)
  return Number(info.lastInsertRowid)
}

/** A row that is already final (nothing was attempted): skipped, failed pre-check, or loop_broken. */
export function insertFinal(db, { sweepId, ruleId = null, op, src, dest = null, status, error = null, detail = null }) {
  const info = db
    .prepare('INSERT INTO ledger (sweep_id, ts, rule_id, op, src, dest, status, error, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sweepId, Date.now(), ruleId, op, src, dest, status, error, detail ? JSON.stringify(detail) : null)
  return Number(info.lastInsertRowid)
}

export function markDone(db, id, detail) {
  if (detail !== undefined) db.prepare("UPDATE ledger SET status = 'done', error = NULL, detail = ? WHERE id = ?").run(JSON.stringify(detail), id)
  else db.prepare("UPDATE ledger SET status = 'done', error = NULL WHERE id = ?").run(id)
}

export function markFailed(db, id, error, detail) {
  if (detail !== undefined) db.prepare("UPDATE ledger SET status = 'failed', error = ?, detail = ? WHERE id = ?").run(error, JSON.stringify(detail), id)
  else db.prepare("UPDATE ledger SET status = 'failed', error = ? WHERE id = ?").run(error, id)
}

export function markSkipped(db, id, error) {
  db.prepare("UPDATE ledger SET status = 'skipped', error = ? WHERE id = ?").run(error, id)
}

export function setUndone(db, id, value, undoError = null) {
  db.prepare('UPDATE ledger SET undone = ?, undo_error = ? WHERE id = ?').run(value, undoError, id)
}

export function setUndoError(db, id, undoError) {
  db.prepare('UPDATE ledger SET undo_error = ? WHERE id = ?').run(undoError, id)
}

const BASE = 'SELECT l.*, r.name AS rule_name FROM ledger l LEFT JOIN rules r ON r.id = l.rule_id'

export function getEntry(db, id) {
  const row = db.prepare(`${BASE} WHERE l.id = ?`).get(id)
  return row ? toEntry(row) : null
}

export function bySweep(db, sweepId) {
  return db.prepare(`${BASE} WHERE l.sweep_id = ? ORDER BY l.id`).all(sweepId).map(toEntry)
}

export function pendingRows(db) {
  return db.prepare(`${BASE} WHERE l.status = 'pending' ORDER BY l.id`).all().map(toEntry)
}

export function undoInProgressRows(db) {
  return db.prepare(`${BASE} WHERE l.undone = 2 ORDER BY l.id`).all().map(toEntry)
}

/** Newest first, with simple filters. */
export function listLedger(db, { limit = 100, offset = 0, status, sweepId, search } = {}) {
  const where = []
  const args = []
  if (status && status !== 'all') {
    if (status === 'undone') where.push('l.undone = 1')
    else {
      where.push('l.status = ?')
      args.push(status)
    }
  }
  if (sweepId) {
    where.push('l.sweep_id = ?')
    args.push(sweepId)
  }
  if (search) {
    where.push("(l.src LIKE ? ESCAPE '\\' OR l.dest LIKE ? ESCAPE '\\' OR r.name LIKE ? ESCAPE '\\')")
    const like = `%${String(search).replace(/[\\%_]/g, (c) => '\\' + c)}%`
    args.push(like, like, like)
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ledger l LEFT JOIN rules r ON r.id = l.rule_id ${w}`).get(...args).n
  const rows = db
    .prepare(`${BASE} ${w} ORDER BY l.id DESC LIMIT ? OFFSET ?`)
    .all(...args, Math.min(Math.max(limit, 1), 500), Math.max(offset, 0))
    .map(toEntry)
  return { rows, total }
}

/** One line per sweep, newest first. */
export function sweepSummaries(db, limit = 50) {
  return db
    .prepare(
      `SELECT sweep_id AS sweepId, MIN(ts) AS ts, COUNT(*) AS total,
              SUM(status = 'done') AS done, SUM(status = 'failed') AS failed,
              SUM(status = 'skipped') AS skipped, SUM(status = 'loop_broken') AS loopBroken,
              SUM(status = 'done' AND undone = 1) AS undone,
              SUM(status = 'done' AND undone = 0 AND op != 'script') AS undoable
         FROM ledger GROUP BY sweep_id ORDER BY MAX(id) DESC LIMIT ?`
    )
    .all(limit)
}

// ----- fingerprints: "this exact file version was already handled by this rule" -----
export function hasFingerprint(db, { path, size, mtime, ruleId }) {
  return Boolean(db.prepare('SELECT 1 FROM fingerprints WHERE path = ? AND size = ? AND mtime = ? AND rule_id = ?').get(path, size, Math.round(mtime), ruleId))
}

export function addFingerprint(db, { path, size, mtime, ruleId }) {
  db.prepare('INSERT OR IGNORE INTO fingerprints (path, size, mtime, rule_id) VALUES (?, ?, ?, ?)').run(path, size, Math.round(mtime), ruleId)
}

export function deleteFingerprints(db, { path, ruleId }) {
  db.prepare('DELETE FROM fingerprints WHERE path = ? AND rule_id = ?').run(path, ruleId)
}
