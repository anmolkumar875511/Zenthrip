export const fmtTime = (ts) => new Date(ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' })
export const baseName = (p) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''

export function stepText(s) {
  if (s.op === 'trash') return 'send to trash'
  if (s.op === 'script') return `run script ${baseName(s.script)}`
  return `${s.op} \u2192 ${s.dest}`
}
export const OP_LABEL = { rename: 'Rename', move: 'Move', copy: 'Copy', trash: 'Trash', script: 'Script' }
export const STATUS_LABEL = { pending: 'Pending', done: 'Done', failed: 'Failed', skipped: 'Skipped', loop_broken: 'Loop stopped' }
