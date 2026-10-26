import { ACTION_TYPES, TEMPLATE_TOKENS } from '@shared/fields.js'

export function defaultAction(type) {
  if (type === 'rename') return { type, template: '{date}_{name}' }
  if (type === 'trash') return { type }
  return { type, to: '' }
}

/** Ordered list of things to do to a matching file. Later actions work on the result of earlier ones. */
export default function ActionsBuilder({ actions, onChange, errors }) {
  const set = (i, next) => onChange(actions.map((a, j) => (j === i ? next : a)))
  const remove = (i) => onChange(actions.filter((_, j) => j !== i))
  const move = (i, d) => {
    const j = i + d
    if (j < 0 || j >= actions.length) return
    const next = [...actions]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  const browse = async (i) => {
    const r = await window.zenthrip.dialog.pickDirectory()
    if (r.ok && r.path) set(i, { ...actions[i], to: r.path })
  }

  return (
    <div className="builder">
      {errors.actions && <div className="error">{errors.actions}</div>}
      {actions.map((a, i) => {
        const base = `actions.${i}`
        const err = errors[`${base}.template`] || errors[`${base}.to`] || errors[`${base}.type`] || errors[base]
        return (
          <div className="cond" key={i}>
            <div className="inline">
              <b>{i + 1}.</b>
              <select value={a.type} onChange={(e) => set(i, defaultAction(e.target.value))}>
                {Object.entries(ACTION_TYPES).map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>

              {a.type === 'rename' && (
                <input
                  className="wide"
                  value={a.template ?? ''}
                  placeholder="{date}_{name}"
                  onChange={(e) => set(i, { ...a, template: e.target.value })}
                />
              )}
              {(a.type === 'move' || a.type === 'copy') && (
                <>
                  <input
                    className="wide"
                    value={a.to ?? ''}
                    placeholder="Full path of the destination folder"
                    onChange={(e) => set(i, { ...a, to: e.target.value })}
                  />
                  <button onClick={() => browse(i)}>Browse…</button>
                </>
              )}

              <button className="icon" title="Move up" onClick={() => move(i, -1)} disabled={i === 0}>{'\u2191'}</button>
              <button className="icon" title="Move down" onClick={() => move(i, 1)} disabled={i === actions.length - 1}>{'\u2193'}</button>
              <button className="icon" title="Remove action" onClick={() => remove(i)} disabled={actions.length === 1}>{'\u2715'}</button>
            </div>

            {a.type === 'rename' && (
              <div className="chips">
                <span className="muted">Insert:</span>
                {TEMPLATE_TOKENS.map((t) => (
                  <button key={t} className="chip" onClick={() => set(i, { ...a, template: (a.template ?? '') + `{${t}}` })}>
                    {`{${t}}`}
                  </button>
                ))}
                <span className="muted">The extension is kept automatically unless you use {'{ext}'} or {'{original}'}.</span>
              </div>
            )}
            {err && <div className="error">{err}</div>}
          </div>
        )
      })}
      <div className="inline">
        <span className="muted">Add:</span>
        {Object.entries(ACTION_TYPES).map(([k, label]) => (
          <button key={k} onClick={() => onChange([...actions, defaultAction(k)])}>+ {label}</button>
        ))}
      </div>
    </div>
  )
}
