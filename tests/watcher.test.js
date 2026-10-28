import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { FolderWatcher } from '../src/main/watcher.js'
import { createKeeper } from '../src/main/keeper.js'
import { openDb } from '../src/db/db.js'
import * as rulesDb from '../src/db/rules.js'
import { tmpDir, waitFor, sleep } from './helpers.js'

const FAST = { stabilityThreshold: 120, pollInterval: 30 }
const cleanups = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()()
})

describe('FolderWatcher (real file system)', () => {
  it('reports new files directly inside the folder, but not temp files or subfolder contents', async () => {
    const dir = tmpDir()
    const got = []
    const w = new FolderWatcher({ onFile: (e) => got.push(path.basename(e.path)), ...FAST })
    cleanups.push(() => w.closeAll())
    await w.add(1, dir)

    fs.writeFileSync(path.join(dir, 'hello.txt'), 'hi')
    fs.writeFileSync(path.join(dir, 'big.crdownload'), 'x')
    fs.writeFileSync(path.join(dir, 'movie.part'), 'x')
    fs.writeFileSync(path.join(dir, 'scratch.tmp'), 'x')
    fs.mkdirSync(path.join(dir, 'sub'))
    fs.writeFileSync(path.join(dir, 'sub', 'deep.txt'), 'x')

    await waitFor(() => got.includes('hello.txt'))
    await sleep(600) // give any wrongly-reported file time to show up
    expect(got).toEqual(['hello.txt'])
  })

  it('stops reporting after a folder is removed', async () => {
    const dir = tmpDir()
    const got = []
    const w = new FolderWatcher({ onFile: (e) => got.push(path.basename(e.path)), ...FAST })
    cleanups.push(() => w.closeAll())
    await w.add(1, dir)
    await w.remove(1)
    fs.writeFileSync(path.join(dir, 'late.txt'), 'x')
    await sleep(600)
    expect(got).toEqual([])
    expect(w.count).toBe(0)
  })
})

describe('Keeper (watcher + queue + planner + executor + database)', () => {
  it('executes the plan for each new file: moves matches, leaves the rest, ignores temp files', async () => {
    const dir = tmpDir()
    const dest = path.join(tmpDir(), 'Invoices')
    const db = openDb()
    rulesDb.saveRule(db, {
      name: 'Invoices',
      enabled: true,
      trigger: { type: 'arrival' },
      condition: { op: 'AND', children: [{ field: 'name', operator: 'contains', value: 'invoice' }] },
      actions: [{ type: 'move', to: dest }],
      folderIds: []
    })
    const events = []
    const keeper = createKeeper({
      db,
      emit: (channel, payload) => channel === 'activity' && events.push(payload),
      trashRoot: path.join(tmpDir(), 'trash'),
      watcherOptions: FAST,
      denylist: { platform: process.platform, inside: [], equal: [] } // temp dirs may live under a protected path on some OSes
    })
    cleanups.push(() => keeper.stop())

    const added = await keeper.addFolder(dir)
    expect(added.ok).toBe(true)
    expect(keeper.listFolders()).toHaveLength(1)
    expect((await keeper.addFolder(dir)).ok).toBe(false) // already watched

    fs.writeFileSync(path.join(dir, 'Invoice_1.pdf'), 'pdf')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'txt')
    fs.writeFileSync(path.join(dir, 'half.crdownload'), 'x')

    await waitFor(() => events.filter((e) => e.file).length >= 2)
    await sleep(400)
    const byFile = Object.fromEntries(events.filter((e) => e.file).map((e) => [e.file, e]))
    expect(Object.keys(byFile).sort()).toEqual(['Invoice_1.pdf', 'notes.txt'])
    expect(byFile['Invoice_1.pdf']).toMatchObject({ message: 'executed', ruleName: 'Invoices' })
    expect(byFile['Invoice_1.pdf'].results).toEqual([
      { op: 'move', src: path.join(dir, 'Invoice_1.pdf'), dest: path.join(dest, 'Invoice_1.pdf'), status: 'done', error: null }
    ])
    expect(byFile['notes.txt'].message).toBe('no-match')

    // The matching file really moved; the others were left alone.
    expect(fs.existsSync(path.join(dir, 'Invoice_1.pdf'))).toBe(false)
    expect(fs.readFileSync(path.join(dest, 'Invoice_1.pdf'), 'utf8')).toBe('pdf')
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'half.crdownload'))).toBe(true)
    expect(keeper.listLedger({}).rows).toHaveLength(1)
  })

  it('remembers its folders after a restart', async () => {
    const dir = tmpDir()
    const dbFile = path.join(tmpDir(), 'z.db')
    const opts = { watcherOptions: FAST, denylist: { platform: process.platform, inside: [], equal: [] } }

    let db = openDb(dbFile)
    let keeper = createKeeper({ db, emit: () => {}, ...opts })
    await keeper.addFolder(dir)
    await keeper.stop()
    db.close()

    db = openDb(dbFile)
    const events = []
    keeper = createKeeper({ db, emit: (c, p) => c === 'activity' && events.push(p), ...opts })
    cleanups.push(async () => { await keeper.stop(); db.close() })
    await keeper.start()
    fs.writeFileSync(path.join(dir, 'after-restart.txt'), 'x')
    await waitFor(() => events.some((e) => e.file === 'after-restart.txt'))
  })

  it('refuses a protected folder and respects the 3-folder limit', async () => {
    const db = openDb()
    const keeper = createKeeper({ db, emit: () => {}, watcherOptions: FAST })
    cleanups.push(() => keeper.stop())
    expect((await keeper.addFolder(path.parse(process.cwd()).root)).ok).toBe(false)

    const open = { platform: process.platform, inside: [], equal: [] }
    const limited = createKeeper({ db: openDb(), emit: () => {}, watcherOptions: FAST, denylist: open })
    cleanups.push(() => limited.stop())
    for (let i = 0; i < 3; i++) expect((await limited.addFolder(tmpDir())).ok).toBe(true)
    const fourth = await limited.addFolder(tmpDir())
    expect(fourth.ok).toBe(false)
    expect(fourth.error).toMatch(/at most 3/)
  })
})
