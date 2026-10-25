// Bounded, de-duplicated, single-worker queue.
//  * Duplicate events for the same file version (path + size + mtime) are dropped.
//  * One item is processed at a time, in arrival order, so two handlers can never race on a file.
//  * Memory stays small: it stores only paths and keys, never file contents.
import { pathKey } from './paths.js'

export function makeKey(filePath, size, mtimeMs) {
  return `${pathKey(filePath)}|${size}|${Math.round(mtimeMs)}`
}

export class EventQueue {
  #items = []
  #queued = new Set()
  #inFlight = new Set()
  #recent = new Set() // keys processed lately; also stops an undone file from being re-processed instantly
  #running = false
  #waiters = []

  constructor({ handler, onError = () => {}, maxSize = 5000, recentSize = 5000 }) {
    this.handler = handler
    this.onError = onError
    this.maxSize = maxSize
    this.recentSize = recentSize
  }

  /** @returns 'queued' | 'duplicate' | 'full' */
  enqueue(item) {
    const { key } = item
    if (this.#queued.has(key) || this.#inFlight.has(key) || this.#recent.has(key)) return 'duplicate'
    if (this.#items.length >= this.maxSize) return 'full'
    this.#items.push(item)
    this.#queued.add(key)
    if (!this.#running) {
      this.#running = true
      Promise.resolve().then(() => this.#run())
    }
    return 'queued'
  }

  get size() {
    return this.#items.length + this.#inFlight.size
  }

  /** Resolves when everything queued so far has been handled. */
  idle() {
    if (!this.#running) return Promise.resolve()
    return new Promise((resolve) => this.#waiters.push(resolve))
  }

  async #run() {
    while (this.#items.length > 0) {
      const item = this.#items.shift()
      this.#queued.delete(item.key)
      this.#inFlight.add(item.key)
      try {
        await this.handler(item)
      } catch (err) {
        this.onError(err, item)
      } finally {
        this.#inFlight.delete(item.key)
        this.#remember(item.key)
      }
      await new Promise((resolve) => setImmediate(resolve)) // let IPC / UI breathe between files
    }
    this.#running = false
    for (const resolve of this.#waiters.splice(0)) resolve()
  }

  #remember(key) {
    this.#recent.add(key)
    if (this.#recent.size > this.recentSize) {
      this.#recent.delete(this.#recent.values().next().value)
    }
  }
}
