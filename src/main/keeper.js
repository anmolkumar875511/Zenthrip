// The Keeper wires everything together:
//   watcher -> queue -> planner -> (Phase 2-3: report the plan, Phase 5: execute it)
import fs from 'node:fs'
import path from 'node:path'
import { EventQueue, makeKey } from '../engine/queue.js'
import { readFacts } from '../engine/facts.js'
import { planFile, makeCtx } from '../engine/planner.js'
import { isIgnoredFile, validateFolderPath } from '../engine/paths.js'
import { FolderWatcher } from './watcher.js'
import { MAX_WATCHED_FOLDERS } from '../shared/fields.js'
import * as foldersDb from '../db/folders.js'
import * as rulesDb from '../db/rules.js'

export function createKeeper({ db, emit, watcherOptions = {}, queueOptions = {}, denylist }) {
  let seq = 0
  const note = (level, message, extra = {}) =>
    emit('activity', { id: ++seq, ts: Date.now(), level, message, ...extra })

  async function handleItem(item) {
    const facts = readFacts(item.path)
    if (!facts) return // vanished or not a regular file
    const plan = planFile(facts, rulesDb.listRules(db), makeCtx({ folderId: item.folderId }))
    // Phase 5 will EXECUTE the plan (journal first, act second). For now we only report it.
    note('info', plan ? 'planned' : 'no-match', {
      folderId: item.folderId,
      file: facts.fileName,
      path: facts.path,
      ruleName: plan?.ruleName ?? null,
      steps: plan?.steps ?? [],
      warnings: plan?.warnings ?? []
    })
  }

  const queue = new EventQueue({
    handler: handleItem,
    onError: (err, item) => note('error', `Could not process ${path.basename(item.path)}: ${err.message}`),
    ...queueOptions
  })

  const watcher = new FolderWatcher({
    onFile: ({ folderId, path: filePath }) => {
      if (isIgnoredFile(path.basename(filePath))) return
      let st
      try {
        st = fs.lstatSync(filePath)
      } catch {
        return
      }
      if (!st.isFile()) return
      const status = queue.enqueue({ key: makeKey(filePath, st.size, st.mtimeMs), folderId, path: filePath })
      if (status === 'full') note('warn', 'Too many files arrived at once; some were skipped.')
    },
    onError: (err) => note('error', `Watcher error: ${err.message}`),
    ...watcherOptions
  })

  return {
    /** Start watching every saved folder that still exists. */
    async start() {
      for (const f of foldersDb.listFolders(db)) {
        if (fs.existsSync(f.path)) await watcher.add(f.id, f.path)
        else note('warn', `Watched folder is missing: ${f.path}`)
      }
    },

    listFolders() {
      return foldersDb.listFolders(db).map((f) => ({ ...f, exists: fs.existsSync(f.path) }))
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

    async stop() {
      await watcher.closeAll()
    }
  }
}
