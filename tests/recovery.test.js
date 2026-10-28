import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { tmpDir, write } from './helpers.js'
import { openDb } from '../src/db/db.js'
import { recoverLedger } from '../src/engine/recovery.js'
import { PARTIAL_SUFFIX } from '../src/engine/executor.js'
import * as ledger from '../src/db/ledger.js'

const child = fileURLToPath(new URL('./fixtures/crashChild.mjs', import.meta.url))
const pending = (db, op, src, dest) => ledger.insertPending(db, { sweepId: 's', ruleId: 1, op, src, dest })

describe('recovery: decides from the disk what a "pending" row really did', () => {
  it('src gone, dest there -> the action completed (done)', () => {
    const db = openDb()
    const dest = write(tmpDir(), 'a.txt')
    const id = pending(db, 'move', path.join(tmpDir(), 'a.txt'), dest)
    const rep = recoverLedger({ db })
    expect(ledger.getEntry(db, id).status).toBe('done')
    expect(rep.completed).toBe(1)
  })

  it('src there, dest missing -> never happened (failed: interrupted)', () => {
    const db = openDb()
    const src = write(tmpDir(), 'a.txt')
    const id = pending(db, 'move', src, path.join(tmpDir(), 'a.txt'))
    recoverLedger({ db })
    expect(ledger.getEntry(db, id)).toMatchObject({ status: 'failed' })
    expect(ledger.getEntry(db, id).error).toMatch(/Interrupted/)
  })

  it('both exist for a copy -> completed', () => {
    const db = openDb()
    const src = write(tmpDir(), 'a.txt')
    const dest = write(tmpDir(), 'a.txt')
    const id = pending(db, 'copy', src, dest)
    recoverLedger({ db })
    expect(ledger.getEntry(db, id).status).toBe('done')
  })

  it('both exist for a move with equal sizes -> finishes the interrupted cross-drive move', () => {
    const db = openDb()
    const src = write(tmpDir(), 'a.txt', 'same')
    const dest = write(tmpDir(), 'a.txt', 'same')
    const id = pending(db, 'move', src, dest)
    recoverLedger({ db })
    expect(ledger.getEntry(db, id).status).toBe('done')
    expect(fs.existsSync(src)).toBe(false)
    expect(fs.existsSync(dest)).toBe(true)
  })

  it('both exist for a move with DIFFERENT sizes -> flagged for review, nothing deleted', () => {
    const db = openDb()
    const src = write(tmpDir(), 'a.txt', 'longer content')
    const dest = write(tmpDir(), 'a.txt', 'x')
    const id = pending(db, 'move', src, dest)
    const rep = recoverLedger({ db })
    expect(ledger.getEntry(db, id).error).toMatch(/Needs review/)
    expect(rep.needsReview).toBe(1)
    expect(fs.existsSync(src) && fs.existsSync(dest)).toBe(true)
  })

  it('neither exists -> failed + needs review', () => {
    const db = openDb()
    const id = pending(db, 'move', path.join(tmpDir(), 'a'), path.join(tmpDir(), 'b'))
    const rep = recoverLedger({ db })
    expect(ledger.getEntry(db, id).error).toMatch(/Needs review/)
    expect(rep.needsReview).toBe(1)
  })

  it('deletes leftover .zenthrip-partial files and treats the action as not done', () => {
    const db = openDb()
    const src = write(tmpDir(), 'a.txt')
    const dest = path.join(tmpDir(), 'a.txt')
    write(path.dirname(dest), 'a.txt' + PARTIAL_SUFFIX, 'half')
    const id = pending(db, 'move', src, dest)
    const rep = recoverLedger({ db })
    expect(rep.partialsRemoved).toBe(1)
    expect(fs.existsSync(dest + PARTIAL_SUFFIX)).toBe(false)
    expect(ledger.getEntry(db, id).status).toBe('failed')
  })

  it('an interrupted script is flagged (it may or may not have run)', () => {
    const db = openDb()
    const id = ledger.insertPending(db, { sweepId: 's', op: 'script', src: '/x', detail: { script: '/s.js' } })
    recoverLedger({ db })
    expect(ledger.getEntry(db, id).error).toMatch(/script may or may not/)
  })

  it('finishes or rolls back an UNDO that was cut short', () => {
    const db = openDb()
    // undo finished: file is back at src, gone from dest
    const back = write(tmpDir(), 'a.txt')
    const a = pending(db, 'move', back, path.join(tmpDir(), 'a.txt'))
    ledger.markDone(db, a)
    ledger.setUndone(db, a, 2)
    // undo never started: file still at dest
    const dest = write(tmpDir(), 'b.txt')
    const b = pending(db, 'move', path.join(tmpDir(), 'b.txt'), dest)
    ledger.markDone(db, b)
    ledger.setUndone(db, b, 2)
    const rep = recoverLedger({ db })
    expect(ledger.getEntry(db, a).undone).toBe(1)
    expect(ledger.getEntry(db, b).undone).toBe(0)
    expect(rep).toMatchObject({ undoFinished: 1, undoRolledBack: 1 })
  })

  it('runs an integrity check and reports ok on a healthy database', () => {
    expect(recoverLedger({ db: openDb() }).integrity).toBe('ok')
  })
})

describe('recovery after a REAL crash (the process is killed with SIGKILL)', () => {
  const crashAt = (point) => {
    const dir = tmpDir()
    const dbFile = path.join(tmpDir(), 'z.db')
    const src = write(dir, 'doc.txt', 'important')
    const dest = path.join(tmpDir(), 'moved', 'doc.txt')
    const res = spawnSync(process.execPath, [child, dbFile, src, dest, point], { encoding: 'utf8' })
    expect(res.signal).toBe('SIGKILL') // it really died mid-operation
    return { dbFile, src, dest }
  }

  it('killed right AFTER the journal row was committed and BEFORE the file moved', () => {
    const { dbFile, src, dest } = crashAt('afterJournal')
    const db = openDb(dbFile)
    const row = ledger.pendingRows(db)[0]
    expect(row).toMatchObject({ status: 'pending', src, dest }) // the intent survived the power cut
    const rep = recoverLedger({ db })
    expect(rep.interrupted).toBe(1)
    expect(ledger.getEntry(db, row.id).status).toBe('failed')
    expect(fs.readFileSync(src, 'utf8')).toBe('important') // the file is untouched
    db.close()
  })

  it('killed right AFTER the file moved and BEFORE the row was marked done', () => {
    const { dbFile, src, dest } = crashAt('afterAct')
    const db = openDb(dbFile)
    expect(ledger.pendingRows(db)).toHaveLength(1)
    const rep = recoverLedger({ db })
    expect(rep.completed).toBe(1)
    expect(ledger.listLedger(db, {}).rows[0].status).toBe('done')
    expect(fs.existsSync(src)).toBe(false)
    expect(fs.readFileSync(dest, 'utf8')).toBe('important')
    // and a recovered "done" move can still be undone
    db.close()
  })
})
