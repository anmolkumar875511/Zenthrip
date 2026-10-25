export function listFolders(db) {
  return db.prepare('SELECT id, path, added_at AS addedAt FROM folders ORDER BY id').all()
}

export function addFolder(db, folderPath, max = 3) {
  return db.transaction(() => {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM folders').get()
    if (n >= max) throw new Error(`You can watch at most ${max} folders at once.`)
    const addedAt = Date.now()
    const info = db.prepare('INSERT INTO folders (path, added_at) VALUES (?, ?)').run(folderPath, addedAt)
    return { id: Number(info.lastInsertRowid), path: folderPath, addedAt }
  })()
}

export function removeFolder(db, id) {
  return db.prepare('DELETE FROM folders WHERE id = ?').run(id).changes > 0
}
