// Pre-flight checks on a destination path, so a hopeless operation is reported instead of attempted.
import path from 'node:path'

const MAX_NAME_BYTES = 255
const WIN_MAX_PATH = 259
const POSIX_MAX_PATH = 4095

/** @returns a human-readable problem, or null when the path is fine. */
export function checkDestination(dest, platform = process.platform) {
  if (!dest) return null
  const name = path.basename(dest)
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
    return `The file name is too long (${Buffer.byteLength(name, 'utf8')} bytes; the limit is ${MAX_NAME_BYTES}).`
  }
  const limit = platform === 'win32' ? WIN_MAX_PATH : POSIX_MAX_PATH
  if (dest.length > limit) return `The full path is too long (${dest.length} characters; the limit is ${limit}).`
  return null
}
