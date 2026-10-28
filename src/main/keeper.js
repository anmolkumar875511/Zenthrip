// The Keeper wires everything together:
//   watcher -> queue -> planner -> loop guard -> executor (the only writer) -> files + ledger
// All changes to files go through ONE lock, so a sweep, an undo and a watcher event can never race.
import fs from 'node:fs'
import path from 'node:path'
import { EventQueue, makeKey } from '../engine/queue.js'
import { readFacts, fileIdOf } from '../engine/facts.js'
import { planFile, makeCtx } from '../engine/planner.js'
import { isIgnoredFile, validateFolderPath } from '../engine/paths.js'
import { checkDestination } from '../engine/checks.js'
import { Mutex } from '../engine/mutex.js'
import { LoopGuard } from '../engine/loopGuard.js'
import { createExecutor } from '../engine/executor.js'
import { createUndo } from '../engine/undo.js'
import { recoverLedger } from '../engine/recovery.js'
import { AbortSweepError } from '../engine/errors.js'
import { FolderWatcher } from './watcher.js'
import { MAX_WATCHED_FOLDERS } from '../shared/fields.js'
import * as foldersDb from '../db/folders.js'
import * as rulesDb from '../db/rules.js'
import * as ledger from '../db/ledger.js'
import * as settingsDb from '../db/settings.js'

const BURST_GAP_MS = 5000 // files that arrive within 5 s of each other share one "sweep" (so a whole burst can be undone at once)
const PREVIEW_TTL_MS = 10 * 60_000

