/**
 * SMI-6531 (A1 step 6c-ii-b): which lock each listed copy's deletion would
 * hold (UD62, UD63; design note D12, D13). Read-only: it takes no lock and
 * makes nothing. `bindSkillsRootReadOnly` makes no directory and writes no
 * file (it `realpath`s and `lstat`s only), so it is the one binding used.
 *
 *  - A parked copy in a discovered root's area: lock 1 of that root.
 *  - A backup copy whose sidecar root binds read-only: lock 1 of it; whose
 *    root is gone (`root-unsafe` caused by ENOENT or ENOTDIR): lock 1′ of the
 *    `<client>/<rootKey>/` directory. Anything else is `unknown`: the root
 *    exists, an update there would take lock 1, and lock 1′ would not
 *    exclude it.
 *  - A parked copy in an index-only area: decided by the index line's kind.
 *    `init-rollback` and `companion-rollback` take lock 1′ of the area; any
 *    other kind needs lock 1 of a root holding the area, and this area has
 *    none. A null, unknown or disputed kind is `unknown`.
 *
 * @module @skillsmith/core/services/skill-backups.locks
 */
import fs from 'node:fs'
import path from 'node:path'
import { parkedLockPath } from '../config/file-lock.parked.js'
import type { LockAssignment, LockMap } from '../install/prune.plan.types.js'
import { bindSkillsRootReadOnly, skillsRootLockPaths, SkillWriteStop } from './skill-write-lock.js'
import type { ParkedAreaView, BackupsListing } from './skill-backups.listing.types.js'

/** Index kinds whose area is outside every skills root and takes lock 1′ (UD63). */
const AREA_LOCK_KINDS: ReadonlySet<string> = new Set(['init-rollback', 'companion-rollback'])

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

/** Index-only area: UD63, decided by the index line's kind (D13). */
function indexOnlyLock(
  listing: BackupsListing,
  view: ParkedAreaView,
  copyPath: string,
  sidecarKind: string | null
): LockAssignment {
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
  if (!AREA_LOCK_KINDS.has(kind)) {
    return unknown(
      `index-only area: kind '${kind}' needs lock 1 of a skills root holding the area, and none does`
    )
  }
  const areaReal = realOf(view.ref.areaDir)
  if (areaReal === null) return unknown('index-only area: the area cannot be resolved')
  // Exactly one state root here: zero lines returned unknown above.
  return lock1prime(stateRoots[0] as string, areaReal)
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
      put(row.copy.copyPath, indexOnlyLock(listing, view, row.copy.copyPath, row.kind))
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
