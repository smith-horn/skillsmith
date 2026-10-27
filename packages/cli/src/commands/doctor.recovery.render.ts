/**
 * @fileoverview The text and JSON `skillsmith doctor recovery` prints (A1 plan
 * §3.9, SMI-6531 step 6a-i).
 *
 * Pure: it turns core's `RootReport`s into lines. For each skills root it
 * lists every operation directory with its state and publish sub-states, the
 * identities and tree hashes the classifier compared, the backup path and
 * what each action would do; then the staging dirs with no record, the
 * unreadable records and the leftover probes.
 * @module @skillsmith/cli/commands/doctor.recovery.render
 */
import type {
  ActionPlan,
  Discovery,
  OpFacts,
  OpReport,
  RecoveryClass,
  RootReport,
} from '@skillsmith/core'

const short = (h: string | null): string => (h === null ? 'unhashable' : h.slice(0, 12))

function treeLine(name: string, role: string, obs: OpFacts['t']): string {
  if (!obs.present) {
    return `    ${name}: ${role}${obs.errno === null ? '' : ` (could not be inspected: ${obs.errno})`}`
  }
  return (
    `    ${name}: ${role}; ${obs.type}, ino ${obs.identity.ino}, ` +
    `birthtime ${obs.identity.birthtimeNs}, hash ${short(obs.hash)}`
  )
}

function factsLines(f: OpFacts): string[] {
  const roleOf = (r: OpFacts['roles']['O']): string =>
    r.kind === 'source'
      ? `in the op dir${r.started === null ? '' : `, keep started (${r.started.state} as ${r.started.kind})`}`
      : r.kind === 'kept'
        ? `kept as ${r.keep.kind} at ${r.keep.destPath}`
        : 'absent'
  const lines = [
    `    skill: ${f.record.target.comparedPath} (${f.record.target.client}, ${f.record.target.scope})`,
    treeLine('T (skill path)', f.tState, f.t),
  ]
  for (const role of ['O', 'N', 'U'] as const) {
    const res = f.roles[role]
    const name = role === 'O' ? 'O (old)' : role === 'N' ? 'N (new)' : 'U (undone)'
    lines.push(
      res.kind === 'source' ? treeLine(name, roleOf(res), res.obs) : `    ${name}: ${roleOf(res)}`
    )
  }
  lines.push(
    `    manifest entry: ${f.manifest ?? `unreadable (${f.manifestRefusal})`}`,
    `    backup: ${f.record.backupDest}`
  )
  for (const g of f.groups) {
    lines.push(
      `    keep ${g.base}: ${g.state ?? `not classified (${g.unclassified})`}${g.verified ? ', verified' : ''}`
    )
  }
  if (f.fullDevice !== null) {
    lines.push(
      `    full device (${f.fullDevice.cause}) while ${f.fullDevice.stage}; area ${f.fullDevice.area}`
    )
  }
  if (f.journal !== null) {
    lines.push(
      `    audit record: ${f.journal.present ? 'present' : 'none'}${f.journal.torn ? ' (the journal ends mid-line)' : ''}`
    )
  }
  return lines
}

function factsOf(cls: RecoveryClass): OpFacts | null {
  return 'facts' in cls ? cls.facts : null
}

function noteOf(cls: RecoveryClass): string[] {
  switch (cls.kind) {
    case 'empty-op-dir':
      return ["    empty: a later doctor action holding this root's lock removes it with one rmdir"]
    case 'no-record':
      return [
        // W1: a verifying move-source intent means the record went at the end, not before the start.
        cls.intent !== null && cls.intent.valid && cls.intent.kind === 'move-source'
          ? `    no record.json: a finish killed after its record was removed, before its op dir was set aside; entries: ${cls.entries.join(', ') || 'none'}`
          : `    no record.json (a crash before the update began); entries: ${cls.entries.join(', ') || 'none'}`,
        cls.owner === null
          ? '    owner: no owner.json'
          : `    owner: pid ${cls.owner.pid ?? '?'} on ${cls.owner.host ?? '?'}, uid ${cls.owner.uid ?? '?'}`,
        ...(cls.intent === null
          ? []
          : cls.intent.blocked === null
            ? ['    a park intent is present and verifies: --apply or --undo finishes the park']
            : [`    a park intent is present: ${cls.intent.blocked}`]),
        ...(cls.recordTmp === null ? [] : [`    ${cls.recordTmp} is present`]),
      ]
    case 'unreadable':
      return [`    ${cls.detail ?? cls.why}${cls.errno === undefined ? '' : ` (${cls.errno})`}`]
    case 'other-user':
      return [`    cannot be read (${cls.errno}); owned by uid ${cls.ownerUid ?? 'unknown'}`]
    case 'moved':
      return [`    ${cls.detail}`]
    case 'identity-changed':
      return [`    not the folders that were written: ${cls.positions.join(', ')}`]
    case 'anything-else':
      return [`    ${cls.reason}`]
    default:
      return []
  }
}

