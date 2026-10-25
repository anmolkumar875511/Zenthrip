// Validation of rules coming from the UI. Runs in the main process (never trust the renderer).
// Hand-written walkers give precise, friendly error paths like "actions.1.to".
import { z } from 'zod'
import { FIELDS, ACTION_TYPES, TEMPLATE_TOKENS } from './fields.js'

const MAX_CONDITION_NODES = 40
const MAX_DEPTH = 5
const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/

const extList = (v) =>
  (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map((s) => String(s).trim().replace(/^\./, ''))
    .filter(Boolean)

function validateLeaf(leaf, at, add) {
  const def = FIELDS[leaf.field]
  if (!def) return add(at.concat('field'), 'Pick what to look at.')
  if (!Object.hasOwn(def.operators, leaf.operator)) return add(at.concat('operator'), 'Pick a valid comparison.')
  const v = leaf.value
  const bad = (m) => add(at.concat('value'), m)
  const isNum = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0
  switch (leaf.field) {
    case 'name':
      if (typeof v !== 'string' || v.trim() === '') return bad('Enter some text.')
      if (v.length > 200) return bad('That text is too long.')
      if (leaf.operator === 'regex') {
        try {
          new RegExp(v, 'i')
        } catch {
          return bad('That is not a valid pattern.')
        }
      }
      return
    case 'ext':
      if (extList(v).length === 0) return bad('Enter an extension, for example pdf.')
      return
    case 'sizeBytes':
      if (leaf.operator === 'between') {
        if (!Array.isArray(v) || v.length !== 2 || !v.every(isNum)) return bad('Enter two sizes.')
      } else if (!isNum(v)) return bad('Enter a size.')
      return
    case 'ageDays':
      if (!isNum(v)) return bad('Enter a number of days.')
  }
}

function validateCondition(node, at, add, state, depth = 0) {
  if (++state.nodes > MAX_CONDITION_NODES) return add(at, 'This rule has too many conditions.')
  if (!node || typeof node !== 'object') return add(at, 'Add at least one condition.')
  if (node.op !== undefined) {
    if (!['AND', 'OR', 'NOT'].includes(node.op)) return add(at.concat('op'), 'Unknown group type.')
    if (depth >= MAX_DEPTH) return add(at, 'Conditions are nested too deeply.')
    const kids = node.children
    if (!Array.isArray(kids) || kids.length === 0) return add(at, 'Add at least one condition.')
    if (node.op === 'NOT' && kids.length !== 1) return add(at, 'NOT needs exactly one condition.')
    kids.forEach((k, i) => validateCondition(k, at.concat('children', i), add, state, depth + 1))
    return
  }
  validateLeaf(node, at, add)
}

function validateActions(actions, add) {
  const trashAt = actions.findIndex((a) => a?.type === 'trash')
  actions.forEach((a, i) => {
    const at = ['actions', i]
    if (!a || typeof a !== 'object' || !Object.hasOwn(ACTION_TYPES, a.type)) return add(at.concat('type'), 'Pick an action.')
    if (a.type === 'rename') {
      const t = a.template
      if (typeof t !== 'string' || t.trim() === '') return add(at.concat('template'), 'Enter the new name.')
      if (t.length > 120) return add(at.concat('template'), 'That name is too long.')
      if (/[\\/]/.test(t)) return add(at.concat('template'), 'A file name cannot contain / or \\.')
      for (const m of t.matchAll(/\{(\w+)\}/g)) {
        if (!TEMPLATE_TOKENS.includes(m[1])) return add(at.concat('template'), `Unknown placeholder {${m[1]}}.`)
      }
    }
    if ((a.type === 'move' || a.type === 'copy') && (typeof a.to !== 'string' || !ABSOLUTE_PATH.test(a.to))) {
      add(at.concat('to'), 'Choose a destination folder (a full path).')
    }
    if (a.type === 'trash' && i !== actions.length - 1) add(at, 'Nothing can follow "Send to trash".')
    if (a.type === 'trash' && trashAt !== i) add(at, 'Only one "Send to trash" is allowed.')
  })
}

function clean(rule) {
  const cleanNode = (n) =>
    n.op !== undefined
      ? { op: n.op, children: n.children.map(cleanNode) }
      : { field: n.field, operator: n.operator, value: n.value }
  const cleanAction = (a) =>
    a.type === 'rename'
      ? { type: 'rename', template: a.template.trim() }
      : a.type === 'trash'
        ? { type: 'trash' }
        : { type: a.type, to: a.to }
  return {
    ...(rule.id ? { id: rule.id } : {}),
    name: rule.name,
    enabled: rule.enabled,
    trigger: { type: 'arrival' },
    condition: cleanNode(rule.condition),
    actions: rule.actions.map(cleanAction),
    folderIds: [...new Set(rule.folderIds)]
  }
}

const RuleShape = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1, 'Give the rule a name.').max(80, 'That name is too long.'),
  enabled: z.boolean().default(true),
  trigger: z.object({ type: z.literal('arrival') }).default({ type: 'arrival' }),
  condition: z.any(),
  actions: z.array(z.any()).min(1, 'Add at least one action.').max(6, 'Use at most 6 actions.'),
  folderIds: z.array(z.number().int().positive()).max(3).default([])
})

/** @returns {{ok:true, rule}|{ok:false, errors:{path:string,message:string}[]}} */
export function parseRule(input) {
  const errors = []
  const add = (path, message) => errors.push({ path: path.join('.'), message })
  const base = RuleShape.safeParse(input)
  if (!base.success) for (const i of base.error.issues) add(i.path.map(String), i.message)
  // Report EVERYTHING that is wrong in one go, so the editor can mark every field at once.
  const raw = base.success ? base.data : (input ?? {})
  validateCondition(raw.condition, ['condition'], add, { nodes: 0 })
  validateActions(Array.isArray(raw.actions) ? raw.actions : [], add)
  if (errors.length) return { ok: false, errors }
  return { ok: true, rule: clean(base.data) }
}
