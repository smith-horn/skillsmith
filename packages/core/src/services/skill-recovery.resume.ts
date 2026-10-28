/**
 * SMI-6531 (A1 step 6a-ii): doctor's one-device tree moves, each resumable
 * from the state a kill left (A1 plan §3.3 "Publish sub-states", "The
 * one-device sidecar rewrite", UD38; design § 4 "`resumePublish`", "Undo
 * resume").
 *
 *  - `installAt(st, src, claim)`: put O or N at the skill path. Without a
 *    claim, claim-publish (`mkdir` T, sync R, `check`, `rename`, sync R), then
 *    sync OP. With an existing empty claim (UN1, an S1 resume): its identity
 *    must be the one the re-plan observed and it must still be empty; `check`,
 *    `rename(src, T)` over it, sync R, then OP.
 *  - `keepRole(st, ...)`: keep a role's tree. A verified keep (P5) is done; a
 *    source with no keep goes through `publishTree`; a started keep resumes
 *    from its sub-state: P0 (a provable temp unlinked, then `publishTree`),
 *    P1 (the sidecar rewritten when the source's hash changed, then the move),
 *    R1-R3 (the rewrite finished, then P1). UD38: the backup's own published
 *    sidecar does not make its name taken to its own resume.
 *
 * A temp that is not provably this op's is never unlinked (owner decision
 * 2026-10-26): only one that parses as this op's sidecar for that `dest` with
 * the source's identity, or an empty regular file with one link. Otherwise
 * the resume stops `backup-unsafe` naming the path. Every unlink of a metadata
 * file doctor did not write goes through `unlinkAdopted`. Across devices
 * (6a-iii, `skill-recovery.xdev.ts`): a P1 move whose rename fails `EXDEV`
 * copies and verifies; P2 keeps its copy temp as `partial-copy` and copies
 * again; P3 renames its verified temp to `dest`; P4 verifies and leaves the
 * source for the op dir's park; a rewrite state beside a copy temp finishes
 * the rewrite, then continues as P3 or P2.
 *
 * @module @skillsmith/core/services/skill-recovery.resume
 */
import fs from 'node:fs'
import path from 'node:path'
import { bindIdentity, sameIdentity } from '../install/park-tree.identity.js'
import { claimPublish, treeHashOf } from './skill-tree.js'
import {
  check,
  codeOf,
  hook,
  linkChecked,
  SwapFault,
  syncDir,
  trace,
  unlinkOwned,
  writeNewFile,
} from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { ensureBackupArea, moveKept, publishTree } from './skill-swap.publish.js'
import { present, sidecarOf, warnForeignChange } from './skill-swap.sidecar.js'
import type { PublishKind } from './skill-swap.sidecar.js'
import { KEPT_KINDS } from './skill-swap.fullmark.js'
import type { RecordIdentity } from './skill-swap.types.js'
import { adoptMetadata, boundOf, unlinkAdopted } from './skill-recovery.state.js'
import type { Adopted } from './skill-recovery.state.js'
import { ROLE_DIR } from './skill-recovery.pstate.js'
import { acrossFor, resumeCopied, resumeCopyTemp } from './skill-recovery.xdev.js'
import type { AcrossKeep } from './skill-recovery.xdev.js'
import type { KeepGroup, OpFacts, ReadTranscript, Role } from './skill-recovery.types.js'

/** The facts a keep reads: each role's resolution, this op's groups, the full-device marker. */
export type KeepFacts = Pick<OpFacts, 'roles' | 'groups' | 'fullDevice'>

/** A kind `publishTree` can write, else a stop: a name this module cannot keep. */
function publishKindOf(kind: string): PublishKind {
  if (kind === 'backup' || KEPT_KINDS.has(kind)) return kind as PublishKind
  throw new SwapFault('backup-unsafe', `a keep of kind ${kind} is not one this step resumes`)
}

