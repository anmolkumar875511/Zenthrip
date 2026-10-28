import { useState } from 'react'
import { FIELDS } from '@shared/fields.js'

/** A fresh condition row for a given field. */
export function leafFor(field) {
  const d = FIELDS[field]
  return { field, operator: d.defaults.operator, value: d.defaults.value }
}

export const newGroup = (op = 'AND') => ({ op, children: [leafFor('name')] })

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

const isGroup = (n) => n && n.op !== undefined && n.op !== 'NOT'
const isNot = (n) => n && n.op === 'NOT'
const firstError = (errors, ...paths) => paths.map((p) => errors[p]).find(Boolean)

function Leaf({ leaf, onChange, path, errors }) {
  const err = firstError(errors, `${path}.value`, `${path}.operator`, `${path}.field`, path)
  return (
    <>
      <div className="inline">
        <select value={leaf.field} onChange={(e) => onChange(leafFor(e.target.value))}>
          {Object.entries(FIELDS).map(([k, f]) => (
            <option key={k} value={k}>{f.label}</option>
          ))}
        </select>
        <select value={leaf.operator} onChange={(e) => onChange({ ...leaf, operator: e.target.value, value: adaptValue(leaf, e.target.value) })}>
          {Object.entries(FIELDS[leaf.field].operators).map(([k, label]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </select>
        <ValueInput key={`${leaf.field}-${leaf.operator}`} leaf={leaf} onChange={(v) => onChange({ ...leaf, value: v })} />
      </div>
      {err && <div className="error">{err}</div>}
    </>
  )
}

/**
 * One row of a group: a condition or a nested group, with a "not" switch.
 * "not" is stored as { op: 'NOT', children: [x] } wrapped around x.
 */
function Row({ node, onChange, onRemove, canRemove, path, errors, depth }) {
  const negated = isNot(node)
  const inner = negated ? node.children[0] : node
  const innerPath = negated ? `${path}.children.0` : path
  const setInner = (next) => onChange(negated ? { op: 'NOT', children: [next] } : next)
  const toggleNot = () => onChange(negated ? inner : { op: 'NOT', children: [inner] })
  return (
    <div className="cond">
      <div className="inline">
        <label className="check" title="Match files that do NOT satisfy this">
          <input type="checkbox" checked={negated} onChange={toggleNot} />
          not
        </label>
        <div className="grow">
          {isGroup(inner) ? (
            <Group group={inner} onChange={setInner} path={innerPath} errors={errors} depth={depth + 1} />
          ) : (
            <Leaf leaf={inner} onChange={setInner} path={innerPath} errors={errors} />
          )}
        </div>
        <button className="icon" title="Remove" onClick={onRemove} disabled={!canRemove}>{'\u2715'}</button>
      </div>
      {negated && errors[path] && <div className="error">{errors[path]}</div>}
    </div>
  )
}

const MAX_UI_DEPTH = 4

/** A group: "all of" (AND) or "any of" (OR) its rows. Rows can be conditions or nested groups. */
export function Group({ group, onChange, path, errors, depth = 0 }) {
  const rows = group.children
  const setRow = (i, next) => onChange({ ...group, children: rows.map((c, j) => (j === i ? next : c)) })
  const removeRow = (i) => onChange({ ...group, children: rows.filter((_, j) => j !== i) })
  return (
    <div className={'builder' + (depth > 0 ? ' nested' : '')}>
      <div className="inline">
        <span>{depth === 0 ? 'A file matches when' : 'This group matches when'}</span>
        <select value={group.op} onChange={(e) => onChange({ ...group, op: e.target.value })}>
          <option value="AND">all</option>
          <option value="OR">any</option>
        </select>
        <span>of these are true:</span>
      </div>
      {errors[path] && <div className="error">{errors[path]}</div>}
      {rows.map((node, i) => (
        <Row
          key={i}
          node={node}
          path={`${path}.children.${i}`}
          errors={errors}
          depth={depth}
          canRemove={rows.length > 1}
          onChange={(next) => setRow(i, next)}
          onRemove={() => removeRow(i)}
        />
      ))}
      <div className="inline">
        <button onClick={() => onChange({ ...group, children: [...rows, leafFor('name')] })}>+ Add condition</button>
        {depth < MAX_UI_DEPTH && (
          <button onClick={() => onChange({ ...group, children: [...rows, newGroup(group.op === 'AND' ? 'OR' : 'AND')] })}>+ Add group</button>
        )}
      </div>
    </div>
  )
}

/** The editor's top level: a group, with nested groups and "not" available (Advanced tier). */
export default function ConditionBuilder({ value, onChange, errors }) {
  return <Group group={value} onChange={onChange} path="condition" errors={errors} depth={0} />
}
