// Custom script action (Advanced tier). Safety rules:
//   * no shell: the script is started with execFile and the file path is passed as an ARGUMENT
//     (and as the ZENTHRIP_FILE environment variable)
//   * a hard timeout kills the child
//   * a script must have been explicitly trusted by the user; if its content changes, trust is lost
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { SCRIPT_TIMEOUT_MS } from '../shared/fields.js'

export function hashScript(scriptPath) {
  return createHash('sha256').update(fs.readFileSync(scriptPath)).digest('hex')
}

/** Which program runs a script, decided by its extension. Anything else is executed directly. */
export function interpreterFor(scriptPath, { platform = process.platform, execPath = process.execPath } = {}) {
  const ext = path.extname(scriptPath).toLowerCase()
  switch (ext) {
    case '.js':
    case '.mjs':
    case '.cjs':
      // Electron's own binary behaves like plain Node with this flag.
      return { cmd: execPath, args: [scriptPath], env: { ELECTRON_RUN_AS_NODE: '1' } }
    case '.py':
      return { cmd: platform === 'win32' ? 'python' : 'python3', args: [scriptPath], env: {} }
    case '.sh':
      return { cmd: 'sh', args: [scriptPath], env: {} }
    case '.ps1':
      return { cmd: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], env: {} }
    case '.bat':
    case '.cmd':
      return { cmd: 'cmd.exe', args: ['/d', '/c', scriptPath], env: {} }
    default:
      return { cmd: scriptPath, args: [], env: {} }
  }
}

/** @returns {Promise<{exitCode:number|null, stdout:string, stderr:string, timedOut:boolean}>} */
export function runScript(scriptPath, filePath, { timeoutMs = SCRIPT_TIMEOUT_MS, interpreter = interpreterFor(scriptPath) } = {}) {
  return new Promise((resolve) => {
    execFile(
      interpreter.cmd,
      [...interpreter.args, filePath],
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        cwd: path.dirname(filePath),
        env: { ...process.env, ...interpreter.env, ZENTHRIP_FILE: filePath }
      },
      (err, stdout, stderr) => {
        const timedOut = Boolean(err && err.killed && err.signal)
        const exitCode = err ? (typeof err.code === 'number' ? err.code : null) : 0
        resolve({ exitCode, stdout: String(stdout).slice(0, 4000), stderr: String(stderr).slice(0, 4000), timedOut, spawnError: err && typeof err.code === 'string' ? err.code : null })
      }
    )
  })
}