/** `t` is the empty claim with identity `claim`, else `SwapFault('target-changed')`. */
async function assertClaim(t: string, claim: RecordIdentity): Promise<void> {
  const now = bindIdentity(t)
  if (!now.ok || !sameIdentity(boundOf(claim), now)) {
    throw new SwapFault('target-changed', `${t} is not the empty claim the plan observed`)
  }
  if ((await fs.promises.readdir(t)).length > 0) {
    throw new SwapFault('target-changed', `${t} is no longer empty`)
  }
}

/** Puts `src` (O or N, a directory in OP) at the skill path. */
export async function installAt(
  st: SwapState,
  src: string,
  claim: RecordIdentity | null
): Promise<void> {
  const t = st.input.realDir
  const root = st.binding.root
  if (claim === null) {
    const r = await claimPublish(src, t, {
      afterClaim: () => {
        check(st)
        // claimPublish's `afterClaim` is synchronous (it runs between its own
        // mkdir and rename, with no await between them), so a test hook here
        // can only act synchronously: a throw stops before the rename, and a
        // returned promise cannot be waited on without changing claimPublish.
        void st.options.hooks?.afterClaim?.()
      },
    })
    if (!r.ok) {
      throw new SwapFault(
        r.reason === 'target-exists' ? 'target-changed' : 'write-failed',
        `${src} could not be put at ${t} (${r.reason})`
      )
    }
    if (r.syncs.publish.outcome === 'failed') {
      throw new SwapFault('write-failed', `${root} could not be synced (${r.syncs.publish.code})`)
    }
    trace(st, { op: 'mkdir', path: t })
    trace(st, { op: 'dirsync', path: root })
    trace(st, { op: 'rename', path: src, dest: t })
    trace(st, { op: 'dirsync', path: root })
  } else {
    check(st)
    await assertClaim(t, claim)
    await hook(st, 'afterClaim')
    // Immediately before the rename: the claim must still be the planned one
    // (identity, file type included) and empty, or a replacement would be
    // renamed over. A swap between this check and the rename is the §3.0
    // item 9 residual (no renameat2).
    check(st)
    await assertClaim(t, claim)
    await fs.promises.rename(src, t)
    trace(st, { op: 'rename', path: src, dest: t })
    await syncDir(st, root)
  }
  await syncDir(st, st.opDir)
  await hook(st, 'afterInstall')
}

/**
 * What a keep resume needs besides the state: the re-plan's facts and
 * transcript. 6b-ii: only the roles, the groups and the marker, which a
 * no-record op dir supplies too (`--clean-staging`).
 */
export interface KeepContext {
  facts: KeepFacts
  transcript: ReadTranscript
  /** Where each copy temp a cross-device resume keeps as `partial-copy` went. */
  partials: string[]
}

/** Keeps `role`'s tree as `kind`. Returns where the tree is kept, or null when there is none. */
export async function keepRole(
  st: SwapState,
  role: Role,
  kind: string,
  k: KeepContext
): Promise<string | null> {
  const res = k.facts.roles[role]
  if (res.kind === 'absent') return null
  if (res.kind === 'kept') return res.keep.destPath
  const src = path.join(st.opDir, ROLE_DIR[role])
  if (res.started !== null) return resumeGroup(st, res.started, src, k)
  // P0: a sidecar temp with no sidecar. Unlink it if provable, then start fresh.
  for (const g of k.facts.groups.filter((x) => x.role === role && x.state === 'P0')) {
    await ensureArea(st)
    await unlinkProvableTemp(st, g, k)
  }
  return publishTree(st, src, publishKindOf(kind))
}

async function ensureArea(st: SwapState): Promise<void> {
  if (st.area === null) await ensureBackupArea(st)
}

const tmpOf = (g: KeepGroup): string => `${g.destPath}.json.tmp`
const sidecarPathOf = (g: KeepGroup): string => `${g.destPath}.json`

