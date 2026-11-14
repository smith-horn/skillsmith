/**
 * SMI-6531 (A1 step 6c-ii-a): the D-11 classifier (ADR-166 D-11, P2), ported
 * from the SMI-6676 spike's `prune.classify.mjs` `classifyCopy` and made to
 * serve BOTH stores: a parked copy and a backup-area tree.
 *
 * First match wins: mounted, held, unverified, changed, clean. Read-only.
 * Nothing here writes, renames or deletes; the fs boundary test pins the
 * members this module may use. Additions over the spike:
 *  - `rootIdentity` carries `fmt` (the file type), which the walker's re-check
 *    needs (SMI-7130);
 *  - a parked sidecar whose `kind` prune has no policy row for is
 *    `unverified/kind-unknown` (UD64);
 *  - a recorded hash of null (a parked copy without a guard hash, a kept tree
 *    that could not be hashed) is `unverified/treehash-null` (UD68);
 *  - a backup whose sidecar `client` or root key disagrees with the area it
 *    sits in is `unverified/area-mismatch` (owner decision D4), so `--keep`'s
 *    grouping by `(client, skillsDir, dirName)` cannot be fooled by a sidecar
 *    copied into another client's area;
 *  - one `measure()` walk per copy, instead of one per call.
 *
 * The mount table fails closed: unreadable is `mounted`, never clean. It is
 * read through `park-tree.mounts.ts`, which looks `fs.readFileSync` up at
 * call time, so a test can inject a table.
 *
 * fs is the DEFAULT export, looked up at call time.
 *
 * @module @skillsmith/core/install/prune.classify
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { mountVerdictAt } from './park-tree.mounts.js'
import { errCode } from './park-result.js'
import { S_IFMT } from './park-tree.perms.js'
import { pathTreeRecord } from './park-tree.verify.js'
import { computeTreeHash } from './tree-hash.js'
import { readStable, parseSidecarStrict } from './prune.sidecar.js'
import type { PruneClass, RootIdentity, SidecarRead } from './prune.job.js'
import { measure } from './prune.measure.js'
import type { Measured } from './prune.measure.js'
import { policyFor } from './prune.kinds.js'
import type { ClassifyInput, CopyStore } from './prune.list.types.js'

/** A class a listing can give: the four a walker may be handed, and `mounted`, which is never offered. */
export type CopyClass = 'mounted' | PruneClass

export interface Classification {
  klass: CopyClass
  /** Why, or null for `clean`. */
  reason: string | null
  detail: string | null
  /** The hash of the tree as it is now, when it could be walked. */
  freshHash: string | null
  /** The hash the sidecar recorded. */
  recordedHash: string | null
  /** The copy root's identity as bound now, or null when it could not be read. */
  rootIdentity: RootIdentity | null
  /** The sidecar as stable-read: the exact bytes and the inode they came from. */
  sidecarRead: SidecarRead | null
  /** The parsed sidecar, when it parsed. */
  sidecar: Record<string, unknown> | null
  /** The sidecar's kind, when it parsed. */
  kind: string | null
  /** One walk's allocated bytes, apparent bytes and unmeasured count. */
  measured: Measured
}

/** A sidecar is under 2 KiB; one over this is not Skillsmith's. */
const SIDECAR_MAX_BYTES = 1024 * 1024

/** First 16 hex characters of sha256 over the skills root, as `rootKeyOf` in `skill-swap.area.ts`. */
export const rootKeyFor = (root: string): string =>
  crypto.createHash('sha256').update(root).digest('hex').slice(0, 16)

/** Linux: is there a mount point exactly AT `abs`? Unresolvable or unreadable is true (fail closed). */
export function mountAt(abs: string): boolean {
  const v = mountVerdictAt(abs)
  if (!v.mounted) return false
  return v.reason !== 'mount-point' || (v.real !== null && v.points.includes(v.real))
}

/** `absent` (ENOENT only), `present`, or the errno of any other failure: unreadable is not absent. */
const probe = (p: string): 'present' | 'absent' | { errno: string | null } => {
  try {
    fs.lstatSync(p)
    return 'present'
  } catch (err) {
    return errCode(err) === 'ENOENT' ? 'absent' : { errno: errCode(err) }
  }
}

type Extra = Partial<Omit<Classification, 'klass' | 'reason' | 'measured'>>
type Make = (klass: CopyClass, reason: string | null, extra?: Extra) => Classification

/** The mounted checks: a mount at or under the copy, another device, a mount inside the tree. */
function mountedFinding(
  copy: ClassifyInput,
  rootSt: BigIntStats,
  res: Make,
  base: Extra
): Classification | null {
  const mi = mountVerdictAt(copy.copyPath)
  if (mi.mounted) return res('mounted', mi.reason, { ...base, detail: mi.detail })
  const parentDir = copy.schema === undefined ? copy.parentDir : path.dirname(copy.copyPath)
  try {
    if (fs.lstatSync(parentDir, { bigint: true }).dev !== rootSt.dev) {
      return res('mounted', 'copy-root-other-device', {
        ...base,
        detail: 'the copy root is on another device than its directory',
      })
    }
  } catch (err) {
    return res('unverified', 'tree-unreadable', {
      ...base,
      detail: `directory unreadable (${errCode(err)})`,
    })
  }
  return null
}

/**
 * Classifies one copy of `store`. Never throws: an unreadable copy is
 * `unverified/tree-unreadable`.
 */
