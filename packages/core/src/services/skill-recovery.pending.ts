/**
 * SMI-6531 (A1 step 6b-iii; owner decision 2026-10-29): a `partial-copy` keep
 * killed between its sidecar and its rename.
 *
 * A copy temp kept as `partial-copy` publishes `<opId>.partial-copy[.k].json`,
 * then renames the temp (`.tmp-<base>`) to that name (doctor's
 * `keepTempAsPartial`, and the update's own partial keep). A kill between the
 * two leaves a valid `partial-copy` sidecar with no tree whose identity is the
 * temp's. That is a keep to finish by its rename, but only when the pair is
 * unambiguous, so the rule is an explicit one-to-one matching:
 *
 *  - a **tree-less partial sidecar** is a `partial-copy` group (not another
 *    copy's) that no sub-state names, with a valid sidecar and no tree, no copy
 *    temp and no sidecar temp of its own;
 *  - a **copy temp** is any group (not another copy's) with a `.tmp-<base>`;
 *  - they **match** when the temp's identity is the one the sidecar names.
 *
 * Every match is counted on both sides first. A sidecar and a temp pair only
 * when the sidecar matches exactly that one temp and the temp is matched by
 * exactly that one sidecar: the sidecar then records the temp's group
 * (`pendingTemp`) and is no longer unclassified. Any other count (a sidecar
 * copied after the kill, two temps with one identity) pairs nothing: each
 * sidecar and temp involved is left unclassified, naming the ambiguity, so
 * `--abandon`'s plan and the `--apply`/`--undo` row both refuse before any
 * change. A sidecar no temp matches stays as `classifyGroup` left it.
 *
 * Pure: no filesystem access.
 *
 * @module @skillsmith/core/services/skill-recovery.pending
 */
import { sameId } from './skill-recovery.trees.js'
import type { KeepGroup } from './skill-recovery.types.js'
import type { RecordIdentity } from './skill-swap.types.js'

/** Why an ambiguous pair is left for the user: the words a refusal names. */
export const AMBIGUOUS_PARTIAL =
  'a partial-copy keep that stopped before its rename is not one-to-one with a copy temp (several sidecars name one temp, or one names several): move the extra one out by hand'

/** The identity a tree-less partial sidecar names, or null when the group is not one. */
function partialSidecarId(g: KeepGroup): RecordIdentity | null {
  const sc = g.sidecar
  if (g.kind !== 'partial-copy' || g.otherCopy || g.state !== null || sc === null) return null
  if (!sc.validForOp || g.dest.present || g.copyTmp.present || g.sidecarTmp !== null) return null
  return sc.identity
}

/** The identity of a group's copy temp, or null when it has none (or is another copy's). */
function copyTempId(g: KeepGroup): RecordIdentity | null {
  return g.copyTmp.present && !g.otherCopy ? g.copyTmp.identity : null
}

/** Pairs each tree-less partial sidecar with its copy temp, one-to-one only (see the module comment). */
export function markPendingPartials(groups: KeepGroup[]): void {
  const sidecars = groups.flatMap((g) => {
    const id = partialSidecarId(g)
    return id === null ? [] : [{ g, id }]
  })
  const temps = groups.flatMap((g) => {
    const id = copyTempId(g)
    return id === null ? [] : [{ g, id }]
  })
  // Count both sides before assigning anything.
  const tempsOf = new Map(
    sidecars.map((s) => [s.g, temps.filter((t) => sameId(t.id, s.id)).map((t) => t.g)])
  )
  const sidecarsOf = new Map(
    temps.map((t) => [t.g, sidecars.filter((s) => sameId(t.id, s.id)).map((s) => s.g)])
  )
  for (const { g } of sidecars) {
    const ts = tempsOf.get(g)!
    if (ts.length === 0) continue
    if (ts.length === 1 && sidecarsOf.get(ts[0]!)!.length === 1) {
      g.pendingTemp = ts[0]!.base
      g.unclassified = null
      continue
    }
    for (const x of [g, ...ts, ...ts.flatMap((t) => sidecarsOf.get(t)!)]) {
      x.state = null
      x.pendingTemp = null
      x.unclassified = AMBIGUOUS_PARTIAL
    }
  }
}
