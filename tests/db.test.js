import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { openDb } from '../src/db/db.js'
import * as foldersDb from '../src/db/folders.js'
import * as rulesDb from '../src/db/rules.js'
import { tmpDir } from './helpers.js'

const sample = (name, extra = {}) => ({
  name,
  enabled: true,
  trigger: { type: 'arrival' },
  condition: { op: 'AND', children: [{ field: 'ext', operator: 'is', value: 'pdf' }] },
  actions: [{ type: 'move', to: '/dest' }],
  folderIds: [],
  ...extra
})

describe('database', () => {
  it('creates the schema and uses WAL with full synchronous on a real file', () => {
    const file = path.join(tmpDir(), 'z.db')
    const db = openDb(file)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('synchronous', { simple: true })).toBe(2) // FULL
    expect(db.pragma('user_version', { simple: true })).toBe(2)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    for (const t of ['folders', 'rules', 'ledger', 'fingerprints', 'settings']) expect(tables).toContain(t)
    db.close()
  })

  it('folders and rules survive closing and reopening (persistence across restart)', () => {
    const file = path.join(tmpDir(), 'z.db')
    let db = openDb(file)
    foldersDb.addFolder(db, '/watch/a')
    rulesDb.saveRule(db, sample('keep me'))
    db.close()
    db = openDb(file)
    expect(foldersDb.listFolders(db).map((f) => f.path)).toEqual(['/watch/a'])
    expect(rulesDb.listRules(db).map((r) => r.name)).toEqual(['keep me'])
    db.close()
  })
})

describe('folders', () => {
  it('enforces the maximum, rejects duplicates, and removes', () => {
    const db = openDb()
    const a = foldersDb.addFolder(db, '/a')
    foldersDb.addFolder(db, '/b')
    foldersDb.addFolder(db, '/c')
    expect(() => foldersDb.addFolder(db, '/d')).toThrow(/at most 3/)
    expect(() => foldersDb.addFolder(db, '/a')).toThrow()
    expect(foldersDb.removeFolder(db, a.id)).toBe(true)
    expect(foldersDb.removeFolder(db, a.id)).toBe(false)
    expect(foldersDb.listFolders(db).map((f) => f.path)).toEqual(['/b', '/c'])
    foldersDb.addFolder(db, '/d') // there is room again
  })
})

describe('rules', () => {
  it('stores JSON faithfully, appends new rules at the end, updates in place', () => {
    const db = openDb()
    const a = rulesDb.saveRule(db, sample('A'))
    const b = rulesDb.saveRule(db, sample('B', { enabled: false, folderIds: [1, 2] }))
    expect([a.rank, b.rank]).toEqual([1, 2])
    expect(b).toMatchObject({ enabled: false, folderIds: [1, 2], condition: sample('x').condition })
    const updated = rulesDb.saveRule(db, { ...a, name: 'A2', actions: [{ type: 'trash' }] })
    expect(updated).toMatchObject({ id: a.id, name: 'A2', rank: 1, actions: [{ type: 'trash' }] })
    expect(rulesDb.listRules(db).map((r) => r.name)).toEqual(['A2', 'B'])
  })
  it('updating a missing rule fails clearly', () => {
    expect(() => rulesDb.saveRule(openDb(), { ...sample('x'), id: 99 })).toThrow(/no longer exists/)
  })
  it('reorders, and refuses an order that does not match the stored rules', () => {
    const db = openDb()
    const [a, b, c] = ['A', 'B', 'C'].map((n) => rulesDb.saveRule(db, sample(n)))
    expect(rulesDb.reorderRules(db, [c.id, a.id, b.id]).map((r) => r.name)).toEqual(['C', 'A', 'B'])
    expect(() => rulesDb.reorderRules(db, [a.id, b.id])).toThrow()
    expect(() => rulesDb.reorderRules(db, [a.id, a.id, b.id])).toThrow()
    expect(rulesDb.listRules(db).map((r) => r.name)).toEqual(['C', 'A', 'B']) // unchanged by the failed attempts
  })
  it('deletes', () => {
    const db = openDb()
    const a = rulesDb.saveRule(db, sample('A'))
    expect(rulesDb.deleteRule(db, a.id)).toBe(true)
    expect(rulesDb.getRule(db, a.id)).toBeNull()
  })
})
