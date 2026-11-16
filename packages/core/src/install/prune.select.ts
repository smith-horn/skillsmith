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
 *     selected. Each row's protection, parked or backup, is the listing's
 *     (`skill-backups.protect.ts`): the planner has no protection rule of its
 *     own, so a scoped or narrowed listing cannot weaken it.
 *  3. A mounted copy is never offered, whatever `--allow-changed` says (D-11).
 *  4. The kind table (`prune.kinds.ts`): `--include-kept` kinds, the
 *     `partial-copy` split on `sourceUnchanged`; an unknown kind needs it too.
 *  5. `--keep` (default 1) guards the newest per group, and unknown age (D5).
 *  6. Held, changed and unverified copies need `--allow-changed <copyPath>`, and
 *     then a per-item yes; clean copies the batch yes. The tier follows the
 *     class, never the kind (M-T1), and the plan carries no authorization (M-T2).
 *  7. A copy no deletion job can name (unknown root identity, or no hash to
 *     approve) is never selected (`unidentified`).
 *  8. A copy whose lock is unknown (or missing from the map) is never selected.
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

/**
 * UD61 for one candidate, either store: the row's own `protection`, which the
 * listing decided once from the whole machine's facts. The planner adds no
 * protection rule of its own, so scope and narrowing cannot change it.
 */
function protectionReason(c: Candidate): ExcludeReason | null {
  const p = c.row.protection
  if (p.status === 'protected') return { code: 'protected', rule: p.rule, path: p.path }
  // Only an explicit `unprotected` selects: any other status, one this code does not know
  // included, keeps the copy.
  if (p.status === 'unprotected') return null
  const reason = (p as { reason?: unknown }).reason
  return {
    code: 'protection-unknown',
    reason:
      typeof reason === 'string'
        ? reason
        : `unrecognised protection status ${String((p as { status: unknown }).status)}`,
  }
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
function judge(c: Candidate, req: PruneRequest, locks: LockMap, guards: Guards): Verdict {
  const no = (reason: ExcludeReason): Verdict => ({ ok: false, reason })
  const row = c.row
  const cls = row.classification
  const prot = protectionReason(c)
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
  // keep 0 would guard nothing and select every group's newest tree (owner decision: keep >= 1).
  if (!Number.isInteger(keep) || keep < 1) {
    throw new TypeError(`planPrune: keep must be an integer of at least 1, got ${String(keep)}`)
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
  const byLock = new Map<string, { lock: Locked; cands: Candidate[]; items: PlanItem[] }>()
  const excluded: ExcludedRow[] = []
  for (const c of cands) {
    if (!matches(c, request)) continue
    const v = judge(c, request, locks, guards)
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
