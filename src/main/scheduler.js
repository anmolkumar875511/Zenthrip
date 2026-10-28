// Time-based rules. A tiny ticker checks every 30 s which scheduled rules are due (pure maths lives in engine/schedule.js).
//  * "last run" times are stored in the database, so a rule that was due while the app was closed still runs once on start-up
//  * a rule that was never seen before starts counting from "now" (creating a daily rule at 10:00 does not fire at 09:00 today)
import { nextRun } from '../engine/schedule.js'
import * as rulesDb from '../db/rules.js'
import * as settingsDb from '../db/settings.js'

export function createScheduler({ db, keeper, now = () => Date.now(), tickMs = 30_000, onError = () => {}, onRan = () => {} }) {
  let timer = null
  let running = false

  async function tick() {
    if (running) return []
    running = true
    try {
      const t = now()
      const due = []
      for (const rule of rulesDb.listRules(db)) {
        if (!rule.enabled || rule.trigger?.type !== 'schedule') continue
        const key = `lastrun:${rule.id}`
        const last = settingsDb.getValue(db, key, null)
        if (last == null) {
          settingsDb.setValue(db, key, t)
          continue
        }
        const next = nextRun(rule.trigger, last)
        if (next != null && next <= t) due.push(rule.id)
      }
      if (due.length && !settingsDb.getSettings(db).paused) {
        for (const id of due) settingsDb.setValue(db, `lastrun:${id}`, t) // before running, so a slow run is never started twice
        const res = await keeper.runScheduled(due)
        onRan(due, res)
      }
      return due
    } catch (err) {
      onError(err)
      return []
    } finally {
      running = false
    }
  }

  return {
    tick,
    start() {
      if (timer) return
      timer = setInterval(tick, tickMs)
      timer.unref?.()
      void tick()
    },
    stop() {
      clearInterval(timer)
      timer = null
    }
  }
}
