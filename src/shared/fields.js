// Single source of truth for what a rule can look at and do.
// Imported by BOTH the engine (main process) and the React UI.

export const FIELDS = {
  name: {
    label: 'Name (without extension)',
    type: 'text',
    operators: {
      contains: 'contains',
      notContains: 'does not contain',
      startsWith: 'starts with',
      endsWith: 'ends with',
      equals: 'is exactly',
      regex: 'matches pattern (regex)'
    },
    defaults: { operator: 'contains', value: '' }
  },
  ext: {
    label: 'Extension',
    type: 'ext',
    operators: { is: 'is', isNot: 'is not', in: 'is one of' },
    defaults: { operator: 'is', value: '' }
  },
  sizeBytes: {
    label: 'Size',
    type: 'size',
    operators: { gt: 'is larger than', lt: 'is smaller than', between: 'is between' },
    defaults: { operator: 'gt', value: 1048576 }
  },
  ageDays: {
    label: 'Age (days since last modified)',
    type: 'age',
    operators: { olderThan: 'is older than', newerThan: 'is newer than' },
    defaults: { operator: 'olderThan', value: 30 }
  }
}

export const ACTION_TYPES = {
  rename: 'Rename',
  move: 'Move to folder',
  copy: 'Copy to folder',
  trash: 'Send to trash'
}

// Tokens usable inside a rename template.
export const TEMPLATE_TOKENS = ['name', 'ext', 'original', 'date', 'year', 'month', 'day']

export const MAX_WATCHED_FOLDERS = 3
