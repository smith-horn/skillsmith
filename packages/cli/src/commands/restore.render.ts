/**
 * @fileoverview Text and JSON for `skillsmith restore <id>` (SMI-6531 6d-ii,
 * design note §7). Pure: no I/O.
 * @module @skillsmith/cli/commands/restore.render
 */
import type { RestorePlan, RestoreResult } from '@skillsmith/core'

export type RestoreStatus = 'planned' | 'restored' | 'refused' | 'stopped'

const contentsLine = (c: RestorePlan['contents']): string =>
  c.state === 'unchanged'
    ? 'unchanged since it was set aside'
    : c.state === 'changed'
      ? 'changed since it was set aside'
      : `not checked (${c.why})`

export function planLines(plan: RestorePlan): string[] {
  const lines = [
    `Restore ${plan.copyPath}`,
    `  kind:     ${plan.kind} (${plan.held ? 'held' : 'parked'})`,
    `  type:     ${plan.type}`,
    `  to:       ${plan.origin}`,
    `  size:     ${plan.bytes} bytes`,
    `  contents: ${contentsLine(plan.contents)}`,
    `  lock:     ${
      plan.lock.kind === 'lock1'
        ? `the skills-root lock of ${plan.lock.root}`
        : `the set-aside-area lock ${plan.lock.path}`
    }`,
    '  manifest: not changed',
  ]
  if (plan.lockNote !== null) lines.push(plan.lockNote)
  return lines
}

export function resultLines(r: RestoreResult, locksDir = ''): string[] {
  const out: string[] = []
  if (r.status === 'restored') {
    out.push(`Restored ${r.origin}.`, ...r.notes, ...r.warnings)
  } else {
    out.push(r.message, ...r.warnings)
    if (r.status === 'stopped')
      out.push('Something was changed before the stop; read the message above.')
  }
  const s = r.strandedLockClaim
  if (s !== undefined) {
    out.push(
      `The lock folder \`${locksDir}\` was replaced while restore held its lock, so a claim \`${s.lockName}\` may have been left in the folder that was moved away. Skillsmith will reclaim it once this process has exited; nothing else needs doing unless that folder comes back.`
    )
  }
  return out
}

const planJson = (plan: RestorePlan): Record<string, unknown> => ({
  copyPath: plan.copyPath,
  opId: plan.opId,
  kind: plan.kind,
  held: plan.held,
  type: plan.type,
  origin: plan.origin,
  lock: plan.lock,
  bytes: plan.bytes,
  contents: plan.contents,
  lockNote: plan.lockNote,
  lockDisagreement: plan.lockDisagreement,
  digest: plan.digest,
})

const resultJson = (r: RestoreResult): Record<string, unknown> => ({
  ...r,
  ...(r.strandedLockClaim === undefined
    ? {}
    : {
        strandedLockClaim: {
          lockName: r.strandedLockClaim.lockName,
          locksDir: {
            dev: String(r.strandedLockClaim.locksDir.dev),
            ino: String(r.strandedLockClaim.locksDir.ino),
          },
          detail: r.strandedLockClaim.detail,
        },
      }),
})

export function restoreJson(a: {
  status: RestoreStatus
  reason: string | null
  plan: RestorePlan | null
  result: RestoreResult | null
  candidates?: unknown[]
}): string {
  return JSON.stringify(
    {
      status: a.status,
      reason: a.reason,
      plan: a.plan === null ? null : planJson(a.plan),
      result: a.result === null ? null : resultJson(a.result),
      ...(a.candidates === undefined ? {} : { candidates: a.candidates }),
    },
    null,
    2
  )
}
