// A4: 200 files dropped at once are each processed EXACTLY once; locked files and over-long names are
// reported in the ledger, never fatal. Run on its own with:  npm run stress
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { createKeeper } from '../src/main/keeper.js'
import { openDb } from '../src/db/db.js'
import * as rulesDb from '../src/db/rules.js'
import * as ledger from '../src/db/ledger.js'
import { tmpDir, waitFor, sleep, rigFs } from './helpers.js'

describe('stress: 200 files at once', () => {
  it('processes every file exactly once; locked and long-named files are reported, the app keeps going', async () => {
    const watched = tmpDir()
    const sorted = tmpDir()
    const db = openDb()

    // Simulate Windows-style locks: files named *locked* cannot be renamed (EBUSY), however often we retry.
    const fsx = rigFs({
      rename: async (a, b) => {
        if (path.basename(a).includes('locked')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
        return fs.promises.rename(a, b)
      }
    })
    const events = []
    const keeper = createKeeper({
      db,
      emit: (c, p) => c === 'activity' && events.push(p),
      trashRoot: path.join(tmpDir(), 'trash'),
      fsx,
      sleep: async () => {},
      watcherOptions: { stabilityThreshold: 150, pollInterval: 30 },
      denylist: { platform: process.platform, inside: [], equal: [] }
    })
    try {
      await keeper.addFolder(watched)
      const base = { enabled: true, trigger: { type: 'arrival' }, folderIds: [] }
      // Rank 1: very long names get a rename that makes them even longer (impossible: name > 255 bytes)
      rulesDb.saveRule(db, { ...base, name: 'Doubler', condition: { op: 'AND', children: [{ field: 'name', operator: 'startsWith', value: 'long-' }] }, actions: [{ type: 'rename', template: '{name}_{name}' }] })
      // Rank 2: everything else is moved
      rulesDb.saveRule(db, { ...base, name: 'Sort', condition: { op: 'AND', children: [{ field: 'ext', operator: 'is', value: 'dat' }] }, actions: [{ type: 'move', to: sorted }] })

      const names = []
      for (let i = 0; i < 185; i++) names.push(`file-${String(i).padStart(3, '0')}.dat`)
      for (let i = 0; i < 10; i++) names.push(`locked-${i}.dat`)
      for (let i = 0; i < 5; i++) names.push(`long-${i}-${'x'.repeat(200)}.dat`) // 205+ chars: doubling exceeds 255 bytes
      expect(names).toHaveLength(200)
      for (const n of names) fs.writeFileSync(path.join(watched, n), n)

      await waitFor(() => events.filter((e) => e.message === 'executed').length >= 200, { timeout: 60000 })
      await keeper.idle()
      await sleep(500) // late duplicate events would show up here

      const rows = keeper.listLedger({ limit: 500 }).rows
      // exactly 200 ledger rows: none missing, none duplicated
      expect(rows).toHaveLength(200)
      expect(new Set(rows.map((r) => r.src)).size).toBe(200)

      const byStatus = (s) => rows.filter((r) => r.status === s)
      expect(byStatus('done')).toHaveLength(185)
      expect(byStatus('failed')).toHaveLength(15)
      expect(rows.filter((r) => r.status === 'pending')).toHaveLength(0)

      // clear, human-readable reasons
      const locked = rows.filter((r) => path.basename(r.src).startsWith('locked-'))
      expect(locked).toHaveLength(10)
      expect(locked.every((r) => r.status === 'failed' && /locked/.test(r.error))).toBe(true)
      const long = rows.filter((r) => path.basename(r.src).startsWith('long-'))
      expect(long.every((r) => r.status === 'failed' && /too long/.test(r.error))).toBe(true)

      // the filesystem agrees with the ledger
      expect(fs.readdirSync(sorted)).toHaveLength(185)
      expect(fs.readdirSync(watched)).toHaveLength(15) // failed files stay put, untouched
      // and the whole burst is ONE sweep, undoable in one go
      expect(new Set(rows.map((r) => r.sweepId)).size).toBeLessThanOrEqual(3)
      const sweeps = keeper.listSweeps(10)
      const totalUndoable = sweeps.reduce((n, s) => n + s.undoable, 0)
      expect(totalUndoable).toBe(185)
      for (const s of sweeps) await keeper.undoSweep(s.sweepId)
      expect(fs.readdirSync(sorted)).toHaveLength(0)
      expect(fs.readdirSync(watched)).toHaveLength(200)
    } finally {
      await keeper.stop()
    }
  }, 90000)
})
