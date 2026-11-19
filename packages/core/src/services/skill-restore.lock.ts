/**
 * SMI-6531 (A1 step 6d-ii, D6, design note §4.1a): the lock restore takes is
 * decided by the origin's CURRENT containing skills root, not by the area the
 * copy sits in (`assignLocks`). Read-only: it binds with
 * `bindSkillsRootReadOnly` and makes nothing.
 *
 * @module @skillsmith/core/services/skill-restore.lock
 */
import fs from 'node:fs'
import path from 'node:path'
import { parkedLockPath } from '../config/file-lock.parked.js'
import type { LockAssignment } from '../install/prune.plan.types.js'
import { STAGING_DIR } from './skill-backups.areas.js'
import type { Discovery } from './skill-recovery.discover.js'
import type { IndexedLine } from './skill-backups.areas.js'
import {
  bindSkillsRootReadOnly,
  skillsRootLockPaths,
  SkillWriteStop,
  SKILL_WRITE_LOCK_BASENAME,
} from './skill-write-lock.js'
import type { RestoreLock, RestoreRefusalReason } from './skill-restore.types.js'

export type ChosenLock =
  | {
      ok: true
      lock: RestoreLock
      note: string | null
      disagreement: { prune: LockAssignment | null; restore: RestoreLock } | null
      rootIdentity: string | null
    }
  | { ok: false; reason: RestoreRefusalReason; message: string }

const realOf = (p: string): string | null => {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return null
  }
}

/** True when `child` is `root` or inside it, by path segments, never by string prefix. */
export function insideOrEqual(root: string, child: string): boolean {
  const rel = path.relative(root, child)
  // A folder named `..proj` is inside; only `..` itself, or `../...`, is outside.
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

/** The longest discovered root (real path) equal to `o` or an ancestor of it. */
export function containingRoot(roots: Discovery['roots'], o: string): string | null {
  let best: string | null = null
  for (const r of roots) {
    const real = realOf(r.root)
    if (real !== null && insideOrEqual(real, o) && (best === null || real.length > best.length)) {
      best = real
    }
  }
  return best
}

/** D14: an ancestor holding a staging directory or a lock-1 file that discovery did not find. */
export function undiscoveredRootAbove(o: string): string | null {
  for (let d = o; ; d = path.dirname(d)) {
    if (
      fs.existsSync(path.join(d, STAGING_DIR)) ||
      fs.existsSync(path.join(d, `${SKILL_WRITE_LOCK_BASENAME}.lock`))
    ) {
      return d
    }
    if (path.dirname(d) === d) return null
  }
}

const describe = (a: LockAssignment | undefined): string =>
  a === undefined
    ? 'no lock (not listed)'
    : a.kind === 'unknown'
      ? `no lock (${a.reason})`
      : `the lock ${a.path}`

export function chooseLock(args: {
  discovery: Pick<Discovery, 'roots'>
  indexLines: readonly IndexedLine[]
  copyPath: string
  origin: string
  /** `realpath.native(dirname(origin))`. */
  o: string
  areaDir: string
  assigned: LockAssignment | undefined
}): Promise<ChosenLock> {
  return choose(args)
}

async function choose(args: Parameters<typeof chooseLock>[0]): Promise<ChosenLock> {
  const { discovery, indexLines, copyPath, origin, o, areaDir, assigned } = args
  const root = containingRoot(discovery.roots, o)
  let lock: RestoreLock
  let rootIdentity: string | null = null
  if (root !== null) {
    try {
      await bindSkillsRootReadOnly(root)
    } catch (err) {
      if (!(err instanceof SkillWriteStop)) throw err
      return {
        ok: false,
        reason: 'origin-root-unbindable',
        message: `The skills folder \`${root}\` that \`${origin}\` is in can't be used right now (${err.code}: ${err.detail}), so nothing was restored.`,
      }
    }
    if (realOf(root) !== root) {
      return {
        ok: false,
        reason: 'origin-root-unbindable',
        message: `The skills folder \`${root}\` that \`${origin}\` is in can't be used right now (root-changed: it now resolves elsewhere), so nothing was restored.`,
      }
    }
    try {
      const st = fs.lstatSync(root, { bigint: true })
      rootIdentity = `${st.dev}:${st.ino}`
    } catch (err) {
      return {
        ok: false,
        reason: 'origin-root-unbindable',
        message: `The skills folder \`${root}\` that \`${origin}\` is in can't be used right now (${(err as NodeJS.ErrnoException).code ?? 'UNKNOWN'}: it can't be read), so nothing was restored.`,
      }
    }
    lock = { kind: 'lock1', root, path: skillsRootLockPaths(root)[0]! }
  } else {
    const lines = indexLines.filter((l) => l.copyPath === copyPath)
    const stateRoots = [...new Set(lines.map((l) => l.stateRoot))]
    if (stateRoots.length !== 1) {
      return {
        ok: false,
        reason: 'origin-root-unknown',
        message: `Skillsmith can't tell which lock protects \`${copyPath}\` (${
          stateRoots.length === 0
            ? 'no set-aside index names it'
            : 'indexes from more than one state root name it'
        }), so it won't restore it.`,
      }
    }
    const hit = undiscoveredRootAbove(o)
    if (hit !== null) {
      return {
        ok: false,
        reason: 'origin-root-undiscovered',
        message: `\`${hit}\` looks like a skills folder Skillsmith didn't find from here. Run \`skillsmith restore <id> --root ${hit}\` so it can lock that folder.`,
      }
    }
    const areaReal = realOf(areaDir)
    if (areaReal === null) {
      return {
        ok: false,
        reason: 'origin-root-unknown',
        message: `Skillsmith can't tell which lock protects \`${copyPath}\` (its set-aside folder can't be resolved), so it won't restore it.`,
      }
    }
    const stateRoot = stateRoots[0]!
    lock = { kind: 'lock1prime', path: parkedLockPath(stateRoot, areaReal), stateRoot, areaReal }
  }
  const same = assigned !== undefined && assigned.kind !== 'unknown' && assigned.path === lock.path
  const note = same
    ? null
    : `Note: \`skillsmith doctor backups --prune\` would lock this copy with ${describe(assigned)}; restore locks ${lock.path} because ${origin} is ${
        root === null ? 'outside every skills root' : `inside ${root}`
      }.`
  return {
    ok: true,
    lock,
    note,
    disagreement: same ? null : { prune: assigned ?? null, restore: lock },
    rootIdentity,
  }
}
