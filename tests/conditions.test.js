import { describe, it, expect } from 'vitest'
import { evaluateCondition as ev } from '../src/engine/conditions.js'
import { facts } from './helpers.js'

const leaf = (field, operator, value) => ({ field, operator, value })
const and = (...children) => ({ op: 'AND', children })
const or = (...children) => ({ op: 'OR', children })
const not = (child) => ({ op: 'NOT', children: [child] })

describe('name conditions (matched against the name without extension)', () => {
  const f = facts('Invoice_March.PDF')
  it('contains / notContains / startsWith / endsWith / equals ignore case', () => {
    expect(ev(leaf('name', 'contains', 'INVOICE'), f)).toBe(true)
    expect(ev(leaf('name', 'contains', 'receipt'), f)).toBe(false)
    expect(ev(leaf('name', 'notContains', 'receipt'), f)).toBe(true)
    expect(ev(leaf('name', 'startsWith', 'invoice_'), f)).toBe(true)
    expect(ev(leaf('name', 'endsWith', 'march'), f)).toBe(true)
    expect(ev(leaf('name', 'equals', 'invoice_march'), f)).toBe(true)
  })
  it('does not look at the extension', () => {
    expect(ev(leaf('name', 'contains', 'pdf'), f)).toBe(false)
  })
  it('regex works and an invalid regex simply does not match', () => {
    expect(ev(leaf('name', 'regex', '^invoice_\\w+$'), f)).toBe(true)
    expect(ev(leaf('name', 'regex', '('), f)).toBe(false)
  })
})

describe('extension conditions', () => {
  const f = facts('photo.JPG')
  it('is / isNot / in, with or without a leading dot', () => {
    expect(ev(leaf('ext', 'is', 'jpg'), f)).toBe(true)
    expect(ev(leaf('ext', 'is', '.JPG'), f)).toBe(true)
    expect(ev(leaf('ext', 'isNot', 'png'), f)).toBe(true)
    expect(ev(leaf('ext', 'in', 'png, jpg ,gif'), f)).toBe(true)
    expect(ev(leaf('ext', 'in', ['png', '.gif']), f)).toBe(false)
  })
  it('a file without extension has an empty extension', () => {
    expect(facts('README').ext).toBe('')
    expect(facts('.bashrc').ext).toBe('')
    expect(facts('archive.tar.gz').ext).toBe('gz')
  })
})

describe('size conditions', () => {
  const f = facts('a.bin', { size: 2_000_000 })
  it('gt / lt / between (either order)', () => {
    expect(ev(leaf('sizeBytes', 'gt', 1_048_576), f)).toBe(true)
    expect(ev(leaf('sizeBytes', 'lt', 1_048_576), f)).toBe(false)
    expect(ev(leaf('sizeBytes', 'between', [1_000_000, 3_000_000]), f)).toBe(true)
    expect(ev(leaf('sizeBytes', 'between', [3_000_000, 1_000_000]), f)).toBe(true)
    expect(ev(leaf('sizeBytes', 'between', [10, 20]), f)).toBe(false)
    expect(ev(leaf('sizeBytes', 'between', [10]), f)).toBe(false)
  })
})

describe('age conditions', () => {
  it('olderThan / newerThan use days since last modified', () => {
    const f = facts('a.txt', { ageDays: 40 })
    expect(ev(leaf('ageDays', 'olderThan', 30), f)).toBe(true)
    expect(ev(leaf('ageDays', 'newerThan', 30), f)).toBe(false)
    expect(ev(leaf('ageDays', 'newerThan', 60), f)).toBe(true)
  })
})

describe('groups', () => {
  const f = facts('invoice.pdf', { size: 2_000_000 })
  const yes = leaf('name', 'contains', 'invoice')
  const no = leaf('name', 'contains', 'zzz')
  it('AND / OR / NOT', () => {
    expect(ev(and(yes, leaf('ext', 'is', 'pdf')), f)).toBe(true)
    expect(ev(and(yes, no), f)).toBe(false)
    expect(ev(or(no, yes), f)).toBe(true)
    expect(ev(or(no, no), f)).toBe(false)
    expect(ev(not(no), f)).toBe(true)
    expect(ev(not(yes), f)).toBe(false)
  })
  it('nested groups work ("anything but this")', () => {
    expect(ev(and(or(no, yes), not(leaf('ext', 'is', 'txt'))), f)).toBe(true)
  })
  it('an empty group never matches, so half-written rules cannot match every file', () => {
    expect(ev({ op: 'AND', children: [] }, f)).toBe(false)
    expect(ev({ op: 'OR', children: [] }, f)).toBe(false)
    expect(ev(null, f)).toBe(false)
  })
  it('unknown fields or operators never match', () => {
    expect(ev(leaf('colour', 'is', 'red'), f)).toBe(false)
    expect(ev(leaf('name', 'sounds-like', 'invoice'), f)).toBe(false)
  })
})
