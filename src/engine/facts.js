// "File facts" are everything a rule is allowed to look at.
// They are plain data, so the planner stays a pure function.
import fs from 'node:fs'
import path from 'node:path'

const DAY_MS = 86_400_000

export function buildFacts(filePath, stat, now = Date.now()) {
  const fileName = path.basename(filePath)
  const dotExt = path.extname(fileName) // ".PDF" ('' for ".bashrc" or "README")
  const stem = dotExt ? fileName.slice(0, -dotExt.length) : fileName
  return {
    path: filePath,
    dir: path.dirname(filePath),
    fileName,
    stem,
    extRaw: dotExt.slice(1), // original case, used by rename templates
    ext: dotExt.slice(1).toLowerCase(), // lower case, used by conditions
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    ageDays: Math.max(0, (now - stat.mtimeMs) / DAY_MS)
  }
}

/** Read facts from disk. Returns null for anything that is not a regular file (dirs, symlinks...). */
export function readFacts(filePath, now = Date.now()) {
  let st
  try {
    st = fs.lstatSync(filePath)
  } catch {
    return null
  }
  if (!st.isFile()) return null
  return buildFacts(filePath, st, now)
}

/**
 * A stable identity for a file that survives renames and moves on the same volume
 * (device + inode; on Windows the NTFS file index). Used by the loop guard to follow one file around.
 */
export function fileIdOf(filePath) {
  try {
    const st = fs.lstatSync(filePath, { bigint: true })
    if (st.ino && st.ino !== 0n) return `${st.dev}:${st.ino}`
  } catch {
    /* fall through */
  }
  return null
}
