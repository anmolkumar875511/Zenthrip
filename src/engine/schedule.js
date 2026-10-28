// Time-based triggers, as pure functions (the scheduler just calls these).
//   { type: 'schedule', kind: 'interval', minutes: 30 }
//   { type: 'schedule', kind: 'daily',    time: '09:00' }
//   { type: 'schedule', kind: 'weekly',   days: [1, 3], time: '18:30' }   // 0 = Sunday
const MIN = 60_000
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function parseTime(time) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(time ?? ''))
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null
}

/** The first moment strictly after `after` (ms) at which the schedule fires. Local time. */
export function nextRun(trigger, after) {
  if (!trigger || trigger.type !== 'schedule') return null
  if (trigger.kind === 'interval') {
    const minutes = Number(trigger.minutes)
    if (!Number.isFinite(minutes) || minutes < 1) return null
    return after + minutes * MIN
  }
  const t = parseTime(trigger.time)
  if (!t) return null
  const days = trigger.kind === 'weekly' ? (Array.isArray(trigger.days) && trigger.days.length ? trigger.days : null) : [0, 1, 2, 3, 4, 5, 6]
  if (!days) return null
  const start = new Date(after)
  for (let add = 0; add <= 8; add++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + add, t.h, t.m, 0, 0)
    if (d.getTime() > after && days.includes(d.getDay())) return d.getTime()
  }
  return null
}

export function describeTrigger(trigger) {
  if (!trigger || trigger.type === 'arrival') return 'When a file arrives'
  if (trigger.kind === 'interval') {
    const n = Number(trigger.minutes)
    if (n % 1440 === 0) return `Every ${n === 1440 ? 'day' : `${n / 1440} days`}`
    if (n % 60 === 0) return `Every ${n === 60 ? 'hour' : `${n / 60} hours`}`
    return `Every ${n} minute${n === 1 ? '' : 's'}`
  }
  if (trigger.kind === 'daily') return `Every day at ${trigger.time}`
  if (trigger.kind === 'weekly') return `Every ${(trigger.days ?? []).map((d) => DAY_NAMES[d]).join(', ')} at ${trigger.time}`
  return 'On a schedule'
}
