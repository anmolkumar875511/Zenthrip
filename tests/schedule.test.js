import { describe, it, expect } from 'vitest'
import { nextRun, describeTrigger, parseTime } from '../src/engine/schedule.js'
import { createScheduler } from '../src/main/scheduler.js'
import { openDb } from '../src/db/db.js'
import * as rulesDb from '../src/db/rules.js'
import * as settingsDb from '../src/db/settings.js'

const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime()

describe('nextRun (pure)', () => {
  it('interval: every N minutes after the last run', () => {
    expect(nextRun({ type: 'schedule', kind: 'interval', minutes: 30 }, at(2026, 10, 28, 10, 0))).toBe(at(2026, 10, 28, 10, 30))
  })
  it('daily: later today if the time has not passed, tomorrow if it has', () => {
    const t = { type: 'schedule', kind: 'daily', time: '09:30' }
    expect(nextRun(t, at(2026, 10, 28, 8, 0))).toBe(at(2026, 10, 28, 9, 30))
    expect(nextRun(t, at(2026, 10, 28, 9, 30))).toBe(at(2026, 10, 29, 9, 30))
    expect(nextRun(t, at(2026, 10, 28, 23, 0))).toBe(at(2026, 10, 29, 9, 30))
  })
  it('weekly: the next chosen weekday (28 Oct 2026 is a Wednesday)', () => {
    const t = { type: 'schedule', kind: 'weekly', days: [1, 5], time: '18:00' } // Mon + Fri
    expect(nextRun(t, at(2026, 10, 28, 12, 0))).toBe(at(2026, 10, 30, 18, 0)) // Friday
    expect(nextRun(t, at(2026, 10, 30, 18, 0))).toBe(at(2026, 11, 2, 18, 0)) // next Monday
  })
  it('returns null for broken or arrival triggers', () => {
    expect(nextRun({ type: 'arrival' }, 0)).toBeNull()
    expect(nextRun({ type: 'schedule', kind: 'daily', time: '25:99' }, 0)).toBeNull()
    expect(nextRun({ type: 'schedule', kind: 'weekly', days: [], time: '10:00' }, 0)).toBeNull()
    expect(nextRun({ type: 'schedule', kind: 'interval', minutes: 0 }, 0)).toBeNull()
  })
  it('parses and describes', () => {
    expect(parseTime('7:05')).toEqual({ h: 7, m: 5 })
    expect(parseTime('24:00')).toBeNull()
    expect(describeTrigger({ type: 'arrival' })).toBe('When a file arrives')
    expect(describeTrigger({ type: 'schedule', kind: 'interval', minutes: 120 })).toBe('Every 2 hours')
    expect(describeTrigger({ type: 'schedule', kind: 'weekly', days: [1, 3], time: '09:00' })).toBe('Every Monday, Wednesday at 09:00')
  })
})

describe('scheduler', () => {
  const rule = (trigger, extra = {}) => ({
    name: 'Tidy',
    enabled: true,
    trigger,
    condition: { op: 'AND', children: [{ field: 'ageDays', operator: 'olderThan', value: 30 }] },
    actions: [{ type: 'trash' }],
    folderIds: [],
    ...extra
  })

  function harness() {
    const db = openDb()
    const calls = []
    const keeper = { runScheduled: async (ids) => (calls.push(ids), { done: 1 }) }
    let t = at(2026, 10, 28, 10, 0)
    const scheduler = createScheduler({ db, keeper, now: () => t })
    return { db, calls, scheduler, advance: (ms) => (t += ms), setNow: (v) => (t = v), now: () => t }
  }

  it('a new rule starts counting from now, then fires when it is due', async () => {
    const h = harness()
    const saved = rulesDb.saveRule(h.db, rule({ type: 'schedule', kind: 'interval', minutes: 10 }))
    await h.scheduler.tick()
    expect(h.calls).toEqual([]) // first sight: just remembered
    h.advance(9 * 60_000)
    await h.scheduler.tick()
    expect(h.calls).toEqual([])
    h.advance(2 * 60_000)
    await h.scheduler.tick()
    expect(h.calls).toEqual([[saved.id]])
    await h.scheduler.tick()
    expect(h.calls).toHaveLength(1) // not twice for the same slot
  })

  it('ignores arrival rules and disabled rules', async () => {
    const h = harness()
    rulesDb.saveRule(h.db, rule({ type: 'arrival' }))
    rulesDb.saveRule(h.db, rule({ type: 'schedule', kind: 'interval', minutes: 1 }, { enabled: false }))
    await h.scheduler.tick()
    h.advance(10 * 60_000)
    await h.scheduler.tick()
    expect(h.calls).toEqual([])
  })

  it('catches up ONCE after the app was closed over the due time', async () => {
    const h = harness()
    const saved = rulesDb.saveRule(h.db, rule({ type: 'schedule', kind: 'daily', time: '09:00' }))
    settingsDb.setValue(h.db, `lastrun:${saved.id}`, at(2026, 10, 25, 9, 0)) // last ran three days ago
    await h.scheduler.tick()
    expect(h.calls).toEqual([[saved.id]])
    await h.scheduler.tick()
    expect(h.calls).toHaveLength(1)
  })

  it('does nothing while watching is paused', async () => {
    const h = harness()
    const saved = rulesDb.saveRule(h.db, rule({ type: 'schedule', kind: 'interval', minutes: 1 }))
    settingsDb.setValue(h.db, `lastrun:${saved.id}`, h.now() - 3600_000)
    settingsDb.setSettings(h.db, { paused: true })
    await h.scheduler.tick()
    expect(h.calls).toEqual([])
  })

  it('groups rules that are due at the same moment into one run', async () => {
    const h = harness()
    const a = rulesDb.saveRule(h.db, rule({ type: 'schedule', kind: 'interval', minutes: 5 }, { name: 'A' }))
    const b = rulesDb.saveRule(h.db, rule({ type: 'schedule', kind: 'interval', minutes: 5 }, { name: 'B' }))
    await h.scheduler.tick()
    h.advance(6 * 60_000)
    await h.scheduler.tick()
    expect(h.calls).toEqual([[a.id, b.id]])
  })
})
