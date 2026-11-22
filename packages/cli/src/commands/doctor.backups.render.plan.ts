/**
 * @fileoverview The text of `skillsmith doctor backups --prune` (SMI-6531 step
 * 6c-ii-b): what `--apply` (6c-iii) would delete, and why each other tree the
 * selectors matched was kept. This is a dry run: nothing here has happened, so
 * the only place the word "deleted" appears is "would be deleted under
 * --apply (6c-iii)". Sizes are allocated bytes, labelled "on disk" (D6). No
 * lock holder is shown (D16): one read now is stale by `--apply`.
 * @module @skillsmith/cli/commands/doctor.backups.render.plan
 */

import { humanBytes } from '@skillsmith/core'
import type {
  ExcludedRow,
  ExcludeReason,
  PlanGroup,
  PlanItem,
  Precondition,
  PrunePlan,
} from '@skillsmith/core'
import { planTotals } from './doctor.backups.plan.json.js'

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** D10: one line per reason `--apply` would refuse. The first line of the output. */
function preconditionLine(p: Precondition): string {
  if (p.code === 'unreadable-record') {
    return (
      `--apply would refuse: ${p.root} holds an operation record that could not be read ` +
      `(${p.recordPath}); see \`skillsmith doctor recovery\` to set it aside.`
    )
  }
  return `--apply would refuse: ${p.path} could not be used (${p.reason}).`
}

/** D20: each reason, in plain words. */
export function reasonText(r: ExcludeReason, copyPath: string): string {
  switch (r.code) {
    case 'protected':
      return r.rule === 'live-record'
        ? `protected by the update record ${r.path}`
        : r.rule === 'backup-dest'
          ? `it is the backup the update record ${r.path} names`
          : `protected by the parked unreadable record ${r.path}`
    case 'protection-unknown':
      return `protection unknown, so it is kept: ${r.reason}`
    case 'newest-kept':
      return 'the newest of its folder, guarded by --keep'
    case 'needs-include-kept':
      return `kind ${r.kind ?? 'unknown'} is selected only with --include-kept`
    case 'mounted':
      return 'mounted: never offered, whatever --allow-changed says'
    case 'needs-allow-changed':
      return `class ${r.klass}: needs --allow-changed ${copyPath}, then a per-item confirmation`
    case 'lock-unknown':
      return `no lock can be named, so it is kept: ${r.reason}`
    case 'unknown-age':
      return 'its age is unknown, so it is kept (it never matches --older-than)'
    case 'unidentified':
      return `no deletion job can name it: ${r.reason}`
  }
}

const tierText = (i: PlanItem): string =>
  i.tier === 'batch' ? 'batch confirmation' : 'per-item confirmation'

const lockText = (g: PlanGroup): string =>
  g.lock.kind === 'lock1'
    ? `lock 1 of the skills root ${g.lock.root}`
    : `lock 1' of the set-aside area ${g.lock.areaReal}`

function groupLines(g: PlanGroup): string[] {
  const bytes = g.items.reduce((n, i) => n + i.allocatedBytes, 0)
  const lines = [
    `Group under ${lockText(g)}: ${plural(g.items.length, 'tree', 'trees')}, ` +
      `${humanBytes(bytes)} on disk`,
    `  lock file: ${g.lock.path}`,
  ]
  for (const i of g.items) {
    lines.push(
      `  ${i.copyPath}  store: ${i.store}  kind: ${i.kind ?? 'unknown'}  class: ${i.klass}  ` +
        `${humanBytes(i.allocatedBytes)} on disk  ${tierText(i)}`
    )
  }
  return lines
}

function excludedLines(rows: readonly ExcludedRow[]): string[] {
  if (rows.length === 0) return []
  const lines = [`Matched but kept (${rows.length}):`]
  for (const r of rows) {
    lines.push(`  ${r.copyPath}  store: ${r.store}  ${reasonText(r.reason, r.copyPath)}`)
  }
  return lines
}

/** The whole plan as text lines. */
export function renderPlan(plan: PrunePlan): string[] {
  const lines: string[] = plan.preconditions.map(preconditionLine)
  lines.push('Dry run: nothing is changed. This lists what --apply (6c-iii) would act on.')
  if (plan.noSelector) {
    lines.push(
      'No selector was given, so nothing is selected. Choose what to prune with --older-than, ' +
        '--keep, --client, --root, --skill, --op or --path; --include-kept and --allow-changed ' +
        'only widen a selection that a selector made.'
    )
  }
  for (const g of plan.groups) lines.push(...groupLines(g))
  lines.push(...excludedLines(plan.excluded))
  const t = planTotals(plan)
  lines.push(
    `${plural(t.trees, 'tree', 'trees')}, ${humanBytes(t.allocatedBytes)} on disk, ` +
      'would be deleted under --apply (6c-iii).'
  )
  return lines
}
