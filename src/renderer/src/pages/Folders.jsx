import { useEffect, useState } from 'react'

function stepText(s) {
  if (s.op === 'trash') return 'send to trash'
  return `${s.op} \u2192 ${s.dest}`
}

function ActivityRow({ a }) {
  const time = new Date(a.ts).toLocaleTimeString()
  let text
  if (a.message === 'planned') {
    const what = a.steps.length ? a.steps.map(stepText).join('; ') : 'already in place, nothing to do'
    text = (
      <>
        <b>{a.file}</b> matched “{a.ruleName}”: {what}
        {a.warnings.map((w, i) => (
          <div key={i} className="warn">{w}</div>
        ))}
      </>
    )
  } else if (a.message === 'no-match') {
    text = (
      <>
        <b>{a.file}</b>: no rule matched, left alone
      </>
    )
  } else {
    text = a.message
  }
  return (
    <li className={'act ' + a.level}>
      <span className="time">{time}</span>
      <span>{text}</span>
    </li>
  )
}

export default function Folders({ info, activity, onClearActivity }) {
  const [folders, setFolders] = useState([])
  const [error, setError] = useState('')

  const refresh = async () => {
    const r = await window.zenthrip.folders.list()
    if (r.ok) setFolders(r.folders)
  }
  useEffect(() => {
    refresh()
  }, [])

  async function add() {
    setError('')
    const r = await window.zenthrip.folders.pick()
    if (r.canceled) return
    if (!r.ok) setError(r.error)
    refresh()
  }

  async function remove(f) {
    if (!window.confirm(`Stop watching this folder?\n\n${f.path}\n\nYour files are not touched.`)) return
    await window.zenthrip.folders.remove(f.id)
    refresh()
  }

  const full = folders.length >= info.maxFolders

  return (
    <div className="page">
      <section className="card">
        <div className="row between">
          <h2>
            Watched folders <small>({folders.length}/{info.maxFolders})</small>
          </h2>
          <button className="primary" onClick={add} disabled={full} title={full ? 'Remove a folder first' : ''}>
            + Add folder
          </button>
        </div>
        <p className="muted">
          Only files directly inside these folders are handled. Half-finished downloads (.crdownload, .part, .tmp) are
          never touched, and system folders are refused.
        </p>
        {error && <div className="error">{error}</div>}
        {folders.length === 0 ? (
          <p className="empty">No folders yet. Add one to start guarding a doorway.</p>
        ) : (
          <ul className="list">
            {folders.map((f) => (
              <li key={f.id} className="row between item">
                <div>
                  <div className="path">{f.path}</div>
                  {!f.exists && <div className="warn">This folder is missing right now.</div>}
                </div>
                <button className="danger" onClick={() => remove(f)}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <div className="row between">
          <h2>Live activity</h2>
          <button onClick={onClearActivity} disabled={activity.length === 0}>Clear</button>
        </div>
        <p className="muted">
          Execution arrives in Phase 5. For now Zenthrip only <b>reports what it would do</b> when a file arrives.
        </p>
        {activity.length === 0 ? (
          <p className="empty">Drop a file into a watched folder to see it here.</p>
        ) : (
          <ul className="feed">
            {activity.map((a) => (
              <ActivityRow key={a.id} a={a} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
