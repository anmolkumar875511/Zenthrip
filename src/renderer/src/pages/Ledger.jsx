import { useCallback, useEffect, useState } from 'react'
import { baseName, fmtTime, OP_LABEL, STATUS_LABEL } from '../lib/format.js'

const PAGE = 50
const sweepKind = (id) => ({ a: 'Automatic', m: 'Manual sweep', s: 'Scheduled' })[id[0]] ?? 'Sweep'

function EntryRow({ e, onUndo }) {
  const undoable = e.status === 'done' && e.undone === 0 && e.op !== 'script'
  const target = e.op === 'trash' ? 'Keeper Trash' : e.op === 'script' ? baseName(e.detail?.script) : e.dest
  return (
    <tr className={e.undone === 1 ? 'muted-row' : e.status === 'failed' || e.status === 'loop_broken' ? 'bad' : ''}>
      <td data-label="Time" className="nowrap">{fmtTime(e.ts)}</td>
      <td data-label="Rule">{e.ruleName ?? <span className="muted">(rule deleted)</span>}</td>
      <td data-label="Action">{OP_LABEL[e.op] ?? e.op}</td>
      <td data-label="From → to">
        <div className="path" title={e.src}>{e.src}</div>
        {target && <div className="path muted" title={e.dest ?? ''}>{'\u2192'} {target}</div>}
        {e.detail?.stdout ? <div className="muted">script output: {e.detail.stdout.trim().slice(0, 200)}</div> : null}
      </td>
      <td data-label="Status" className="nowrap">
        <span className={'badge ' + e.status}>{e.undone === 1 ? 'Undone' : e.undone === 2 ? 'Undoing…' : STATUS_LABEL[e.status] ?? e.status}</span>
        {e.error && <div className="error">{e.error}</div>}
        {e.undoError && <div className="warn">Undo failed: {e.undoError}</div>}
        {e.op === 'script' && e.status === 'done' && <div className="warn">Cannot be undone</div>}
      </td>
      <td data-label="">
        <button disabled={!undoable} onClick={() => onUndo(e)} title={undoable ? 'Put this file back' : 'Nothing to undo'}>Undo</button>
      </td>
    </tr>
  )
}

/** B5: everything Zenthrip ever did. Each entry, or a whole sweep, can be undone. */
export default function Ledger() {
  const [sweeps, setSweeps] = useState([])
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState('all')
  const [search, setSearch] = useState('')
  const [sweepId, setSweepId] = useState('')
  const [offset, setOffset] = useState(0)
  const [msg, setMsg] = useState(null)

  const load = useCallback(async () => {
    const q = { limit: PAGE, offset, ...(status !== 'all' ? { status } : {}), ...(sweepId ? { sweepId } : {}), ...(search ? { search } : {}) }
    const [l, s] = await Promise.all([window.zenthrip.ledger.list(q), window.zenthrip.ledger.sweeps()])
    if (l.ok) {
      setRows(l.rows)
      setTotal(l.total)
    }
    if (s.ok) setSweeps(s.sweeps)
  }, [status, search, sweepId, offset])

  useEffect(() => {
    load()
  }, [load])
  useEffect(() => window.zenthrip.on('ledger:changed', () => load()), [load])

  async function undo(e) {
    const r = await window.zenthrip.ledger.undo(e.id)
    setMsg(r.ok ? { ok: true, text: 'Undone.' } : { ok: false, text: r.error })
    load()
  }
  async function undoSweep(s) {
    if (!window.confirm(`Undo everything this sweep did (${s.undoable} action(s))? Newest actions are undone first.`)) return
    const r = await window.zenthrip.ledger.undoSweep(s.sweepId)
    if (!r.ok) setMsg({ ok: false, text: r.error })
    else if (r.failed.length) setMsg({ ok: false, text: `${r.undone} undone, ${r.failed.length} could not be undone: ${r.failed[0].error}` })
    else setMsg({ ok: true, text: `${r.undone} action(s) undone.` })
    load()
  }

  return (
    <div className="page">
      <section className="card">
        <div className="row between">
          <h2>Sweeps <small>({sweeps.length})</small></h2>
          {sweepId && <button onClick={() => { setSweepId(''); setOffset(0) }}>Show all entries</button>}
        </div>
        <p className="muted">Files that arrive within a few seconds of each other form one sweep, so a whole batch can be undone at once.</p>
        {msg && <div className={msg.ok ? 'ok-box' : 'error'}>{msg.text}</div>}
        {sweeps.length === 0 ? (
          <p className="empty">Nothing has happened yet.</p>
        ) : (
          <ul className="list sweeps">
            {sweeps.slice(0, 8).map((s) => (
              <li key={s.sweepId} className={'row between item' + (s.sweepId === sweepId ? ' selected' : '')}>
                <div>
                  <b>{sweepKind(s.sweepId)}</b> <span className="muted">{fmtTime(s.ts)}</span>
                  <div className="muted">
                    {s.done} done{s.failed ? `, ${s.failed} failed` : ''}{s.skipped ? `, ${s.skipped} skipped` : ''}{s.loopBroken ? `, ${s.loopBroken} loop stopped` : ''}
                    {s.undone ? `, ${s.undone} undone` : ''}
                  </div>
                </div>
                <div className="row">
                  <button onClick={() => { setSweepId(s.sweepId); setOffset(0) }}>View</button>
                  <button disabled={s.undoable === 0} onClick={() => undoSweep(s)}>Undo sweep</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <div className="row between">
          <h2>Ledger <small>({total} entries)</small></h2>
          <div className="row">
            <input placeholder="Search file or rule…" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0) }} />
            <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0) }} aria-label="Status">
              <option value="all">All</option>
              <option value="done">Done</option>
              <option value="failed">Failed</option>
              <option value="skipped">Skipped</option>
              <option value="loop_broken">Loop stopped</option>
              <option value="undone">Undone</option>
              <option value="pending">Pending</option>
            </select>
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="empty">No entries match.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Time</th><th>Rule</th><th>Action</th><th>From → to</th><th>Status</th><th /></tr></thead>
              <tbody>{rows.map((e) => <EntryRow key={e.id} e={e} onUndo={undo} />)}</tbody>
            </table>
          </div>
        )}
        <div className="row between pager">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</button>
          <span className="muted">{total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE, total)} of {total}</span>
          <button disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Older</button>
        </div>
      </section>
    </div>
  )
}
