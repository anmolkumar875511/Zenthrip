// Path safety: protected-folder deny-list, temp-file detection, collision keys.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---------- files the Keeper must never touch ----------
const TEMP_EXTENSIONS = new Set([
  'crdownload', // Chrome / Edge
  'part', // Firefox and many download managers
  'tmp',
  'download', // Safari
  'partial',
  'opdownload', // Opera
  'zenthrip-partial' // our own half-copied files (Phase 5)
])
const OS_JUNK = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

/** Half-finished downloads and lock files. */
export function isTempFile(fileName) {
  const lower = String(fileName).toLowerCase()
  if (lower.startsWith('~$')) return true // Office lock files
  return TEMP_EXTENSIONS.has(path.extname(lower).slice(1))
}

/** Anything the watcher should silently skip. */
export function isIgnoredFile(fileName) {
  return isTempFile(fileName) || OS_JUNK.has(String(fileName).toLowerCase())
}

// ---------- path comparison ----------
const caseInsensitive = (platform) => platform === 'win32' || platform === 'darwin'

/** Stable key for comparing paths (absolute, no trailing slash, case-folded where the OS is). */
export function pathKey(p, platform = process.platform) {
  const P = platform === 'win32' ? path.win32 : path.posix
  let r = P.resolve(p)
  if (r.length > P.parse(r).root.length) r = r.replace(/[\\/]+$/, '')
  return caseInsensitive(platform) ? r.toLowerCase() : r
}

function isInside(childKey, parentKey, P) {
  const rel = P.relative(parentKey, childKey)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + P.sep) && !P.isAbsolute(rel))
}

// ---------- protected folders ----------
export function getDenylist({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    return {
      platform,
      // the folder itself AND everything inside it is refused
      inside: [env.SystemRoot, env.windir, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.ProgramData].filter(Boolean),
      // only the folder itself is refused (its children are fine)
      equal: [home, path.win32.dirname(home)]
    }
  }
  return {
    platform,
    inside: ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/libx32', '/proc', '/run', '/sbin', '/sys', '/usr', '/var', '/System', '/Library', '/private'],
    equal: ['/home', '/Users', '/mnt', '/media', '/opt', '/root', home]
  }
}

/** Returns a human-readable reason if the path must not be watched/used, else null. */
export function isDeniedPath(p, deny = getDenylist()) {
  const platform = deny.platform
  const P = platform === 'win32' ? path.win32 : path.posix
  const key = pathKey(p, platform)
  if (P.parse(key).root === key) return 'That is a drive or filesystem root, which is not allowed.'
  for (const e of deny.equal) {
    if (e && pathKey(e, platform) === key) return 'That is a protected system or home folder. Choose a subfolder instead.'
  }
  for (const e of deny.inside) {
    if (e && isInside(key, pathKey(e, platform), P)) return 'That folder is part of the operating system, which is not allowed.'
  }
  return null
}

/**
 * Validate a folder the user wants to WATCH.
 * Resolves symlinks first, so a link pointing at a protected folder is refused too.
 */
export function validateFolderPath(input, { existing = [], max = 3, denylist = getDenylist() } = {}) {
  const fail = (reason) => ({ ok: false, reason })
  if (typeof input !== 'string' || input.trim() === '') return fail('No folder was selected.')
  let real
  try {
    real = fs.realpathSync(path.resolve(input))
    if (!fs.statSync(real).isDirectory()) return fail('That path is not a folder.')
  } catch {
    return fail('That folder does not exist or cannot be read.')
  }
  const denied = isDeniedPath(real, denylist)
  if (denied) return fail(denied)
  if (existing.some((e) => pathKey(e) === pathKey(real))) return fail('That folder is already being watched.')
  if (existing.length >= max) return fail(`You can watch at most ${max} folders at once. Remove one first.`)
  return { ok: true, path: real }
}

/** Validate a folder a rule wants to move/copy files INTO. (It may not exist yet.) */
export function validateDestination(input, { denylist = getDenylist() } = {}) {
  const fail = (reason) => ({ ok: false, reason })
  if (typeof input !== 'string' || input.trim() === '') return fail('Choose a destination folder.')
  if (!path.isAbsolute(input)) return fail('The destination must be a full path.')
  const resolved = path.resolve(input)
  const denied = isDeniedPath(resolved, denylist)
  if (denied) return fail(denied)
  return { ok: true, path: resolved }
}
