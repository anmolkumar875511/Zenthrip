import { useState } from 'react'
import { FIELDS } from '@shared/fields.js'

/** A fresh condition row for a given field. */
export function leafFor(field) {
  const d = FIELDS[field]
  return { field, operator: d.defaults.operator, value: d.defaults.value }
}

/**
 * Number box that keeps what you type while still reporting a clean number upward.
 * `factor` lets the box show KB/MB/GB while the rule stores bytes.
 */
function NumberField({ value, onChange, factor = 1, placeholder }) {
  const [text, setText] = useState(() =>
    typeof value === 'number' ? String(Math.round((value / factor) * 100) / 100) : ''
  )
  return (
    <input
      type="number"
      min="0"
      step="any"
      className="num"
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        const n = parseFloat(e.target.value)
        onChange(Number.isFinite(n) && n >= 0 ? Math.round(n * factor) : null)
      }}
    />
  )
}

const UNITS = [
  ['KB', 1024],
  ['MB', 1024 ** 2],
  ['GB', 1024 ** 3]
]

function bestUnit(bytes) {
  const n = Array.isArray(bytes) ? Math.max(...bytes) : bytes
  if (n >= 1024 ** 3) return 2
  if (n >= 1024 ** 2) return 1
  return 0 // KB
}

function SizeInput({ leaf, onChange }) {
  const [unit, setUnit] = useState(() => bestUnit(leaf.value))
  const factor = UNITS[unit][1]
  const between = leaf.operator === 'between'
  const pair = Array.isArray(leaf.value) ? leaf.value : [leaf.value, leaf.value]
  return (
    <span className="inline">
      {between ? (
        <>
          <NumberField key={'a' + unit} value={pair[0]} factor={factor} onChange={(v) => onChange([v, pair[1]])} />
          <span>and</span>
          <NumberField key={'b' + unit} value={pair[1]} factor={factor} onChange={(v) => onChange([pair[0], v])} />
        </>
      ) : (
        <NumberField key={unit} value={leaf.value} factor={factor} onChange={onChange} />
      )}
      <select value={unit} onChange={(e) => setUnit(Number(e.target.value))}>
        {UNITS.map(([label], i) => (
          <option key={label} value={i}>{label}</option>
        ))}
      </select>
    </span>
  )
}

function ValueInput({ leaf, onChange }) {
  switch (FIELDS[leaf.field].type) {
    case 'size':
      return <SizeInput leaf={leaf} onChange={onChange} />
    case 'age':
      return (
        <span className="inline">
          <NumberField value={leaf.value} onChange={onChange} />
          <span>days</span>
        </span>
      )
    case 'ext':
      return (
        <input
          value={leaf.value ?? ''}
          placeholder={leaf.operator === 'in' ? 'jpg, png, gif' : 'pdf'}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    default:
      return (
        <input
          value={leaf.value ?? ''}
          placeholder={leaf.operator === 'regex' ? '^invoice_\\d+' : 'invoice'}
          onChange={(e) => onChange(e.target.value)}
        />
      )
  }
}

/** Keep the value sensible when the comparison changes (e.g. "larger than" -> "between"). */
function adaptValue(leaf, nextOperator) {
  if (leaf.field !== 'sizeBytes') return leaf.value
  const isPair = Array.isArray(leaf.value)
  if (nextOperator === 'between' && !isPair) return [leaf.value ?? 0, (leaf.value ?? 0) * 10]
  if (nextOperator !== 'between' && isPair) return leaf.value[0]
  return leaf.value
}

/**
 * Flat list of conditions joined by "all" (AND) or "any" (OR).
 * (The data model is already a tree; nested groups and NOT arrive with the Advanced tier.)
 */
export default function ConditionBuilder({ value, onChange, errors }) {
  const children = value.children
  const setChild = (i, next) => onChange({ ...value, children: children.map((c, j) => (j === i ? next : c)) })
  const remove = (i) => onChange({ ...value, children: children.filter((_, j) => j !== i) })
  const add = () => onChange({ ...value, children: [...children, leafFor('name')] })

  return (
    <div className="builder">
      <div className="inline">
        <span>A file matches when</span>
        <select value={value.op} onChange={(e) => onChange({ ...value, op: e.target.value })}>
          <option value="AND">all</option>
          <option value="OR">any</option>
        </select>
        <span>of these are true:</span>
      </div>
      {errors.condition && <div className="error">{errors.condition}</div>}

      {children.map((leaf, i) => {
        const base = `condition.children.${i}`
        return (
          <div className="cond" key={`${i}-${leaf.field}-${leaf.operator}`}>
            <div className="inline">
              <select value={leaf.field} onChange={(e) => setChild(i, leafFor(e.target.value))}>
                {Object.entries(FIELDS).map(([k, f]) => (
                  <option key={k} value={k}>{f.label}</option>
                ))}
              </select>
              <select
                value={leaf.operator}
                onChange={(e) =>
                  setChild(i, { ...leaf, operator: e.target.value, value: adaptValue(leaf, e.target.value) })
                }
              >
                {Object.entries(FIELDS[leaf.field].operators).map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
              <ValueInput leaf={leaf} onChange={(v) => setChild(i, { ...leaf, value: v })} />
              <button className="icon" title="Remove condition" onClick={() => remove(i)} disabled={children.length === 1}>
                {'\u2715'}
              </button>
            </div>
            {(errors[`${base}.value`] || errors[`${base}.operator`] || errors[base]) && (
              <div className="error">{errors[`${base}.value`] || errors[`${base}.operator`] || errors[base]}</div>
            )}
          </div>
        )
      })}
      <button onClick={add}>+ Add condition</button>
    </div>
  )
}
