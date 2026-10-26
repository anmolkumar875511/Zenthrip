// Every renderer request lands here. The renderer is NOT trusted:
// inputs are validated, and each handler returns { ok: true, ... } or { ok: false, error | errors }.
import { ipcMain, dialog } from 'electron'
import { z } from 'zod'
import { parseRule } from '../shared/schemas.js'
import { validateDestination } from '../engine/paths.js'
import { MAX_WATCHED_FOLDERS } from '../shared/fields.js'
import * as rulesDb from '../db/rules.js'

const Id = z.number().int().positive()
const IdList = z.array(Id).max(1000)

export function registerIpc({ db, keeper, getWindow, appInfo }) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, payload) => {
      if (event.sender !== getWindow()?.webContents) return { ok: false, error: 'Untrusted sender.' }
      try {
        return await fn(payload)
      } catch (err) {
        return { ok: false, error: err.message }
      }
    })

  const pickDirectory = async () => {
    const win = getWindow()
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  }

  // ----- app -----
  handle('app:info', async () => ({ ok: true, ...appInfo(), maxFolders: MAX_WATCHED_FOLDERS }))

  // ----- folders (Phase 2) -----
  handle('folders:list', async () => ({ ok: true, folders: keeper.listFolders() }))

  handle('folders:pick', async () => {
    const chosen = await pickDirectory()
    if (!chosen) return { ok: true, canceled: true }
    return keeper.addFolder(chosen)
  })

  handle('folders:remove', async (id) => {
    const parsed = Id.safeParse(id)
    if (!parsed.success) return { ok: false, error: 'Invalid folder.' }
    return keeper.removeFolder(parsed.data)
  })

  handle('dialog:pickDirectory', async () => ({ ok: true, path: await pickDirectory() }))

  // ----- rules (Phase 3) -----
  handle('rules:list', async () => ({ ok: true, rules: rulesDb.listRules(db) }))

  handle('rules:save', async (input) => {
    const parsed = parseRule(input)
    if (!parsed.ok) return { ok: false, errors: parsed.errors }
    const rule = parsed.rule
    const errors = []
    rule.actions.forEach((a, i) => {
      if (a.type !== 'move' && a.type !== 'copy') return
      const res = validateDestination(a.to)
      if (res.ok) a.to = res.path
      else errors.push({ path: `actions.${i}.to`, message: res.reason })
    })
    if (errors.length) return { ok: false, errors }
    return { ok: true, rule: rulesDb.saveRule(db, rule) }
  })

  handle('rules:delete', async (id) => {
    const parsed = Id.safeParse(id)
    if (!parsed.success) return { ok: false, error: 'Invalid rule.' }
    return { ok: rulesDb.deleteRule(db, parsed.data) }
  })

  handle('rules:reorder', async (ids) => {
    const parsed = IdList.safeParse(ids)
    if (!parsed.success) return { ok: false, error: 'Invalid order.' }
    return { ok: true, rules: rulesDb.reorderRules(db, parsed.data) }
  })
}
