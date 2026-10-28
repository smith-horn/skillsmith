/**
 * @fileoverview The lines `skillsmith doctor recovery --apply | --undo |
 * --park <opId>` prints: the plan before the prompt and the result after the
 * run (A1 plan §3.9; SMI-6531 6b-i, moved out of `doctor.recovery.action.ts`).
 *
 * Pure: it turns core's `PlannedRecovery` and `RecoveryRunResult` into lines.
 * @module @skillsmith/cli/commands/doctor.recovery.action.render
 */

import type { PlannedRecovery, RecoveryAction, RecoveryRunResult } from '@skillsmith/core'

/** The plan's lines, as the prompt shows them. */
export function planLines(p: PlannedRecovery): string[] {
  const lines = [
    `Plan for --${p.request.action} ${p.request.opId}`,
    `  op dir: ${p.opDir} (${p.report.label})`,
  ]
  for (const s of p.plan.steps) {
    const d = s.disposition
    lines.push(`  ${s.tree}: ${d.kind === 'kept' ? `kept as ${d.as}` : d.kind}; ${s.note}`)
  }
  lines.push(
    `  manifest: ${p.plan.manifest === 'untouched' ? 'untouched' : 'committed to the updated entry'}`
  )
  for (const r of p.plan.remaining) lines.push(`  then: ${r}`)
  for (const n of p.plan.notes) lines.push(`  note: ${n}`)
  if (p.request.acceptIdentity === true && 'facts' in p.report.cls && p.report.cls.facts) {
    const f = p.report.cls.facts
    const rec = f.record
    const now = (o: typeof f.t) =>
      o.present ? `${o.identity.dev}/${o.identity.ino}/${o.identity.birthtimeNs}` : 'absent'
    lines.push(
      `  identity (dev/ino/birthtime) recorded old ${rec.oldIdentity.dev}/${rec.oldIdentity.ino}/${rec.oldIdentity.birthtimeNs}, new ${rec.newIdentity.dev}/${rec.newIdentity.ino}/${rec.newIdentity.birthtimeNs}; T now ${now(f.t)}`
    )
  }
  return lines
}

type Warning = Extract<RecoveryRunResult, { status: 'done' }>['warnings'][number]

/**
 * A warning's line. `removal-not-done` names the op dir and the park's status:
 * a held park moved it but holds it (check it); a kept or stopped one left it
 * in place, and the same command finishes it (governance S1). For `--park`, a
 * held op dir has left the staging dir, so it no longer blocks the root; a
 * kept or stopped one still does.
 */
function warningLines(w: Warning, r: { opId: string; action: RecoveryAction }): string[] {
  if (w.code !== 'removal-not-done') return [`  warning: ${w.code}`]
  const status = `${w.status}/${w.reason}${w.errno === undefined ? '' : ` (${w.errno})`}`
  const head =
    w.status === 'held'
      ? `  warning: removal-not-done: the op dir ${w.path} was moved to ${String(w.parkedPath)} but is held there (${status})`
      : `  warning: removal-not-done: the op dir ${w.path} was not set aside (${status})`
  const command = `skillsmith doctor recovery --${r.action} ${r.opId}`
  const park = r.action === 'park'
  return [
    head,
    ...(w.detail === undefined ? [] : [`    ${w.detail}`]),
    ...(w.status === 'held'
      ? [
          park
            ? '    it has left the staging dir, so it no longer blocks writes; it may have changed while it moved: check the parked copy'
            : '    it may have changed while it moved: check it before relying on it',
        ]
      : [
          ...(park ? ['    the skills root stays blocked until it is set aside'] : []),
          `    run \`${command}\` again to finish setting it aside`,
        ]),
  ]
}

/** The result's lines. */
export function resultLines(r: RecoveryRunResult): string[] {
  if (r.status === 'refused')
    return [`Not done (${r.reason}): ${r.detail}`, ...r.paths.map((p) => `  ${p}`)]
  if (r.status === 'stopped') {
    return [
      `Stopped (${r.reason}): ${r.detail}`,
      r.recordPath === null
        ? '  the record is gone; run the same command to finish'
        : `  the record is kept at ${r.recordPath}; run the same command again to resume`,
    ]
  }
  const lines = [`Done: ${r.action} of ${r.opId} (from ${r.from}).`]
  if (r.installed !== null) lines.push(`  installed: ${r.installed}`)
  for (const k of r.kept) {
    lines.push(
      k.tree === 'OP'
        ? `  the whole op dir was set aside as ${k.kind} at ${k.path}`
        : `  kept ${k.tree} as ${k.kind} at ${k.path}`
    )
  }
  if (r.extraCopy !== null) {
    lines.push(
      `  the op dir, holding the verified source copies, was moved aside to ${r.extraCopy}`
    )
  }
  lines.push(`  manifest: ${r.manifest}`)
  if (r.audit.kind === 'not-recorded') lines.push(`  ${r.audit.detail}`)
  for (const w of r.warnings) lines.push(...warningLines(w, r))
  for (const p of r.swept.removed) lines.push(`  removed the empty directory ${p}`)
  for (const p of r.swept.left) lines.push(`  left ${p.path} (${p.errno})`)
  return lines
}
