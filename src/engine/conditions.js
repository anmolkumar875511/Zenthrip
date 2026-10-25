// Condition evaluation: a tree of groups (AND / OR / NOT) and leaves.
//   leaf  = { field, operator, value }
//   group = { op: 'AND' | 'OR' | 'NOT', children: [...] }
// Rules of the game:
//   * Pure and deterministic: same facts + same condition => same answer.
//   * Text matching is case-insensitive.
//   * An empty group NEVER matches (so a half-written rule can't match every file).
//   * Unknown fields/operators never match.

const lc = (s) => String(s ?? '').toLowerCase()
const stripDot = (s) => lc(s).trim().replace(/^\./, '')
const extList = (v) =>
  (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map(stripDot)
    .filter(Boolean)

const OPERATORS = {
  name: {
    contains: (f, v) => lc(f.stem).includes(lc(v)),
    notContains: (f, v) => !lc(f.stem).includes(lc(v)),
    startsWith: (f, v) => lc(f.stem).startsWith(lc(v)),
    endsWith: (f, v) => lc(f.stem).endsWith(lc(v)),
    equals: (f, v) => lc(f.stem) === lc(v),
    regex: (f, v) => {
      try {
        return new RegExp(String(v), 'i').test(f.stem)
      } catch {
        return false
      }
    }
  },
  ext: {
    is: (f, v) => f.ext === stripDot(Array.isArray(v) ? v[0] : v),
    isNot: (f, v) => f.ext !== stripDot(Array.isArray(v) ? v[0] : v),
    in: (f, v) => extList(v).includes(f.ext)
  },
  sizeBytes: {
    gt: (f, v) => f.sizeBytes > Number(v),
    gte: (f, v) => f.sizeBytes >= Number(v),
    lt: (f, v) => f.sizeBytes < Number(v),
    lte: (f, v) => f.sizeBytes <= Number(v),
    between: (f, v) => {
      if (!Array.isArray(v) || v.length !== 2) return false
      const [a, b] = [Number(v[0]), Number(v[1])]
      return f.sizeBytes >= Math.min(a, b) && f.sizeBytes <= Math.max(a, b)
    }
  },
  ageDays: {
    olderThan: (f, v) => f.ageDays > Number(v),
    newerThan: (f, v) => f.ageDays < Number(v)
  }
}

export function evaluateLeaf(leaf, facts) {
  const fn = OPERATORS[leaf?.field]?.[leaf?.operator]
  if (!fn) return false
  return Boolean(fn(facts, leaf.value))
}

export function evaluateCondition(node, facts) {
  if (!node) return false
  if (node.op) {
    const kids = Array.isArray(node.children) ? node.children : []
    if (kids.length === 0) return false
    switch (node.op) {
      case 'AND':
        return kids.every((k) => evaluateCondition(k, facts))
      case 'OR':
        return kids.some((k) => evaluateCondition(k, facts))
      case 'NOT':
        return !evaluateCondition(kids[0], facts)
      default:
        return false
    }
  }
  return evaluateLeaf(node, facts)
}
