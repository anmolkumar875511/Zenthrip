// Smoke tests: the React components render without throwing and show the right text.
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import RuleEditor from '../src/renderer/src/components/RuleEditor.jsx'
import ConditionBuilder from '../src/renderer/src/components/ConditionBuilder.jsx'
import ActionsBuilder from '../src/renderer/src/components/ActionsBuilder.jsx'
import Rules from '../src/renderer/src/pages/Rules.jsx'
import Preview from '../src/renderer/src/pages/Preview.jsx'
import Ledger from '../src/renderer/src/pages/Ledger.jsx'
import Settings from '../src/renderer/src/pages/Settings.jsx'
import TriggerEditor from '../src/renderer/src/components/TriggerEditor.jsx'
import Folders from '../src/renderer/src/pages/Folders.jsx'

const noop = () => {}
const rule = {
  id: 3,
  name: 'Everything at once',
  enabled: true,
  trigger: { type: 'arrival' },
  condition: {
    op: 'OR',
    children: [
      { field: 'name', operator: 'regex', value: '^inv' },
      { field: 'ext', operator: 'in', value: 'jpg, png' },
      { field: 'sizeBytes', operator: 'between', value: [1048576, 5242880] },
      { field: 'ageDays', operator: 'olderThan', value: 30 }
    ]
  },
  actions: [
    { type: 'rename', template: '{date}_{name}' },
    { type: 'copy', to: '/backup' },
    { type: 'move', to: '/final' },
    { type: 'trash' }
  ],
  folderIds: [1]
}

describe('React components render', () => {
  it('RuleEditor: new rule', () => {
    const html = renderToString(<RuleEditor rule={null} folders={[]} onClose={noop} onSaved={noop} />)
    expect(html).toContain('New enchantment')
    expect(html).toContain('In plain words')
  })
  it('RuleEditor: existing rule using every field type and action type', () => {
    const html = renderToString(
      <RuleEditor rule={rule} folders={[{ id: 1, path: '/watch/a' }]} onClose={noop} onSaved={noop} />
    )
    expect(html).toContain('Edit enchantment')
    expect(html).toContain('/watch/a')
    expect(html).toContain('size is between 1 MB and 5 MB')
    expect(html).toContain('Send to trash')
  })
  it('RuleEditor wraps a single leaf condition so the builder can show it', () => {
    const leaf = { ...rule, condition: { field: 'ext', operator: 'is', value: 'pdf' } }
    expect(() => renderToString(<RuleEditor rule={leaf} folders={[]} onClose={noop} onSaved={noop} />)).not.toThrow()
  })
  it('ConditionBuilder shows validation errors next to the right row', () => {
    const html = renderToString(
      <ConditionBuilder
        value={rule.condition}
        onChange={noop}
        errors={{ 'condition.children.0.value': 'That is not a valid pattern.' }}
      />
    )
    expect(html).toContain('That is not a valid pattern.')
  })
  it('ActionsBuilder shows rename placeholders and destination fields', () => {
    const html = renderToString(<ActionsBuilder actions={rule.actions} onChange={noop} errors={{ 'actions.1.to': 'Choose a destination folder (a full path).' }} />)
    expect(html).toContain('{original}')
    expect(html).toContain('Browse')
    expect(html).toContain('Choose a destination folder')
  })
  it('pages render their empty states', () => {
    expect(renderToString(<Rules />)).toContain('No rules yet')
    const html = renderToString(<Folders info={{ maxFolders: 3 }} activity={[]} onClearActivity={noop} />)
    expect(html).toContain('No folders yet')
    expect(html).toContain('Drop a file into a watched folder')
  })
  it('ConditionBuilder renders nested groups and NOT, with errors on the right nested row', () => {
    const nested = {
      op: 'AND',
      children: [
        { op: 'NOT', children: [{ field: 'ext', operator: 'is', value: 'pdf' }] },
        { op: 'OR', children: [{ field: 'name', operator: 'contains', value: 'a' }, { field: 'name', operator: 'regex', value: '(' }] }
      ]
    }
    const html = renderToString(<ConditionBuilder value={nested} onChange={noop} errors={{ 'condition.children.1.children.1.value': 'That is not a valid pattern.' }} />)
    expect(html).toContain('This group matches when')
    expect(html).toContain('+ Add group')
    expect(html).toContain('That is not a valid pattern.')
  })
  it('TriggerEditor shows schedule fields', () => {
    expect(renderToString(<TriggerEditor value={{ type: 'arrival' }} onChange={noop} errors={{}} />)).toContain('When a file arrives')
    const w = renderToString(<TriggerEditor value={{ type: 'schedule', kind: 'weekly', days: [1], time: '09:00' }} onChange={noop} errors={{ 'trigger.days': 'Pick at least one weekday.' }} />)
    expect(w).toContain('Mon')
    expect(w).toContain('Pick at least one weekday.')
  })
  it('ActionsBuilder shows the script action with its warning', () => {
    const html = renderToString(<ActionsBuilder actions={[{ type: 'script', path: '/s.js' }]} onChange={noop} errors={{}} />)
    expect(html).toContain('cannot be undone')
  })
  it('Preview, Ledger and Settings render their initial states', () => {
    expect(renderToString(<Preview folders={[]} />)).toContain('dry run')
    expect(renderToString(<Ledger />)).toContain('Nothing has happened yet')
    expect(renderToString(<Settings info={{ version: '1', platform: 'x' }} />)).toContain('Loading')
  })
  it('the activity feed shows executed results', () => {
    const activity = [{ id: 1, ts: 1, level: 'info', message: 'executed', file: 'a.pdf', ruleName: 'PDFs', results: [{ op: 'move', status: 'done' }, { op: 'copy', status: 'failed', error: 'locked' }], warnings: [] }]
    const html = renderToString(<Folders info={{ maxFolders: 3 }} activity={activity} onClearActivity={noop} />)
    expect(html).toContain('matched')
    expect(html).toContain('locked')
  })
  it('the activity feed describes planned, unmatched and warning events', () => {
    const activity = [
      { id: 3, ts: 1, level: 'warn', message: 'Too many files arrived at once; some were skipped.' },
      { id: 2, ts: 1, level: 'info', message: 'no-match', file: 'notes.txt' },
      { id: 1, ts: 1, level: 'info', message: 'planned', file: 'a.pdf', ruleName: 'PDFs', steps: [{ op: 'move', src: '/w/a.pdf', dest: '/d/a.pdf' }], warnings: [] }
    ]
    const html = renderToString(<Folders info={{ maxFolders: 3 }} activity={activity} onClearActivity={noop} />)
    expect(html).toContain('matched')
    expect(html).toContain('no rule matched')
    expect(html).toContain('Too many files')
    expect(html).toContain('/d/a.pdf')
  })
})
