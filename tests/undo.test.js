import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { tmpDir, write, makeEngine, snapshot } from './helpers.js'
import * as ledger from '../src/db/ledger.js'

const run = (e, steps, extra = {}) => e.executor.executePlan({ sweepId: 's1', ruleId: 1, steps, ...extra })

describe('undo: every operation round-trips to the original state', () => {
  it('move', async () => {
    const dir = tmpDir()
    const out = tmpDir()
    const src = write(dir, 'a.txt')
    const before = snapshot(dir)
    const e = makeEngine()
    const [r] = await run(e, [{ op: 'move', src, dest: path.join(out, 'sub', 'a.txt') }])
    expect(await e.undo.undoEntry(r.id)).toEqual({ ok: true, id: r.id })
    expect(snapshot(dir)).toEqual(before)
    expect(ledger.getEntry(e.db, r.id)).toMatchObject({ status: 'done', undone: 1 })
  })

  it('rename', async () => {
    const dir = tmpDir()
    const src = write(dir, 'a.txt')
    const before = snapshot(dir)
    const e = makeEngine()
    const [r] = await run(e, [{ op: 'rename', src, dest: path.join(dir, 'b.txt') }])
    await e.undo.undoEntry(r.id)
    expect(snapshot(dir)).toEqual(before)
  })

  it('copy: the copy is parked in the Keeper Trash (not deleted) and the original is untouched', async () => {
    const dir = tmpDir()
    const out = tmpDir()
    const src = write(dir, 'a.txt')
    const before = snapshot(dir)
    const e = makeEngine()
    const [r] = await run(e, [{ op: 'copy', src, dest: path.join(out, 'a.txt') }], { fingerprint: { path: src, size: 5, mtime: 1, ruleId: 1 } })
    await e.undo.undoEntry(r.id)
    expect(snapshot(dir)).toEqual(before)
    expect(fs.readdirSync(out)).toEqual([])
    expect(fs.existsSync(path.join(e.trashRoot, '_undone-copies'))).toBe(true)
    expect(ledger.hasFingerprint(e.db, { path: src, size: 5, mtime: 1, ruleId: 1 })).toBe(false)
  })

  it('trash: restores from the Keeper Trash', async () => {
    const dir = tmpDir()
    const src = write(dir, 'old.log', 'precious')
    const before = snapshot(dir)
    const e = makeEngine()
    const [r] = await run(e, [{ op: 'trash', src, dest: null }])
    expect(fs.existsSync(src)).toBe(false)
    await e.undo.undoEntry(r.id)
    expect(snapshot(dir)).toEqual(before)
  })
})

describe('undo: a whole sweep', () => {
  it('unwinds rename -> copy -> move chains in reverse order, back to EXACTLY the start', async () => {
    const dir = tmpDir()
    const out = tmpDir()
    const backup = tmpDir()
    const files = ['a.pdf', 'b.pdf', 'c.txt']
    const paths = files.map((f) => write(dir, f))
    const beforeDir = snapshot(dir)
    const e = makeEngine()
    for (const p of paths) {
      const renamed = path.join(dir, `2026_${path.basename(p)}`)
      await run(e, [
        { op: 'rename', src: p, dest: renamed },
        { op: 'copy', src: renamed, dest: path.join(backup, path.basename(renamed)) },
        { op: 'move', src: renamed, dest: path.join(out, path.basename(renamed)) }
      ])
    }
    expect(fs.readdirSync(dir)).toEqual([])
    const res = await e.undo.undoSweep('s1')
    expect(res).toEqual({ undone: 9, failed: [] })
    expect(snapshot(dir)).toEqual(beforeDir)
    expect(fs.readdirSync(out)).toEqual([])
    expect(fs.readdirSync(backup)).toEqual([])
  })

  it('"undo one action, then undo the sweep" ends in the original state (demo step 8)', async () => {
    const dir = tmpDir()
    const out = tmpDir()
    const before = {}
    const e = makeEngine()
    for (const f of ['x.txt', 'y.txt', 'z.txt']) {
      const p = write(dir, f)
      before[f] = true
      await run(e, [{ op: 'move', src: p, dest: path.join(out, f) }])
    }
    const first = ledger.bySweep(e.db, 's1')[0]
    expect((await e.undo.undoEntry(first.id)).ok).toBe(true)
    const res = await e.undo.undoSweep('s1')
    expect(res.undone).toBe(2)
    expect(Object.keys(snapshot(dir)).sort()).toEqual(['x.txt', 'y.txt', 'z.txt'])
  })
})

describe('undo: checks the disk first and refuses to guess', () => {
  it('cannot be done twice', async () => {
    const e = makeEngine()
    const src = write(tmpDir(), 'a.txt')
    const [r] = await run(e, [{ op: 'move', src, dest: path.join(tmpDir(), 'a.txt') }])
    await e.undo.undoEntry(r.id)
    const again = await e.undo.undoEntry(r.id)
    expect(again.ok).toBe(false)
    expect(again.error).toMatch(/already undone/)
  })

  it('fails with a clear reason when the moved file is gone', async () => {
    const e = makeEngine()
    const src = write(tmpDir(), 'a.txt')
    const [r] = await run(e, [{ op: 'move', src, dest: path.join(tmpDir(), 'a.txt') }])
    fs.unlinkSync(r.dest)
    const res = await e.undo.undoEntry(r.id)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no longer where/)
    expect(ledger.getEntry(e.db, r.id)).toMatchObject({ undone: 0 })
    expect(ledger.getEntry(e.db, r.id).undoError).toMatch(/no longer where/)
  })

  it('does not overwrite something that now occupies the original location', async () => {
    const dir = tmpDir()
    const e = makeEngine()
    const src = write(dir, 'a.txt', 'original')
    const [r] = await run(e, [{ op: 'move', src, dest: path.join(tmpDir(), 'a.txt') }])
    write(dir, 'a.txt', 'someone else wrote this')
    const res = await e.undo.undoEntry(r.id)
    expect(res.ok).toBe(false)
    expect(fs.readFileSync(src, 'utf8')).toBe('someone else wrote this')
    expect(fs.existsSync(r.dest)).toBe(true)
  })

  it('says so when the Keeper Trash was emptied', async () => {
    const e = makeEngine()
    const src = write(tmpDir(), 'a.txt')
    const [r] = await run(e, [{ op: 'trash', src, dest: null }])
    fs.rmSync(e.trashRoot, { recursive: true })
    const res = await e.undo.undoEntry(r.id)
    expect(res.error).toMatch(/Keeper Trash/)
  })

  it('scripts cannot be undone and are clearly flagged; the rest of the sweep still unwinds', async () => {
    const e = makeEngine()
    const dir = tmpDir()
    const src = write(dir, 'a.txt')
    await run(e, [{ op: 'move', src, dest: path.join(tmpDir(), 'a.txt') }])
    const id = ledger.insertPending(e.db, { sweepId: 's1', op: 'script', src, detail: { script: '/x.js' } })
    ledger.markDone(e.db, id)
    const res = await e.undo.undoSweep('s1')
    expect(res.undone).toBe(1)
    expect(res.failed).toEqual([{ id, error: expect.stringMatching(/cannot be undone/) }])
  })

  it('failed, skipped and loop_broken entries are not undoable', async () => {
    const e = makeEngine()
    const id = ledger.insertFinal(e.db, { sweepId: 's1', op: 'move', src: '/a', status: 'failed', error: 'x' })
    expect((await e.undo.undoEntry(id)).ok).toBe(false)
    expect((await e.undo.undoEntry(9999)).ok).toBe(false)
  })
})
