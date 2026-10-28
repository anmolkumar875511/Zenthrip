// User preferences and small bits of state, stored as key/value JSON in the settings table.
export const DEFAULT_SETTINGS = {
  trashRetentionDays: 30, // 0 = keep forever
  hopLimit: 3, // how many times the Keeper may act on one file before freezing it
  retryCount: 3, // retries for locked files
  notifications: true,
  startAtLogin: false,
  paused: false
}

export function getValue(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  if (!row) return fallback
  try {
    return JSON.parse(row.value)
  } catch {
    return fallback
  }
}

export function setValue(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
}

export function deleteValue(db, key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key)
}

export function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS }
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = getValue(db, `pref:${k}`, DEFAULT_SETTINGS[k])
  return out
}

export function setSettings(db, patch) {
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS) setValue(db, `pref:${k}`, v)
  })()
  return getSettings(db)
}

// ----- trusted scripts: { [absolute path]: sha256 of the file as the user approved it } -----
export const trustedScripts = (db) => getValue(db, 'trusted-scripts', {})
export function trustScript(db, scriptPath, hash) {
  setValue(db, 'trusted-scripts', { ...trustedScripts(db), [scriptPath]: hash })
}
export function revokeScript(db, scriptPath) {
  const all = { ...trustedScripts(db) }
  delete all[scriptPath]
  setValue(db, 'trusted-scripts', all)
}
