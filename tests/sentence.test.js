import { describe, it, expect } from 'vitest'
import { describeRule, describeCondition, formatBytes } from '../src/shared/sentence.js'

describe('formatBytes', () => {
  it('formats common sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1048576)).toBe('1 MB')
    expect(formatBytes(5 * 1024 ** 3)).toBe('5 GB')
  })
})

describe('describeRule', () => {
  it('reads like a simple sentence', () => {
    const rule = {
      condition: {
        op: 'AND',
        children: [
          { field: 'name', operator: 'contains', value: 'invoice' },
          { field: 'sizeBytes', operator: 'gt', value: 1048576 }
        ]
      },
      actions: [
        { type: 'rename', template: '{date}_{name}' },
        { type: 'move', to: 'C:\\Invoices' }
      ]
    }
    expect(describeRule(rule)).toBe(
      'When a file arrives, if name contains \u201Cinvoice\u201D and size is larger than 1 MB, ' +
        'then rename to \u201C{date}_{name}\u201D, then move to \u201CC:\\Invoices\u201D.'
    )
  })
  it('handles OR, NOT, ranges, age and trash', () => {
    expect(
      describeCondition({
        op: 'OR',
        children: [
          { field: 'ext', operator: 'in', value: 'jpg, png' },
          { op: 'NOT', children: [{ field: 'ageDays', operator: 'olderThan', value: 1 }] },
          { field: 'sizeBytes', operator: 'between', value: [1024, 2048] }
        ]
      })
    ).toBe(
      '(extension is one of \u201Cjpg, png\u201D or not (age is older than 1 day) or size is between 1 KB and 2 KB)'
    )
    expect(describeRule({ condition: { field: 'ext', operator: 'is', value: 'tmp' }, actions: [{ type: 'trash' }] })).toBe(
      'When a file arrives, if extension is \u201Ctmp\u201D, then send it to the trash.'
    )
  })
})
