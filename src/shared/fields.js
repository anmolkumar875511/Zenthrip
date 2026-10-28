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
  trash: 'Send to trash',
  script: 'Run a script'
}

// Tokens usable inside a rename template.
export const TEMPLATE_TOKENS = ['name', 'ext', 'original', 'date', 'year', 'month', 'day']

export const MAX_WATCHED_FOLDERS = 3

export const TRIGGER_KINDS = { arrival: 'When a file arrives', interval: 'Every so often', daily: 'Every day', weekly: 'On certain weekdays' }
export const SCRIPT_TIMEOUT_MS = 10_000
export const SETTING_LIMITS = {
  trashRetentionDays: { min: 0, max: 3650 },
  hopLimit: { min: 1, max: 20 },
  retryCount: { min: 0, max: 10 }
}
