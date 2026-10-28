// The Phase 4-6 IPC handlers, driven through a fake Electron.
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpDir, write } from './helpers.js'

const handlers = new Map()
const ui = { picked: null, confirm: true, boxes: [] }
vi.mock('electron', () => ({
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  dialog: {
    showOpenDialog: async () => ({ canceled: ui.picked === null, filePaths: ui.picked ? [ui.picked] : [] }),
    showMessageBox: async (_win, opts) => (ui.boxes.push(opts), { response: ui.confirm ? 1 : 0 })
  }
}))

const { registerIpc } = await import('../src/main/ipc.js')
const { createKeeper } = await import('../src/main/keeper.js')
const { openDb } = await import('../src/db/db.js')

const sender = {}
const win = { webContents: sender }
const call = (channel, payload) => handlers.get(channel)({ sender }, payload)
const open = { platform: process.platform, inside: [], equal: [] }

let db, keeper, changes
beforeEach(() => {
  handlers.clear()
  ui.picked = null
  ui.confirm = true
  ui.boxes = []
  changes = []
  db = openDb()
  keeper = createKeeper({ db, emit: () => {}, trashRoot: path.join(tmpDir(), 'trash'), watcherOptions: { stabilityThreshold: 100, pollInterval: 30 }, denylist: open })
  registerIpc({ db, keeper, getWindow: () => win, appInfo: () => ({ platform: 'test', version: '0' }), onSettingsChanged: (s) => changes.push(s) })
})
afterEach(() => keeper.stop())

const rule = (over = {}) => ({
  name: 'PDFs',
  enabled: true,
  trigger: { type: 'arrival' },
  condition: { op: 'AND', children: [{ field: 'ext', operator: 'is', value: 'pdf' }] },
  actions: [{ type: 'move', to: path.join(tmpDir(), 'PDFs') }],
  folderIds: [],
  ...over
})

describe('preview, run, ledger and undo over IPC', () => {
  it('previews, runs exactly that plan, lists the ledger, undoes an entry and a sweep', async () => {
    const dir = tmpDir()
    await keeper.addFolder(dir)
    await call('rules:save', rule())
    write(dir, 'a.pdf')
    write(dir, 'b.pdf')

    const pv = await call('preview:run', {})
    expect(pv.ok).toBe(true)
    expect(pv.summary.planned).toBe(2)
    expect(fs.readdirSync(dir).sort()).toEqual(['a.pdf', 'b.pdf']) // untouched

    const run = await call('sweep:run', pv.previewId)
    expect(run).toMatchObject({ ok: true, done: 2 })
    expect(fs.readdirSync(dir)).toEqual([])

    const list = await call('ledger:list', { status: 'done' })
    expect(list.total).toBe(2)
    const sweeps = await call('ledger:sweeps')
    expect(sweeps.sweeps[0]).toMatchObject({ sweepId: run.sweepId, done: 2, undoable: 2 })

    expect((await call('ledger:undo', list.rows[0].id)).ok).toBe(true)
    expect(fs.readdirSync(dir)).toHaveLength(1)
    expect((await call('ledger:undoSweep', run.sweepId)).undone).toBe(1)
    expect(fs.readdirSync(dir).sort()).toEqual(['a.pdf', 'b.pdf'])
    expect((await call('ledger:undo', list.rows[0].id)).ok).toBe(false) // no double undo
  })

  it('validates its inputs', async () => {
    expect((await call('preview:run', { folderId: 'x' })).ok).toBe(false)
    expect((await call('sweep:run', 5)).ok).toBe(false)
    expect((await call('ledger:undo', -3)).ok).toBe(false)
    expect((await call('ledger:undoSweep', '')).ok).toBe(false)
    expect((await call('ledger:list', { limit: 99999 })).ok).toBe(false)
    expect((await call('ledger:list', { status: 'weird' })).ok).toBe(false)
    expect((await call('sweep:run', 'p-unknown')).ok).toBe(false)
  })
})

describe('pause, settings and trash over IPC', () => {
  it('pauses and resumes', async () => {
    expect((await call('watch:pause')).paused).toBe(true)
    expect((await call('watch:status')).paused).toBe(true)
    expect((await call('watch:resume')).paused).toBe(false)
  })

  it('reads, validates and saves settings, and tells the app (login item, loop limit)', async () => {
    expect((await call('settings:get')).settings.hopLimit).toBe(3)
    const bad = await call('settings:set', { hopLimit: 0 })
    expect(bad.ok).toBe(false)
    const good = await call('settings:set', { hopLimit: 6, startAtLogin: true })
    expect(good.settings).toMatchObject({ hopLimit: 6, startAtLogin: true })
    expect(keeper.loopGuard.hopLimit).toBe(6)
    expect(changes).toHaveLength(1)
  })

  it('empties the trash only after a NATIVE confirmation', async () => {
    const dir = tmpDir()
    await keeper.addFolder(dir)
    await call('rules:save', rule({ condition: { op: 'AND', children: [{ field: 'ext', operator: 'is', value: 'log' }] }, actions: [{ type: 'trash' }] }))
    write(dir, 'a.log')
    await call('sweep:run', (await call('preview:run', {})).previewId)
    expect((await call('trash:info')).files).toBe(1)

    ui.confirm = false
    expect(await call('trash:empty')).toEqual({ ok: true, emptied: false })
    expect((await call('trash:info')).files).toBe(1)
    ui.confirm = true
    expect(await call('trash:empty')).toEqual({ ok: true, emptied: true })
    expect((await call('trash:info')).files).toBe(0)
    expect(ui.boxes).toHaveLength(2)
  })
})

