// Every renderer request lands here. The renderer is NOT trusted:
// inputs are validated, dangerous confirmations are native dialogs, and each handler returns
// { ok: true, ... } or { ok: false, error | errors }.
import fs from 'node:fs'
import path from 'node:path'
import { ipcMain, dialog } from 'electron'
import { z } from 'zod'
import { parseRule, parseSettingsPatch } from '../shared/schemas.js'
import { validateDestination } from '../engine/paths.js'
import { loopsCausedBy } from '../engine/loopGuard.js'
import { hashScript } from '../engine/scripts.js'
import { MAX_WATCHED_FOLDERS } from '../shared/fields.js'
import * as rulesDb from '../db/rules.js'
import * as settingsDb from '../db/settings.js'

const Id = z.number().int().positive()
const IdList = z.array(Id).max(1000)
const Text = z.string().min(1).max(200)
const AbsPath = z.string().min(1).max(1000)
const LedgerQuery = z
  .object({
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
    status: z.enum(['all', 'pending', 'done', 'failed', 'skipped', 'loop_broken', 'undone']).optional(),
    sweepId: Text.optional(),
    search: z.string().max(200).optional()
  })
  .default({})

export function registerIpc({ db, keeper, getWindow, appInfo, onSettingsChanged = () => {} }) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, payload) => {
      if (event.sender !== getWindow()?.webContents) return { ok: false, error: 'Untrusted sender.' }
      try {
        return await fn(payload)
      } catch (err) {
        return { ok: false, error: err.message }
      }
    })
  const invalid = (what) => ({ ok: false, error: `Invalid ${what}.` })
  const confirmNative = async (options) => {
    const res = await dialog.showMessageBox(getWindow(), { type: 'warning', noLink: true, defaultId: 0, cancelId: 0, ...options })
    return res.response === 1
  }

  const pickDirectory = async () => {
    const res = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory', 'createDirectory'] })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  }

  // ----- app -----
  handle('app:info', async () => ({ ok: true, ...appInfo(), maxFolders: MAX_WATCHED_FOLDERS }))

  // ----- folders (B1) -----
  handle('folders:list', async () => ({ ok: true, folders: keeper.listFolders() }))
  handle('folders:pick', async () => {
    const chosen = await pickDirectory()
    if (!chosen) return { ok: true, canceled: true }
    return keeper.addFolder(chosen)
  })
  handle('folders:remove', async (id) => {
    const parsed = Id.safeParse(id)
    if (!parsed.success) return invalid('folder')
    return keeper.removeFolder(parsed.data)
  })
  handle('dialog:pickDirectory', async () => ({ ok: true, path: await pickDirectory() }))

  // ----- rules (B2, B3, A1, A2) -----
  handle('rules:list', async () => ({ ok: true, rules: rulesDb.listRules(db) }))

  handle('rules:save', async (input) => {
    const allowLoop = input?.allowLoop === true
    const parsed = parseRule(input)
    if (!parsed.ok) return { ok: false, errors: parsed.errors }
    const rule = parsed.rule
    const errors = []
    const untrusted = []
    const trusted = settingsDb.trustedScripts(db)
    rule.actions.forEach((a, i) => {
      if (a.type === 'move' || a.type === 'copy') {
        const res = validateDestination(a.to)
        if (res.ok) a.to = res.path
        else errors.push({ path: `actions.${i}.to`, message: res.reason })
      } else if (a.type === 'script') {
        a.path = path.resolve(a.path)
        let hash = null
        try {
          if (!fs.statSync(a.path).isFile()) throw new Error('not a file')
          hash = hashScript(a.path)
        } catch {
          errors.push({ path: `actions.${i}.path`, message: 'That script file does not exist or cannot be read.' })
          return
        }
        if (trusted[a.path] !== hash) untrusted.push(a.path)
      }
    })
    if (errors.length) return { ok: false, errors }
    if (untrusted.length) {
      return { ok: false, code: 'untrusted_script', scripts: [...new Set(untrusted)], error: 'Scripts must be trusted before a rule can use them.' }
    }
    // A2: refuse rule pairs that would carry files around in circles (unless the user insists; the runtime guard still protects them)
    const loops = rule.enabled ? loopsCausedBy(rule, rulesDb.listRules(db), keeper.listFolders()) : []
    if (loops.length && !allowLoop) {
      return { ok: false, code: 'loop', loops, error: `This rule would create a loop: ${loops[0].text}.` }
    }
    return { ok: true, rule: rulesDb.saveRule(db, rule), loops }
  })

  handle('rules:delete', async (id) => {
    const parsed = Id.safeParse(id)
    if (!parsed.success) return invalid('rule')
    return { ok: rulesDb.deleteRule(db, parsed.data) }
  })

  handle('rules:reorder', async (ids) => {
    const parsed = IdList.safeParse(ids)
    if (!parsed.success) return invalid('order')
    return { ok: true, rules: rulesDb.reorderRules(db, parsed.data) }
  })

  // ----- scripts (A1): trust is granted ONLY through a native dialog the renderer cannot click for itself -----
  handle('scripts:pick', async () => {
    const res = await dialog.showOpenDialog(getWindow(), { properties: ['openFile'] })
    return { ok: true, path: res.canceled || !res.filePaths.length ? null : res.filePaths[0] }
  })
  handle('scripts:trust', async (p) => {
    const parsed = AbsPath.safeParse(p)
    if (!parsed.success || !path.isAbsolute(parsed.data)) return invalid('script path')
    const file = path.resolve(parsed.data)
    let hash
    try {
      hash = hashScript(file)
    } catch {
      return { ok: false, error: 'That script file cannot be read.' }
    }
    const yes = await confirmNative({
      buttons: ['Cancel', 'I trust this script'],
      title: 'Trust this script?',
      message: 'Allow Zenthrip to run this script on your files?',
      detail: `${file}\n\nIt will run with your permissions, once for every file a rule matches, and its effects cannot be undone. If the file is edited later, you will be asked again.`
    })
    if (!yes) return { ok: true, trusted: false }
    settingsDb.trustScript(db, file, hash)
    return { ok: true, trusted: true }
  })
  handle('scripts:list', async () => {
    const trusted = settingsDb.trustedScripts(db)
    return {
      ok: true,
      scripts: Object.entries(trusted).map(([p, h]) => {
        let state = 'trusted'
        try {
          if (hashScript(p) !== h) state = 'changed'
        } catch {
          state = 'missing'
        }
        return { path: p, state }
      })
    }
  })
  handle('scripts:revoke', async (p) => {
    const parsed = AbsPath.safeParse(p)
    if (!parsed.success) return invalid('script path')
    settingsDb.revokeScript(db, parsed.data)
    return { ok: true }
  })

  // ----- preview + sweep (B4) -----
  handle('preview:run', async (payload) => {
    const parsed = z.object({ folderId: Id.optional() }).default({}).safeParse(payload ?? {})
    if (!parsed.success) return invalid('folder')
    return { ok: true, ...keeper.preview({ folderId: parsed.data.folderId ?? null }) }
  })
  handle('sweep:run', async (previewId) => {
    const parsed = Text.safeParse(previewId)
    if (!parsed.success) return invalid('preview')
    return keeper.runPreview(parsed.data)
  })

  // ----- ledger and undo (B5) -----
  handle('ledger:list', async (query) => {
    const parsed = LedgerQuery.safeParse(query ?? {})
    if (!parsed.success) return invalid('query')
    return { ok: true, ...keeper.listLedger(parsed.data) }
  })
  handle('ledger:sweeps', async () => ({ ok: true, sweeps: keeper.listSweeps(100) }))
  handle('ledger:undo', async (id) => {
    const parsed = Id.safeParse(id)
    if (!parsed.success) return invalid('entry')
    return keeper.undoEntry(parsed.data)
  })
  handle('ledger:undoSweep', async (sweepId) => {
    const parsed = Text.safeParse(sweepId)
    if (!parsed.success) return invalid('sweep')
    return keeper.undoSweep(parsed.data)
  })

  // ----- pause / resume -----
  handle('watch:status', async () => ({ ok: true, ...keeper.status() }))
  handle('watch:pause', async () => ({ ok: true, ...keeper.setPaused(true) }))
  handle('watch:resume', async () => ({ ok: true, ...keeper.setPaused(false) }))

  // ----- settings and trash -----
  handle('settings:get', async () => ({ ok: true, settings: settingsDb.getSettings(db) }))
  handle('settings:set', async (patch) => {
    const parsed = parseSettingsPatch(patch)
    if (!parsed.ok) return { ok: false, errors: parsed.errors }
    const next = settingsDb.setSettings(db, parsed.patch)
    keeper.loopGuard.hopLimit = next.hopLimit
    onSettingsChanged(next)
    return { ok: true, settings: next }
  })
  handle('trash:info', async () => ({ ok: true, ...keeper.trashInfo() }))
  handle('trash:empty', async () => {
    const info = keeper.trashInfo()
    if (info.files === 0) return { ok: true, emptied: false }
    const yes = await confirmNative({
      buttons: ['Cancel', 'Empty the Keeper Trash'],
      title: 'Empty the Keeper Trash?',
      message: `Permanently delete ${info.files} file${info.files === 1 ? '' : 's'}?`,
      detail: 'Actions that sent files to the trash can no longer be undone afterwards.'
    })
    if (!yes) return { ok: true, emptied: false }
    await keeper.emptyTrash()
    return { ok: true, emptied: true }
  })
}
