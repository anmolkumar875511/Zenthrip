// Exercises the real IPC handlers with a fake Electron, so the wiring between
// validation, the database and the keeper is tested without opening a window.
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpDir } from './helpers.js'

const handlers = new Map()
const dialogState = { next: null }
vi.mock('electron', () => ({
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  dialog: { showOpenDialog: async () => ({ canceled: dialogState.next === null, filePaths: dialogState.next ? [dialogState.next] : [] }) }
}))

const { registerIpc } = await import('../src/main/ipc.js')
const { createKeeper } = await import('../src/main/keeper.js')
const { openDb } = await import('../src/db/db.js')

const sender = {}
const win = { webContents: sender }
const call = (channel, payload, from = sender) => handlers.get(channel)({ sender: from }, payload)

const goodRule = (over = {}) => ({
  name: 'PDFs',
  enabled: true,
  trigger: { type: 'arrival' },
  condition: { op: 'AND', children: [{ field: 'ext', operator: 'is', value: 'pdf' }] },
  actions: [{ type: 'move', to: path.join(tmpDir(), 'PDFs') }],
  folderIds: [],
  ...over
})

let db
beforeEach(() => {
  handlers.clear()
  db = openDb()
  const keeper = createKeeper({
    db,
    emit: () => {},
    watcherOptions: { stabilityThreshold: 100, pollInterval: 30 },
    denylist: { platform: process.platform, inside: [], equal: [] }
  })
  registerIpc({ db, keeper, getWindow: () => win, appInfo: () => ({ platform: 'test', version: '0.0.0' }) })
})

describe('IPC handlers', () => {
  it('ignores calls from any window other than ours', async () => {
    expect(await call('rules:list', undefined, {})).toEqual({ ok: false, error: 'Untrusted sender.' })
  })

  it('app:info reports the folder limit', async () => {
    expect(await call('app:info')).toMatchObject({ ok: true, maxFolders: 3, version: '0.0.0' })
  })

  it('saves, lists, updates, reorders and deletes rules', async () => {
    const a = (await call('rules:save', goodRule({ name: 'A' }))).rule
    const b = (await call('rules:save', goodRule({ name: 'B' }))).rule
    expect((await call('rules:list')).rules.map((r) => r.name)).toEqual(['A', 'B'])

    const edited = await call('rules:save', { ...a, name: 'A edited' })
    expect(edited.rule).toMatchObject({ id: a.id, name: 'A edited' })

    const re = await call('rules:reorder', [b.id, a.id])
    expect(re.rules.map((r) => r.name)).toEqual(['B', 'A edited'])
    expect((await call('rules:reorder', [a.id])).ok).toBe(false)
    expect((await call('rules:reorder', 'nope')).ok).toBe(false)

    expect(await call('rules:delete', a.id)).toEqual({ ok: true })
    expect((await call('rules:list')).rules).toHaveLength(1)
    expect((await call('rules:delete', -1)).ok).toBe(false)
  })

  it('returns friendly, path-tagged errors for invalid rules and saves nothing', async () => {
    const res = await call('rules:save', goodRule({ name: '', actions: [{ type: 'rename', template: 'a/b' }] }))
    expect(res.ok).toBe(false)
    expect(res.errors.map((e) => e.path).sort()).toEqual(['actions.0.template', 'name'])
    expect((await call('rules:list')).rules).toHaveLength(0)
  })

  it('refuses to move or copy into a protected or relative destination', async () => {
    const protectedDir = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc/zenthrip'
    const res = await call('rules:save', goodRule({ actions: [{ type: 'move', to: protectedDir }] }))
    expect(res.ok).toBe(false)
    expect(res.errors[0].path).toBe('actions.0.to')
    expect((await call('rules:save', goodRule({ actions: [{ type: 'copy', to: 'relative' }] }))).ok).toBe(false)
  })

  it('adds a folder through the dialog, lists it, and removes it', async () => {
    const dir = tmpDir()
    dialogState.next = dir
    const added = await call('folders:pick')
    expect(added).toMatchObject({ ok: true, folder: { path: dir, exists: true } })
    expect((await call('folders:list')).folders).toHaveLength(1)

    dialogState.next = null // user cancels
    expect(await call('folders:pick')).toEqual({ ok: true, canceled: true })

    expect(await call('folders:remove', added.folder.id)).toEqual({ ok: true })
    expect((await call('folders:list')).folders).toHaveLength(0)
    expect((await call('folders:remove', 'x')).ok).toBe(false)
  })

  it('dialog:pickDirectory returns the chosen path (or null)', async () => {
    dialogState.next = '/some/dir'
    expect(await call('dialog:pickDirectory')).toEqual({ ok: true, path: '/some/dir' })
    dialogState.next = null
    expect(await call('dialog:pickDirectory')).toEqual({ ok: true, path: null })
  })
})
