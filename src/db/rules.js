const toRule = (r) => ({
  id: r.id,
  name: r.name,
  rank: r.rank,
  enabled: r.enabled === 1,
  trigger: JSON.parse(r.trigger_json),
  condition: JSON.parse(r.condition_json),
  actions: JSON.parse(r.actions_json),
  folderIds: JSON.parse(r.folder_ids_json)
})

export function listRules(db) {
  return db.prepare('SELECT * FROM rules ORDER BY rank, id').all().map(toRule)
}

export function getRule(db, id) {
  const row = db.prepare('SELECT * FROM rules WHERE id = ?').get(id)
  return row ? toRule(row) : null
}

/** Insert (no id) or update (id given). New rules go to the end of the list. */
export function saveRule(db, rule) {
  return db.transaction(() => {
    const cols = [
      rule.name,
      rule.enabled ? 1 : 0,
      JSON.stringify(rule.trigger),
      JSON.stringify(rule.condition),
      JSON.stringify(rule.actions),
      JSON.stringify(rule.folderIds ?? [])
    ]
    if (rule.id) {
      const info = db
        .prepare(
          `UPDATE rules SET name = ?, enabled = ?, trigger_json = ?, condition_json = ?,
             actions_json = ?, folder_ids_json = ? WHERE id = ?`
        )
        .run(...cols, rule.id)
      if (info.changes === 0) throw new Error('That rule no longer exists.')
      return getRule(db, rule.id)
    }
    const { next } = db.prepare('SELECT COALESCE(MAX(rank), 0) + 1 AS next FROM rules').get()
    const info = db
      .prepare(
        `INSERT INTO rules (name, enabled, trigger_json, condition_json, actions_json, folder_ids_json, rank)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(...cols, next)
    return getRule(db, Number(info.lastInsertRowid))
  })()
}

export function deleteRule(db, id) {
  return db.prepare('DELETE FROM rules WHERE id = ?').run(id).changes > 0
}

/** Persist a new order. `orderedIds` must contain every existing rule id exactly once. */
export function reorderRules(db, orderedIds) {
  db.transaction(() => {
    const existing = db.prepare('SELECT id FROM rules').all().map((r) => r.id)
    const same =
      existing.length === orderedIds.length &&
      new Set(orderedIds).size === orderedIds.length &&
      existing.every((id) => orderedIds.includes(id))
    if (!same) throw new Error('The rule list changed; refresh and try again.')
    const upd = db.prepare('UPDATE rules SET rank = ? WHERE id = ?')
    orderedIds.forEach((id, i) => upd.run(i + 1, id))
  })()
  return listRules(db)
}
