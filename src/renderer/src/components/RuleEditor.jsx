import { useMemo, useState } from 'react'
import { describeRule } from '@shared/sentence.js'
import ConditionBuilder, { leafFor } from './ConditionBuilder.jsx'
import ActionsBuilder, { defaultAction } from './ActionsBuilder.jsx'

const blankRule = () => ({
  name: '',
  enabled: true,
  trigger: { type: 'arrival' },
  condition: { op: 'AND', children: [leafFor('name')] },
  actions: [defaultAction('move')],
  folderIds: []
})

// The UI edits a flat AND/OR group; wrap anything else (a single leaf) so the builder can show it.
function normalize(rule) {
  const condition = rule.condition?.op && rule.condition.op !== 'NOT' ? rule.condition : { op: 'AND', children: [rule.condition] }
  return { ...rule, condition }
}

export default function RuleEditor({ rule, folders, onClose, onSaved }) {
  const [draft, setDraft] = useState(() => (rule ? normalize(rule) : blankRule()))
  const [errors, setErrors] = useState([])
  const [saving, setSaving] = useState(false)

  const errMap = useMemo(() => Object.fromEntries(errors.map((e) => [e.path, e.message])), [errors])
  const patch = (p) => setDraft((d) => ({ ...d, ...p }))

  async function save() {
    setSaving(true)
    const r = await window.zenthrip.rules.save(draft)
    setSaving(false)
    if (r.ok) onSaved(r.rule)
    else setErrors(r.errors ?? [{ path: '', message: r.error }])
  }

  const toggleFolder = (id) =>
    patch({ folderIds: draft.folderIds.includes(id) ? draft.folderIds.filter((x) => x !== id) : [...draft.folderIds, id] })

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <h2>{rule ? 'Edit enchantment' : 'New enchantment'}</h2>

        <label className="field">
          <span>Name</span>
          <input
            value={draft.name}
            placeholder="Big invoices"
            onChange={(e) => patch({ name: e.target.value })}
            autoFocus
          />
          {errMap.name && <div className="error">{errMap.name}</div>}
        </label>

        <div className="field">
          <span>Conditions</span>
          <ConditionBuilder value={draft.condition} onChange={(condition) => patch({ condition })} errors={errMap} />
        </div>

        <div className="field">
          <span>Then do this, in order</span>
          <ActionsBuilder actions={draft.actions} onChange={(actions) => patch({ actions })} errors={errMap} />
        </div>

        {folders.length > 0 && (
          <div className="field">
            <span>Applies to</span>
            <div className="inline wrap">
              {folders.map((f) => (
                <label key={f.id} className="check">
                  <input type="checkbox" checked={draft.folderIds.includes(f.id)} onChange={() => toggleFolder(f.id)} />
                  {f.path}
                </label>
              ))}
            </div>
            <div className="muted">Leave all unticked to apply to every watched folder.</div>
          </div>
        )}

        <div className="sentence">
          <span className="muted">In plain words</span>
          <p>{describeRule(draft)}</p>
        </div>

        {errMap[''] && <div className="error">{errMap['']}</div>}
        <div className="row end">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save rule'}
          </button>
        </div>
      </div>
    </div>
  )
}