/** Q10: the temp parses as this op's sidecar for `dest` with the source's identity, or is empty. */
function provable(g: KeepGroup): boolean {
  const t = g.sidecarTmp
  if (t === null) return false
  if (t.emptySingleLink) return true
  return (
    t.thisOps &&
    t.identity !== null &&
    g.src.present &&
    t.identity.dev === g.src.identity.dev &&
    t.identity.ino === g.src.identity.ino &&
    t.identity.birthtimeNs === g.src.identity.birthtimeNs &&
    t.identity.fmt === g.src.identity.fmt
  )
}

/** Unlinks a group's sidecar temp only if provable (else stops naming it), then syncs the area. */
async function unlinkProvableTemp(st: SwapState, g: KeepGroup, k: KeepContext): Promise<void> {
  if (g.sidecarTmp === null) return
  if (!provable(g)) {
    throw new SwapFault(
      'backup-unsafe',
      `${tmpOf(g)} is not provably this operation's sidecar temp; it was left untouched`
    )
  }
  await unlinkAdopted(st, adoptMetadata(k.transcript, tmpOf(g)), 'backup-unsafe')
  await hook(st, 'afterTempUnlink')
  await syncDir(st, st.areaPath)
}

/** Links the synced temp at the sidecar's name; an entry already there is `backup-unsafe`. */
async function linkTemp(st: SwapState, tmp: string, final: string): Promise<void> {
  try {
    await linkChecked(st, tmp, final)
  } catch (err) {
    if (codeOf(err) === 'EEXIST') {
      throw new SwapFault('backup-unsafe', `${final} appeared before the sidecar was linked`)
    }
    throw err
  }
}

/** Resumes a started keep from its sub-state. */
async function resumeGroup(
  st: SwapState,
  g: KeepGroup,
  src: string,
  k: KeepContext
): Promise<string> {
  if (g.state === 'P5') return g.destPath
  await ensureArea(st)
  const across = (named: AcrossKeep['named'], sidecarHash: string | null): AcrossKeep => ({
    group: g,
    src,
    kind: publishKindOf(g.kind),
    named,
    sidecarHash,
    marker: k.facts.fullDevice,
    partials: k.partials,
  })
  if (g.state === 'P4') return resumeCopied(st, across(g.sidecar!.identity, g.sidecar!.treeHash))
  if (g.state === 'P2' || g.state === 'P3') {
    return resumeCopyTemp(st, across(g.sidecar!.identity, g.sidecar!.treeHash))
  }
  const final = sidecarPathOf(g)
  const tmp = tmpOf(g)
  // What `<dest>.json` holds once the temp handling is done: its adoption and tree hash.
  let sidecar: { adopted: Adopted; treeHash: string | null }
  if (g.state === 'R3') {
    await unlinkAdopted(st, adoptMetadata(k.transcript, tmp), 'backup-unsafe')
    await hook(st, 'afterTempUnlink')
    await syncDir(st, st.areaPath)
    sidecar = { adopted: adoptMetadata(k.transcript, final), treeHash: g.sidecar!.treeHash }
  } else if (g.state === 'R2') {
    if (!provable(g) || g.sidecarTmp!.emptySingleLink) {
      throw new SwapFault('backup-unsafe', `${tmp} does not name ${src}; it was left untouched`)
    }
    const a = adoptMetadata(k.transcript, tmp)
    await linkTemp(st, tmp, final)
    await hook(st, 'afterRewriteLink')
    await syncDir(st, st.areaPath)
    await hook(st, 'afterRewriteLinkSync')
    await unlinkAdopted(st, a, 'backup-unsafe')
    await hook(st, 'afterRewriteTempUnlink')
    await syncDir(st, st.areaPath)
    sidecar = { adopted: { ...a, path: final }, treeHash: g.sidecarTmp!.treeHash }
  } else if (g.state === 'R1') {
    const t = g.sidecarTmp!
    if (
      provable(g) &&
      !t.emptySingleLink &&
      t.treeHash !== null &&
      g.src.present &&
      t.treeHash === g.src.hash
    ) {
      // Finish the rewrite: the temp already describes the source as it is.
      const temp = adoptMetadata(k.transcript, tmp)
      await unlinkAdopted(st, adoptMetadata(k.transcript, final), 'backup-unsafe')
      await hook(st, 'afterSidecarUnlink')
      await linkTemp(st, tmp, final)
      await hook(st, 'afterRewriteLink')
      await syncDir(st, st.areaPath)
      await hook(st, 'afterRewriteLinkSync')
      await unlinkAdopted(st, temp, 'backup-unsafe')
      await hook(st, 'afterRewriteTempUnlink')
      await syncDir(st, st.areaPath)
      sidecar = { adopted: { ...temp, path: final }, treeHash: t.treeHash }
    } else {
      await unlinkProvableTemp(st, g, k)
      sidecar = { adopted: adoptMetadata(k.transcript, final), treeHash: g.sidecar!.treeHash }
    }
  } else {
    sidecar = { adopted: adoptMetadata(k.transcript, final), treeHash: g.sidecar!.treeHash }
  }
  // The cross-device rewrite: the copy temp verified, so it continues as P3 (or P2).
  if (g.copyTmp.present) return resumeCopyTemp(st, across(namedOf(g), sidecar.treeHash))
  return resumeP1(st, g, src, sidecar)
}

