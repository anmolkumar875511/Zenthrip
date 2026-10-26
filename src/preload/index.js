// The ONLY bridge between the UI and the main process: a fixed list of calls.
import { contextBridge, ipcRenderer } from 'electron'

const call = (channel) => (payload) => ipcRenderer.invoke(channel, payload)
const EVENTS = ['activity']

contextBridge.exposeInMainWorld('zenthrip', {
  app: { info: call('app:info') },
  folders: {
    list: call('folders:list'),
    pick: call('folders:pick'),
    remove: call('folders:remove')
  },
  rules: {
    list: call('rules:list'),
    save: call('rules:save'),
    delete: call('rules:delete'),
    reorder: call('rules:reorder')
  },
  dialog: { pickDirectory: call('dialog:pickDirectory') },
  on(channel, callback) {
    if (!EVENTS.includes(channel)) throw new Error(`Unknown event: ${channel}`)
    const listener = (_event, data) => callback(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
})
