import { useEffect, useState } from 'react'
import { formatBytes } from '@shared/sentence.js'
import { stepText, OP_LABEL } from '../lib/format.js'

const OUTCOME = {
  planned: ['Will be changed', 'ok'],
  'no-match': ['No rule matched: left alone', 'muted-row'],
  'no-op': ['Already in place', 'muted-row'],
  'already-done': ['Already handled (copy exists)', 'muted-row'],
  'will-fail': ['Will fail', 'bad']
}

function Steps({ row }) {
  if (!row.steps.length) return <span className="muted">-</span>
  return (
    <ol className="steps">
      {row.steps.map((s, i) => (
        <li key={i} title={s.src}>
          <b>{OP_LABEL[s.op]}</b> {s.op === 'trash' ? '(Keeper Trash)' : s.op === 'script' ? stepText(s).replace('run script ', '') : <span className="path">{s.dest}</span>}
        </li>
      ))}
    </ol>
  )
}

/** B4: the dry run. Shows what every file WOULD go through. Nothing is touched until "Run this plan". */
export default function Preview({ folders }) {
  const [folderId, setFolderId] = useState('all')
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  async function run() {
    setBusy(true)
    setError('')
    setResult(null)
    const r = await window.zenthrip.preview.run(folderId === 'all' ? {} : { folderId: Number(folderId) })
    setBusy(false)
    if (r.ok) setData(r)
    else setError(r.error)
  }
  useEffect(() => {
    run()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function execute() {
    const { trash, scripts, planned } = data.summary
    const warn = [
      trash ? `${trash} file(s) will be sent to the Keeper Trash (you can undo this).` : '',
      scripts ? `${scripts} file(s) will be processed by a script (this CANNOT be undone).` : ''
    ].filter(Boolean)
    if (!window.confirm([`Apply this plan to ${planned} file(s)?`, ...warn].join('\n\n'))) return
    setBusy(true)
    const r = await window.zenthrip.sweep.run(data.previewId)
    setBusy(false)
    if (!r.ok) return setError(r.error)
    setResult(r)
    setData(null)
    run()
  }

  const s = data?.summary
  return (
    <div className="page">
      <section className="card">
        <div className="row between">
          <h2>Preview <small>(dry run: nothing is touched)</small></h2>
          <div className="row">
            <select value={folderId} onChange={(e) => setFolderId(e.target.value)} aria-label="Folder">
              <option value="all">All watched folders</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>{f.path}</option>
              ))}
            </select>
            <button onClick={run} disabled={busy}>Refresh preview</button>
            <button className="primary" onClick={execute} disabled={busy || !s || s.planned === 0} title="Executes exactly the plan shown below">
              Run this plan
            </button>
          </div>
        </div>
        <p className="muted">
          Shows what <b>every file</b> already sitting in your watched folders would go through, using the first matching rule. “Run this plan” does
          exactly this, and everything it does can be reviewed and undone in the Ledger.
        </p>
        {error && <div className="error">{error}</div>}
        {result && (
          <div className="ok-box">
            Done: {result.done} file(s) handled{result.failed ? `, ${result.failed} failed` : ''}
            {result.skipped ? `, ${result.skipped} skipped` : ''}
            {result.loops ? `, ${result.loops} stopped by the loop guard` : ''}. See the Ledger for details and undo.
          </div>
        )}
        {s && (
          <div className="stats">
            <span><b>{s.files}</b> files</span>
            <span className="ok"><b>{s.planned}</b> will change</span>
            <span><b>{s.noMatch}</b> no rule</span>
            <span><b>{s.unchanged}</b> unchanged</span>
            {s.willFail > 0 && <span className="bad"><b>{s.willFail}</b> will fail</span>}
          </div>
        )}
      </section>

      <section className="card">
        {!data ? (
          <p className="empty">{busy ? 'Working…' : 'No preview yet.'}</p>
        ) : data.rows.length === 0 ? (
          <p className="empty">The watched folders contain no files (temporary downloads are never listed).</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>File</th><th>Outcome</th><th>Matched rule</th><th>What would happen</th></tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const [label, cls] = OUTCOME[r.outcome] ?? [r.outcome, '']
                  return (
                    <tr key={r.id} className={cls}>
                      <td data-label="File">
                        <div className="path">{r.file}</div>
                        <div className="muted">{formatBytes(r.sizeBytes)}</div>
                      </td>
                      <td data-label="Outcome">{label}</td>
                      <td data-label="Matched rule">{r.ruleName ?? <span className="muted">no rule matched</span>}</td>
                      <td data-label="What would happen">
                        <Steps row={r} />
                        {r.issues.map((m, i) => <div key={i} className="error">{m}</div>)}
                        {r.warnings.map((m, i) => <div key={i} className="warn">{m}</div>)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
