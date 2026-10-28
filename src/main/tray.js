// System tray: Open, Pause/Resume watching, Run sweep now, Quit.
import { Tray, Menu, nativeImage } from 'electron'

export function createTray({ iconPath, onOpen, onTogglePause, onRunSweep, onQuit, isPaused }) {
  let tray
  try {
    const image = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    tray = new Tray(image)
  } catch {
    return null // some Linux desktops have no tray; the app then simply quits when its window closes
  }
  tray.setToolTip('Zenthrip')

  const build = () =>
    Menu.buildFromTemplate([
      { label: 'Open Zenthrip', click: onOpen },
      { type: 'separator' },
      { label: isPaused() ? 'Resume watching' : 'Pause watching', click: onTogglePause },
      { label: 'Run sweep now', click: onRunSweep },
      { type: 'separator' },
      { label: 'Quit Zenthrip', click: onQuit }
    ])

  const refresh = () => {
    tray.setContextMenu(build())
    tray.setToolTip(isPaused() ? 'Zenthrip (paused)' : 'Zenthrip')
  }
  tray.on('click', onOpen)
  refresh()
  return { refresh, destroy: () => tray.destroy() }
}
