/**
 * SMI-6531 (A1 step 6c-ii-b): `planPrune`, the selection behind `doctor backups
 * --prune` (PLAN 2047; UD29, UD60-UD65; design note sections 1.2, 2 and 4.1).
 *
 * Pure: it reads a listing, a request and the lock assignments, and touches no
 * filesystem (the fs boundary pins it `[]`). 6c-iii deletes exactly what this
 * plan holds, so every rule below errs toward keeping a tree:
 *
 *  1. No selector selects nothing. Selectors intersect, over both stores;
 *     `--keep` is a selector only when given (UD65, M-KEEP1).
 *  2. UD61: a tree whose protection is `protected` OR `unknown` is never
 *     selected. Rule (c) and D17 (a live unreadable record's opId) are also
 *     applied to parked copies.
 *  3. A mounted copy is never offered, whatever `--allow-changed` says (D-11).
 *  4. The kind table (`prune.kinds.ts`): `--include-kept` kinds, the
 *     `partial-copy` split on `sourceUnchanged`; an unknown kind needs it too.
 *  5. `--keep` (default 1) guards the newest per group, and unknown age (D5).
 *  6. Held, changed and unverified copies need `--allow-changed <copyPath>`, and
 *     then a per-item yes; clean copies the batch yes. The tier follows the
 *     class, never the kind (M-T1), and the plan carries no authorization (M-T2).
 *  7. A copy whose lock is unknown (or missing from the map) is never selected.
 *
 * Groups come in ascending bytewise order of the lock path (UD60), each with
 * the digest 6c-iii re-plans against.
 *
 * @module @skillsmith/core/install/prune.select
 */
import type {
  ExcludedRow,
  ExcludeReason,
  LockAssignment,
  LockMap,
  PlanGroup,
  PlanItem,
  PlanTier,
  PrunePlan,
  PruneRequest,
} from './prune.plan.types.js'
import type { BackupsListing } from '../services/skill-backups.listing.types.js'
import { policyFor } from './prune.kinds.js'
import { bytewise, groupDigest } from './prune.select.digest.js'
import { candidatesOf, hasSelector, keepGuards, matches } from './prune.select.match.js'
import type { Candidate, Guards } from './prune.select.match.js'
import { preconditionsOf, unmatchedPaths } from './prune.select.paths.js'

type Locked = Exclude<LockAssignment, { kind: 'unknown' }>

/** Run-wide UD61 facts the parked copies need: (c) and D17, from the whole listing. */
interface RunFacts {
  /** opId -> the parked `unreadable-record` copy with it. */
  parkedUnreadable: Map<string, string>
  /** opId -> a live record that could not be verified, named by its op dir (D17). */
  liveUnreadable: Map<string, string>
}

function runFacts(listing: BackupsListing, cands: readonly Candidate[]): RunFacts {
  const parkedUnreadable = new Map<string, string>()
  for (const c of cands) {
    if (c.store === 'parked' && c.row.kind === 'unreadable-record') {
      parkedUnreadable.set(c.row.copy.opId, c.row.copy.copyPath)
    }
  }
  const liveUnreadable = new Map<string, string>()
  for (const u of listing.records.unreadable) liveUnreadable.set(u.record.opId, u.record.path)
  return { parkedUnreadable, liveUnreadable }
}

/** UD61 for one candidate: the reason it is protected or unknown, or null when it is free. */
function protectionReason(c: Candidate, f: RunFacts): ExcludeReason | null {
  const opId = c.store === 'backup' ? c.row.opId : c.row.copy.opId
  const unreadable = f.liveUnreadable.get(opId)
  if (c.store === 'backup') {
    const p = c.row.protection
    if (p.status === 'protected') return { code: 'protected', rule: p.rule, path: p.path }
    if (unreadable !== undefined) {
      return {
        code: 'protection-unknown',
        reason: `the unreadable update record ${unreadable} has this operation id`,
      }
    }
    if (p.status === 'unknown') return { code: 'protection-unknown', reason: p.reason }
    return null
  }
  // Rule (c) for a parked copy: another parked copy with this opId is an unreadable record.
  // The unreadable-record copy itself stays selectable with --include-kept (UD61).
  const parked = f.parkedUnreadable.get(opId)
  if (parked !== undefined && c.row.kind !== 'unreadable-record') {
    return { code: 'protected', rule: 'parked-unreadable-record', path: parked }
  }
  if (unreadable !== undefined) {
    return {
      code: 'protection-unknown',
      reason: `the unreadable update record ${unreadable} has this operation id`,
    }
  }
  return null
}

/** The kind table: null when the kind may be selected under this request. */
function kindReason(c: Candidate, includeKept: boolean): ExcludeReason | null {
  const kind = c.row.kind
  const policy = kind === null ? null : policyFor(c.store, kind)
  let selection = policy?.selection ?? 'include-kept'
  if (selection === 'default-if-source-unchanged') {
    selection =
      c.row.classification.sidecar?.['sourceUnchanged'] === true ? 'default' : 'include-kept'
  }
  return selection === 'default' || includeKept ? null : { code: 'needs-include-kept', kind }
}

