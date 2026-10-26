import { app, BrowserWindow, session, shell } from 'electron'
import { join } from 'node:path'
import { openDb } from '../db/db.js'
import { createKeeper } from './keeper.js'
import { registerIpc } from './ipc.js'

let mainWindow = null
let db = null
let keeper = null

// Only one Zenthrip at a time (two watchers on the same folders would race).
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    // Strict CSP in the packaged app (dev needs inline scripts for hot reload).
    if (app.isPackaged) {
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
            ]
          }
        })
      })
    }

    db = openDb(join(app.getPath('userData'), 'zenthrip.db'))
    const send = (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
    }
    keeper = createKeeper({ db, emit: send })
    registerIpc({
      db,
      keeper,
      getWindow: () => mainWindow,
      appInfo: () => ({ platform: process.platform, version: app.getVersion() })
    })

    createWindow()
    await keeper.start()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit() // (Phase 6 changes this: the app will keep living in the system tray)
  })

  let shuttingDown = false
  app.on('before-quit', async (event) => {
    if (shuttingDown) return
    shuttingDown = true
    event.preventDefault()
    try {
      await keeper?.stop()
      db?.close()
    } finally {
      app.exit(0)
    }
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 560,
    show: false,
    backgroundColor: '#14101c',
    title: 'Zenthrip',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())
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
