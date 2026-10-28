// The EXECUTOR is the only code that changes files. For every step:
//   1. write a ledger row with status "pending" (committed to disk before anything happens)
//   2. perform the operation
//   3. mark the row "done" (or "failed" with a reason)
// If the app dies between 1 and 3, recovery.js reads the "pending" rows and works out what really happened.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveCollision } from './actions.js'
import { classify, coded, AbortSweepError } from './errors.js'
import { checkDestination } from './checks.js'
import { runScript as defaultRunScript, hashScript } from './scripts.js'
import { trustedScripts } from '../db/settings.js'
import * as ledger from '../db/ledger.js'

export const PARTIAL_SUFFIX = '.zenthrip-partial'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const exists = (fsx, p) => {
  try {
    fsx.lstatSync(p)
    return true
  } catch {
    return false
  }
}

/** Copy to "<dest>.zenthrip-partial", verify the size, then rename into place. Never leaves a half file under the real name. */
export async function safeCopy(fsx, src, dest) {
  const partial = dest + PARTIAL_SUFFIX
  await fsx.promises.mkdir(path.dirname(dest), { recursive: true })
  await fsx.promises.copyFile(src, partial, fs.constants.COPYFILE_EXCL)
  try {
    const [a, b] = await Promise.all([fsx.promises.lstat(src), fsx.promises.lstat(partial)])
    if (a.size !== b.size) throw new Error('The copy did not match the original (size differs).')
    await fsx.promises.rename(partial, dest)
  } catch (err) {
    await fsx.promises.unlink(partial).catch(() => {})
    throw err
  }
}

/** Same-volume: one atomic rename. Another volume (EXDEV): safe copy, then delete the source. */
export async function moveFile(fsx, src, dest) {
  await fsx.promises.mkdir(path.dirname(dest), { recursive: true })
  try {
    await fsx.promises.rename(src, dest)
  } catch (err) {
    if (err.code !== 'EXDEV') throw err
    await safeCopy(fsx, src, dest)
    await fsx.promises.unlink(src)
  }
}

