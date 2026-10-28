import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { planFile, planMany, makeCtx, sortRules } from '../src/engine/planner.js'
import { expandTemplate, renamedFileName, sanitizeFileName, resolveCollision } from '../src/engine/actions.js'
import { facts, NOW } from './helpers.js'

const R = (...p) => path.resolve(path.join(...p))
const nothingExists = () => false
const ctx = (extra = {}) => makeCtx({ now: NOW, exists: nothingExists, ...extra })

const rule = (over) => ({
  id: 1,
  name: 'r',
  rank: 1,
  enabled: true,
  trigger: { type: 'arrival' },
  condition: { op: 'AND', children: [{ field: 'ext', operator: 'is', value: 'pdf' }] },
  actions: [{ type: 'move', to: R('/dest') }],
  folderIds: [],
  ...over
})

describe('first spell wins', () => {
  const a = rule({ id: 1, name: 'A', rank: 2, actions: [{ type: 'move', to: R('/a') }] })
  const b = rule({ id: 2, name: 'B', rank: 1, actions: [{ type: 'move', to: R('/b') }] })
  const f = facts('x.pdf')

  it('the lowest rank that matches is the only one that acts', () => {
    const plan = planFile(f, [a, b], ctx())
    expect(plan.ruleName).toBe('B')
    expect(plan.steps).toEqual([{ op: 'move', src: f.path, dest: R('/b', 'x.pdf') }])
  })
  it('ties are broken by id, so the order is always the same', () => {
    const t1 = rule({ id: 7, name: 'seven', rank: 1 })
    const t2 = rule({ id: 3, name: 'three', rank: 1 })
    expect(sortRules([t1, t2]).map((r) => r.name)).toEqual(['three', 'seven'])
  })
  it('the same file and rules always give the same plan', () => {
    const p1 = planFile(f, [a, b], ctx())
    const p2 = planFile(f, [b, a], ctx())
    expect(p2).toEqual(p1)
  })
  it('disabled rules are skipped, and no match returns null', () => {
    expect(planFile(f, [rule({ enabled: false })], ctx())).toBeNull()
    expect(planFile(facts('x.txt'), [a, b], ctx())).toBeNull()
  })
  it('respects folder scope and trigger type', () => {
    const scoped = rule({ folderIds: [5] })
    expect(planFile(f, [scoped], ctx({ folderId: 5 }))).not.toBeNull()
    expect(planFile(f, [scoped], ctx({ folderId: 6 }))).toBeNull()
    expect(planFile(f, [rule({ trigger: { type: 'schedule' } })], ctx())).toBeNull()
  })
})

describe('actions', () => {
  it('rename keeps the extension unless the template uses {ext}', () => {
    const f = facts('Report.PDF')
    expect(renamedFileName('{date}_{name}', f, NOW)).toBe('2026-10-24_Report.PDF')
    expect(renamedFileName('final.{ext}', f, NOW)).toBe('final.PDF')
    expect(renamedFileName('{original}', f, NOW)).toBe('Report.PDF')
  })
  it('expands every token and leaves unknown ones alone', () => {
    const f = facts('a.txt')
    expect(expandTemplate('{year}/{month}/{day}', f, NOW)).toBe('2026/10/24')
    expect(expandTemplate('{nope}', f, NOW)).toBe('{nope}')
  })
  it('sanitises names that are illegal on some operating system', () => {
    expect(sanitizeFileName('a:b*c?.txt')).toBe('a_b_c_.txt')
    expect(sanitizeFileName('CON')).toBe('_CON')
    expect(sanitizeFileName('   ')).toBe('_')
    expect(sanitizeFileName('name. ')).toBe('name')
  })
  it('rename then move works on the renamed file', () => {
    const f = facts('invoice.pdf')
    const plan = planFile(
      f,
      [rule({ actions: [{ type: 'rename', template: 'inv_{name}' }, { type: 'move', to: R('/inv') }] })],
      ctx()
    )
    expect(plan.steps).toEqual([
      { op: 'rename', src: f.path, dest: R('/watch', 'inv_invoice.pdf') },
      { op: 'move', src: R('/watch', 'inv_invoice.pdf'), dest: R('/inv', 'inv_invoice.pdf') }
    ])
  })
  it('copy leaves the original in place', () => {
    const f = facts('a.pdf')
    const plan = planFile(f, [rule({ actions: [{ type: 'copy', to: R('/backup') }, { type: 'move', to: R('/main') }] })], ctx())
    expect(plan.steps).toEqual([
      { op: 'copy', src: f.path, dest: R('/backup', 'a.pdf') },
      { op: 'move', src: f.path, dest: R('/main', 'a.pdf') }
    ])
  })
  it('trash ends the plan', () => {
    const f = facts('a.pdf')
    const plan = planFile(f, [rule({ actions: [{ type: 'trash' }, { type: 'move', to: R('/x') }] })], ctx())
    expect(plan.steps).toEqual([{ op: 'trash', src: f.path, dest: null }])
  })
  it('a file already in its destination needs no step', () => {
    const f = facts('a.pdf', { dir: '/dest' })
    expect(planFile(f, [rule()], ctx()).steps).toEqual([])
  })
  it('refuses to copy next to the original (it would be copied again forever)', () => {
    const f = facts('a.pdf', { dir: '/watch' })
    const plan = planFile(f, [rule({ actions: [{ type: 'copy', to: R('/watch') }] })], ctx())
    expect(plan.steps).toEqual([])
    expect(plan.warnings).toHaveLength(1)
  })
})

describe('name collisions: nothing is ever overwritten', () => {
  it('adds (1), (2) when the destination exists', () => {
    const taken = new Set([R('/dest', 'a.pdf'), R('/dest', 'a (1).pdf')])
    const plan = planFile(facts('a.pdf'), [rule()], ctx({ exists: (p) => taken.has(p) }))
    expect(plan.steps[0].dest).toBe(R('/dest', 'a (2).pdf'))
  })
  it('two files in one batch that want the same name get different names', () => {
    const batch = [facts('a.pdf', { dir: '/one' }), facts('a.pdf', { dir: '/two' })]
    const out = planMany(batch, [rule()], ctx())
    const dests = out.map((o) => o.plan.steps[0].dest)
    expect(new Set(dests).size).toBe(2)
    expect(dests).toEqual([R('/dest', 'a.pdf'), R('/dest', 'a (1).pdf')])
  })
  it('resolveCollision handles names without an extension', () => {
    expect(resolveCollision(R('/d', 'README'), (p) => p === R('/d', 'README'), new Set())).toBe(R('/d', 'README (1)'))
  })
})

describe('planMany', () => {
  it('returns rows in a stable order (sorted by path)', () => {
    const out = planMany([facts('b.txt'), facts('a.txt')], [], ctx())
    expect(out.map((o) => o.facts.fileName)).toEqual(['a.txt', 'b.txt'])
    expect(out.every((o) => o.plan === null)).toBe(true)
  })
})
