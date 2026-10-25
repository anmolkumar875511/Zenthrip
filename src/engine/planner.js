// The Planner is a PURE decision function:
//   (file facts, ordered rules, context)  ->  the plan for the FIRST matching rule, or null.
// "First spell wins": rules are tried by rank, and the first one that matches is the only one that acts.
// It never writes to disk, which is what makes dry-run preview and testing trivial.
import fs from 'node:fs'
import { evaluateCondition } from './conditions.js'
import { planActions } from './actions.js'

export function makeCtx(partial = {}) {
  return {
    now: Date.now(), // inject a fixed value in tests so "age" is deterministic
    exists: (p) => fs.existsSync(p),
    reserved: new Set(), // destinations already claimed within this batch
    trigger: 'arrival',
    folderId: undefined,
    ...partial
  }
}

/** Enabled rules in priority order (lowest rank first; ties broken by id so it is always stable). */
export function sortRules(rules) {
  return rules.filter((r) => r.enabled).sort((a, b) => a.rank - b.rank || a.id - b.id)
}

function inScope(rule, folderId) {
  const ids = rule.folderIds ?? []
  return ids.length === 0 || folderId == null || ids.includes(folderId)
}

export function planFile(facts, rules, ctx = makeCtx()) {
  for (const rule of sortRules(rules)) {
    if ((rule.trigger?.type ?? 'arrival') !== ctx.trigger) continue
    if (!inScope(rule, ctx.folderId)) continue
    if (!evaluateCondition(rule.condition, facts)) continue
    const { steps, warnings } = planActions(rule.actions, facts, ctx)
    return { ruleId: rule.id, ruleName: rule.name, steps, warnings }
  }
  return null
}

/** Plan many files in a stable order (sorted by path) so previews are reproducible. */
export function planMany(factsList, rules, ctx = makeCtx()) {
  const sorted = [...factsList].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return sorted.map((facts) => ({ facts, plan: planFile(facts, rules, ctx) }))
}