export function createKeeper({
  db,
  emit,
  notify = () => {},
  trashRoot,
  watcherOptions = {},
  queueOptions = {},
  denylist,
  fsx = fs,
  executorHooks = {},
  sleep,
  now = () => Date.now()
}) {
  trashRoot = trashRoot ?? path.join(process.cwd(), '.zenthrip-trash')
  let seq = 0
  const note = (level, message, extra = {}) => emit('activity', { id: ++seq, ts: Date.now(), level, message, ...extra })
  const changed = () => emit('ledger:changed', { ts: Date.now() })

  const lock = new Mutex()
  const settings = () => settingsDb.getSettings(db)
  const loopGuard = new LoopGuard({ hopLimit: settings().hopLimit })
  const executor = createExecutor({ db, trashRoot, getSettings: settings, loopGuard, fsx, sleep, hooks: executorHooks })
  const undoer = createUndo({ db, trashRoot, fsx, loopGuard })

  // ---------- progress (throttled to ~4 updates per second) ----------
  const progress = { queued: 0, processed: 0, failed: 0, active: false }
  let progressTimer = null
  const pushProgress = (force = false) => {
    if (force) {
      clearTimeout(progressTimer)
      progressTimer = null
      return emit('progress', { ...progress })
    }
    if (progressTimer) return
    progressTimer = setTimeout(() => {
      progressTimer = null
      emit('progress', { ...progress })
    }, 250)
  }

  // ---------- sweeps ----------
  let burst = { id: null, last: 0 }
  const arrivalSweepId = () => {
    const t = now()
    if (!burst.id || t - burst.last > BURST_GAP_MS) burst = { id: ledger.newSweepId('a'), last: t }
    burst.last = t
    return burst.id
  }

  const fingerprintOf = (facts, ruleId) => ({ path: facts.path, size: facts.sizeBytes, mtime: facts.mtimeMs, ruleId })

  function reportResults(facts, plan, results) {
    const failed = results.filter((r) => r.status === 'failed')
    progress.processed++
    if (failed.length) progress.failed++
    pushProgress()
    note(failed.length ? 'error' : 'info', 'executed', {
      file: facts.fileName,
      path: facts.path,
      ruleName: plan.ruleName,
      results: results.map((r) => ({ op: r.op, src: r.src, dest: r.dest, status: r.status, error: r.error ?? null })),
      warnings: plan.warnings
    })
    changed()
  }

  /**
   * Run one planned file through the loop guard and the executor. Must be called inside the lock.
   * @returns 'done' | 'loop' | 'already' | 'noop' | 'stopped'
   */
  async function actOn(facts, plan, { sweepId, auto }) {
    if (!plan.steps.length) return 'noop'
    // A copy leaves the original in place, so remember the exact file version we already copied
    // (otherwise a restart, a scheduled run or a second sweep would copy it again). Moves need no memory:
    // the file is gone from its old path.
    const copies = plan.steps.some((s) => s.op === 'copy')
    const fp = copies ? fingerprintOf(facts, plan.ruleId) : null
    if (fp && ledger.hasFingerprint(db, fp)) return 'already'

    const id = fileIdOf(facts.path)
    if (loopGuard.wouldExceed(id)) {
      loopGuard.freeze(id)
      ledger.insertFinal(db, {
        sweepId,
        ruleId: plan.ruleId,
        op: plan.steps[0].op,
        src: facts.path,
        dest: plan.steps[0].dest,
        status: 'loop_broken',
        error: `Loop stopped: Zenthrip has already acted on this file ${loopGuard.hops(id)} times in a row. The file is left alone.`
      })
      note('error', `Loop detected on ${facts.fileName}: it was moved around ${loopGuard.hops(id)} times, so it is now frozen.`, { file: facts.fileName, loop: true })
      notify('Loop stopped', `${facts.fileName} kept triggering rules, so Zenthrip froze it. Check your rule order.`)
      progress.failed++
      pushProgress()
      changed()
      return 'loop'
    }

    let results
    try {
      results = await executor.executePlan({ sweepId, ruleId: plan.ruleId, steps: plan.steps, fingerprint: fp })
    } catch (err) {
      if (err instanceof AbortSweepError) {
        reportResults(facts, plan, err.results ?? [])
        note('error', err.message)
        notify('Zenthrip stopped', err.message)
        return 'stopped'
      }
      throw err
    }
    if (results.some((r) => r.status === 'done')) {
      loopGuard.record(id)
      for (const r of results) {
        if (r.status === 'done' && r.op === 'copy') loopGuard.inherit(fileIdOf(r.dest), id)
      }
    }
    reportResults(facts, plan, results)
    return 'done'
  }

  // ---------- automatic path: watcher -> queue ----------
  async function handleItem(item) {
    if (settings().paused) return
    return lock.run(async () => {
      const facts = readFacts(item.path)
      if (!facts) return
      if (loopGuard.isSelfCaused(item.path)) return // our own in-place change: never re-process it
      if (loopGuard.isFrozen(fileIdOf(item.path))) return
      loopGuard.hopLimit = settings().hopLimit
      const plan = planFile(facts, rulesDb.listRules(db), makeCtx({ folderId: item.folderId, trigger: 'arrival', now: now() }))
      if (!plan) return void note('info', 'no-match', { file: facts.fileName, path: facts.path })
      if (!plan.steps.length) return void note('info', 'no-op', { file: facts.fileName, ruleName: plan.ruleName })
      const outcome = await actOn(facts, plan, { sweepId: arrivalSweepId(), auto: true })
      if (outcome === 'already') note('info', 'already-handled', { file: facts.fileName, ruleName: plan.ruleName })
      return { forget: !fsx.existsSync(item.path) }
    })
  }

  const queue = new EventQueue({
    handler: handleItem,
    onError: (err, item) => {
      progress.failed++
      note('error', `Could not process ${path.basename(item.path)}: ${err.message}`)
    },
    ...queueOptions
  })

  const watcher = new FolderWatcher({
    onFile: ({ folderId, path: filePath }) => {
      if (isIgnoredFile(path.basename(filePath))) return
      if (settings().paused) return
      let st
      try {
        st = fs.lstatSync(filePath)
      } catch {
        return
      }
      if (!st.isFile()) return
      const status = queue.enqueue({ key: makeKey(filePath, st.size, st.mtimeMs), folderId, path: filePath })
      if (status === 'queued') {
        progress.queued++
        pushProgress()
      }
      if (status === 'full') note('warn', 'Too many files arrived at once; some were skipped.')
    },
    onError: (err) => note('error', `Watcher error: ${err.message}`),
    ...watcherOptions
  })

  // ---------- preview (dry run) and sweeps ----------
  /** Direct child files of a folder that rules may act on. */
  function listFiles(folderPath) {
    const out = []
    for (const e of fsx.readdirSync(folderPath, { withFileTypes: true })) {
      if (!e.isFile() || isIgnoredFile(e.name)) continue
      out.push(path.join(folderPath, e.name))
    }
    return out
  }

  /** Pure planning pass over the existing files. Reads the disk, writes NOTHING. */
  function buildSweepPlan({ folderId = null, trigger = 'any', onlyRuleIds = null } = {}) {
    const rules = rulesDb.listRules(db)
    const t = now()
    const reserved = new Set() // destinations claimed within this batch, so two files never collide
    const rows = []
    const folders = foldersDb.listFolders(db).filter((f) => folderId == null || f.id === folderId)
    for (const folder of folders) {
      if (!fsx.existsSync(folder.path)) continue
      const ctx = makeCtx({ trigger, onlyRuleIds, folderId: folder.id, now: t, reserved })
      const factsList = listFiles(folder.path).map((p) => readFacts(p, t)).filter(Boolean)
      factsList.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      for (const facts of factsList) {
        const plan = planFile(facts, rules, ctx)
        const row = {
          folderId: folder.id,
          folderPath: folder.path,
          file: facts.fileName,
          path: facts.path,
          sizeBytes: facts.sizeBytes,
          mtimeMs: facts.mtimeMs,
          ruleId: plan?.ruleId ?? null,
          ruleName: plan?.ruleName ?? null,
          steps: plan?.steps ?? [],
          warnings: plan?.warnings ?? [],
          issues: [],
          outcome: 'no-match'
        }
        if (plan) {
          row.outcome = plan.steps.length ? 'planned' : 'no-op'
          for (const s of plan.steps) {
            const problem = checkDestination(s.dest)
            if (problem) row.issues.push(problem)
          }
          if (row.issues.length) row.outcome = 'will-fail'
          const copies = plan.steps.some((s) => s.op === 'copy')
          if (copies && ledger.hasFingerprint(db, { path: facts.path, size: facts.sizeBytes, mtime: facts.mtimeMs, ruleId: plan.ruleId })) {
            row.outcome = 'already-done'
          }
          if (plan.steps.some((s) => s.op === 'script')) row.hasScript = true
        }
        rows.push(row)
      }
    }
    return rows
  }

  const summarize = (rows) => ({
    files: rows.length,
    planned: rows.filter((r) => r.outcome === 'planned').length,
    willFail: rows.filter((r) => r.outcome === 'will-fail').length,
    noMatch: rows.filter((r) => r.outcome === 'no-match').length,
    unchanged: rows.filter((r) => r.outcome === 'no-op' || r.outcome === 'already-done').length,
    trash: rows.filter((r) => r.steps.some((s) => s.op === 'trash')).length,
    scripts: rows.filter((r) => r.hasScript).length
  })

  let lastPreview = null

  async function executeRows(rows, { kind }) {
    const sweepId = ledger.newSweepId(kind)
    const out = { sweepId, done: 0, failed: 0, skipped: 0, loops: 0, stopped: false }
    progress.active = true
    pushProgress(true)
    try {
      for (const row of rows) {
        if (!row.steps.length || row.outcome === 'already-done') continue
        const facts = readFacts(row.path, now())
        // "Run" executes exactly the plan that was shown: if the file changed since, do NOT guess.
        if (!facts || facts.sizeBytes !== row.sizeBytes || Math.round(facts.mtimeMs) !== Math.round(row.mtimeMs)) {
          ledger.insertFinal(db, { sweepId, ruleId: row.ruleId, op: row.steps[0].op, src: row.path, dest: row.steps[0].dest, status: 'skipped', error: 'The file changed or disappeared after the preview, so it was left alone.' })
          out.skipped++
          continue
        }
        const plan = { ruleId: row.ruleId, ruleName: row.ruleName, steps: row.steps, warnings: row.warnings }
        const outcome = await actOn(facts, plan, { sweepId, auto: false })
        if (outcome === 'done') out.done++
        else if (outcome === 'loop') out.loops++
        else if (outcome === 'stopped') {
          out.stopped = true
          break
        }
      }
    } finally {
      progress.active = false
      pushProgress(true)
      changed()
    }
    const entries = ledger.bySweep(db, sweepId)
    out.failed = entries.filter((e) => e.status === 'failed').length
    out.skipped = entries.filter((e) => e.status === 'skipped').length
    return out
  }

  // ---------- public API ----------
  return {
    loopGuard,

    /** Start watching every saved folder that still exists, after repairing anything a crash left half-done. */
    async start() {
      const report = await lock.run(async () => {
        const r = recoverLedger({ db, fsx, log: (m) => note('warn', m) })
        this.purgeTrashSync()
        return r
      })
      this.recovery = report
      if (report.pending || report.undoFinished || report.undoRolledBack || report.integrity !== 'ok') {
        const parts = []
        if (report.completed) parts.push(`${report.completed} finished`)
        if (report.interrupted) parts.push(`${report.interrupted} never started`)
        if (report.needsReview) parts.push(`${report.needsReview} need review`)
        note(report.needsReview || report.integrity !== 'ok' ? 'warn' : 'info', `Recovered from an unexpected shutdown: ${parts.join(', ') || 'ledger checked'}.`, { recovery: report })
        changed()
      }
      for (const f of foldersDb.listFolders(db)) {
        if (fsx.existsSync(f.path)) await watcher.add(f.id, f.path)
        else note('warn', `Watched folder is missing: ${f.path}`)
      }
      return report
    },

    listFolders() {
      return foldersDb.listFolders(db).map((f) => ({ ...f, exists: fsx.existsSync(f.path) }))
    },

    async addFolder(input) {
      const existing = foldersDb.listFolders(db).map((f) => f.path)
      const check = validateFolderPath(input, { existing, max: MAX_WATCHED_FOLDERS, ...(denylist ? { denylist } : {}) })
      if (!check.ok) return { ok: false, error: check.reason }
      let folder
      try {
        folder = foldersDb.addFolder(db, check.path, MAX_WATCHED_FOLDERS)
      } catch (err) {
        return { ok: false, error: err.message }
      }
      try {
        await watcher.add(folder.id, folder.path)
      } catch (err) {
        foldersDb.removeFolder(db, folder.id)
        return { ok: false, error: `Could not watch that folder: ${err.message}` }
      }
      return { ok: true, folder: { ...folder, exists: true } }
    },

    async removeFolder(id) {
      await watcher.remove(id)
      return { ok: foldersDb.removeFolder(db, id) }
    },

    // ----- pause / resume -----
    status() {
      return { paused: settings().paused, folders: watcher.count, progress: { ...progress } }
    },
    setPaused(paused) {
      settingsDb.setSettings(db, { paused: Boolean(paused) })
      emit('status', this.status())
      return this.status()
    },

    // ----- B4: dry run (zero writes) -----
    preview({ folderId = null } = {}) {
      const rows = buildSweepPlan({ folderId })
      const previewId = `p-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      lastPreview = { previewId, createdAt: now(), rows, folderId }
      return {
        previewId,
        summary: summarize(rows),
        rows: rows.map((r, i) => ({ id: i, ...r }))
      }
    },

    /** Execute EXACTLY the plan the user was shown. */
    async runPreview(previewId) {
      if (!lastPreview || lastPreview.previewId !== previewId) return { ok: false, error: 'That preview is out of date. Run the preview again.' }
      if (now() - lastPreview.createdAt > PREVIEW_TTL_MS) return { ok: false, error: 'That preview is too old. Run the preview again.' }
      const { rows } = lastPreview
      lastPreview = null
      const result = await lock.run(() => executeRows(rows, { kind: 'm' }))
      return { ok: true, ...result }
    },

    /** Plan and execute straight away (tray: "Run sweep now"). */
    async runNow({ folderId = null } = {}) {
      return lock.run(() => executeRows(buildSweepPlan({ folderId }), { kind: 'm' }))
    },

    /** Time-based rules that are due: plan only those rules over the existing files, then execute. */
    async runScheduled(ruleIds) {
      if (!ruleIds?.length || settings().paused) return { ok: true, skipped: true }
      return lock.run(async () => {
        const rows = buildSweepPlan({ trigger: 'schedule', onlyRuleIds: ruleIds })
        const res = await executeRows(rows, { kind: 's' })
        return { ok: true, ...res }
      })
    },

    // ----- B5: ledger and undo -----
    listLedger: (filters) => ledger.listLedger(db, filters),
    listSweeps: (limit) => ledger.sweepSummaries(db, limit),
    async undoEntry(id) {
      const res = await lock.run(() => undoer.undoEntry(id))
      changed()
      return res
    },
    async undoSweep(sweepId) {
      const res = await lock.run(() => undoer.undoSweep(sweepId))
      changed()
      return { ok: true, ...res }
    },

    // ----- Keeper Trash -----
    trashInfo() {
      let files = 0
      let bytes = 0
      const walk = (dir) => {
        let entries = []
        try {
          entries = fsx.readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          const p = path.join(dir, e.name)
          if (e.isDirectory()) walk(p)
          else {
            files++
            try {
              bytes += fsx.lstatSync(p).size
            } catch {
              /* ignore */
            }
          }
        }
      }
      walk(trashRoot)
      return { path: trashRoot, files, bytes }
    },
    async emptyTrash() {
      await lock.run(async () => {
        await fsx.promises.rm(trashRoot, { recursive: true, force: true })
      })
      changed()
      return { ok: true }
    },
    /** Remove trash older than the retention period (0 = keep forever). */
    purgeTrashSync() {
      const days = settings().trashRetentionDays
      if (!days || !fsx.existsSync(trashRoot)) return 0
      const cutoff = now() - days * 86_400_000
      let removed = 0
      const sweepDirs = []
      for (const top of fsx.readdirSync(trashRoot, { withFileTypes: true })) {
        if (!top.isDirectory()) continue
        const dir = path.join(trashRoot, top.name)
        if (top.name === '_undone-copies') for (const d of fsx.readdirSync(dir, { withFileTypes: true })) d.isDirectory() && sweepDirs.push(path.join(dir, d.name))
        else sweepDirs.push(dir)
      }
      for (const dir of sweepDirs) {
        try {
          if (fsx.statSync(dir).mtimeMs < cutoff) {
            fsx.rmSync(dir, { recursive: true, force: true })
            removed++
          }
        } catch {
          /* ignore */
        }
      }
      return removed
    },

    async idle() {
      await queue.idle()
      await lock.run(() => {})
    },

    async stop() {
      await watcher.closeAll()
      clearTimeout(progressTimer)
    }
  }
}
