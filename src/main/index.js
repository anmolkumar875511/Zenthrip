import { app, BrowserWindow, Notification, session, shell } from 'electron'
import { join } from 'node:path'
import icon from '../../resources/icon.png?asset'
import { openDb } from '../db/db.js'
import * as settingsDb from '../db/settings.js'
import { createKeeper } from './keeper.js'
import { createScheduler } from './scheduler.js'
import { createTray } from './tray.js'
import { registerIpc } from './ipc.js'

let mainWindow = null
let db = null
let keeper = null
let scheduler = null
let tray = null
let isQuitting = false

// A crash in one handler must never take the whole app down: log it and carry on.
process.on('uncaughtException', (err) => console.error('[zenthrip] uncaughtException:', err))
process.on('unhandledRejection', (err) => console.error('[zenthrip] unhandledRejection:', err))

// Only one Zenthrip at a time (two watchers on the same folders would race).
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  app.whenReady().then(async () => {
    // Strict CSP in the packaged app (dev needs inline scripts for hot reload).
    if (app.isPackaged) {
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"]
          }
        })
      })
    }

    db = openDb(join(app.getPath('userData'), 'zenthrip.db'))
    const send = (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
    }
    const notify = (title, body) => {
      send('notice', { title, body, ts: Date.now() })
      if (settingsDb.getSettings(db).notifications && Notification.isSupported()) new Notification({ title, body }).show()
    }

    keeper = createKeeper({ db, emit: send, notify, trashRoot: join(app.getPath('userData'), 'trash') })
    scheduler = createScheduler({
      db,
      keeper,
      onRan: (ids, res) => {
        if (res?.skipped) return
        notify('Scheduled sweep finished', `${res.done ?? 0} file(s) handled${res.failed ? `, ${res.failed} failed` : ''}.`)
      },
      onError: (err) => console.error('[zenthrip] scheduler:', err)
    })

    const togglePause = () => {
      keeper.setPaused(!keeper.status().paused)
      tray?.refresh()
    }
    registerIpc({
      db,
      keeper,
      getWindow: () => mainWindow,
      appInfo: () => ({ platform: process.platform, version: app.getVersion(), trashPath: join(app.getPath('userData'), 'trash') }),
      onSettingsChanged: applyLoginItem
    })
    applyLoginItem(settingsDb.getSettings(db))

    tray = createTray({
      iconPath: icon,
      onOpen: showWindow,
      onTogglePause: togglePause,
      onRunSweep: async () => {
        const res = await keeper.runNow()
        notify('Sweep finished', `${res.done} file(s) handled${res.failed ? `, ${res.failed} failed` : ''}. Open Zenthrip to review or undo.`)
      },
      onQuit: () => app.quit(),
      isPaused: () => keeper.status().paused
    })

    createWindow({ hidden: process.argv.includes('--hidden') && Boolean(tray) })
    await keeper.start()
    scheduler.start()

    app.on('activate', showWindow)
  })

  // With a tray the app keeps running when the window is closed; without one, closing the window quits.
  app.on('window-all-closed', () => {
    if (!tray) app.quit()
  })

  let shuttingDown = false
  app.on('before-quit', async (event) => {
    isQuitting = true
    if (shuttingDown) return
    shuttingDown = true
    event.preventDefault()
    try {
      scheduler?.stop()
      await keeper?.stop()
      tray?.destroy()
      db?.close()
    } finally {
      app.exit(0)
    }
  })
}

function applyLoginItem(settings) {
  // Launched at login: start hidden in the tray (the --hidden flag is checked above).
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.startAtLogin, args: ['--hidden'] })
}

function showWindow() {
  if (!mainWindow) return createWindow({})
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createWindow({ hidden = false }) {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 560,
    show: false,
    backgroundColor: '#14101c',
    title: 'Zenthrip',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow.once('ready-to-show', () => {
    if (!hidden) mainWindow.show()
  })
  // Closing the window hides it; the Keeper keeps working from the tray.
  mainWindow.on('close', (event) => {
    if (!isQuitting && tray) {
      event.preventDefault()
      mainWindow.hide()
    }
  })
  mainWindow.on('closed', () => (mainWindow = null))

  // The UI never navigates away and never opens new windows.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())

  if (process.env['ELECTRON_RENDERER_URL']) mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}
