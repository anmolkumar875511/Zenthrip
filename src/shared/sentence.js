// Turns a rule into the plain sentence shown in the UI:
//   "When a file arrives, if name contains “invoice” and size is larger than 1 MB,
//    then rename to “{date}_{name}”, move to “C:\Invoices”."
import { FIELDS } from './fields.js'
import { describeTrigger } from '../engine/schedule.js'

export function formatBytes(n) {
  const num = Number(n)
  if (!Number.isFinite(num) || num < 0) return String(n)
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = num
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const s = i === 0 ? String(v) : String(Math.round(v * 100) / 100)
  return `${s} ${units[i]}`
}

const q = (s) => `\u201C${s}\u201D`

export function describeLeaf(leaf) {
  const def = FIELDS[leaf.field]
  if (!def) return 'something unknown'
  const opText = def.operators[leaf.operator] ?? leaf.operator
  const fieldText = { name: 'name', ext: 'extension', sizeBytes: 'size', ageDays: 'age' }[leaf.field]
  let value
  if (leaf.field === 'sizeBytes') {
    value = Array.isArray(leaf.value)
      ? `${formatBytes(leaf.value[0])} and ${formatBytes(leaf.value[1])}`
      : formatBytes(leaf.value)
  } else if (leaf.field === 'ageDays') {
    value = `${leaf.value} day${Number(leaf.value) === 1 ? '' : 's'}`
  } else {
    value = q(Array.isArray(leaf.value) ? leaf.value.join(', ') : leaf.value)
  }
  return `${fieldText} ${opText} ${value}`
}

export function describeCondition(node) {
  if (!node) return 'anything'
  if (node.op) {
    const kids = (node.children ?? []).map(describeCondition)
    if (node.op === 'NOT') return `not (${kids[0] ?? '…'})`
    const word = node.op === 'AND' ? ' and ' : ' or '
    const text = kids.join(word)
    return kids.length > 1 && node.op === 'OR' ? `(${text})` : text
  }
  return describeLeaf(node)
}

export function describeAction(a) {
  switch (a.type) {
    case 'rename':
      return `rename to ${q(a.template)}`
    case 'move':
      return `move to ${q(a.to)}`
    case 'copy':
      return `copy to ${q(a.to)}`
    case 'trash':
      return 'send it to the trash'
    case 'script':
      return `run the script ${q(a.path)}`
    default:
      return 'do something unknown'
  }
}

export function describeRule(rule) {
  const cond = describeCondition(rule.condition)
  const acts = (rule.actions ?? []).map(describeAction).join(', then ')
  const scheduled = rule.trigger && rule.trigger.type === 'schedule'
  const when = describeTrigger(rule.trigger)
  return scheduled
    ? `${when}, for every file in the watched folders where ${cond}, ${acts || 'do nothing'}.`
    : `${when}, if ${cond}, then ${acts || 'do nothing'}.`
}
