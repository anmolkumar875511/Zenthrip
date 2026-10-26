import { useEffect, useState } from 'react'
import Folders from './pages/Folders.jsx'
import Rules from './pages/Rules.jsx'

const TABS = [
  { id: 'folders', label: 'Doors (Folders)' },
  { id: 'rules', label: 'Enchantments (Rules)' },
  { id: 'preview', label: 'Preview', soon: 'Phase 4' },
  { id: 'ledger', label: 'Ledger', soon: 'Phase 5' }
]

export default function App() {
  const [tab, setTab] = useState('folders')
  const [info, setInfo] = useState({ maxFolders: 3 })
  const [activity, setActivity] = useState([])

  useEffect(() => {
    window.zenthrip.app.info().then((r) => r.ok && setInfo(r))
    // Keep the feed here so it survives switching tabs.
    return window.zenthrip.on('activity', (a) => setActivity((prev) => [a, ...prev].slice(0, 100)))
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <h1>Zenthrip</h1>
        <nav>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={'tab' + (tab === t.id ? ' active' : '')}
              disabled={Boolean(t.soon)}
              title={t.soon ? `Arrives in ${t.soon}` : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.soon && <small> · {t.soon}</small>}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {tab === 'folders' && <Folders info={info} activity={activity} onClearActivity={() => setActivity([])} />}
        {tab === 'rules' && <Rules />}
      </main>
    </div>
  )
}
