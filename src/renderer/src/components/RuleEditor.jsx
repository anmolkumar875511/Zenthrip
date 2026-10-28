import { useMemo, useState } from 'react'
import { describeRule } from '@shared/sentence.js'
import ConditionBuilder, { leafFor } from './ConditionBuilder.jsx'
import ActionsBuilder, { defaultAction } from './ActionsBuilder.jsx'
import TriggerEditor from './TriggerEditor.jsx'

const blankRule = () => ({
  name: '',
  enabled: true,
  trigger: { type: 'arrival' },
  condition: { op: 'AND', children: [leafFor('name')] },
  actions: [defaultAction('move')],
  folderIds: []
})

// The editor works on a group at the top; wrap anything else (a single leaf, or a NOT) so the builder can show it.
function normalize(rule) {
  const c = rule.condition
  const condition = c?.op === 'AND' || c?.op === 'OR' ? c : { op: 'AND', children: [c] }
  return { ...rule, condition }
}

export default function RuleEditor({ rule, folders, onClose, onSaved }) {
  const [draft, setDraft] = useState(() => (rule ? normalize(rule) : blankRule()))
  const [errors, setErrors] = useState([])
  const [saving, setSaving] = useState(false)
  const [loopWarning, setLoopWarning] = useState(null) // { text } when the rule would carry files in circles

  const errMap = useMemo(() => Object.fromEntries(errors.map((e) => [e.path, e.message])), [errors])
  const patch = (p) => setDraft((d) => ({ ...d, ...p }))

  async function save(allowLoop = false) {
    setSaving(true)
    setLoopWarning(null)
    let r = await window.zenthrip.rules.save({ ...draft, allowLoop })

    // A1: scripts must be trusted first. The confirmation is a native dialog the page cannot click for itself.
    if (!r.ok && r.code === 'untrusted_script') {
      let allTrusted = true
      for (const script of r.scripts) {
        const t = await window.zenthrip.scripts.trust(script)
        if (!t.ok || !t.trusted) allTrusted = false
      }
      if (allTrusted) r = await window.zenthrip.rules.save({ ...draft, allowLoop })
      else r = { ok: false, errors: [{ path: '', message: 'The rule was not saved because the script was not trusted.' }] }
    }
    setSaving(false)

    if (r.ok) {
      setErrors([])
      onSaved(r.rule, r.loops ?? [])
    } else if (r.code === 'loop') {
      setLoopWarning(r.loops[0])
      setErrors([])
    } else setErrors(r.errors ?? [{ path: '', message: r.error }])
  }

  const toggleFolder = (id) =>
    patch({ folderIds: draft.folderIds.includes(id) ? draft.folderIds.filter((x) => x !== id) : [...draft.folderIds, id] })

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <h2>{rule ? 'Edit enchantment' : 'New enchantment'}</h2>

        <label className="field">
          <span>Name</span>
          <input value={draft.name} placeholder="Big invoices" onChange={(e) => patch({ name: e.target.value })} autoFocus />
          {errMap.name && <div className="error">{errMap.name}</div>}
        </label>

        <div className="field">
          <span>When</span>
          <TriggerEditor value={draft.trigger} onChange={(trigger) => patch({ trigger })} errors={errMap} />
        </div>

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

        {loopWarning && (
          <div className="loop-box">
            <b>This rule would create a loop.</b>
            <p>
              Files could be carried round and round: {loopWarning.text}. Rules {loopWarning.rules.map((r) => `\u201C${r}\u201D`).join(' and ')} chase each
              other.
            </p>
            <p className="muted">
              Zenthrip would stop it after a few hops and freeze the file, but it is better to change a destination or narrow the conditions.
            </p>
            <button className="danger" onClick={() => save(true)}>Save anyway</button>
          </div>
        )}

        {errMap[''] && <div className="error">{errMap['']}</div>}
        <div className="row end">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => save(false)} disabled={saving}>
            {saving ? 'Saving…' : 'Save rule'}
          </button>
        </div>
      </div>
    </div>
  )
}
