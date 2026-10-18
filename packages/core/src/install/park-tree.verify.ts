/**
 * SMI-6531 (A1 step 3a): the tree walk, the mountinfo probe and post-move
 * verification, ported from the SMI-6676 spike's `quarantine.verify.mjs`.
 *
 * What the post-move check detects, and what it does not, is stated once in
 * ADR-166's D-0 amendment ("What the post-move check detects, and what it
 * doesn't"); not restated here.
 *
 * @module @skillsmith/core/install/park-tree.verify
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { computeTreeHash } from './tree-hash.js'
import type { TreeRecord } from './tree-hash.js'
import { errCode, errCodeOrMessage } from './park-result.js'
import type { ParkIdentity } from './park-result.js'
import { MOUNTINFO_APPLIES, readMountPointsAtOrUnder } from './park-tree.mounts.js'
import { opDirOwnerModeProblem } from './park-tree.perms.js'
import { bindIdentity, identityOf, sameIdentity } from './park-tree.identity.js'

export type WalkFailureReason = 'guard-unreadable' | 'guard-unsupported-type' | 'mount-inside-tree'

export type PathTreeRecordResult =
  | { ok: true; record: TreeRecord }
  | { ok: false; reason: WalkFailureReason; path: string; rel?: string; errno: string | null }

type WalkFailure = Extract<PathTreeRecordResult, { ok: false }>

/**
 * Builds a §3.4 tree record from a path walk that never follows links. Path
 * based and so TOCTOU-prone: it closes the pre-aged-substitute class only.
 *
 * `mountCheck: true` compares each entry's bigint `dev` with the root's and
 * stops at the first difference with `mount-inside-tree` (ADR-166 D-10 item 5).
 * The default stays mount-tolerant, because a caller's own hash must walk
 * through a mount.
 *
 * Any entry that is not a directory, regular file or symlink (FIFO, socket,
 * device), the root included, ends `guard-unsupported-type` (§3.4, UD30).
 */
export function pathTreeRecord(
  absRoot: string,
  { mountCheck = false }: { mountCheck?: boolean } = {}
): PathTreeRecordResult {
  const record: TreeRecord = new Map()
  let rootDev: bigint | null = null
  const unreadable = (abs: string, err: unknown): WalkFailure => ({
    ok: false,
    reason: 'guard-unreadable',
    path: abs,
    errno: errCode(err),
  })
  function visit(rel: string, abs: string): WalkFailure | null {
    let st: BigIntStats
    try {
      st = fs.lstatSync(abs, { bigint: true })
    } catch (err) {
      return unreadable(abs, err)
    }
    if (rootDev === null) rootDev = st.dev
    else if (mountCheck && st.dev !== rootDev) {
      return { ok: false, reason: 'mount-inside-tree', path: abs, rel, errno: null }
    }
    const mode = Number(st.mode)
    const size = st.size
    if (st.isDirectory()) {
      record.set(rel, { type: 'dir', mode, size })
      let names: string[]
      try {
        names = fs.readdirSync(abs).sort()
      } catch (err) {
        return unreadable(abs, err)
      }
      for (const name of names) {
        const r = visit(rel ? `${rel}/${name}` : name, path.join(abs, name))
        if (r !== null) return r
      }
      return null
    }
    if (st.isSymbolicLink()) {
      try {
        record.set(rel, { type: 'symlink', mode, size, linkText: fs.readlinkSync(abs) })
      } catch (err) {
        return unreadable(abs, err)
      }
      return null
    }
    if (st.isFile()) {
      let buf: Buffer
      try {
        buf = fs.readFileSync(abs)
      } catch (err) {
        return unreadable(abs, err)
      }
      record.set(rel, {
        type: 'file',
        mode,
        size,
        contentHash: crypto.createHash('sha256').update(buf).digest('hex'),
      })
      return null
    }
    return { ok: false, reason: 'guard-unsupported-type', path: abs, errno: null }
  }
  const failure = visit('', absRoot)
  if (failure !== null) return failure
  return { ok: true, record }
}

/**
 * On Linux, a mountinfo mount point at or under `dirReal`: null when there is
 * none, else a detail string. An unreadable table fails closed: it is reported
 * as a possible mount, because a same-filesystem bind mount is otherwise
 * undetectable.
 */
export function mountinfoFinding(dirReal: string): string | null {
  if (!MOUNTINFO_APPLIES) return null
  const m = readMountPointsAtOrUnder(dirReal)
  if (!m.ok) return `mountinfo unreadable (${m.errno}); a bind mount cannot be ruled out`
  return m.points.length > 0 ? `mount point ${m.points[0]}` : null
}

export type HeldReason = 'changed-during-move' | 'mount-appeared-during-move'

export type VerifyResult =
  | { ok: true; treeHash: string }
  | {
      ok: false
      reason: HeldReason
      diagnosis: string
      treeHash: string | null
      /** Location checks (1)-(4) passed: we know where the tree is. */
      located: boolean
      /** (5) passed too: it sits in a private directory the park validated. */
      safe: boolean
    }

type VerifyFailure = Extract<VerifyResult, { ok: false }>

export interface VerifyInput {
  destPath: string
  boundIdentity: ParkIdentity
  guardHash: string
  parkedRoot: string
  parkedRootIdentity: ParkIdentity
  opReal: string | null
  opIdentity: ParkIdentity
}

