import { describe, it, expect } from 'vitest'
import { parseRule } from '../src/shared/schemas.js'

const good = () => ({
  name: ' Big invoices ',
  enabled: true,
  trigger: { type: 'arrival' },
  condition: {
    op: 'AND',
    children: [
      { field: 'name', operator: 'contains', value: 'invoice' },
      { field: 'sizeBytes', operator: 'gt', value: 1048576 }
    ]
  },
  actions: [
    { type: 'rename', template: '{date}_{name}' },
    { type: 'move', to: '/home/me/Invoices' }
  ],
  folderIds: [1, 1, 2]
})
const errorPaths = (rule) => {
  const r = parseRule(rule)
  expect(r.ok).toBe(false)
  return r.errors.map((e) => e.path)
}
const withChange = (fn) => {
  const r = good()
  fn(r)
  return r
}

describe('parseRule', () => {
  it('accepts a valid rule, trims the name, de-duplicates folders and drops unknown properties', () => {
    const input = good()
    input.evil = 'x'
    input.actions[0].junk = 1
    const r = parseRule(input)
    expect(r.ok).toBe(true)
    expect(r.rule.name).toBe('Big invoices')
    expect(r.rule.folderIds).toEqual([1, 2])
    expect(r.rule.evil).toBeUndefined()
    expect(r.rule.actions[0]).toEqual({ type: 'rename', template: '{date}_{name}' })
  })
  it('fills in defaults for enabled, trigger and folderIds', () => {
    const r = parseRule({ name: 'x', condition: good().condition, actions: good().actions })
    expect(r.ok).toBe(true)
    expect(r.rule).toMatchObject({ enabled: true, trigger: { type: 'arrival' }, folderIds: [] })
  })
  it('requires a name', () => {
    expect(errorPaths(withChange((r) => (r.name = '   ')))).toContain('name')
  })
  it('requires at least one condition and one action', () => {
    expect(errorPaths(withChange((r) => (r.condition.children = [])))).toContain('condition')
    expect(errorPaths(withChange((r) => (r.actions = [])))).toContain('actions')
  })
  it('validates condition values with precise paths', () => {
    expect(errorPaths(withChange((r) => (r.condition.children[0].value = ''))))
      .toContain('condition.children.0.value')
    expect(errorPaths(withChange((r) => { r.condition.children[0].operator = 'regex'; r.condition.children[0].value = '(' })))
      .toContain('condition.children.0.value')
    expect(errorPaths(withChange((r) => (r.condition.children[1].value = -5))))
      .toContain('condition.children.1.value')
    expect(errorPaths(withChange((r) => (r.condition.children[1].value = null))))
      .toContain('condition.children.1.value')
    expect(errorPaths(withChange((r) => { r.condition.children[1].operator = 'between'; r.condition.children[1].value = [1] })))
      .toContain('condition.children.1.value')
    expect(errorPaths(withChange((r) => (r.condition.children[0] = { field: 'ext', operator: 'is', value: ' . ' }))))
      .toContain('condition.children.0.value')
    expect(errorPaths(withChange((r) => (r.condition.children[0].operator = 'nonsense'))))
      .toContain('condition.children.0.operator')
  })
  it('NOT needs exactly one child', () => {
    expect(errorPaths(withChange((r) => (r.condition = { op: 'NOT', children: [r.condition.children[0], r.condition.children[1]] }))))
      .toContain('condition')
  })
  it('validates actions', () => {
    expect(errorPaths(withChange((r) => (r.actions[0].template = 'a/b')))).toContain('actions.0.template')
    expect(errorPaths(withChange((r) => (r.actions[0].template = '{wat}')))).toContain('actions.0.template')
    expect(errorPaths(withChange((r) => (r.actions[1].to = 'relative/path')))).toContain('actions.1.to')
    expect(errorPaths(withChange((r) => (r.actions = [{ type: 'trash' }, { type: 'move', to: '/x' }])))).toContain('actions.0')
    expect(errorPaths(withChange((r) => (r.actions = [{ type: 'trash' }, { type: 'trash' }])))).toContain('actions.1')
    expect(errorPaths(withChange((r) => (r.actions = [{ type: 'explode' }])))).toContain('actions.0.type')
  })
  it('accepts Windows and UNC destination paths', () => {
    for (const to of ['C:\\Users\\me\\Docs', 'D:/x', '\\\\server\\share\\dir']) {
      expect(parseRule(withChange((r) => (r.actions[1].to = to))).ok, to).toBe(true)
    }
  })
  it('rejects absurdly large conditions', () => {
    const many = Array.from({ length: 41 }, () => ({ field: 'name', operator: 'contains', value: 'a' }))
    expect(parseRule(withChange((r) => (r.condition.children = many))).ok).toBe(false)
  })
})

describe('parseRule reports every problem at once', () => {
  it('does not stop at the first broken field', () => {
    const r = parseRule({ name: '', condition: { op: 'AND', children: [] }, actions: [{ type: 'rename', template: 'a/b' }] })
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.path).sort()).toEqual(['actions.0.template', 'condition', 'name'])
  })
  it('survives garbage input without throwing', () => {
    for (const junk of [null, undefined, 42, 'x', [], { actions: 'nope', condition: 5 }]) {
      expect(() => parseRule(junk)).not.toThrow()
      expect(parseRule(junk).ok).toBe(false)
    }
  })
})
