/**
 * SMI-6531 (A1 step 6c-i): the walker's two read-only checks (ADR-166 D-11),
 * ported from the SMI-6676 spike: the re-check before staging (`recheck`,
 * spike `prune.walk.mjs` P4a) and the verification at the staging path
 * (`verifyAtStaging`, spike `prune.walk.verify.mjs` P4e). CHILD PROCESS ONLY:
 * the walker calls them, and nothing else does yet. fs is the DEFAULT export,
 * looked up at call time.
 *
 * @module @skillsmith/core/install/prune.walk.verify
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { errCode, errCodeOrMessage } from './park-result.js'
import { S_IFMT } from './park-tree.perms.js'
import { computeTreeHash } from './tree-hash.js'
import type { TreeRecord } from './tree-hash.js'
import { readStable } from './prune.sidecar.js'
import type { PruneJob, RootIdentity } from './prune.job.js'
import { SIDECAR_KEY, rowOf, mountFinding } from './prune.walk.shared.js'
import type { Inventory } from './prune.walk.shared.js'

function exists(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * P4a: the copy and its sidecar are still what the listing classified and the
 * user approved. Returns why not, or null.
 */
export function recheck(job: PruneJob): string | null {
  let st: BigIntStats
  try {
    st = fs.lstatSync(job.copyPath, { bigint: true })
  } catch (err) {
    return `copy unreadable (${errCode(err)})`
  }
  const id = job.rootIdentity
  if (st.dev !== id.dev || st.ino !== id.ino || st.birthtimeNs !== id.birthtimeNs) {
    return 'the copy is no longer the inode that was classified'
  }
  // A reused inode number of another file type (SMI-7130) is refused before anything moves.
  if ((st.mode & S_IFMT) !== id.fmt)
    return 'the copy is no longer the file type that was classified'
  const mi = mountFinding(job.copyPath)
  if (mi !== null) return mi
  if (job.sidecarRead === null) {
    if (job.sidecarPath !== null && exists(job.sidecarPath)) return 'a sidecar appeared'
    return null
  }
  if (job.sidecarPath === null) return 'the job carries sidecar bytes but no sidecar path'
  const rs = readStable(job.sidecarPath)
  if (!rs.ok) return `sidecar: ${rs.reason}`
  if (!rs.bytes.equals(job.sidecarRead.bytes)) {
    return 'the sidecar bytes changed since classification'
  }
  return null
}

export type StagingVerify =
  | { ok: true; inventory: Inventory; hash: string }
  | { ok: false; reason: string; detail: string }

/**
 * P4e: walk `S/leaf` with lstat (st_dev checked against the root), stable-read
 * every file, hash, and build the inventory; then stable-read `S/sidecar.json`
 * and require it to be the very inode and bytes approved at P4a.
 */
export function verifyAtStaging(
  S: string,
  leaf: string,
  a: {
    approvedHash: string
    rootIdentity: RootIdentity
    sidecar: { ino: bigint; bytes: Buffer } | null
  }
): StagingVerify {
  const no = (reason: string, detail: string): StagingVerify => ({ ok: false, reason, detail })
  const leafPath = path.join(S, leaf)
  let top: BigIntStats
  try {
    top = fs.lstatSync(leafPath, { bigint: true })
  } catch (err) {
    return no('unreadable-in-staging', `staged copy unreadable (${errCode(err)})`)
  }
  if (
    top.dev !== a.rootIdentity.dev ||
    top.ino !== a.rootIdentity.ino ||
    top.birthtimeNs !== a.rootIdentity.birthtimeNs ||
    (top.mode & S_IFMT) !== a.rootIdentity.fmt
  ) {
    return no('changed-in-staging', 'the staged copy is not the inode that was approved')
  }
  const mi = mountFinding(leafPath)
  if (mi !== null) return no('mount-in-staging', mi)
  const record: TreeRecord = new Map()
  const inventory: Inventory = new Map()
  const visit = (rel: string, abs: string): StagingVerify | null => {
    const st = fs.lstatSync(abs, { bigint: true })
    if (st.dev !== top.dev) return no('mount-in-staging', `mount at ${rel || '.'} (st_dev differs)`)
    const mode = Number(st.mode)
    inventory.set(rel, rowOf(st))
    if (st.isDirectory()) {
      record.set(rel, { type: 'dir', mode, size: st.size })
      for (const n of fs.readdirSync(abs).sort()) {
        const r = visit(rel ? `${rel}/${n}` : n, path.join(abs, n))
        if (r) return r
      }
      return null
    }
    if (st.isSymbolicLink()) {
      record.set(rel, { type: 'symlink', mode, size: st.size, linkText: fs.readlinkSync(abs) })
      return null
    }
    if (st.isFile()) {
      const rs = readStable(abs)
      if (!rs.ok) {
        return no(
          rs.reason === 'unreadable' ? 'unreadable-in-staging' : 'changed-in-staging',
          `${rel}: ${rs.reason}`
        )
      }
      if (
        rs.ino !== st.ino ||
        rs.size !== st.size ||
        rs.mtimeNs !== st.mtimeNs ||
        rs.ctimeNs !== st.ctimeNs
      ) {
        return no('changed-in-staging', `${rel} changed while it was verified`)
      }
      record.set(rel, {
        type: 'file',
        mode,
        size: st.size,
        contentHash: crypto.createHash('sha256').update(rs.bytes).digest('hex'),
      })
      return null
    }
    return no('unreadable-in-staging', `${rel}: unsupported entry type`)
  }
  let failure: StagingVerify | null
  try {
    failure = visit('', leafPath)
  } catch (err) {
    return no('unreadable-in-staging', `walk failed (${errCodeOrMessage(err)})`)
  }
  if (failure) return failure
  const hash = computeTreeHash(record)
  if (hash !== a.approvedHash) {
    return no('changed-in-staging', 'tree hash at the staging path differs from the approved hash')
  }
  if (a.sidecar) {
    const rs = readStable(path.join(S, 'sidecar.json'))
    if (!rs.ok) return no('sidecar-changed-in-staging', `staged sidecar: ${rs.reason}`)
    if (rs.ino !== a.sidecar.ino || !rs.bytes.equals(a.sidecar.bytes)) {
      return no(
        'sidecar-changed-in-staging',
        'the staged sidecar is not the approved inode and bytes'
      )
    }
    inventory.set(SIDECAR_KEY, {
      dev: rs.dev,
      ino: rs.ino,
      birthtimeNs: null,
      type: 'file',
      mode: rs.mode,
      size: rs.size,
      mtimeNs: rs.mtimeNs,
      ctimeNs: rs.ctimeNs,
    })
  }
  return { ok: true, inventory, hash }
}
