/**
 * SMI-6531 (A1 step 8-i-a-2): `doctor recovery --apply` / `--undo` on a fresh
 * install's row (design § 4), called by `runRecorded`
 * (`skill-recovery.run.ts`) under lock 1, after the re-plan matched, the
 * metadata was adopted and the pre-mutation blocks passed. The finish (one
 * device, or the park across devices) and the sweep are `runRecorded`'s.
 *
 * | Row | `--apply` | `--undo` |
 * |---|---|---|
 * | FI0 | N re-checked; claim-publish N (re-checked before the rename); commit | keep N |
 * | FI0 after its keep | (= `--undo`) | nothing left but the finish |
 * | FI1 | rename N over the bound empty claim (re-checked); commit | keep N, then `rmdir` the claim |
 * | FI1 after its keep | (= `--undo`) | `rmdir` the claim |
 * | FI2 | commit (the first mutation: a CAS miss is `plan-changed`) | T aside to U; keep U |
 * | FI2′ | refused at plan time | T aside to U; keep U |
 * | FI2u | (= `--undo`) | keep U unless kept |
 * | FI3 | nothing but the finish | refused at plan time |
 * | FI4 | nothing but the finish: T, the parked copy and the manifest untouched | (= `--apply`) |
 *
 * FI1's undo keeps N before it removes the claim: a kill between them leaves
 * "FI1 after its keep", whose only action finishes the undo; the other order
 * would leave FI0, whose `--apply` installs the folder the user chose to undo.
 * The claim is removed with a non-recursive `rmdir`, after `check` and a
 * re-check that T is still the empty claim the plan saw; anything written
 * into it makes the `rmdir` fail (`ENOTEMPTY`), which stops `target-changed`
 * with N already kept. That `rmdir` is the one removal besides metadata (§3.8's
 * exempt class). No audit line is appended: a fresh install writes none.
 *
 * @module @skillsmith/core/services/skill-recovery.run.install
 */
import fs from 'node:fs'
import { bindIdentity, sameIdentity } from '../install/park-tree.identity.js'
import { installAt } from './skill-recovery.resume.js'
import { claimOf, commitFirst, expectOf, keep, kindIn } from './skill-recovery.run.row.js'
import type { Row } from './skill-recovery.run.row.js'
import { boundOf } from './skill-recovery.state.js'
import type { InstallRowState } from './skill-recovery.types.js'
import { assertIdentity, commit } from './skill-swap.commit.js'
import { check, codeOf, hook, opPaths, SwapFault, syncDir, trace } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { publishTree } from './skill-swap.publish.js'
import { treeHashOf } from './skill-tree.js'
import { undoAside } from './skill-swap.undo.js'
import type { RecordIdentity } from './skill-swap.types.js'

/** FI0/FI1 `--apply`: N at the skill path (claim-publish, or over the bound claim), then the commit. */
async function installNew(row: Row): Promise<null> {
  const { st } = row
  const f = row.cls.facts
  const newDir = opPaths(st).newDir
  const expect = expectOf(st, f, 'N')
  // Before the claim (design § 4): N's hash, then its identity, so a folder
  // changed since the plan is refused with nothing moved, not left behind a claim.
  check(st)
  const now = treeHashOf(newDir)
  if (!now.ok || now.hash !== st.postTree) {
    throw new SwapFault('recovery-conflict', `${newDir} no longer hashes to what was built`)
  }
  const id = bindIdentity(newDir)
  if (!id.ok || !sameIdentity(expect.identity, id)) {
    throw new SwapFault('staging-unsafe', `${newDir} is not the folder the plan saw; nothing moved`)
  }
  // `installAt` checks N again immediately before its publishing rename (Major 1).
  await installAt(st, newDir, claimOf(f), expect)
  row.out.installed = 'N'
  if ((await commit(st)) === 'cas-failed') {
    throw new SwapFault(
      'changed-since-plan',
      'the manifest entry changed after the new folder was installed; the record is kept'
    )
  }
  row.out.manifest = 'committed'
  await hook(st, 'afterCommit')
  return null
}

/**
 * Removes FI1's empty claim at T: `check`, T is still the claim the plan saw
 * (identity, file type included), then a non-recursive `rmdir`. `ENOTEMPTY`
 * (something was written into it) stops `target-changed`; T is untouched.
 */
async function removeClaim(st: SwapState, claim: RecordIdentity): Promise<void> {
  const t = st.input.realDir
  check(st)
  const now = bindIdentity(t)
  if (!now.ok || !sameIdentity(boundOf(claim), now)) {
    throw new SwapFault('target-changed', `${t} is not the empty claim the plan observed`)
  }
  try {
    await fs.promises.rmdir(t)
  } catch (err) {
    if (codeOf(err) === 'ENOTEMPTY' || codeOf(err) === 'EEXIST') {
      throw new SwapFault('target-changed', `${t} is no longer empty; it was left untouched`)
    }
    throw err
  }
  trace(st, { op: 'rmdir', path: t })
  await syncDir(st, st.binding.root)
}

/** FI1 `--undo`: keep N (unless kept), then remove the claim (see the module comment). */
async function undoClaimed(row: Row): Promise<null> {
  const claim = claimOf(row.cls.facts)
  if (claim === null) throw new SwapFault('target-changed', 'the skill path is not a claim')
  if (!row.cls.postKeep) await keep(row, 'N')
  await removeClaim(row.st, claim)
  return null
}

/**
 * FI2/FI2′ `--undo`: T, still the published folder, set aside to U; then U
 * kept as `undone` when it still hashes to `postTree` and the plan kept it so,
 * else `conflict`. The skill path ends empty; the manifest is untouched.
 */
async function undoPublished(row: Row): Promise<null> {
  const { st } = row
  check(st)
  assertIdentity(st.input.realDir, st.newIdentity!, 'target-changed', 'the installed folder')
  await undoAside(st)
  const undone = opPaths(st).undoneDir
  const h = treeHashOf(undone)
  const planned = kindIn(row.steps, 'T')
  const kind = planned === 'undone' && h.ok && h.hash === st.postTree ? 'undone' : 'conflict'
  const dest = await publishTree(st, undone, kind)
  row.out.kept.push({ tree: 'T', kind, path: dest })
  if (kind === 'conflict') st.warnings.push({ code: 'conflict-kept', path: dest })
  return null
}

/** Runs a fresh install's row. Returns `plan-changed` when the first mutation found the plan stale. */
export async function runInstallRow(
  row: Row,
  state: InstallRowState,
  action: 'apply' | 'undo'
): Promise<'plan-changed' | null> {
  const { cls } = row
  switch (state) {
    case 'FI0':
      if (cls.postKeep) return null
      if (action === 'apply') return installNew(row)
      await keep(row, 'N')
      return null
    case 'FI1':
      if (action === 'apply' && !cls.postKeep) return installNew(row)
      return undoClaimed(row)
    case 'FI2':
    case 'FI2prime':
      if (action === 'apply') {
        // FI2′ `--apply` is refused at plan time; only FI2 reaches here.
        return (await commitFirst(row)) === null ? null : 'plan-changed'
      }
      return undoPublished(row)
    case 'FI2u':
      if (!cls.postKeep) await keep(row, 'U')
      return null
    case 'FI3':
    case 'FI4':
      // Nothing moves: the finish unlinks the metadata (FI4 never touches the parked copy).
      return null
  }
}