type Verdict = { ok: true; item: PlanItem; lock: Locked } | { ok: false; reason: ExcludeReason }

/** Every rule, in order; the first that keeps the copy is its reason (D20). */
function judge(
  c: Candidate,
  req: PruneRequest,
  locks: LockMap,
  guards: Guards,
  facts: RunFacts
): Verdict {
  const no = (reason: ExcludeReason): Verdict => ({ ok: false, reason })
  const row = c.row
  const cls = row.classification
  const prot = protectionReason(c, facts)
  if (prot !== null) return no(prot)
  if (cls.klass === 'mounted') return no({ code: 'mounted' })
  const kind = kindReason(c, req.includeKept)
  if (kind !== null) return no(kind)
  const guard = guards.get(row.copy.copyPath)
  if (guard !== undefined) return no(guard)
  const klass = cls.klass
  let tier: PlanTier = 'batch'
  if (klass !== 'clean') {
    if (!req.allowChanged.includes(row.copy.copyPath)) {
      return no({ code: 'needs-allow-changed', klass })
    }
    tier = 'per-item'
  }
  // The hash the user approves: the recorded one for a clean copy, the fresh one per item.
  const approvedHash = klass === 'clean' ? cls.recordedHash : cls.freshHash
  if (cls.rootIdentity === null || approvedHash === null) {
    return no({
      code: 'unidentified',
      reason:
        cls.rootIdentity === null
          ? 'the copy root could not be identified, so no deletion job can name it'
          : 'the tree could not be hashed, so there is no hash to approve',
    })
  }
  const lock = locks.get(row.copy.copyPath)
  if (lock === undefined) return no({ code: 'lock-unknown', reason: 'no lock was assigned' })
  if (lock.kind === 'unknown') return no({ code: 'lock-unknown', reason: lock.reason })
  const item: PlanItem = {
    leaf: row.copy.name,
    klass,
    stagingRoot: row.copy.stagingRoot,
    opDir: row.copy.opDir,
    copyPath: row.copy.copyPath,
    sidecarPath: cls.sidecarRead === null ? null : row.copy.sidecarPath,
    sidecarRead: cls.sidecarRead,
    rootIdentity: cls.rootIdentity,
    approvedHash,
    store: c.store,
    kind: row.kind,
    allocatedBytes: row.allocatedBytes,
    tier,
  }
  return { ok: true, item, lock }
}

/**
 * The areas a group's re-plan must list: where its items are, plus every area
 * holding a tree of the same `--keep` group, so the scoped re-plan sees the
 * same newest trees (a keep group can span state roots).
 */
function scopeOf(items: readonly Candidate[], cands: readonly Candidate[]): string[] {
  const areas = new Set(items.map((c) => c.areaPath))
  const groups = new Set(items.flatMap((c) => (c.store === 'backup' ? [c.keepGroup] : [])))
  for (const c of cands) if (c.store === 'backup' && groups.has(c.keepGroup)) areas.add(c.areaPath)
  return [...areas].sort(bytewise)
}

/** Plans a prune from a listing. Pure: reads its arguments only. */
export function planPrune(
  listing: BackupsListing,
  request: PruneRequest,
  locks: LockMap
): PrunePlan {
  const keep = request.keep ?? 1
  if (!Number.isInteger(keep) || keep < 0) {
    throw new TypeError(`planPrune: keep must be a non-negative integer, got ${String(keep)}`)
  }
  const preconditions = preconditionsOf(listing)
  const plan: PrunePlan = {
    request,
    noSelector: !hasSelector(request),
    preconditions,
    groups: [],
    excluded: [],
    unmatchedPaths: [],
  }
  if (plan.noSelector) return plan
  const cands = candidatesOf(listing)
  plan.unmatchedPaths = unmatchedPaths(
    listing,
    request.paths ?? [],
    new Set(cands.map((c) => c.row.copy.copyPath))
  )
  const guards = keepGuards(cands, keep)
  const facts = runFacts(listing, cands)
  const byLock = new Map<string, { lock: Locked; cands: Candidate[]; items: PlanItem[] }>()
  const excluded: ExcludedRow[] = []
  for (const c of cands) {
    if (!matches(c, request)) continue
    const v = judge(c, request, locks, guards, facts)
    if (!v.ok) {
      excluded.push({ copyPath: c.row.copy.copyPath, store: c.store, reason: v.reason })
      continue
    }
    const g = byLock.get(v.lock.path)
    if (g === undefined) byLock.set(v.lock.path, { lock: v.lock, cands: [c], items: [v.item] })
    else {
      g.cands.push(c)
      g.items.push(v.item)
    }
  }
  const groups: PlanGroup[] = []
  for (const [lockPath, g] of byLock) {
    const items = [...g.items].sort((a, b) => bytewise(a.copyPath, b.copyPath))
    groups.push({
      lock: g.lock,
      scope: { areaPaths: scopeOf(g.cands, cands) },
      items,
      digest: groupDigest(lockPath, items),
    })
  }
  plan.groups = groups.sort((a, b) => bytewise(a.lock.path, b.lock.path))
  plan.excluded = excluded.sort((a, b) => bytewise(a.copyPath, b.copyPath))
  return plan
}
