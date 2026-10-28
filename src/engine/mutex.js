// One-at-a-time lock. Everything that changes files runs through it, so there is exactly one writer.
export class Mutex {
  #tail = Promise.resolve()

  run(fn) {
    const result = this.#tail.then(fn, fn)
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }
}
