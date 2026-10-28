// Validation of rules coming from the UI. Runs in the main process (never trust the renderer).
// Hand-written walkers give precise, friendly error paths like "actions.1.to".
import { z } from 'zod'
import { FIELDS, ACTION_TYPES, TEMPLATE_TOKENS, SETTING_LIMITS } from './fields.js'
import { parseTime } from '../engine/schedule.js'

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
    if (a.type === 'script') {
      if (typeof a.path !== 'string' || !ABSOLUTE_PATH.test(a.path)) add(at.concat('path'), 'Choose a script file (a full path).')
      else if (a.path.length > 500) add(at.concat('path'), 'That path is too long.')
    }
    if (a.type === 'trash' && i !== actions.length - 1) add(at, 'Nothing can follow "Send to trash".')
    if (a.type === 'trash' && trashAt !== i) add(at, 'Only one "Send to trash" is allowed.')
  })
}

function validateTrigger(t, add) {
  const at = ['trigger']
  if (t == null || t.type === 'arrival') return
  if (t.type !== 'schedule') return add(at.concat('type'), 'Unknown trigger.')
  if (t.kind === 'interval') {
    const n = Number(t.minutes)
    if (!Number.isInteger(n) || n < 1 || n > 525_600) add(at.concat('minutes'), 'Enter a whole number of minutes (1 or more).')
  } else if (t.kind === 'daily' || t.kind === 'weekly') {
    if (!parseTime(t.time)) add(at.concat('time'), 'Enter a time like 09:30.')
    if (t.kind === 'weekly') {
      const ok = Array.isArray(t.days) && t.days.length > 0 && t.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      if (!ok) add(at.concat('days'), 'Pick at least one weekday.')
    }
  } else add(at.concat('kind'), 'Pick how often the rule runs.')
}

function cleanTrigger(t) {
  if (!t || t.type === 'arrival') return { type: 'arrival' }
  if (t.kind === 'interval') return { type: 'schedule', kind: 'interval', minutes: Number(t.minutes) }
  if (t.kind === 'daily') return { type: 'schedule', kind: 'daily', time: parseTimeString(t.time) }
  return { type: 'schedule', kind: 'weekly', days: [...new Set(t.days)].sort(), time: parseTimeString(t.time) }
}
const parseTimeString = (t) => {
  const p = parseTime(t)
  return `${String(p.h).padStart(2, '0')}:${String(p.m).padStart(2, '0')}`
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
        : a.type === 'script'
          ? { type: 'script', path: a.path }
          : { type: a.type, to: a.to }
  return {
    ...(rule.id ? { id: rule.id } : {}),
    name: rule.name,
    enabled: rule.enabled,
    trigger: cleanTrigger(rule.trigger),
    condition: cleanNode(rule.condition),
    actions: rule.actions.map(cleanAction),
    folderIds: [...new Set(rule.folderIds)]
  }
}

const RuleShape = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1, 'Give the rule a name.').max(80, 'That name is too long.'),
  enabled: z.boolean().default(true),
  trigger: z.any().optional(),
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
  validateTrigger(raw.trigger, add)
  validateCondition(raw.condition, ['condition'], add, { nodes: 0 })
  validateActions(Array.isArray(raw.actions) ? raw.actions : [], add)
  if (errors.length) return { ok: false, errors }
  return { ok: true, rule: clean(base.data) }
}

/** Validate a settings patch coming from the UI. Unknown keys are dropped. */
export function parseSettingsPatch(input) {
  const out = {}
  const errors = []
  const num = (key) => {
    const { min, max } = SETTING_LIMITS[key]
    const n = Number(input[key])
    if (!Number.isInteger(n) || n < min || n > max) errors.push({ path: key, message: `Enter a whole number from ${min} to ${max}.` })
    else out[key] = n
  }
  const bool = (key) => {
    if (typeof input[key] !== 'boolean') errors.push({ path: key, message: 'Must be on or off.' })
    else out[key] = input[key]
  }
  if (!input || typeof input !== 'object') return { ok: false, errors: [{ path: '', message: 'Invalid settings.' }] }
  for (const k of ['trashRetentionDays', 'hopLimit', 'retryCount']) if (k in input) num(k)
  for (const k of ['notifications', 'startAtLogin']) if (k in input) bool(k)
  return errors.length ? { ok: false, errors } : { ok: true, patch: out }
}
