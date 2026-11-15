/**
 * SMI-6531 (A1 step 6c-ii-b): which lock each listed copy's deletion would
 * hold (UD62, UD63; design note D12, D13). Read-only: it takes no lock and
 * makes nothing. `bindSkillsRootReadOnly` makes no directory and writes no
 * file (it `realpath`s and `lstat`s only), so it is the one binding used.
 *
 *  - A parked copy in a discovered root's area: lock 1 of that root.
 *  - A backup copy's lock follows its sidecar root only when the sidecar
 *    agrees with the area it sits in: `rootKeyOf(skillsDir)` is the area's
 *    `<rootKey>` and the sidecar's client is the area's `<client>`. A sidecar
 *    naming another root is not trusted to pick the lock (an update of the
 *    area's own root publishes there under that root's lock 1), so the lock is
 *    `unknown`. With agreement: a root that binds read-only gets lock 1 of it;
 *    a gone root (`root-unsafe` caused by ENOENT or ENOTDIR) gets lock 1′ of
 *    the `<client>/<rootKey>/` directory. Anything else is `unknown`: the root
 *    exists, an update there would take lock 1, and lock 1′ would not
 *    exclude it.
 *  - A parked copy in an index-only area: decided by the index line's kind
 *    (UD63, PLAN:235). `init-rollback`, `agent-uninstall` and
 *    `companion-rollback` take lock 1′ of the area. Every other kind takes
 *    lock 1 of the skills root holding the area (the area's real parent, or
 *    `<root>` for an area under `<root>/.skillsmith-staging/`), bound
 *    read-only and still resolving to itself, and only when discovery found
 *    that root (its records were scanned); a root that does not bind, or was
 *    not discovered, is `unknown`, kept and named. A null, unknown or disputed kind is `unknown`.
 *
 * @module @skillsmith/core/services/skill-backups.locks
 */
import fs from 'node:fs'
import path from 'node:path'
import { parkedLockPath } from '../config/file-lock.parked.js'
import type { LockAssignment, LockMap } from '../install/prune.plan.types.js'
import { bindSkillsRootReadOnly, skillsRootLockPaths, SkillWriteStop } from './skill-write-lock.js'
import { rootKeyFor } from '../install/prune.classify.js'
import { policyFor } from '../install/prune.kinds.js'
import { STAGING_DIR } from './skill-backups.areas.js'
import type {
  BackupAreaView,
  BackupRow,
  ParkedAreaView,
  BackupsListing,
} from './skill-backups.listing.types.js'

/** Index kinds whose area is outside every skills root and takes lock 1′ (UD63, PLAN:235). */
const AREA_LOCK_KINDS: ReadonlySet<string> = new Set([
  'init-rollback',
  'agent-uninstall',
  'companion-rollback',
])

const unknown = (reason: string): LockAssignment => ({ kind: 'unknown', reason })

const realOf = (p: string): string | null => {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return null
  }
}

function lock1(root: string): LockAssignment {
  return { kind: 'lock1', path: skillsRootLockPaths(root)[0]!, root }
}

function lock1prime(stateRoot: string, areaReal: string): LockAssignment {
  return { kind: 'lock1prime', path: parkedLockPath(stateRoot, areaReal), areaReal }
}

/**
 * UD63's "every other kind": lock 1 of the skills root holding an index-only
 * area, bound read-only. The root is taken from the area's real path, so a
 * symlinked area names the root it really sits in.
 */
async function indexOnlyRootLock(
  listing: BackupsListing,
  areaDir: string
): Promise<LockAssignment> {
  const areaReal = realOf(areaDir)
  if (areaReal === null) return unknown('index-only area: the area cannot be resolved')
  const parent = path.dirname(areaReal)
  const root = path.basename(parent) === STAGING_DIR ? path.dirname(parent) : parent
  // Only a root discovery found had its update records scanned, so only its lock 1 is named: a
  // root nobody scanned may hold a live or unreadable record that protects the copy.
  const discovered = listing.discovery.roots.map((r) => realOf(r.root))
  if (!discovered.includes(root)) {
    return unknown(
      `index-only area: the skills root ${root} holding it was not discovered, so its update records were not read`
    )
  }
  try {
    await bindSkillsRootReadOnly(root)
  } catch (err) {
    if (!(err instanceof SkillWriteStop)) throw err
    return unknown(
      `index-only area: the skills root ${root} holding it does not bind read-only ` +
        `(${err.code}: ${err.detail})`
    )
  }
  const now = realOf(root)
  if (now !== root) {
    return unknown(`index-only area: the skills root ${root} now resolves to ${now ?? 'nothing'}`)
  }
  return lock1(root)
}

