import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createKeeper } from '../src/main/keeper.js'
import { openDb } from '../src/db/db.js'
import * as rulesDb from '../src/db/rules.js'
import * as ledger from '../src/db/ledger.js'
import { tmpDir, write, snapshot } from './helpers.js'

const open = { platform: process.platform, inside: [], equal: [] }
const base = { enabled: true, trigger: { type: 'arrival' }, folderIds: [] }
const cleanups = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length) await cleanups.pop()()
})

async function setup(rules = []) {
  const dir = tmpDir()
  const dest = path.join(tmpDir(), 'Sorted')
  const db = openDb()
  const keeper = createKeeper({ db, emit: () => {}, trashRoot: path.join(tmpDir(), 'trash'), watcherOptions: { stabilityThreshold: 100, pollInterval: 30 }, denylist: open })
  cleanups.push(() => keeper.stop())
  await keeper.addFolder(dir)
  for (const r of rules) rulesDb.saveRule(db, { ...base, ...r(dest) })
  return { dir, dest, db, keeper }
}
const pdfRule = (dest) => ({ name: 'PDFs', condition: { op: 'AND', children: [{ field: 'ext', operator: 'is', value: 'pdf' }] }, actions: [{ type: 'rename', template: 'doc_{name}' }, { type: 'move', to: dest }] })
const oldRule = () => ({ name: 'Old logs', condition: { op: 'AND', children: [{ field: 'ext', operator: 'is', value: 'log' }] }, actions: [{ type: 'trash' }] })

describe('B4: dry-run preview', () => {
  it('lists every direct-child file with its rule, steps and destination, and writes NOTHING', async () => {
    const { dir, dest, db, keeper } = await setup([pdfRule, oldRule])
    write(dir, 'a.pdf')
    write(dir, 'b.log')
    write(dir, 'c.txt')
    write(dir, 'half.crdownload')
    write(dir, 'sub/deep.pdf')
    const before = snapshot(dir)
    const mutators = ['renameSync', 'copyFileSync', 'unlinkSync', 'writeFileSync', 'mkdirSync', 'rmSync', 'appendFileSync', 'truncateSync']
    const spies = mutators.map((m) => vi.spyOn(fs, m))
    const promiseSpies = ['rename', 'copyFile', 'unlink', 'writeFile', 'mkdir', 'rm'].map((m) => vi.spyOn(fs.promises, m))
    const ledgerBefore = ledger.listLedger(db, {}).total

    const res = keeper.preview()

    for (const s of [...spies, ...promiseSpies]) expect(s).not.toHaveBeenCalled() // ZERO mutating calls
    expect(snapshot(dir)).toEqual(before)
    expect(fs.existsSync(dest)).toBe(false)
    expect(ledger.listLedger(db, {}).total).toBe(ledgerBefore)

    const byFile = Object.fromEntries(res.rows.map((r) => [r.file, r]))
    expect(Object.keys(byFile).sort()).toEqual(['a.pdf', 'b.log', 'c.txt']) // no temp file, no subfolder content
    expect(byFile['a.pdf']).toMatchObject({ outcome: 'planned', ruleName: 'PDFs' })
    expect(byFile['a.pdf'].steps.map((s) => s.op)).toEqual(['rename', 'move'])
    expect(byFile['a.pdf'].steps[1].dest).toBe(path.join(dest, 'doc_a.pdf'))
    expect(byFile['b.log'].steps[0].op).toBe('trash')
    expect(byFile['c.txt']).toMatchObject({ outcome: 'no-match', ruleName: null })
    expect(res.summary).toMatchObject({ files: 3, planned: 2, noMatch: 1, trash: 1 })
  })

  it('previews two files that would get the same name without a collision', async () => {
    const { dir, keeper } = await setup([(dest) => ({ name: 'Flat', condition: { op: 'AND', children: [{ field: 'ext', operator: 'is', value: 'txt' }] }, actions: [{ type: 'rename', template: 'same' }] })])
    write(dir, 'a.txt')
    write(dir, 'b.txt')
    const dests = keeper.preview().rows.map((r) => path.basename(r.steps[0].dest)).sort()
    expect(dests).toEqual(['same (1).txt', 'same.txt'])
  })

  it('flags names that would be too long (will-fail) before anything runs', async () => {
    const { dir, keeper } = await setup([() => ({ name: 'Double', condition: { op: 'AND', children: [{ field: 'ext', operator: 'is', value: 'txt' }] }, actions: [{ type: 'rename', template: '{name}_{name}' }] })])
    write(dir, 'x'.repeat(200) + '.txt')
    const row = keeper.preview().rows[0]
    expect(row.outcome).toBe('will-fail')
    expect(row.issues[0]).toMatch(/too long/)
  })

  it('"Run" executes exactly the previewed plan', async () => {
    const { dir, dest, db, keeper } = await setup([pdfRule])
    write(dir, 'a.pdf')
    write(dir, 'c.txt')
    const preview = keeper.preview()
    const res = await keeper.runPreview(preview.previewId)
    expect(res).toMatchObject({ ok: true, done: 1, failed: 0 })
    expect(fs.readFileSync(path.join(dest, 'doc_a.pdf'), 'utf8')).toBe('a.pdf')
    expect(fs.existsSync(path.join(dir, 'c.txt'))).toBe(true)
    expect(ledger.listLedger(db, {}).rows.map((r) => r.op).sort()).toEqual(['move', 'rename'])
    // the sweep is undoable as a whole
    await keeper.undoSweep(res.sweepId)
    expect(fs.readdirSync(dir).sort()).toEqual(['a.pdf', 'c.txt'])
  })

  it('a preview can only be run once, and an unknown preview is refused', async () => {
    const { dir, keeper } = await setup([pdfRule])
    write(dir, 'a.pdf')
    const { previewId } = keeper.preview()
    expect((await keeper.runPreview('p-bogus')).ok).toBe(false)
    expect((await keeper.runPreview(previewId)).ok).toBe(true)
    expect((await keeper.runPreview(previewId)).ok).toBe(false)
  })

  it('leaves alone a file that changed after the preview (never guesses)', async () => {
    const { dir, dest, keeper, db } = await setup([pdfRule])
    const p = write(dir, 'a.pdf', 'v1')
    const { previewId } = keeper.preview()
    fs.writeFileSync(p, 'v2 is longer')
    const res = await keeper.runPreview(previewId)
    expect(res).toMatchObject({ ok: true, done: 0, skipped: 1 })
    expect(fs.existsSync(p)).toBe(true)
    expect(fs.existsSync(dest)).toBe(false)
    expect(ledger.listLedger(db, {}).rows[0].error).toMatch(/changed or disappeared/)
  })

  it('a copy rule is not run twice on the same file version', async () => {
    const { dir, dest, keeper } = await setup([(d) => ({ name: 'Backup', condition: { op: 'AND', children: [{ field: 'ext', operator: 'is', value: 'pdf' }] }, actions: [{ type: 'copy', to: d }] })])
    write(dir, 'a.pdf')
    await keeper.runPreview(keeper.preview().previewId)
    const second = keeper.preview()
    expect(second.rows[0].outcome).toBe('already-done')
    await keeper.runPreview(second.previewId)
    expect(fs.readdirSync(dest)).toEqual(['a.pdf']) // still a single copy
  })

  it('can be limited to one folder', async () => {
    const { dir, keeper } = await setup([pdfRule])
    write(dir, 'a.pdf')
    expect(keeper.preview({ folderId: 999 }).rows).toEqual([])
    expect(keeper.preview({ folderId: keeper.listFolders()[0].id }).rows).toHaveLength(1)
  })
})

