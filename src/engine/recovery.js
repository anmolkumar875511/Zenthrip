// Crash recovery, run at every start-up BEFORE any file is processed.
// A "pending" ledger row means the app died somewhere between "journal written" and "marked done".
// We look at the disk and decide what really happened:
//
//   src exists | dest exists | conclusion
//   -----------+-------------+------------------------------------------------------------
//   no         | yes         | the action completed             -> done
//   yes        | no          | the action never happened        -> failed ("interrupted")
//   yes        | yes (copy)  | the action completed             -> done
//   yes        | yes (move)  | cross-drive move cut short: finish it if sizes match, else needs review
//   no         | no          | cannot tell                      -> failed + "needs review"
//   leftover "*.zenthrip-partial" file                          -> deleted
import fs from 'node:fs'
import { PARTIAL_SUFFIX } from './executor.js'
import * as ledger from '../db/ledger.js'
import { integrityCheck } from '../db/db.js'

const exists = (fsx, p) => {
  try {
    fsx.lstatSync(p)
    return true
  } catch {
    return false
  }
}

export function recoverLedger({ db, fsx = fs, log = () => {} }) {
  const report = { integrity: 'ok', pending: 0, completed: 0, interrupted: 0, needsReview: 0, partialsRemoved: 0, undoFinished: 0, undoRolledBack: 0 }
  report.integrity = integrityCheck(db)
  if (report.integrity !== 'ok') log(`Database integrity check reported: ${report.integrity}`)

  const removePartial = (dest) => {
    if (!dest) return
    const partial = dest + PARTIAL_SUFFIX
    if (exists(fsx, partial)) {
      try {
        fsx.unlinkSync(partial)
        report.partialsRemoved++
      } catch (err) {
        log(`Could not remove ${partial}: ${err.message}`)
      }
    }
  }

  for (const row of ledger.pendingRows(db)) {
    report.pending++
    removePartial(row.dest)

    if (row.op === 'script') {
      ledger.markFailed(db, row.id, 'Interrupted by a shutdown. The script may or may not have run.')
      report.needsReview++
      continue
    }
    const srcThere = exists(fsx, row.src)
    const destThere = Boolean(row.dest) && exists(fsx, row.dest)

    if (!srcThere && destThere) {
      ledger.markDone(db, row.id)
      report.completed++
    } else if (srcThere && !destThere) {
      ledger.markFailed(db, row.id, 'Interrupted by a shutdown before anything was changed.')
      report.interrupted++
    } else if (srcThere && destThere) {
      if (row.op === 'copy') {
        ledger.markDone(db, row.id)
        report.completed++
      } else {
        // A cross-drive move: the copy landed but the original was not deleted yet.
        let same = false
        try {
          same = fsx.lstatSync(row.src).size === fsx.lstatSync(row.dest).size
        } catch {
          /* ignore */
        }
        if (same) {
          try {
            fsx.unlinkSync(row.src)
            ledger.markDone(db, row.id)
            report.completed++
            continue
          } catch (err) {
            log(`Could not finish the move of ${row.src}: ${err.message}`)
          }
        }
        ledger.markFailed(db, row.id, 'Needs review: the file exists at both the old and the new location.')
        report.needsReview++
      }
    } else {
      ledger.markFailed(db, row.id, 'Needs review: the file could not be found at the old or the new location.')
      report.needsReview++
    }
  }

  // An undo that was cut short: either it finished (file is back) or it never started.
  for (const row of ledger.undoInProgressRows(db)) {
    const srcThere = exists(fsx, row.src)
    const destThere = Boolean(row.dest) && exists(fsx, row.dest)
    const finished = row.op === 'copy' ? !destThere : srcThere && !destThere
    if (finished) {
      ledger.setUndone(db, row.id, 1)
      report.undoFinished++
    } else {
      ledger.setUndone(db, row.id, 0, 'Undo was interrupted by a shutdown; nothing was changed. Try again.')
      report.undoRolledBack++
    }
  }
  return report
}
