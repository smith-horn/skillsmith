/**
 * SMI-6531 (A1 step 3): the skill tree primitives (A1 plan §3.4): the tree
 * hash of a folder, the no-follow copy, and claim-publish.
 *
 *  - `treeHashOf(absRoot)`: the one tree-hash function (ADR-166) applied to a
 *    path walk. `preTree`, `postTree`, every sidecar `treeHash` and every park
 *    `guardHash` come from here, so a guarded park never sees a foreign hash.
 *    A FIFO, socket or device makes the folder `unsupported-entry`, which is
 *    the planning refusal (T-B2). It writes nothing.
 *  - `copyTreeNoFollow(src, dest)`: see `skill-tree.copy.ts`.
 *  - `claimPublish(staged, dest)`: `mkdir` the destination, which fails if
 *    anything exists, then `rename` the staged folder over that empty claim.
 *    `rename` over an empty directory replaces it silently and over a
 *    non-empty one fails `ENOTEMPTY`, so only an empty directory can ever be
 *    replaced (ADR-155 residual, SMI-6559).
 *
 * A claim whose rename failed is left in place: it is an empty directory at
 * the target, and removing it here would be a removal this module never makes.
 * Recovery (`doctor`, step 6) owns it.
 *
 * @module @skillsmith/core/services/skill-tree
 */
import fs from 'node:fs'
import path from 'node:path'
import { syncDirectory } from '../install/dir-sync.js'
import type { DirSyncOutcome } from '../install/dir-sync.js'
import { pathTreeRecord } from '../install/park-tree.verify.js'
import { computeTreeHash } from '../install/tree-hash.js'
import type { TreeRecord } from '../install/tree-hash.js'

export { copyTreeNoFollow } from './skill-tree.copy.js'
export type { CopyFailureReason, CopyResult } from './skill-tree.copy.js'

export type TreeHashResult =
  | { ok: true; hash: string; record: TreeRecord }
  | {
      ok: false
      /** `unsupported-entry`: a FIFO, socket or device (T-B2). `unreadable`: a walk read failed. */
      reason: 'unsupported-entry' | 'unreadable'
      path: string
      errno: string | null
    }

/**
 * The §3.4 tree hash of `absRoot`, with the record it came from. Reads only.
 * A mount inside the tree is tolerated: the caller's own hash must walk
 * through it (`pathTreeRecord`'s default).
 */
export function treeHashOf(absRoot: string): TreeHashResult {
  const walked = pathTreeRecord(absRoot)
  if (walked.ok) return { ok: true, hash: computeTreeHash(walked.record), record: walked.record }
  return {
    ok: false,
    reason: walked.reason === 'guard-unsupported-type' ? 'unsupported-entry' : 'unreadable',
    path: walked.path,
    errno: walked.errno,
  }
}

export type ClaimPublishResult =
  | {
      ok: true
      /** What each parent sync reported; `failed` means durability is not assured. */
      syncs: { claim: DirSyncOutcome; publish: DirSyncOutcome }
    }
  /** Something exists at `destAbs`; nothing was touched. */
  | { ok: false; reason: 'target-exists' }
  /** The claim could not be made (parent missing, permissions); nothing was touched. */
  | { ok: false; reason: 'claim-failed'; errno: string | null }
  /** The claim was made, then the parent could not be synced. The claim stays. */
  | { ok: false; reason: 'sync-failed'; errno: string | null; claimLeft: true }
  /** The claim was made, then the rename failed. The empty claim stays. */
  | { ok: false; reason: 'rename-failed'; errno: string | null; claimLeft: true }

/** @internal Test seam. */
export interface ClaimPublishHooks {
  /** Runs between the claim's `mkdir` and the `rename`. */
  afterClaim?: () => void
}

const codeOf = (err: unknown): string | null => {
  const c = (err as { code?: unknown } | null)?.code
  return typeof c === 'string' ? c : null
}

/**
 * Publishes the staged folder at `destAbs` by claiming the path first. Never
 * writes through an existing entry and never removes anything.
 */
export async function claimPublish(
  stagedAbs: string,
  destAbs: string,
  /** @internal */
  hooks?: ClaimPublishHooks
): Promise<ClaimPublishResult> {
  try {
    await fs.promises.mkdir(destAbs)
  } catch (err) {
    const errno = codeOf(err)
    return errno === 'EEXIST'
      ? { ok: false, reason: 'target-exists' }
      : { ok: false, reason: 'claim-failed', errno }
  }
  const parent = path.dirname(destAbs)
  const claim = await syncDirectory(parent)
  if (claim.outcome === 'failed') {
    return { ok: false, reason: 'sync-failed', errno: claim.code, claimLeft: true }
  }
  hooks?.afterClaim?.()
  try {
    await fs.promises.rename(stagedAbs, destAbs)
  } catch (err) {
    return { ok: false, reason: 'rename-failed', errno: codeOf(err), claimLeft: true }
  }
  return { ok: true, syncs: { claim, publish: await syncDirectory(parent) } }
}