describe('A2: loop protection when saving rules', () => {
  it('rejects the second rule of an A -> B -> A pair, unless the user insists', async () => {
    const A = tmpDir()
    const B = tmpDir()
    const a = (await keeper.addFolder(A)).folder
    const b = (await keeper.addFolder(B)).folder
    expect((await call('rules:save', rule({ name: 'A to B', actions: [{ type: 'move', to: B }], folderIds: [a.id] }))).ok).toBe(true)

    const second = rule({ name: 'B to A', actions: [{ type: 'move', to: A }], folderIds: [b.id] })
    const refused = await call('rules:save', second)
    expect(refused).toMatchObject({ ok: false, code: 'loop' })
    expect(refused.loops[0].rules.sort()).toEqual(['A to B', 'B to A'])
    expect((await call('rules:list')).rules).toHaveLength(1)

    const forced = await call('rules:save', { ...second, allowLoop: true })
    expect(forced.ok).toBe(true)
    expect(forced.loops).toHaveLength(1)
  })
})

describe('A1: scripts must be trusted through a native dialog', () => {
  const script = () => write(tmpDir(), 'hook.js', 'process.exit(0)')

  it('a rule using an untrusted script is refused with code untrusted_script', async () => {
    const s = script()
    const res = await call('rules:save', rule({ actions: [{ type: 'script', path: s }] }))
    expect(res).toMatchObject({ ok: false, code: 'untrusted_script', scripts: [s] })
  })

  it('trusting shows a native warning; declining trusts nothing; accepting lets the rule save', async () => {
    const s = script()
    ui.confirm = false
    expect(await call('scripts:trust', s)).toEqual({ ok: true, trusted: false })
    expect((await call('rules:save', rule({ actions: [{ type: 'script', path: s }] }))).ok).toBe(false)

    ui.confirm = true
    expect(await call('scripts:trust', s)).toEqual({ ok: true, trusted: true })
    expect(ui.boxes.at(-1).detail).toContain(s)
    expect((await call('rules:save', rule({ actions: [{ type: 'script', path: s }] }))).ok).toBe(true)
    expect((await call('scripts:list')).scripts).toEqual([{ path: s, state: 'trusted' }])
  })

  it('editing a trusted script revokes its trust; a missing script is a field error; revoke works', async () => {
    const s = script()
    await call('scripts:trust', s)
    fs.appendFileSync(s, '\n// changed')
    expect((await call('scripts:list')).scripts[0].state).toBe('changed')
    expect((await call('rules:save', rule({ actions: [{ type: 'script', path: s }] }))).code).toBe('untrusted_script')

    const missing = await call('rules:save', rule({ actions: [{ type: 'script', path: path.join(tmpDir(), 'nope.js') }] }))
    expect(missing.errors[0].path).toBe('actions.0.path')

    await call('scripts:revoke', s)
    expect((await call('scripts:list')).scripts).toEqual([])
    expect((await call('scripts:trust', 'relative.js')).ok).toBe(false)
  })

  it('an end-to-end script run: trusted script processes a file and cannot be undone', async () => {
    const dir = tmpDir()
    await keeper.addFolder(dir)
    const marker = path.join(tmpDir(), 'seen.txt')
    const s = write(tmpDir(), 'hook.js', `require('fs').writeFileSync(${JSON.stringify(marker)}, require('path').basename(process.argv[2]))`)
    await call('scripts:trust', s)
    await call('rules:save', rule({ actions: [{ type: 'script', path: s }] }))
    write(dir, 'doc.pdf')
    const run = await call('sweep:run', (await call('preview:run', {})).previewId)
    expect(run.done).toBe(1)
    expect(fs.readFileSync(marker, 'utf8')).toBe('doc.pdf')
    const row = (await call('ledger:list', {})).rows[0]
    expect(row).toMatchObject({ op: 'script', status: 'done' })
    expect((await call('ledger:undo', row.id)).error).toMatch(/cannot be undone/)
  })
})

describe('schedule triggers over IPC', () => {
  it('saves a scheduled rule and rejects a bad one with readable errors', async () => {
    const ok = await call('rules:save', rule({ trigger: { type: 'schedule', kind: 'daily', time: '9:05' } }))
    expect(ok.rule.trigger).toEqual({ type: 'schedule', kind: 'daily', time: '09:05' })
    const bad = await call('rules:save', rule({ trigger: { type: 'schedule', kind: 'weekly', days: [], time: '99:00' } }))
    expect(bad.errors.map((e) => e.path).sort()).toEqual(['trigger.days', 'trigger.time'])
  })
})
