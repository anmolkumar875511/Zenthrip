// Undo = run the inverse of a ledger entry, after checking that the disk still looks the way the ledger says.
// If it does not, nothing is guessed: the entry gets a clear "undo failed" reason and is left alone.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { moveFile } from './executor.js'
import * as ledger from '../db/ledger.js'

const exists = (fsx, p) => {
  try {
    fsx.lstatSync(p)
    return true
  } catch {
    return false
  }
}

export function createUndo({ db, trashRoot, fsx = fs, loopGuard = null, hooks = {} }) {
  const fail = (id, message) => {
    ledger.setUndoError(db, id, message)
    return { ok: false, id, error: message }
  }

  async function undoEntry(id) {
    const e = ledger.getEntry(db, id)
    if (!e) return { ok: false, id, error: 'That ledger entry does not exist.' }
    if (e.undone === 1) return { ok: false, id, error: 'This entry was already undone.' }
    if (e.undone === 2) return { ok: false, id, error: 'An undo of this entry is already in progress.' }
    if (e.status !== 'done') return { ok: false, id, error: 'Only completed actions can be undone.' }
    if (e.op === 'script') return fail(id, 'A script\u2019s effects cannot be undone automatically.')

    // ---- preconditions ----
    if (e.op === 'copy') {
      if (!exists(fsx, e.dest)) return fail(id, 'The copy is no longer there, so there is nothing to remove.')
    } else {
      if (!exists(fsx, e.dest)) {
        return fail(id, e.op === 'trash' ? 'The file is no longer in the Keeper Trash (it was emptied or removed).' : 'The file is no longer where Zenthrip put it.')
      }
      if (exists(fsx, e.src)) return fail(id, 'Something else now exists at the original location, so the file was not moved back.')
    }

    // ---- act (marked "in progress" first, so recovery can finish or roll back after a crash) ----
    ledger.setUndone(db, id, 2)
    hooks.afterUndoMark?.(id)
    try {
      if (e.op === 'copy') {
        // The copy goes to the Keeper Trash rather than being deleted, in case it was edited since.
        const parked = path.join(trashRoot, '_undone-copies', e.sweepId, `${randomUUID().slice(0, 8)}_${path.basename(e.dest)}`)
        await moveFile(fsx, e.dest, parked)
        if (e.ruleId != null) ledger.deleteFingerprints(db, { path: e.src, ruleId: e.ruleId })
      } else {
        await moveFile(fsx, e.dest, e.src)
      }
    } catch (err) {
      ledger.setUndone(db, id, 0, `Undo failed: ${err.message}`)
      return { ok: false, id, error: `Undo failed: ${err.message}` }
    }
    loopGuard?.markSelfCaused(e.src) // the restored file must not be picked up by the rules again
    ledger.setUndone(db, id, 1)
    return { ok: true, id }
  }

  /** Undo everything a sweep did, newest first (so renames-then-moves unwind correctly). */
  async function undoSweep(sweepId) {
    const rows = ledger.bySweep(db, sweepId).filter((r) => r.status === 'done' && r.undone === 0).reverse()
    const out = { undone: 0, failed: [] }
    for (const r of rows) {
      const res = await undoEntry(r.id)
      if (res.ok) out.undone++
      else out.failed.push({ id: r.id, error: res.error })
    }
    return out
  }

  return { undoEntry, undoSweep }
}