/** The identity the sidecar (or, after R2, the temp now at its name) names for the source. */
const namedOf = (g: KeepGroup) => g.sidecar?.identity ?? g.sidecarTmp?.identity ?? null

/**
 * P1: the sidecar is published. Rewrite it when the source's hash changed,
 * then move the tree. UD38: `dest` must be absent; the sidecar at its name is
 * this op's own, so the name is free to this resume.
 */
async function resumeP1(
  st: SwapState,
  g: KeepGroup,
  src: string,
  sidecar: { adopted: Adopted; treeHash: string | null }
): Promise<string> {
  const kind = publishKindOf(g.kind)
  const id = bindIdentity(src)
  const h = treeHashOf(src)
  if (!id.ok || !h.ok) throw new SwapFault('write-failed', `${src} could not be hashed`)
  const named = namedOf(g)
  if (named === null || !sameIdentity(boundOf(named), id)) {
    throw new SwapFault('backup-unsafe', `${src} is not the tree its sidecar names`)
  }
  if (kind === 'backup' && h.hash !== st.input.preTree) warnForeignChange(st, g.destPath)
  if (sidecar.treeHash !== h.hash) await rewrite(st, g, sidecarOf(st, kind, h, id), sidecar.adopted)
  if (await present(g.destPath)) {
    throw new SwapFault('backup-unsafe', `${g.destPath} already exists; it was left untouched`)
  }
  // Across devices the rename fails `EXDEV` and nothing moved: copy and verify (6a-iii).
  const over = acrossFor(st, { src, dest: g.destPath, kind, id, sidecarHash: h.hash }, h)
  await moveKept(st, src, g.destPath, kind, over)
  return g.destPath
}

/**
 * Doctor's one-device sidecar rewrite (`rewriteSidecar`'s order, with the old
 * sidecar adopted rather than owned): temp written and synced, area synced,
 * old unlinked, temp linked, area synced, temp unlinked, area synced.
 */
async function rewrite(
  st: SwapState,
  g: KeepGroup,
  body: ReturnType<typeof sidecarOf>,
  old: Adopted
): Promise<void> {
  const tmp = tmpOf(g)
  const final = sidecarPathOf(g)
  await writeNewFile(st, tmp, Buffer.from(JSON.stringify(body, null, 2) + '\n'), 0o600)
  await hook(st, 'afterSidecarTemp')
  await syncDir(st, st.areaPath)
  await hook(st, 'afterRewriteTempSync')
  await unlinkAdopted(st, old, 'backup-unsafe')
  await hook(st, 'afterSidecarUnlink')
  await linkTemp(st, tmp, final)
  await hook(st, 'afterRewriteLink')
  await syncDir(st, st.areaPath)
  await hook(st, 'afterRewriteLinkSync')
  await unlinkOwned(st, tmp, 'backup-unsafe')
  await hook(st, 'afterRewriteTempUnlink')
  await syncDir(st, st.areaPath)
}
