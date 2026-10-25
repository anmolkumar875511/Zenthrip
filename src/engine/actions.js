// Turns a rule's actions into concrete, ordered "steps" for one file.
// This module only PLANS. It may read the disk (to avoid name collisions) but never writes.
//   step = { op: 'rename' | 'move' | 'copy' | 'trash', src, dest }
import path from 'node:path'
import { pathKey } from './paths.js'
import { TEMPLATE_TOKENS } from '../shared/fields.js'

const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Make a string safe to use as a file name on Windows, macOS and Linux alike. */
export function sanitizeFileName(name) {
  let s = String(name).replace(ILLEGAL_CHARS, '_').replace(/^\s+/, '').replace(/[. ]+$/, '')
  if (!s) s = '_'
  if (WINDOWS_RESERVED.test(s)) s = '_' + s
  return s
}

const pad = (n) => String(n).padStart(2, '0')

/** Expand {name} {ext} {original} {date} {year} {month} {day}. Unknown tokens are left untouched. */
export function expandTemplate(template, facts, now) {
  const d = new Date(now)
  const values = {
    name: facts.stem,
    ext: facts.extRaw,
    original: facts.fileName,
    year: String(d.getFullYear()),
    month: pad(d.getMonth() + 1),
    day: pad(d.getDate())
  }
  values.date = `${values.year}-${values.month}-${values.day}`
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    TEMPLATE_TOKENS.includes(key) ? values[key] : whole
  )
}

/** New file name for a rename. The extension is kept automatically unless the template uses {ext} or {original}. */
export function renamedFileName(template, facts, now) {
  const expanded = expandTemplate(template, facts, now)
  const keepsExt = /\{(ext|original)\}/.test(String(template)) || !facts.extRaw
  return sanitizeFileName(keepsExt ? expanded : `${expanded}.${facts.extRaw}`)
}

/** If `dest` is taken, return "name (1).ext", "name (2).ext"... Nothing is ever overwritten. */
export function resolveCollision(dest, exists, reserved) {
  const taken = (p) => reserved.has(pathKey(p)) || exists(p)
  if (!taken(dest)) return dest
  const dir = path.dirname(dest)
  const ext = path.extname(dest)
  const stem = path.basename(dest, ext)
  for (let i = 1; i <= 9999; i++) {
    const candidate = path.join(dir, `${stem} (${i})${ext}`)
    if (!taken(candidate)) return candidate
  }
  throw new Error(`Could not find a free file name for ${dest}`)
}

/**
 * Plan every action of a rule for one file, in order.
 * Later actions work on the result of earlier ones (rename, then move => moves the renamed file).
 * ctx = { now, exists(path), reserved: Set }
 */
export function planActions(actions, facts, ctx) {
  const steps = []
  const warnings = []
  let current = facts.path

  const claim = (dest) => {
    const free = resolveCollision(dest, ctx.exists, ctx.reserved)
    ctx.reserved.add(pathKey(free))
    return free
  }

  for (const action of actions) {
    if (action.type === 'rename') {
      const target = path.join(path.dirname(current), renamedFileName(action.template, facts, ctx.now))
      if (pathKey(target) === pathKey(current)) continue // already has that name
      const dest = claim(target)
      steps.push({ op: 'rename', src: current, dest })
      current = dest
    } else if (action.type === 'move') {
      const target = path.join(path.resolve(action.to), path.basename(current))
      if (pathKey(target) === pathKey(current)) continue // already there
      const dest = claim(target)
      steps.push({ op: 'move', src: current, dest })
      current = dest
    } else if (action.type === 'copy') {
      const target = path.join(path.resolve(action.to), path.basename(current))
      if (pathKey(path.dirname(target)) === pathKey(path.dirname(current))) {
        // A copy next to the original would be seen as a brand-new file and copied again, forever.
        warnings.push('Copy skipped: the destination is the same folder as the file.')
        continue
      }
      const dest = claim(target)
      steps.push({ op: 'copy', src: current, dest }) // the original stays where it is
    } else if (action.type === 'trash') {
      steps.push({ op: 'trash', src: current, dest: null })
      break // nothing can happen to a trashed file
    } else {
      warnings.push(`Unknown action "${action.type}" was skipped.`)
    }
  }
  return { steps, warnings }
}
