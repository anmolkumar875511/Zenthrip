// The ONLY bridge between the UI and the main process: a fixed list of calls.
import { contextBridge, ipcRenderer } from 'electron'

const call = (channel) => (payload) => ipcRenderer.invoke(channel, payload)
const EVENTS = ['activity', 'progress', 'status', 'ledger:changed', 'notice']

contextBridge.exposeInMainWorld('zenthrip', {
  app: { info: call('app:info') },
  folders: { list: call('folders:list'), pick: call('folders:pick'), remove: call('folders:remove') },
  rules: { list: call('rules:list'), save: call('rules:save'), delete: call('rules:delete'), reorder: call('rules:reorder') },
  scripts: { pick: call('scripts:pick'), trust: call('scripts:trust'), list: call('scripts:list'), revoke: call('scripts:revoke') },
  preview: { run: call('preview:run') },
  sweep: { run: call('sweep:run') },
  ledger: { list: call('ledger:list'), sweeps: call('ledger:sweeps'), undo: call('ledger:undo'), undoSweep: call('ledger:undoSweep') },
  watch: { status: call('watch:status'), pause: call('watch:pause'), resume: call('watch:resume') },
  settings: { get: call('settings:get'), set: call('settings:set') },
  trash: { info: call('trash:info'), empty: call('trash:empty') },
  dialog: { pickDirectory: call('dialog:pickDirectory') },
  on(channel, callback) {
    if (!EVENTS.includes(channel)) throw new Error(`Unknown event: ${channel}`)
    const listener = (_event, data) => callback(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
})
