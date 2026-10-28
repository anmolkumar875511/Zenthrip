import { DAY_NAMES } from '@shared/schedule.js'

export const defaultTrigger = (kind) => {
  if (kind === 'arrival') return { type: 'arrival' }
  if (kind === 'interval') return { type: 'schedule', kind, minutes: 60 }
  if (kind === 'daily') return { type: 'schedule', kind, time: '09:00' }
  return { type: 'schedule', kind: 'weekly', days: [1], time: '09:00' }
}

const kindOf = (t) => (t?.type === 'schedule' ? t.kind : 'arrival')

/** When does the rule run? On arrival, or on a schedule (every N minutes, daily, weekly). */
export default function TriggerEditor({ value, onChange, errors }) {
  const kind = kindOf(value)
  const err = errors['trigger.minutes'] || errors['trigger.time'] || errors['trigger.days'] || errors['trigger.kind'] || errors['trigger.type']
  const toggleDay = (d) => {
    const days = value.days.includes(d) ? value.days.filter((x) => x !== d) : [...value.days, d]
    onChange({ ...value, days })
  }
  return (
    <div className="builder">
      <div className="inline">
        <select value={kind} onChange={(e) => onChange(defaultTrigger(e.target.value))}>
          <option value="arrival">When a file arrives</option>
          <option value="interval">Every so many minutes</option>
          <option value="daily">Every day at a time</option>
          <option value="weekly">On chosen weekdays</option>
        </select>
        {kind === 'interval' && (
          <>
            <span>every</span>
            <input className="num" type="number" min="1" value={value.minutes ?? ''} onChange={(e) => onChange({ ...value, minutes: e.target.value === '' ? '' : Number(e.target.value) })} />
            <span>minutes</span>
          </>
        )}
        {(kind === 'daily' || kind === 'weekly') && (
          <>
            <span>at</span>
            <input type="time" value={value.time ?? ''} onChange={(e) => onChange({ ...value, time: e.target.value })} />
          </>
        )}
      </div>
      {kind === 'weekly' && (
        <div className="inline wrap">
          {DAY_NAMES.map((name, d) => (
            <label key={d} className="check">
              <input type="checkbox" checked={value.days.includes(d)} onChange={() => toggleDay(d)} />
              {name.slice(0, 3)}
            </label>
          ))}
        </div>
      )}
      {kind !== 'arrival' && (
        <div className="muted">
          Scheduled rules look at the files already in the watched folders. If Zenthrip was closed at the time, the rule runs once when it
          starts again.
        </div>
      )}
      {err && <div className="error">{err}</div>}
    </div>
  )
}
