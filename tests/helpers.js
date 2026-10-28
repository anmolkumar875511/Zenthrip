import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildFacts } from '../src/engine/facts.js'

export const DAY = 86_400_000
export const NOW = new Date(2026, 9, 24, 12, 0, 0).getTime() // 24 Oct 2026, local time

/** Facts for a pretend file, without touching the disk. */
export function facts(file, { size = 1000, ageDays = 0, dir = '/watch' } = {}) {
  const p = path.resolve(dir, file)
  return buildFacts(p, { size, mtimeMs: NOW - ageDays * DAY }, NOW)
}

export function tmpDir(prefix = 'zenthrip-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

export async function waitFor(fn, { timeout = 8000, interval = 25 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error('waitFor timed out')
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

import { createHash } from 'node:crypto'
import { openDb } from '../src/db/db.js'
import { createExecutor } from '../src/engine/executor.js'
import { createUndo } from '../src/engine/undo.js'
import { LoopGuard } from '../src/engine/loopGuard.js'

/** Every file under `dir` with a hash of its content: lets a test assert "back to exactly how it started". */
export function snapshot(dir) {
  const out = {}
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[path.relative(dir, p)] = createHash('sha1').update(fs.readFileSync(p)).digest('hex')
    }
  }
  walk(dir)
  return out
}

export const write = (dir, name, content = name) => {
  const p = path.join(dir, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
  return p
}

/** A ready-to-use engine: in-memory database, executor, undo and a temp Keeper Trash. */
export function makeEngine({ fsx = fs, hooks = {}, settings = {}, runScript } = {}) {
  const db = openDb()
  const trashRoot = path.join(tmpDir('zenthrip-trash-'), 'trash')
  const loopGuard = new LoopGuard({ hopLimit: 3 })
  const executor = createExecutor({
    db,
    trashRoot,
    getSettings: () => ({ retryCount: 3, ...settings }),
    loopGuard,
    fsx,
    sleep: async () => {},
    hooks,
    ...(runScript ? { runScript } : {})
  })
  const undo = createUndo({ db, trashRoot, fsx, loopGuard })
  return { db, trashRoot, loopGuard, executor, undo }
}

/** fs with some operations rigged to fail, to simulate locked files, other drives, full disks... */
export function rigFs(overrides) {
  return { ...fs, promises: { ...fs.promises, ...overrides } }
}
