import { useCallback, useEffect, useState } from 'react'
import Folders from './pages/Folders.jsx'
import Rules from './pages/Rules.jsx'
import Preview from './pages/Preview.jsx'
import Ledger from './pages/Ledger.jsx'
import Settings from './pages/Settings.jsx'

// Mythic names on the surface, plain names underneath, so nothing is ambiguous.
const TABS = [
  { id: 'folders', label: 'Doors', plain: 'Folders', glyph: '\u2302' },
  { id: 'rules', label: 'Enchantments', plain: 'Rules', glyph: '\u2726' },
  { id: 'preview', label: 'Oracle', plain: 'Preview', glyph: '\u25C9' },
  { id: 'ledger', label: 'Chronicle', plain: 'Ledger', glyph: '\u2630' },
  { id: 'settings', label: 'Hearth', plain: 'Settings', glyph: '\u2699' }
]

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="16" cy="16" r="10.5" fill="none" stroke="currentColor" strokeWidth=".6" strokeDasharray="1.6 2.2" />
      <path d="M10.5 11h11l-11 10h11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" />
    </svg>
  )
}

export default function App() {
  const [tab, setTab] = useState('folders')
  const [info, setInfo] = useState({ maxFolders: 3 })
  const [activity, setActivity] = useState([])
  const [folders, setFolders] = useState([])
  const [paused, setPaused] = useState(false)
  const [progress, setProgress] = useState(null)
  const [notice, setNotice] = useState(null)

  const loadFolders = useCallback(async () => {
    const r = await window.zenthrip.folders.list()
    if (r.ok) setFolders(r.folders)
  }, [])

  useEffect(() => {
    window.zenthrip.app.info().then((r) => r.ok && setInfo(r))
    window.zenthrip.watch.status().then((r) => r.ok && setPaused(r.paused))
    loadFolders()
    const offs = [
      // Keep the feed here so it survives switching tabs.
      window.zenthrip.on('activity', (a) => setActivity((prev) => [a, ...prev].slice(0, 100))),
      window.zenthrip.on('progress', setProgress),
      window.zenthrip.on('status', (s) => setPaused(s.paused)),
      window.zenthrip.on('notice', (n) => setNotice(n))
    ]
    return () => offs.forEach((off) => off())
  }, [loadFolders])

  async function togglePause() {
    const r = await (paused ? window.zenthrip.watch.resume() : window.zenthrip.watch.pause())
    if (r.ok) setPaused(r.paused)
  }

  const busy = progress?.active
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Mark />
          <h1>Zenthrip</h1>
        </div>
        <nav aria-label="Main">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={'tab' + (tab === t.id ? ' active' : '')}
              aria-current={tab === t.id ? 'page' : undefined}
              title={t.plain}
              onClick={() => { setTab(t.id); if (t.id === 'preview' || t.id === 'rules') loadFolders() }}
            >
              <span className="glyph" aria-hidden="true">{t.glyph}</span>
              <span className="tab-name">{t.label}</span>
              <small className="tab-plain">{t.plain}</small>
            </button>
          ))}
        </nav>
        <div className="top-actions">
          {busy && <span className="muted working">Working… {progress.processed}</span>}
          <button className={'pause' + (paused ? ' on' : '')} onClick={togglePause} title="Pause or resume automatic watching and schedules">
            <span aria-hidden="true">{paused ? '\u25B6' : '\u23F8'}</span>
            <span className="pause-text">{paused ? 'Resume watching' : 'Pause watching'}</span>
          </button>
        </div>
      </header>
      <div className="meander" aria-hidden="true" />
      {paused && <div className="banner">Watching is paused: new files and scheduled rules are ignored. You can still preview and run a sweep by hand.</div>}
      {notice && (
        <div className="banner notice" role="status">
          <b>{notice.title}</b> {notice.body}
          <button className="icon" onClick={() => setNotice(null)} aria-label="Dismiss">{'\u2715'}</button>
        </div>
      )}
      <main>
        {tab === 'folders' && <Folders info={info} activity={activity} onClearActivity={() => setActivity([])} />}
        {tab === 'rules' && <Rules />}
        {tab === 'preview' && <Preview folders={folders} />}
        {tab === 'ledger' && <Ledger />}
        {tab === 'settings' && <Settings info={info} />}
      </main>
    </div>
  )
}
