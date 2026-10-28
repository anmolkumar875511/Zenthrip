import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { findCycles, loopsCausedBy, LoopGuard } from '../src/engine/loopGuard.js'
import { createKeeper } from '../src/main/keeper.js'
import { openDb } from '../src/db/db.js'
import * as rulesDb from '../src/db/rules.js'
import * as ledger from '../src/db/ledger.js'
import { tmpDir, waitFor, sleep } from './helpers.js'

const folders = [{ id: 1, path: '/w/A' }, { id: 2, path: '/w/B' }, { id: 3, path: '/w/C' }]
const rule = (name, from, to, id) => ({
  id,
  name,
  enabled: true,
  folderIds: from ? [from] : [],
  actions: [{ type: 'move', to }]
})

describe('static check: cycles in the folder graph', () => {
  it('finds A -> B -> A', () => {
    const cycles = findCycles([rule('a2b', 1, '/w/B', 1), rule('b2a', 2, '/w/A', 2)], folders)
    expect(cycles).toHaveLength(1)
    expect(cycles[0].map((e) => e.rule.name).sort()).toEqual(['a2b', 'b2a'])
  })

  it('finds a three-folder cycle A -> B -> C -> A', () => {
    const cycles = findCycles([rule('1', 1, '/w/B', 1), rule('2', 2, '/w/C', 2), rule('3', 3, '/w/A', 3)], folders)
    expect(cycles.length).toBeGreaterThan(0)
  })

  it('a one-way chain is fine, and so is a move to an unwatched folder', () => {
    expect(findCycles([rule('1', 1, '/w/B', 1), rule('2', 2, '/w/C', 2)], folders)).toEqual([])
    expect(findCycles([rule('1', 1, '/elsewhere', 1), rule('2', 2, '/w/A', 2)], folders)).toEqual([])
  })

  it('a rule for "all folders" that moves into a watched folder loops with itself only via another folder', () => {
    // all-folders rule into B: edges A->B and C->B, but nothing leaves B, so no cycle
    expect(findCycles([rule('all', null, '/w/B', 1)], folders)).toEqual([])
    // add a rule that leaves B again: now B -> A closes a loop
    expect(findCycles([rule('all', null, '/w/B', 1), rule('back', 2, '/w/A', 2)], folders).length).toBeGreaterThan(0)
  })

  it('disabled rules are ignored', () => {
    const off = { ...rule('b2a', 2, '/w/A', 2), enabled: false }
    expect(findCycles([rule('a2b', 1, '/w/B', 1), off], folders)).toEqual([])
  })

  it('loopsCausedBy reports the loop a NEW rule would create, in readable form', () => {
    const existing = [rule('a2b', 1, '/w/B', 1)]
    const loops = loopsCausedBy({ name: 'b2a', enabled: true, folderIds: [2], actions: [{ type: 'move', to: '/w/A' }] }, existing, folders)
    expect(loops).toHaveLength(1)
    expect(loops[0].rules.sort()).toEqual(['a2b', 'b2a'])
    expect(loops[0].text).toMatch(/\/w\/A.*\/w\/B/)
  })

  it('editing an existing rule does not count its old version', () => {
    const existing = [rule('a2b', 1, '/w/B', 1), rule('b2c', 2, '/w/C', 2)]
    const edited = { ...existing[1], actions: [{ type: 'move', to: '/w/C' }] }
    expect(loopsCausedBy(edited, existing, folders)).toEqual([])
  })
})

describe('runtime guard', () => {
  it('ignores events it caused itself, but only for a short while', () => {
    let t = 1000
    const g = new LoopGuard({ ttlMs: 500, now: () => t })
    g.markSelfCaused('/w/A/x.txt')
    expect(g.isSelfCaused('/w/A/x.txt')).toBe(true)
    expect(g.isSelfCaused('/w/A/other.txt')).toBe(false)
    t += 600
    expect(g.isSelfCaused('/w/A/x.txt')).toBe(false)
  })

  it('counts hops per file identity and freezes at the limit; a copy inherits its source history', () => {
    const g = new LoopGuard({ hopLimit: 2 })
    g.record('f1')
    expect(g.wouldExceed('f1')).toBe(false)
    g.record('f1')
    expect(g.wouldExceed('f1')).toBe(true)
    g.inherit('f2', 'f1')
    expect(g.wouldExceed('f2')).toBe(true)
    g.freeze('f1')
    expect(g.isFrozen('f1')).toBe(true)
    expect(g.wouldExceed(null)).toBe(false) // unknown identity never blocks
  })
})

describe('integration: two mutually-undoing rules terminate with loop_broken ("Dormammu")', () => {
  const cleanups = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()()
  })

  async function setup(actionType) {
    const A = tmpDir()
    const B = tmpDir()
    const db = openDb()
    const events = []
    const keeper = createKeeper({
      db,
      emit: (c, p) => c === 'activity' && events.push(p),
      trashRoot: path.join(tmpDir(), 'trash'),
      watcherOptions: { stabilityThreshold: 100, pollInterval: 25 },
      denylist: { platform: process.platform, inside: [], equal: [] }
    })
    cleanups.push(() => keeper.stop())
    const a = (await keeper.addFolder(A)).folder
    const b = (await keeper.addFolder(B)).folder
    const base = { enabled: true, trigger: { type: 'arrival' }, condition: { op: 'AND', children: [{ field: 'name', operator: 'contains', value: 'ping' }] } }
    rulesDb.saveRule(db, { ...base, name: 'A to B', actions: [{ type: actionType, to: B }], folderIds: [a.id] }) // bypasses the save-time check on purpose
    rulesDb.saveRule(db, { ...base, name: 'B to A', actions: [{ type: actionType, to: A }], folderIds: [b.id] })
    return { A, B, db, keeper, events }
  }

  it('move/move: the file stops bouncing and is frozen', async () => {
    const { A, B, db, keeper, events } = await setup('move')
    fs.writeFileSync(path.join(A, 'ping.txt'), 'x')
    await waitFor(() => ledger.listLedger(db, { status: 'loop_broken' }).total >= 1, { timeout: 15000 })
    await sleep(800) // a frozen file must stay frozen
    expect(ledger.listLedger(db, { status: 'loop_broken' }).total).toBe(1)
    expect(ledger.listLedger(db, { status: 'done' }).total).toBe(3) // hop limit = 3
    // exactly one copy of the file exists, in one of the two folders
    expect(fs.readdirSync(A).length + fs.readdirSync(B).length).toBe(1)
    expect(events.some((e) => e.loop)).toBe(true)
    expect(keeper.listLedger({ status: 'loop_broken' }).rows[0].error).toMatch(/Loop stopped/)
  }, 30000)

  it('copy/copy: files that multiply are also stopped (copies inherit the history)', async () => {
    const { A, B, db } = await setup('copy')
    fs.writeFileSync(path.join(A, 'ping.txt'), 'x')
    await waitFor(() => ledger.listLedger(db, { status: 'loop_broken' }).total >= 1, { timeout: 15000 })
    await sleep(1200)
    const total = fs.readdirSync(A).length + fs.readdirSync(B).length
    expect(total).toBeLessThan(10) // bounded, not an explosion
    expect(ledger.listLedger(db, { status: 'loop_broken' }).total).toBeGreaterThanOrEqual(1)
  }, 30000)
})