function planLines(p: ActionPlan, opId: string): string[] {
  const flag = `--${p.action}`
  if (!p.offered) return [`    ${flag}: not offered (${p.reason}): ${p.detail}`]
  // `--apply` and `--undo` are supported (6a-iii); `--abandon`, `--clean-staging` and `--park` are 6b's.
  const later = p.action === 'apply' || p.action === 'undo' ? '' : ' (not available yet)'
  const lines = [`    ${flag}: \`skillsmith doctor recovery ${flag} ${opId}\`${later}`]
  for (const s of p.steps) {
    const d = s.disposition
    lines.push(`      ${s.tree}: ${d.kind === 'kept' ? `kept as ${d.as}` : d.kind}; ${s.note}`)
  }
  lines.push(
    `      manifest: ${p.manifest === 'untouched' ? 'untouched' : 'committed to the updated entry'}`
  )
  for (const r of p.remaining) lines.push(`      then: ${r}`)
  for (const n of p.notes) lines.push(`      note: ${n}`)
  return lines
}

function opLines(op: OpReport): string[] {
  const lines = [`  ${op.opId}  ${op.label}`]
  const f = factsOf(op.cls)
  if (f !== null) lines.push(...factsLines(f))
  lines.push(...noteOf(op.cls))
  const offered = op.plans.filter((p) => p.offered)
  if (offered.length === 0) {
    const why = op.plans.find((p) => !p.offered)
    lines.push(
      `    nothing is offered here${why !== undefined && !why.offered ? ` (${why.reason})` : ''}`
    )
  } else {
    for (const p of offered) lines.push(...planLines(p, op.opId))
    for (const p of op.plans) {
      if (!p.offered && (p.action === 'apply' || p.action === 'undo')) {
        lines.push(...planLines(p, op.opId))
      }
    }
  }
  return lines
}

/** The lines for the whole listing. */
export function renderRecovery(found: Discovery, reports: readonly RootReport[]): string[] {
  const lines: string[] = []
  const total = reports.reduce((n, r) => n + r.ops.length, 0)
  lines.push(
    `Scanned ${reports.length} skills root${reports.length === 1 ? '' : 's'}; ` +
      `${total} operation director${total === 1 ? 'y' : 'ies'} found.`
  )
  for (const r of reports) {
    const meta = found.roots.find((d) => d.root === r.root)
    if (r.staging === 'absent') continue
    lines.push('', `${r.root}${meta === undefined ? '' : `  (${meta.sources.join(', ')})`}`)
    if (r.staging === 'unsafe') {
      lines.push(`  staging cannot be listed: ${r.detail ?? 'unsafe'}`)
      continue
    }
    if (r.ops.length === 0) lines.push('  no operation directories')
    for (const op of r.ops) lines.push(...opLines(op))
    if (r.parked.length > 0) {
      lines.push('  already set aside (the op dir was parked; nothing left to do, not verified):')
      for (const p of r.parked) lines.push(`    ${p.opId}  ${p.path}`)
    }
    if (r.probes.length > 0) {
      lines.push(
        "  leftover probes (empty directories a killed update left; removed by any doctor action holding this root's lock):"
      )
      for (const p of r.probes) {
        lines.push(
          `    ${p.path}${p.type === null ? ` (${p.errno})` : p.type === 'dir' ? '' : ` (not a directory: ${p.type})`}`
        )
      }
    }
  }
  const quiet = reports.filter((r) => r.staging === 'absent').length
  if (quiet > 0)
    lines.push('', `${quiet} scanned root${quiet === 1 ? ' has' : 's have'} no staging directory.`)
  for (const s of found.skipped) {
    if (s.errno !== 'ENOENT') lines.push(`Skipped ${s.path} (${s.source}): ${s.errno}`)
  }
  return lines
}

/** The same listing as JSON: discovery, then every root with every op and its plans and digest. */
export function recoveryJson(found: Discovery, reports: readonly RootReport[]): unknown {
  return {
    stateRoots: found.stateRoots,
    skipped: found.skipped,
    roots: reports.map((r) => ({
      ...r,
      sources: found.roots.find((d) => d.root === r.root)?.sources ?? [],
      spellings: found.roots.find((d) => d.root === r.root)?.spellings ?? [],
      ops: r.ops.map((o) => ({
        opId: o.opId,
        opDir: o.opDir,
        label: o.label,
        class: o.cls,
        plans: o.plans,
        digest: o.digest,
      })),
    })),
  }
}
