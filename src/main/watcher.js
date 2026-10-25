// Thin wrapper around chokidar.
//  * depth: 0            -> only files DIRECTLY inside a watched folder
//  * awaitWriteFinish    -> an 'add' fires only after the file has stopped growing
//  * ignored             -> half-finished downloads (.crdownload, .part, .tmp ...) are never reported
import path from 'node:path'
import chokidar from 'chokidar'
import { isIgnoredFile } from '../engine/paths.js'

export class FolderWatcher {
  #watchers = new Map() // folderId -> chokidar watcher

  constructor({ onFile, onError = () => {}, stabilityThreshold = 2000, pollInterval = 100 }) {
    this.onFile = onFile
    this.onError = onError
    this.stabilityThreshold = stabilityThreshold
    this.pollInterval = pollInterval
  }

  async add(folderId, folderPath) {
    if (this.#watchers.has(folderId)) return
    const root = path.resolve(folderPath)
    const watcher = chokidar.watch(root, {
      depth: 0,
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: this.stabilityThreshold, pollInterval: this.pollInterval },
      ignored: (p) => path.resolve(p) !== root && isIgnoredFile(path.basename(p))
    })
    watcher.on('add', (filePath) => this.onFile({ folderId, path: filePath }))
    watcher.on('error', (err) => this.onError(err, folderId))
    this.#watchers.set(folderId, watcher)
    // Resolve once the initial scan is done (but never hang forever).
    await Promise.race([
      new Promise((resolve) => watcher.once('ready', resolve)),
      new Promise((resolve) => setTimeout(resolve, 10_000))
    ])
  }

  async remove(folderId) {
    const watcher = this.#watchers.get(folderId)
    if (!watcher) return
    this.#watchers.delete(folderId)
    await watcher.close()
  }

  async closeAll() {
    await Promise.all([...this.#watchers.keys()].map((id) => this.remove(id)))
  }

  get count() {
    return this.#watchers.size
  }
}