/** Index-only area: UD63, decided by the index line's kind (D13). */
async function indexOnlyLock(
  listing: BackupsListing,
  view: ParkedAreaView,
  copyPath: string,
  sidecarKind: string | null
): Promise<LockAssignment> {
  const lines = listing.index.facts.lines.filter((l) => l.copyPath === copyPath)
  // Lock 1' lives in the state root whose index named the copy; lines from two state roots
  // leave no single locks/ directory, so no lock is named.
  const stateRoots = [...new Set(lines.map((l) => l.stateRoot))]
  if (stateRoots.length > 1) {
    return unknown('index-only area: index lines from more than one state root name the copy')
  }
  const kinds = [...new Set(lines.map((l) => l.entry.kind))]
  if (kinds.length !== 1 || kinds[0] === null || kinds[0] === undefined) {
    return unknown(
      kinds.length === 0
        ? 'index-only area: the copy has no index line, so no kind decides its lock'
        : 'index-only area: the index line kind is missing or the lines disagree'
    )
  }
  const kind = kinds[0]
  if (sidecarKind === null || sidecarKind !== kind) {
    return unknown(
      `index-only area: the index kind '${kind}' is not confirmed by the sidecar kind ` +
        `(${sidecarKind === null ? 'unreadable' : `'${sidecarKind}'`})`
    )
  }
  if (policyFor('parked', kind) === null) {
    return unknown(`index-only area: the kind '${kind}' is not a parked kind prune recognises`)
  }
  if (!AREA_LOCK_KINDS.has(kind)) return indexOnlyRootLock(listing, view.ref.areaDir)
  const areaReal = realOf(view.ref.areaDir)
  if (areaReal === null) return unknown('index-only area: the area cannot be resolved')
  // Exactly one state root here: zero lines returned unknown above.
  return lock1prime(stateRoots[0] as string, areaReal)
}

const str = (o: Record<string, unknown> | null, k: string): string | null =>
  o !== null && typeof o[k] === 'string' ? (o[k] as string) : null

/**
 * Null when the sidecar's root and client agree with the area the tree sits
 * in, else why its root must not pick the lock (the same `rootKeyOf` the
 * writer keys the area by; the classifier's pinned copy, `rootKeyFor`).
 */
function sidecarDisagrees(row: BackupRow, area: BackupAreaView, skillsDir: string): string | null {
  const client = str(row.classification.sidecar, 'client')
  const key = rootKeyFor(skillsDir)
  if (key === area.rootKey && client === area.client) return null
  return (
    `the sidecar names client ${JSON.stringify(client)} and root ${skillsDir} (key ${key}), ` +
    `but the tree sits in ${area.client}/${area.rootKey}: its root does not pick the lock`
  )
}

const errnoOfCause = (err: SkillWriteStop): string | null => {
  const code = (err.cause as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : null
}

/** UD62 for one backup copy's sidecar root, memoised per root. */
async function backupRootLock(
  skillsDir: string,
  stateRoot: string,
  keyDir: string
): Promise<LockAssignment> {
  try {
    await bindSkillsRootReadOnly(skillsDir)
    // A root with no staging directory binds as null, so the root is resolved here: it must
    // still be the real path the sidecar recorded, or an update there would lock another root.
    const now = realOf(skillsDir)
    if (now !== skillsDir) {
      return unknown(`the sidecar root now resolves to ${now ?? 'nothing'}, not ${skillsDir}`)
    }
    return lock1(now)
  } catch (err) {
    if (!(err instanceof SkillWriteStop)) throw err
    const errno = errnoOfCause(err)
    if (err.code === 'root-unsafe' && (errno === 'ENOENT' || errno === 'ENOTDIR')) {
      const keyReal = realOf(keyDir)
      if (keyReal === null) return unknown(`the backup area ${keyDir} cannot be resolved`)
      return lock1prime(stateRoot, keyReal)
    }
    return unknown(`${err.code}: ${err.detail}`)
  }
}

/** Assigns every listed copy (parked rows and backup rows) exactly one entry. */
export async function assignLocks(listing: BackupsListing): Promise<LockMap> {
  const out = new Map<string, LockAssignment>()
  const put = (copyPath: string, a: LockAssignment): void => {
    out.set(copyPath, out.has(copyPath) ? unknown('the copy is listed more than once') : a)
  }
  for (const view of listing.parked) {
    for (const row of view.rows) {
      const owner = view.ref.skillsRoot
      if (owner !== null) {
        // Lock 1 is named by the root's real path; a root that cannot be resolved names none.
        const real = realOf(owner)
        put(
          row.copy.copyPath,
          real === null ? unknown(`the skills root ${owner} cannot be resolved`) : lock1(real)
        )
        continue
      }
      put(row.copy.copyPath, await indexOnlyLock(listing, view, row.copy.copyPath, row.kind))
    }
  }
  const memo = new Map<string, Promise<LockAssignment>>()
  for (const store of listing.backups) {
    for (const area of store.areas) {
      const keyDir = path.dirname(area.areaPath)
      for (const row of area.rows) {
        if (row.skillsDir === null) {
          put(row.copy.copyPath, unknown('no sidecar names the skills root'))
          continue
        }
        const disagrees = sidecarDisagrees(row, area, row.skillsDir)
        if (disagrees !== null) {
          put(row.copy.copyPath, unknown(disagrees))
          continue
        }
        const key = `${store.stateRoot}\0${keyDir}\0${row.skillsDir}`
        let pending = memo.get(key)
        if (pending === undefined) {
          pending = backupRootLock(row.skillsDir, store.stateRoot, keyDir)
          memo.set(key, pending)
        }
        put(row.copy.copyPath, await pending)
      }
    }
  }
  return out
}