export function createExecutor({
  db,
  trashRoot,
  getSettings = () => ({ retryCount: 3 }),
  loopGuard = null,
  fsx = fs,
  sleep = wait,
  runScript = defaultRunScript,
  hooks = {} // { afterJournal(id, step), afterAct(id, step) } : used by crash tests
}) {
  /** Work out where this step really goes (names can have been taken since planning). */
  function resolveStep(step, current, sweepId) {
    const taken = (p) => exists(fsx, p)
    switch (step.op) {
      case 'rename':
        return { src: current, dest: resolveCollision(path.join(path.dirname(current), path.basename(step.dest)), taken, new Set()) }
      case 'move':
      case 'copy':
        return { src: current, dest: resolveCollision(path.join(path.dirname(step.dest), path.basename(current)), taken, new Set()) }
      case 'trash':
        return { src: current, dest: path.join(trashRoot, sweepId, `${randomUUID().slice(0, 8)}_${path.basename(current)}`) }
      default:
        return { src: current, dest: null }
    }
  }

  async function perform(op, src, dest, step) {
    switch (op) {
      case 'rename':
      case 'move':
      case 'trash':
        return moveFile(fsx, src, dest)
      case 'copy':
        return safeCopy(fsx, src, dest)
      case 'script': {
        const trusted = trustedScripts(db)
        const known = trusted[step.script]
        let hash
        try {
          hash = hashScript(step.script)
        } catch {
          throw Object.assign(new Error('The script file could not be read.'), { code: 'ZSCRIPT' })
        }
        if (!known || known !== hash) throw Object.assign(new Error('This script is not trusted (or it changed since you trusted it). Open the rule and confirm it again.'), { code: 'ZSCRIPT' })
        const res = await runScript(step.script, src)
        if (res.timedOut) throw Object.assign(new Error('The script ran too long and was stopped.'), { code: 'ZSCRIPT', result: res })
        if (res.spawnError) throw Object.assign(new Error(`The script could not be started (${res.spawnError}).`), { code: 'ZSCRIPT', result: res })
        if (res.exitCode !== 0) throw Object.assign(new Error(`The script exited with code ${res.exitCode}.`), { code: 'ZSCRIPT', result: res })
        return res
      }
      default:
        throw new Error(`Unknown operation ${op}`)
    }
  }

  async function withRetries(fn) {
    const max = Math.max(0, Number(getSettings().retryCount ?? 3))
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn()
      } catch (err) {
        const c = classify(err)
        if (!c.retryable || attempt >= max) throw err
        await sleep(100 * 2 ** attempt)
      }
    }
  }

  /** Runs ONE step. Never throws except AbortSweepError (disk full). */
  async function executeStep(step, current, ctx) {
    const { sweepId, ruleId } = ctx
    const { src, dest } = resolveStep(step, current, sweepId)
    const base = { sweepId, ruleId, op: step.op, src, dest, detail: step.op === 'script' ? { script: step.script } : null }

    if (!exists(fsx, src)) {
      const id = ledger.insertFinal(db, { ...base, status: 'skipped', error: 'The file vanished before it could be processed.' })
      return { id, op: step.op, src, dest, status: 'skipped', error: 'The file vanished before it could be processed.' }
    }
    const problem = checkDestination(dest)
    if (problem) {
      const id = ledger.insertFinal(db, { ...base, status: 'failed', error: problem })
      return { id, op: step.op, src, dest, status: 'failed', error: problem, kind: 'toolong' }
    }

    const id = ledger.insertPending(db, base) // committed (synchronous=FULL) BEFORE any file is touched
    hooks.afterJournal?.(id, { ...step, src, dest })
    try {
      const res = await withRetries(() => perform(step.op, src, dest, step))
      hooks.afterAct?.(id, { ...step, src, dest })
      if (step.op === 'script') ledger.markDone(db, id, { script: step.script, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr })
      else ledger.markDone(db, id)
      if (loopGuard && dest && step.op === 'rename') loopGuard.markSelfCaused(dest) // an in-place rename must not trigger rules again
      if (loopGuard && step.op === 'trash') loopGuard.markSelfCaused(dest)
      return { id, op: step.op, src, dest, status: 'done' }
    } catch (err) {
      const c = classify(err)
      const status = c.skip ? 'skipped' : 'failed'
      if (status === 'skipped') ledger.markSkipped(db, id, c.message)
      else ledger.markFailed(db, id, c.message, err.result ? { script: step.script, exitCode: err.result.exitCode, stdout: err.result.stdout, stderr: err.result.stderr } : undefined)
      const out = { id, op: step.op, src, dest, status, error: c.message, kind: c.kind }
      if (c.fatal) {
        out.fatal = true
      }
      return out
    }
  }

  return {
    /**
     * Execute every step planned for ONE file, in order.
     * If a step does not succeed, the remaining steps are recorded as skipped (they depend on it).
     * `fingerprint` = { path, size, mtime, ruleId } is stored when at least one step succeeded.
     */
    async executePlan({ sweepId, ruleId, steps, fingerprint }) {
      const results = []
      let current = steps[0]?.src
      let blocked = null
      for (const step of steps) {
        if (blocked) {
          const id = ledger.insertFinal(db, { sweepId, ruleId, op: step.op, src: current ?? step.src, dest: step.dest, status: 'skipped', error: `Skipped because an earlier step did not finish (${blocked}).` })
          results.push({ id, op: step.op, src: current ?? step.src, dest: step.dest, status: 'skipped', error: `Skipped because an earlier step did not finish.` })
          continue
        }
        const r = await executeStep(step, current, { sweepId, ruleId })
        results.push(r)
        if (r.status === 'done') {
          if (step.op === 'rename' || step.op === 'move') current = r.dest
          if (step.op === 'trash') current = null
        } else blocked = r.error ?? r.status
        if (r.fatal) {
          if (results.some((x) => x.status === 'done') && fingerprint) ledger.addFingerprint(db, fingerprint)
          throw Object.assign(new AbortSweepError(r.error), { results })
        }
      }
      if (fingerprint && results.some((r) => r.status === 'done')) ledger.addFingerprint(db, fingerprint)
      return results
    }
  }
}