describe('pause, trash and recovery wiring', () => {
  it('pausing stops automatic processing', async () => {
    const { dir, keeper } = await setup([pdfRule])
    keeper.setPaused(true)
    expect(keeper.status().paused).toBe(true)
    write(dir, 'late.pdf')
    await new Promise((r) => setTimeout(r, 700))
    await keeper.idle()
    expect(fs.existsSync(path.join(dir, 'late.pdf'))).toBe(true)
    keeper.setPaused(false)
    expect(keeper.status().paused).toBe(false)
  })

  it('Keeper Trash: info, empty, and retention purge', async () => {
    const { dir, keeper } = await setup([oldRule])
    write(dir, 'a.log', 'abc')
    write(dir, 'b.log', 'abcd')
    const res = await keeper.runPreview(keeper.preview().previewId)
    expect(res.done).toBe(2)
    expect(keeper.trashInfo()).toMatchObject({ files: 2, bytes: 7 })
    expect(keeper.purgeTrashSync()).toBe(0) // too young to purge
    await keeper.emptyTrash()
    expect(keeper.trashInfo().files).toBe(0)
    // after emptying, undo explains why it cannot restore
    const rows = keeper.listLedger({}).rows
    expect((await keeper.undoEntry(rows[0].id)).error).toMatch(/Keeper Trash/)
  })

  it('start() repairs a crash first and reports it', async () => {
    const { dir, dest, db, keeper } = await setup([])
    const src = write(dir, 'a.txt')
    ledger.insertPending(db, { sweepId: 'a-crash', op: 'move', src, dest: path.join(dest, 'a.txt') })
    const report = await keeper.start()
    expect(report).toMatchObject({ pending: 1, interrupted: 1 })
    expect(ledger.pendingRows(db)).toHaveLength(0)
  })
})