/**
 * Post-move verification at `destPath` (ADR-166 D-10). Reads only; never
 * writes, and never touches the origin. The content checks run first (walk
 * with the `st_dev` check, mountinfo, re-hash); every location check runs
 * afterwards as one final block, so a change during the walk is still seen.
 *
 * The location block asks whether the entry is the tree the park bound and
 * sits in the directory it validated, not where its own realpath leads:
 * rename(2) keeps the inode, so a swapped op directory or parked area passes
 * the hash while the tree sits elsewhere. In order: (1) destination identity
 * equals `boundIdentity`, so a byte-identical copy fails on its inode; (2) the
 * entry's parent resolves to `opReal`, pinned before the rename (SMI-7132);
 * (3) the parked area still matches its identity (SMI-7132); (4) the op
 * directory still matches its identity and (5) passes the owner/mode check
 * (SMI-7134). The entry itself is never resolved: a symlink skill root resolves
 * to its target, outside the parked area by design. Nothing moves back.
 */
export function verifyAtDestination(v: VerifyInput): VerifyResult {
  const held = (
    reason: HeldReason,
    diagnosis: string,
    treeHash: string | null = null,
    located = false,
    safe = false
  ): VerifyFailure => ({ ok: false, reason, diagnosis, treeHash, located, safe })
  const opDir = path.dirname(v.destPath)
  const checkLocation = (): VerifyFailure | null => {
    const at = bindIdentity(v.destPath)
    if (!at.ok) {
      return held('changed-during-move', `identity at destination unreadable (${at.errno})`)
    }
    if (!sameIdentity(v.boundIdentity, at)) {
      return held(
        'changed-during-move',
        'identity at destination does not match the tree the park verified'
      )
    }
    let parentReal: string
    try {
      parentReal = fs.realpathSync(opDir)
    } catch (err) {
      return held(
        'changed-during-move',
        `op directory unresolvable after the move (${errCodeOrMessage(err)})`
      )
    }
    if (typeof v.opReal !== 'string' || parentReal !== v.opReal) {
      return held(
        'changed-during-move',
        'op directory resolves elsewhere than where the park validated it'
      )
    }
    const rootNow = bindIdentity(v.parkedRoot)
    if (!rootNow.ok || !sameIdentity(v.parkedRootIdentity, rootNow)) {
      return held('changed-during-move', 'parked area is no longer the one the park validated')
    }
    let opNow: BigIntStats
    try {
      opNow = fs.lstatSync(opDir, { bigint: true })
    } catch (err) {
      return held(
        'changed-during-move',
        `op directory identity unreadable after the move (${errCodeOrMessage(err)})`
      )
    }
    if (!sameIdentity(v.opIdentity, identityOf(opNow))) {
      return held(
        'changed-during-move',
        'op directory identity check failed: it is no longer the directory the park validated'
      )
    }
    const permProblem = opDirOwnerModeProblem(opNow)
    if (permProblem !== null) {
      return held(
        'changed-during-move',
        `op directory owner/mode check failed after the move: ${permProblem}`,
        null,
        true
      )
    }
    return null
  }
  type Content = { reason: HeldReason; diagnosis: string; treeHash: string | null }
  // The location verdict decides which result is reported; a content failure
  // is still named, never dropped, and safety is claimed only when confirmed.
  const finish = (content: Content | null): VerifyFailure | null => {
    const loc = checkLocation()
    if (loc !== null) {
      const also =
        content === null
          ? ''
          : `; content check also failed: ${content.reason}: ${content.diagnosis}`
      return { ...loc, diagnosis: loc.diagnosis + also, treeHash: content?.treeHash ?? null }
    }
    if (content === null) return null
    return held(content.reason, content.diagnosis, content.treeHash, true, true)
  }
  const rec = pathTreeRecord(v.destPath, { mountCheck: true })
  if (!rec.ok) {
    if (rec.reason === 'mount-inside-tree') {
      return finish({
        reason: 'mount-appeared-during-move',
        diagnosis: `mount at ${rec.rel} (st_dev differs from the root)`,
        treeHash: null,
      }) as VerifyFailure
    }
    return finish({
      reason: 'changed-during-move',
      diagnosis: `${rec.reason} at ${rec.path}${rec.errno ? ` (${rec.errno})` : ''}`,
      treeHash: null,
    }) as VerifyFailure
  }
  // Probe mountinfo at opReal + entry name, never realpath(entry): a symlink
  // root would otherwise be checked at its target (SMI-7132).
  if (typeof v.opReal !== 'string') {
    return finish({
      reason: 'changed-during-move',
      diagnosis: 'the pinned op directory path is missing, so mountinfo cannot be probed',
      treeHash: null,
    }) as VerifyFailure
  }
  const mi = mountinfoFinding(path.join(v.opReal, path.basename(v.destPath)))
  if (mi !== null) {
    return finish({
      reason: 'mount-appeared-during-move',
      diagnosis: mi,
      treeHash: null,
    }) as VerifyFailure
  }
  const treeHash = computeTreeHash(rec.record)
  if (treeHash !== v.guardHash) {
    return finish({
      reason: 'changed-during-move',
      diagnosis: 'tree hash at the destination differs from guardHash',
      treeHash,
    }) as VerifyFailure
  }
  const bad = finish(null)
  return bad ?? { ok: true, treeHash }
}
