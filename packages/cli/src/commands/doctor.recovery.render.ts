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
import path from 'node:path'
import type {
  ActionPlan,
  Discovery,
  OpFacts,
  OpReport,
  RecoveryClass,
  RootReport,
} from '@skillsmith/core'
import { GUARD_WORD, MOVE_SOURCE_NO_RECORD_ORIGIN } from '@skillsmith/core'

const short = (h: string | null): string => (h === null ? 'unhashable' : h.slice(0, 12))

/** An unreadable record's op dir as the classifier read it: its entries and whether it can be guarded. */
function observedLines(cls: Extract<RecoveryClass, { kind: 'unreadable' }>): string[] {
  const o = cls.observed
  if (o === null) return []
  const h = o.hash
  return [
    `    entries: ${o.entries.map((e) => `${e.name} (${e.stat.ok ? e.stat.type : e.stat.errno})`).join(', ')}`,
    h.ok
      ? `    guard hash: ${short(h.hash)} (${h.bytes} bytes of files)`
      : `    guard walk failed: ${GUARD_WORD[h.reason] ?? h.reason} at ${h.path}${h.errno === null ? '' : ` (${h.errno})`}`,
  ]
}

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
    // The area the classifier reads this op dir's keeps from (core's `facts.area`): the record's own
    // for a recorded op, where this is `record.backupDest`; the scanned root's for a moved one (6b-iii).
    `    backup: ${path.join(f.area, f.opId)}`
  )
  for (const g of f.groups) {
    lines.push(
      g.otherCopy
        ? `    keep ${g.base}: another copy's keep (an abandon of another op dir with this id); not this op's`
        : `    keep ${g.base}: ${g.state ?? `not classified (${g.unclassified})`}${g.verified ? ', verified' : ''}`
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

type NoRecordClass = Extract<RecoveryClass, { kind: 'no-record' }>

/** How an op dir with no `record.json` came to be, from the park intent it holds (W1). */
function noRecordWord(cls: NoRecordClass): string {
  const entries = `entries: ${cls.entries.join(', ') || 'none'}`
  const i = cls.intent
  if (i !== null && i.valid && i.kind === 'move-source') {
    return `    no record.json: ${MOVE_SOURCE_NO_RECORD_ORIGIN}, before its op dir was set aside; ${entries}`
  }
  if (i !== null && i.valid && i.kind === 'abort-new') {
    return `    no record.json: the update aborted and was setting it aside (an abort-new park intent); ${entries}`
  }
  return `    no record.json (the update stopped before writing it, or after removing it); ${entries}`
}

function noteOf(cls: RecoveryClass): string[] {
  switch (cls.kind) {
    case 'empty-op-dir':
      return ["    empty: any doctor action holding this root's lock removes it with one rmdir"]
    case 'no-record':
      return [
        noRecordWord(cls),
        cls.owner === null
          ? '    owner: no owner.json'
          : `    owner: pid ${cls.owner.pid ?? '?'} on ${cls.owner.host ?? '?'}, uid ${cls.owner.uid ?? '?'}`,
        // The owner verdict as a fact. Which action is offered, and with which flag, is the
        // --clean-staging line's derived hint (UD57), never words written here.
        `    owner verdict: ${cls.clean.verdict} (${cls.clean.verdictWhy})`,
        ...(cls.intent === null
          ? []
          : !cls.intent.valid
            ? [`    a park intent is present: ${cls.intent.blocked}`]
            : cls.intent.kind === 'abort-new'
              ? [
                  `    an abort-new park intent is present and verifies${
                    cls.clean.intentBlocked === null ? '' : `: ${cls.clean.intentBlocked}`
                  }`,
                ]
              : cls.intent.blocked === null
                ? ['    a move-source park intent is present and verifies']
                : [`    a park intent is present: ${cls.intent.blocked}`]),
        ...(cls.recordTmp === null ? [] : [`    ${cls.recordTmp} is present`]),
      ]
    case 'unreadable':
      return [
        `    ${cls.detail ?? cls.why}${cls.errno === undefined ? '' : ` (${cls.errno})`}`,
        ...observedLines(cls),
      ]
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
  // Every action is supported (6a-iii, 6b-i, 6b-ii, 6b-iii): an offered plan names its command.
  const lines = [`    ${flag}: \`skillsmith doctor recovery ${flag} ${opId}\``]
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
    // 6b-i: an unreadable record whose op dir cannot be parked says why, with the walk's path and errno.
    const park = op.plans.find((p) => p.action === 'park')
    if (op.cls.kind === 'unreadable' && park !== undefined) lines.push(...planLines(park, op.opId))
    // 6b-ii: a no-record op dir says why --clean-staging is not offered (the owner, an entry, the intent).
    const clean = op.plans.find((p) => p.action === 'clean-staging')
    if (op.cls.kind === 'no-record' && clean !== undefined) lines.push(...planLines(clean, op.opId))
    // An op dir holding a stray entry (2026-10-28): the actions that would act say why, naming it
    // (a row's --apply and --undo; --abandon for the classes only it acts on).
    if (f !== null && f.strays.length > 0) {
      const named = op.cls.kind === 'state' ? ['apply', 'undo'] : ['abandon']
      for (const p of op.plans) if (named.includes(p.action)) lines.push(...planLines(p, op.opId))
    }
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
      lines.push(
        '  already set aside (doctor takes no action: it neither verifies nor syncs that copy):'
      )
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