export function classifyCopy(copy: ClassifyInput, store: CopyStore): Classification {
  const measured = measure(copy.copyPath)
  const res: Make = (klass, reason, extra = {}) => ({
    klass,
    reason,
    detail: null,
    freshHash: null,
    recordedHash: null,
    rootIdentity: null,
    sidecarRead: null,
    sidecar: null,
    kind: null,
    measured,
    ...extra,
  })
  let rootSt: BigIntStats
  try {
    rootSt = fs.lstatSync(copy.copyPath, { bigint: true })
  } catch (err) {
    return res('unverified', 'tree-unreadable', { detail: `copy unreadable (${errCode(err)})` })
  }
  const base: Extra = {
    rootIdentity: {
      dev: rootSt.dev,
      ino: rootSt.ino,
      birthtimeNs: rootSt.birthtimeNs,
      fmt: rootSt.mode & S_IFMT,
    },
  }
  const mounted = mountedFinding(copy, rootSt, res, base)
  if (mounted !== null) return mounted
  const walk = pathTreeRecord(copy.copyPath, { mountCheck: true })
  if (!walk.ok && walk.reason === 'mount-inside-tree') {
    return res('mounted', 'mount-inside-tree', {
      ...base,
      detail: `mount at ${walk.rel} (st_dev differs from the root)`,
    })
  }
  const fresh = walk.ok ? computeTreeHash(walk.record) : null
  return bySidecar(copy, store, { res, base, fresh, walkProblem: walk.ok ? null : walk })
}

interface Walked {
  res: Make
  base: Extra
  fresh: string | null
  walkProblem: { reason: string; path: string } | null
}

/** Held, unverified, changed, clean: everything that reads the sidecar. */
function bySidecar(copy: ClassifyInput, store: CopyStore, w: Walked): Classification {
  const { res, base, fresh } = w
  if (copy.interruptedDelete === true) {
    return res('held', 'interrupted-delete', {
      ...base,
      freshHash: fresh,
      detail: 'prune stopped part-way through deleting this copy',
    })
  }
  const present = probe(copy.sidecarPath)
  if (present === 'absent') {
    return res('held', 'sidecar-absent', { ...base, freshHash: fresh, detail: 'no sidecar' })
  }
  if (present !== 'present') {
    return res('held', 'sidecar-unreadable', {
      ...base,
      freshHash: fresh,
      detail: `the sidecar could not be examined (${present.errno})`,
    })
  }
  const rs = readStable(copy.sidecarPath, { maxBytes: SIDECAR_MAX_BYTES })
  if (!rs.ok) {
    return res('held', 'sidecar-unreadable', {
      ...base,
      detail: `${rs.reason}${rs.errno ? ` (${rs.errno})` : ''}`,
    })
  }
  const sidecarRead: SidecarRead = {
    bytes: rs.bytes,
    ino: rs.ino,
    size: rs.size,
    mtimeNs: rs.mtimeNs,
    ctimeNs: rs.ctimeNs,
  }
  let json: unknown
  try {
    json = JSON.parse(rs.bytes.toString('utf8'))
  } catch {
    return res('held', 'sidecar-unparseable', { ...base, sidecarRead })
  }
  const withRead: Extra = { ...base, sidecarRead, freshHash: fresh }
  if (json !== null && typeof json === 'object' && (json as { hold?: unknown }).hold === true) {
    const h = (json as { postMoveTreeHash?: unknown }).postMoveTreeHash
    return res('held', 'hold', {
      ...withRead,
      sidecar: json as Record<string, unknown>,
      recordedHash: typeof h === 'string' ? h : null,
    })
  }
  const strict = parseSidecarStrict(rs.bytes, {
    copyPath: copy.schema?.copyPath ?? copy.copyPath,
    parentName: copy.schema?.parentName ?? path.basename(copy.parentDir),
    store,
  })
  if (!strict.ok) return res('unverified', 'schema-invalid', { ...withRead, detail: strict.detail })
  return verified(copy, store, strict, { ...w, base: withRead })
}

/** A sidecar that passed its schema: its kind, its area, its hash, then the tree against it. */
function verified(
  copy: ClassifyInput,
  store: CopyStore,
  strict: { sidecar: Record<string, unknown>; recordedHash: string | null },
  w: Walked
): Classification {
  const { res, base, fresh, walkProblem } = w
  const sc = strict.sidecar
  const kind = typeof sc.kind === 'string' ? sc.kind : null
  const withSc: Extra = { ...base, sidecar: sc, kind }
  if (kind === null || policyFor(store, kind) === null) {
    return res('unverified', 'kind-unknown', {
      ...withSc,
      detail: `prune has no policy for kind ${JSON.stringify(sc.kind)}`,
    })
  }
  if (store === 'backup') {
    // A backup input with no area facts cannot be cross-checked, so it is never clean (D4).
    if (copy.area === undefined) {
      return res('unverified', 'area-unknown', {
        ...withSc,
        detail: 'the backup tree has no area facts to check its sidecar against',
      })
    }
    const key = typeof sc.skillsDir === 'string' ? rootKeyFor(sc.skillsDir) : null
    if (sc.client !== copy.area.client || key !== copy.area.rootKey) {
      return res('unverified', 'area-mismatch', {
        ...withSc,
        detail:
          `the sidecar names client ${JSON.stringify(sc.client)} and root key ${key}, ` +
          `but the tree sits in ${copy.area.client}/${copy.area.rootKey}`,
      })
    }
  }
  if (strict.recordedHash === null) {
    return res('unverified', 'treehash-null', {
      ...withSc,
      detail: 'the sidecar records no tree hash',
    })
  }
  if (walkProblem !== null) {
    return res('unverified', 'tree-unreadable', {
      ...withSc,
      detail: `${walkProblem.reason} at ${walkProblem.path}`,
    })
  }
  const recordedHash = strict.recordedHash
  if (fresh !== recordedHash) return res('changed', 'hash-differs', { ...withSc, recordedHash })
  return res('clean', null, { ...withSc, recordedHash })
}
