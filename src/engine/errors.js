// Turns raw Node file-system errors into decisions: retry, skip, stop, or report.
//   kind: 'locked' | 'toolong' | 'gone' | 'full' | 'cross-device' | 'script' | 'other'
export class AbortSweepError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AbortSweepError'
  }
}

export function classify(err) {
  const code = err?.code
  switch (code) {
    case 'EBUSY':
    case 'EPERM':
    case 'EACCES':
    case 'ETXTBSY':
      return { kind: 'locked', retryable: true, skip: false, fatal: false, message: 'The file is locked or in use, or Zenthrip does not have permission to change it.' }
    case 'ENAMETOOLONG':
      return { kind: 'toolong', retryable: false, skip: false, fatal: false, message: err.userMessage || 'The new file name or path is too long for this system.' }
    case 'ENOENT':
      return { kind: 'gone', retryable: false, skip: true, fatal: false, message: 'The file no longer exists (it was moved or deleted before Zenthrip got to it).' }
    case 'ENOSPC':
    case 'EDQUOT':
      return { kind: 'full', retryable: false, skip: false, fatal: true, message: 'The disk is full. The sweep was stopped.' }
    case 'EXDEV':
      return { kind: 'cross-device', retryable: false, skip: false, fatal: false, message: 'The destination is on another drive.' }
    case 'ZSCRIPT':
      return { kind: 'script', retryable: false, skip: false, fatal: false, message: err.message }
    default:
      return { kind: 'other', retryable: false, skip: false, fatal: false, message: err?.message || String(err) }
  }
}

/** Error with a Node-style code, so classify() treats our own pre-checks like real fs errors. */
export function coded(code, message) {
  const e = new Error(message)
  e.code = code
  e.userMessage = message
  return e
}
