import { describe, it, expect } from 'vitest'
import { EventQueue, makeKey } from '../src/engine/queue.js'
import { sleep } from './helpers.js'

const item = (n) => ({ key: `k${n}`, n })

describe('EventQueue', () => {
  it('processes items one at a time, in arrival order', async () => {
    const seen = []
    let running = 0
    let maxRunning = 0
    const q = new EventQueue({
      handler: async (it) => {
        running++
        maxRunning = Math.max(maxRunning, running)
        await sleep(2)
        seen.push(it.n)
        running--
      }
    })
    for (let i = 0; i < 10; i++) q.enqueue(item(i))
    await q.idle()
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(maxRunning).toBe(1)
  })

  it('drops duplicates: queued, in flight, and recently processed', async () => {
    const seen = []
    const q = new EventQueue({ handler: async (it) => { await sleep(5); seen.push(it.n) } })
    expect(q.enqueue(item(1))).toBe('queued')
    expect(q.enqueue(item(1))).toBe('duplicate') // already queued / about to run
    await sleep(1)
    expect(q.enqueue(item(1))).toBe('duplicate') // in flight
    await q.idle()
    expect(q.enqueue(item(1))).toBe('duplicate') // recently processed
    expect(seen).toEqual([1])
  })

  it('a burst of 200 files is processed exactly once each', async () => {
    const counts = new Map()
    const q = new EventQueue({ handler: async (it) => counts.set(it.n, (counts.get(it.n) ?? 0) + 1) })
    for (let i = 0; i < 200; i++) q.enqueue(item(i))
    for (let i = 0; i < 200; i++) q.enqueue(item(i)) // duplicate events for the same files
    await q.idle()
    expect(counts.size).toBe(200)
    expect([...counts.values()].every((c) => c === 1)).toBe(true)
  })

  it('is bounded: reports "full" instead of growing without limit', async () => {
    const q = new EventQueue({ handler: async () => sleep(5), maxSize: 3 })
    const results = [1, 2, 3, 4, 5].map((n) => q.enqueue(item(n)))
    expect(results).toEqual(['queued', 'queued', 'queued', 'full', 'full'])
    await q.idle()
  })

  it('an error in one item is reported and the queue keeps going', async () => {
    const errors = []
    const done = []
    const q = new EventQueue({
      handler: async (it) => {
        if (it.n === 2) throw new Error('boom')
        done.push(it.n)
      },
      onError: (err, it) => errors.push([err.message, it.n])
    })
    ;[1, 2, 3].forEach((n) => q.enqueue(item(n)))
    await q.idle()
    expect(done).toEqual([1, 3])
    expect(errors).toEqual([['boom', 2]])
  })

  it('makeKey changes when the file changes', () => {
    expect(makeKey('/a/b.txt', 10, 1000)).toBe(makeKey('/a/b.txt', 10, 1000.2))
    expect(makeKey('/a/b.txt', 10, 1000)).not.toBe(makeKey('/a/b.txt', 11, 1000))
    expect(makeKey('/a/b.txt', 10, 1000)).not.toBe(makeKey('/a/b.txt', 10, 2000))
  })
})
