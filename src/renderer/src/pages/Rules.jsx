import { useEffect, useState } from 'react'
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { describeRule } from '@shared/sentence.js'
import RuleEditor from '../components/RuleEditor.jsx'

function SortableRule({ rule, index, onEdit, onToggle, onDuplicate, onDelete }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: rule.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }
  return (
    <li ref={setNodeRef} style={style} className={'rule' + (rule.enabled ? '' : ' disabled')}>
      <button className="handle" title="Drag to change priority" {...attributes} {...listeners}>
        {'\u283F'}
      </button>
      <div className="rank">{index + 1}</div>
      <div className="grow">
        <div className="rule-name">{rule.name}</div>
        <div className="muted">{describeRule(rule)}</div>
      </div>
      <label className="check" title="Enable or disable this rule">
        <input type="checkbox" checked={rule.enabled} onChange={() => onToggle(rule)} />
        On
      </label>
      <button onClick={() => onEdit(rule)}>Edit</button>
      <button onClick={() => onDuplicate(rule)}>Duplicate</button>
      <button className="danger" onClick={() => onDelete(rule)}>Delete</button>
    </li>
  )
}

export default function Rules() {
  const [rules, setRules] = useState([])
  const [folders, setFolders] = useState([])
  const [editing, setEditing] = useState(null) // null | 'new' | rule
  const [error, setError] = useState('')

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const refresh = async () => {
    const [r, f] = await Promise.all([window.zenthrip.rules.list(), window.zenthrip.folders.list()])
    if (r.ok) setRules(r.rules)
    if (f.ok) setFolders(f.folders)
  }
  useEffect(() => {
    refresh()
  }, [])

  async function onDragEnd({ active, over }) {
    if (!over || active.id === over.id) return
    const next = arrayMove(
      rules,
      rules.findIndex((r) => r.id === active.id),
      rules.findIndex((r) => r.id === over.id)
    )
    setRules(next) // optimistic; the saved order comes back from the main process
    const r = await window.zenthrip.rules.reorder(next.map((x) => x.id))
    if (r.ok) setRules(r.rules)
    else {
      setError(r.error)
      refresh()
    }
  }

  async function toggle(rule) {
    const r = await window.zenthrip.rules.save({ ...rule, enabled: !rule.enabled })
    if (!r.ok) setError(r.error ?? r.errors?.[0]?.message ?? 'Could not update the rule.')
    refresh()
  }

  async function duplicate(rule) {
    const { id, ...rest } = rule
    const r = await window.zenthrip.rules.save({ ...rest, name: `${rule.name} (copy)`.slice(0, 80) })
    if (!r.ok) setError(r.error ?? r.errors?.[0]?.message ?? 'Could not duplicate the rule.')
    refresh()
  }

  async function remove(rule) {
    if (!window.confirm(`Delete the rule \u201C${rule.name}\u201D?`)) return
    await window.zenthrip.rules.delete(rule.id)
    refresh()
  }

  return (
    <div className="page">
      <section className="card">
        <div className="row between">
          <h2>Enchantments <small>({rules.length})</small></h2>
          <button className="primary" onClick={() => setEditing('new')}>+ New rule</button>
        </div>
        <p className="muted">
          Rules are tried from the top. <b>The first rule that matches a file is the only one that acts</b>, so the same
          file always meets the same fate. Drag the handle to change priority.
        </p>
        {error && <div className="error">{error}</div>}
        {rules.length === 0 ? (
          <p className="empty">No rules yet. Create one to teach the Keeper what to do.</p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={rules.map((r) => r.id)} strategy={verticalListSortingStrategy}>
              <ul className="rules">
                {rules.map((r, i) => (
                  <SortableRule
                    key={r.id}
                    rule={r}
                    index={i}
                    onEdit={setEditing}
                    onToggle={toggle}
                    onDuplicate={duplicate}
                    onDelete={remove}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </section>

      {editing && (
        <RuleEditor
          rule={editing === 'new' ? null : editing}
          folders={folders}
          onClose={() => setEditing(null)}
          onSaved={(_rule, loops) => {
            setEditing(null)
            setError(loops?.length ? `Saved, but this rule forms a loop (${loops[0].text}). Zenthrip will freeze files that bounce around.` : '')
            refresh()
          }}
        />
      )}
    </div>
  )
}
