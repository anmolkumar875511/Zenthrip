import { useEffect, useState } from 'react'
import { formatBytes } from '@shared/sentence.js'
import { SETTING_LIMITS } from '@shared/fields.js'

function Num({ label, help, name, value, onChange, error }) {
  const { min, max } = SETTING_LIMITS[name]
  return (
    <label className="field">
      <span>{label}</span>
      <input className="num" type="number" min={min} max={max} value={value} onChange={(e) => onChange(name, e.target.value === '' ? '' : Number(e.target.value))} />
      <div className="muted">{help}</div>
      {error && <div className="error">{error}</div>}
    </label>
  )
}

export default function Settings({ info }) {
  const [s, setS] = useState(null)
  const [errors, setErrors] = useState({})
  const [saved, setSaved] = useState(false)
  const [trash, setTrash] = useState(null)
  const [scripts, setScripts] = useState([])

  const loadAll = async () => {
    const [a, b, c] = await Promise.all([window.zenthrip.settings.get(), window.zenthrip.trash.info(), window.zenthrip.scripts.list()])
    if (a.ok) setS(a.settings)
    if (b.ok) setTrash(b)
    if (c.ok) setScripts(c.scripts)
  }
  useEffect(() => {
    loadAll()
  }, [])

  const change = (k, v) => {
    setS((cur) => ({ ...cur, [k]: v }))
    setSaved(false)
  }

  async function save() {
    const { trashRetentionDays, hopLimit, retryCount, notifications, startAtLogin } = s
    const r = await window.zenthrip.settings.set({ trashRetentionDays, hopLimit, retryCount, notifications, startAtLogin })
    if (r.ok) {
      setS(r.settings)
      setErrors({})
      setSaved(true)
    } else setErrors(Object.fromEntries((r.errors ?? []).map((e) => [e.path, e.message])))
  }

  async function emptyTrash() {
    await window.zenthrip.trash.empty()
    loadAll()
  }
  async function revoke(p) {
    await window.zenthrip.scripts.revoke(p)
    loadAll()
  }

  if (!s) return <div className="page"><p className="empty">Loading…</p></div>
  return (
    <div className="page">
      <section className="card">
        <h2>Settings</h2>
        <Num name="trashRetentionDays" label="Keeper Trash: keep files for (days)" help="Files sent to the trash can be undone until they are purged. 0 keeps them until you empty the trash yourself." value={s.trashRetentionDays} onChange={change} error={errors.trashRetentionDays} />
        <Num name="hopLimit" label="Loop guard: hop limit" help="How many times Zenthrip may act on the same file before it freezes it and reports a loop." value={s.hopLimit} onChange={change} error={errors.hopLimit} />
        <Num name="retryCount" label="Locked files: retries" help="How often a locked or busy file is retried (with a growing delay) before it is reported as failed." value={s.retryCount} onChange={change} error={errors.retryCount} />
        <label className="check pad"><input type="checkbox" checked={s.notifications} onChange={(e) => change('notifications', e.target.checked)} /> Show desktop notifications (failures, loops, scheduled sweeps)</label>
        <label className="check pad"><input type="checkbox" checked={s.startAtLogin} onChange={(e) => change('startAtLogin', e.target.checked)} /> Start Zenthrip when I log in (hidden in the tray; only in the installed app)</label>
        <div className="row end">
          {saved && <span className="ok">Saved.</span>}
          <button className="primary" onClick={save}>Save settings</button>
        </div>
      </section>

      <section className="card">
        <h2>Keeper Trash</h2>
        <p className="muted">
          “Send to trash” moves files into this folder instead of the operating-system trash, so Zenthrip can always put them back.
        </p>
        <div className="path">{trash?.path ?? info.trashPath}</div>
        <p>{trash ? `${trash.files} file(s), ${formatBytes(trash.bytes)}` : '…'}</p>
        <button className="danger" onClick={emptyTrash} disabled={!trash || trash.files === 0}>Empty the Keeper Trash…</button>
      </section>

      <section className="card">
        <h2>Trusted scripts</h2>
        {scripts.length === 0 ? (
          <p className="empty">No scripts are trusted.</p>
        ) : (
          <ul className="list">
            {scripts.map((x) => (
              <li key={x.path} className="row between item">
                <div>
                  <div className="path">{x.path}</div>
                  {x.state !== 'trusted' && <div className="warn">{x.state === 'changed' ? 'Changed since you trusted it, so it will not run.' : 'The file is missing.'}</div>}
                </div>
                <button onClick={() => revoke(x.path)}>Revoke</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>About</h2>
        <p className="muted">Zenthrip {info.version} on {info.platform}. Tessaract Zero, Softablitz 2026.</p>
      </section>
    </div>
  )
}
