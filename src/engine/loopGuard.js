// "Dormammu" protection: stop rules from chasing the same file forever.
//  1. STATIC (when a rule is saved): look for cycles in the folder graph, e.g. A -> B by one rule and B -> A by another.
//  2. RUNTIME: ignore events caused by our own in-place changes, count how many times the Keeper has acted
//     on the same file, and freeze it (status "loop_broken") once the hop limit is reached.
import path from 'node:path'
import { pathKey } from './paths.js'

/**
 * Edges of the folder graph: "a rule can carry a file from watched folder X into watched folder Y".
 * @returns {{from:number,to:number,rule:{id?:number,name:string}}[]}
 */
export function buildFolderGraph(rules, folders) {
  const byKey = new Map(folders.map((f) => [pathKey(f.path), f.id]))
  const edges = []
  for (const rule of rules) {
    if (rule.enabled === false) continue
    const sources = rule.folderIds?.length ? rule.folderIds : folders.map((f) => f.id)
    for (const action of rule.actions ?? []) {
      if (action.type !== 'move' && action.type !== 'copy') continue
      const to = byKey.get(pathKey(path.resolve(action.to)))
      if (to == null) continue // destination is not a watched folder: no new events there
      for (const from of sources) if (from !== to) edges.push({ from, to, rule: { id: rule.id, name: rule.name } })
    }
  }
  return edges
}

/** All simple cycles in the folder graph (at most 3 folders are watched, so this is tiny). */
export function findCycles(rules, folders) {
  const edges = buildFolderGraph(rules, folders)
  const cycles = []
  const seen = new Set()
  const walk = (start, node, trail, visited) => {
    for (const e of edges.filter((x) => x.from === node)) {
      if (e.to === start) {
        const cycle = [...trail, e]
        const key = cycle.map((c) => `${c.from}>${c.to}:${c.rule.id ?? c.rule.name}`).sort().join('|')
        if (!seen.has(key)) {
          seen.add(key)
          cycles.push(cycle)
        }
      } else if (!visited.has(e.to)) {
        walk(start, e.to, [...trail, e], new Set([...visited, e.to]))
      }
    }
  }
  for (const f of folders) walk(f.id, f.id, [], new Set([f.id]))
  return cycles
}

/** Cycles that the candidate rule would create or join. */
export function loopsCausedBy(candidate, otherRules, folders) {
  const others = otherRules.filter((r) => r.id == null || r.id !== candidate.id)
  const cand = { ...candidate, id: candidate.id ?? '__candidate__' }
  const label = (id) => folders.find((f) => f.id === id)?.path ?? String(id)
  return findCycles([...others, cand], folders)
    .filter((cycle) => cycle.some((e) => e.rule.id === cand.id))
    .map((cycle) => ({
      rules: [...new Set(cycle.map((e) => (e.rule.id === '__candidate__' ? candidate.name : e.rule.name)))],
      folders: cycle.map((e) => label(e.from)),
      text: cycle
        .map((e) => `${label(e.from)} \u2192 ${label(e.to)} (rule \u201C${e.rule.id === '__candidate__' ? candidate.name : e.rule.name}\u201D)`)
        .join(', then ')
    }))
}

export class LoopGuard {
  #self = new Map() // path key -> expiry time
  #hops = new Map() // file id -> times the Keeper acted on it
  #frozen = new Set()

  constructor({ hopLimit = 3, ttlMs = 30_000, now = () => Date.now() } = {}) {
    this.hopLimit = hopLimit
    this.ttlMs = ttlMs
    this.now = now
  }

  /** Remember that WE caused a change at this path, so the watcher event it produces is ignored. */
  markSelfCaused(p) {
    this.#self.set(pathKey(p), this.now() + this.ttlMs)
    if (this.#self.size > 5000) this.#purge()
  }

  isSelfCaused(p) {
    const key = pathKey(p)
    const exp = this.#self.get(key)
    if (exp == null) return false
    if (exp < this.now()) {
      this.#self.delete(key)
      return false
    }
    return true
  }

  #purge() {
    const t = this.now()
    for (const [k, exp] of this.#self) if (exp < t) this.#self.delete(k)
  }

  hops(id) {
    return id ? (this.#hops.get(id) ?? 0) : 0
  }

  record(id, n = 1) {
    if (!id) return
    this.#hops.set(id, this.hops(id) + n)
    if (this.#hops.size > 20_000) this.#hops.delete(this.#hops.keys().next().value)
  }

  /** A copy inherits the history of its source (otherwise copy loops would reset the counter every time). */
  inherit(destId, srcId) {
    if (destId && srcId) this.#hops.set(destId, this.hops(srcId))
  }

  /** True when acting on this file once more would exceed the limit. */
  wouldExceed(id) {
    return Boolean(id) && this.hops(id) >= this.hopLimit
  }

  freeze(id) {
    if (id) this.#frozen.add(id)
  }

  isFrozen(id) {
    return Boolean(id) && this.#frozen.has(id)
  }

  unfreeze(id) {
    this.#frozen.delete(id)
    this.#hops.delete(id)
  }
}
