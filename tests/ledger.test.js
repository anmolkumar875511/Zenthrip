import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, it, expect } from 'vitest'
import { openDb, integrityCheck } from '../src/db/db.js'
import { V1 } from '../src/db/schema.js'
import * as ledger from '../src/db/ledger.js'
import * as settingsDb from '../src/db/settings.js'
import * as rulesDb from '../src/db/rules.js'
import { parseSettingsPatch } from '../src/shared/schemas.js'
import { tmpDir } from './helpers.js'

describe('ledger database', () => {
  const seed = () => {
    const db = openDb()
    const rule = rulesDb.saveRule(db, { name: 'PDFs', enabled: true, trigger: { type: 'arrival' }, condition: { op: 'AND', children: [{ field: 'ext', operator: 'is', value: 'pdf' }] }, actions: [{ type: 'trash' }], folderIds: [] })
    const a = ledger.insertPending(db, { sweepId: 'm-1', ruleId: rule.id, op: 'move', src: '/w/a.pdf', dest: '/d/a.pdf' })
    ledger.markDone(db, a)
    const b = ledger.insertPending(db, { sweepId: 'm-1', ruleId: rule.id, op: 'move', src: '/w/b.pdf', dest: '/d/b.pdf' })
    ledger.markFailed(db, b, 'locked')
    const c = ledger.insertFinal(db, { sweepId: 'm-2', op: 'move', src: '/w/c%_.pdf', status: 'skipped', error: 'gone' })
    return { db, rule, a, b, c }
  }

  it('lists newest first, with rule names, and filters by status, sweep and text', () => {
    const { db, a } = seed()
    const all = ledger.listLedger(db, {})
    expect(all.total).toBe(3)
    expect(all.rows[0].src).toBe('/w/c%_.pdf')
    expect(all.rows.find((r) => r.id === a).ruleName).toBe('PDFs')
    expect(ledger.listLedger(db, { status: 'failed' }).rows.map((r) => r.src)).toEqual(['/w/b.pdf'])
    expect(ledger.listLedger(db, { sweepId: 'm-2' }).total).toBe(1)
    expect(ledger.listLedger(db, { search: 'a.pdf' }).total).toBe(1)
    expect(ledger.listLedger(db, { search: 'PDFs' }).total).toBe(2)
    expect(ledger.listLedger(db, { search: '%' }).total).toBe(1) // LIKE wildcards are escaped
    expect(ledger.listLedger(db, { limit: 1, offset: 1 }).rows).toHaveLength(1)
  })

  it('summarises sweeps', () => {
    const { db } = seed()
    const s = ledger.sweepSummaries(db)
    expect(s.map((x) => x.sweepId)).toEqual(['m-2', 'm-1'])
    expect(s[1]).toMatchObject({ total: 2, done: 1, failed: 1, undoable: 1 })
  })

  it('tracks fingerprints per exact file version and rule', () => {
    const db = openDb()
    const fp = { path: '/w/a.pdf', size: 10, mtime: 1000.4, ruleId: 1 }
    expect(ledger.hasFingerprint(db, fp)).toBe(false)
    ledger.addFingerprint(db, fp)
    ledger.addFingerprint(db, fp) // idempotent
    expect(ledger.hasFingerprint(db, fp)).toBe(true)
    expect(ledger.hasFingerprint(db, { ...fp, size: 11 })).toBe(false)
    expect(ledger.hasFingerprint(db, { ...fp, ruleId: 2 })).toBe(false)
    ledger.deleteFingerprints(db, { path: '/w/a.pdf', ruleId: 1 })
    expect(ledger.hasFingerprint(db, fp)).toBe(false)
  })

  it('survives closing and reopening a real file (crash-safe journal)', () => {
    const file = path.join(tmpDir(), 'z.db')
    let db = openDb(file)
    ledger.insertPending(db, { sweepId: 'm-1', op: 'move', src: '/a', dest: '/b' })
    db.close()
    db = openDb(file)
    expect(ledger.pendingRows(db)).toHaveLength(1)
    expect(integrityCheck(db)).toBe('ok')
    db.close()
  })

  it('upgrades an existing Phase 3 (version 1) database without losing data', () => {
    const file = path.join(tmpDir(), 'old.db')
    const old = new Database(file)
    old.exec(V1)
    old.pragma('user_version = 1')
    old.prepare('INSERT INTO folders (path, added_at) VALUES (?, ?)').run('/keep/me', 1)
    old.close()
    const db = openDb(file)
    expect(db.pragma('user_version', { simple: true })).toBe(2)
    expect(db.prepare('SELECT path FROM folders').all()).toEqual([{ path: '/keep/me' }])
    expect(() => settingsDb.setValue(db, 'k', 1)).not.toThrow()
    expect(ledger.listLedger(db, {}).total).toBe(0)
  })
})

describe('settings', () => {
  it('has defaults, stores patches and trusted scripts', () => {
    const db = openDb()
    expect(settingsDb.getSettings(db)).toMatchObject({ trashRetentionDays: 30, hopLimit: 3, retryCount: 3, notifications: true, startAtLogin: false, paused: false })
    expect(settingsDb.setSettings(db, { hopLimit: 5, bogus: 1 }).hopLimit).toBe(5)
    expect(settingsDb.getSettings(db)).not.toHaveProperty('bogus')
    settingsDb.trustScript(db, '/s.js', 'abc')
    expect(settingsDb.trustedScripts(db)).toEqual({ '/s.js': 'abc' })
    settingsDb.revokeScript(db, '/s.js')
    expect(settingsDb.trustedScripts(db)).toEqual({})
  })

  it('validates patches from the UI', () => {
    expect(parseSettingsPatch({ hopLimit: 4, retryCount: 0, trashRetentionDays: 0, notifications: false })).toEqual({ ok: true, patch: { hopLimit: 4, retryCount: 0, trashRetentionDays: 0, notifications: false } })
    const bad = parseSettingsPatch({ hopLimit: 0, retryCount: 1.5, notifications: 'yes', trashRetentionDays: 99999 })
    expect(bad.ok).toBe(false)
    expect(bad.errors.map((e) => e.path).sort()).toEqual(['hopLimit', 'notifications', 'retryCount', 'trashRetentionDays'])
    expect(parseSettingsPatch(null).ok).toBe(false)
  })
})
