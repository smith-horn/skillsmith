/**
 * SMI-6531 (A1 step 6a-ii): the end of a one-device doctor action, and the
 * sweep of what any doctor action holding a root's lock 1 removes (A1 plan
 * §3.3 "Recovery invariant", §3.9 leftover probes; design § 4
 * "`finishRecovered`", § 7).
 *
 * `finishNoRecord(st, adopted)` (6b-ii): the same for an op dir with no
 * record, `owner.json` last (see its comment).
 *
 * `finishRecovered(st, adopted)`: every tree is installed or kept, so OP must
 * hold exactly the adopted metadata (UD40's rule: anything else stops
 * `op-not-empty` with nothing removed). It unlinks every other metadata file
 * first (`owner.json`, an adopted `record.json.tmp`), each through
 * `unlinkAdopted`, then syncs OP, then unlinks `record.json` last (owner
 * decision 2026-10-26), syncs OP again, `rmdir`s it and syncs ST. A kill before `record.json` goes leaves
 * an op the same action still classifies and finishes; a kill after leaves an
 * empty op dir.
 *
 * `sweepRoot`: an empty op dir or a leftover probe that the plan listed is
 * removed with one `rmdir`, and only when it still has the identity the plan
 * saw. A probe made after the plan is not touched. An `rmdir` that fails (the
 * entry is not empty) leaves it, reported with its errno. Never a recursive
 * removal.
 *
 * @module @skillsmith/core/services/skill-recovery.finish
 */
import fs from 'node:fs'
import path from 'node:path'
import { identityOf, sameIdentity } from '../install/park-tree.identity.js'
import { syncDirectory } from '../install/dir-sync.js'
import { check, codeOf, hook, rmdirChecked, SwapFault, syncDir } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { OWNER_FILE, RECORD_FILE } from './skill-swap.types.js'
import type { RecordIdentity, TraceOp } from './skill-swap.types.js'
import { boundOf, unlinkAdopted } from './skill-recovery.state.js'
import type { Adopted } from './skill-recovery.state.js'
import type { SkillWriteContext } from './skill-write-lock.types.js'

/** Unlinks the adopted metadata, syncs OP, unlinks `record.json`, syncs OP, removes it, syncs ST. */
export async function finishRecovered(st: SwapState, adopted: readonly Adopted[]): Promise<void> {
  await hook(st, 'beforeMetadataCleanup')
  check(st)
  const record = adopted.find((a) => path.basename(a.path) === RECORD_FILE)
  if (record === undefined) throw new SwapFault('staging-unsafe', 'record.json is not adopted')
  const names = await fs.promises.readdir(st.opDir)
  const allowed = new Set(adopted.map((a) => path.basename(a.path)))
  const extra = names.filter((n) => !allowed.has(n)).sort()
  if (extra.length > 0) {
    throw new SwapFault('op-not-empty', `${st.opDir} still holds ${extra.join(', ')}`)
  }
  for (const a of adopted) {
    if (a === record || !names.includes(path.basename(a.path))) continue
    await unlinkAdopted(st, a)
    if (path.basename(a.path) === OWNER_FILE) await hook(st, 'afterOwnerUnlink')
  }
  // Those unlinks are made durable before the record goes: a crash may persist
  // the record's removal only after them, never instead of them.
  await syncDir(st, st.opDir)
  await unlinkAdopted(st, record)
  st.recordRemoved = true
  await hook(st, 'afterRecordUnlink')
  await syncDir(st, st.opDir)
  await hook(st, 'afterRecoveredOpSync')
  await rmdirChecked(st, st.opDir)
  await syncDir(st, st.binding.stagingDir)
}

/**
 * 6b-ii (`--clean-staging`, one device): the end of a no-record op dir once
 * its tree is kept. OP must hold exactly the adopted metadata (UD40). The
 * provable temps go first and OP is synced; then `owner.json` **last**, OP
 * synced, OP `rmdir`ed and ST synced. `owner.json` is what lets the same
 * command resume without `--unsafe-unverified-owner` (PLAN:1276-1278's
 * record-last rule, with `owner.json` in the record's place): a kill before
 * it goes leaves an op dir holding only `owner.json`, which the same command
 * finishes; a kill after leaves an empty op dir, which any action sweeps.
 */
export async function finishNoRecord(st: SwapState, adopted: readonly Adopted[]): Promise<void> {
  await hook(st, 'beforeMetadataCleanup')
  check(st)
  const names = await fs.promises.readdir(st.opDir)
  const allowed = new Set(adopted.map((a) => path.basename(a.path)))
  const extra = names.filter((n) => !allowed.has(n)).sort()
  if (extra.length > 0) {
    throw new SwapFault('op-not-empty', `${st.opDir} still holds ${extra.join(', ')}`)
  }
  const owner = adopted.find((a) => path.basename(a.path) === OWNER_FILE)
  for (const a of adopted) {
    if (a === owner || !names.includes(path.basename(a.path))) continue
    await unlinkAdopted(st, a)
    await hook(st, 'afterTempUnlink')
  }
  await syncDir(st, st.opDir)
  if (owner !== undefined && names.includes(OWNER_FILE)) {
    await unlinkAdopted(st, owner)
    await hook(st, 'afterOwnerUnlink')
    await syncDir(st, st.opDir)
  }
  await hook(st, 'afterRecoveredOpSync')
  await rmdirChecked(st, st.opDir)
  await syncDir(st, st.binding.stagingDir)
}

/** An entry of ST the plan listed and the sweep may `rmdir`: an empty op dir or a probe. */
export interface SweepEntry {
  path: string
  identity: RecordIdentity
}

export interface SweepResult {
  removed: string[]
  /** Entries left because their `rmdir` (or the identity check) refused; with the errno. */
  left: Array<{ path: string; errno: string }>
}

/**
 * Under lock 1, after the action: `rmdir` each listed entry that still has its
 * listed identity and is a directory. Syncs ST once if anything went.
 */
export async function sweepRoot(
  ctx: SkillWriteContext,
  entries: readonly SweepEntry[],
  traceSink?: (op: TraceOp) => void
): Promise<SweepResult> {
  const out: SweepResult = { removed: [], left: [] }
  for (const e of entries) {
    let now: fs.BigIntStats
    try {
      now = fs.lstatSync(e.path, { bigint: true })
    } catch (err) {
      if (codeOf(err) !== 'ENOENT') out.left.push({ path: e.path, errno: codeOf(err) ?? 'UNKNOWN' })
      continue
    }
    if (!sameIdentity(boundOf(e.identity), identityOf(now))) {
      out.left.push({ path: e.path, errno: 'IDENTITY_CHANGED' })
      continue
    }
    try {
      ctx.check()
      fs.rmdirSync(e.path)
    } catch (err) {
      out.left.push({ path: e.path, errno: codeOf(err) ?? 'UNKNOWN' })
      continue
    }
    traceSink?.({ op: 'rmdir', path: e.path })
    out.removed.push(e.path)
  }
  if (out.removed.length > 0) {
    const s = await syncDirectory(ctx.stagingDir)
    if (s.outcome !== 'failed') traceSink?.({ op: 'dirsync', path: ctx.stagingDir })
  }
  return out
}

/** Removes the target op dir when the plan found it empty (a kill after `record.json` went). */
export async function removeEmptyOp(
  ctx: SkillWriteContext,
  e: SweepEntry,
  traceSink?: (op: TraceOp) => void
): Promise<void> {
  const r = await sweepRoot(ctx, [e], traceSink)
  if (r.left.length > 0) {
    throw new SwapFault('op-not-empty', `${e.path} could not be removed (${r.left[0]!.errno})`)
  }
}
