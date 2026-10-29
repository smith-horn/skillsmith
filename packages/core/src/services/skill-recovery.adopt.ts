/**
 * SMI-6531 (A1 steps 6a-ii, 6a-iii, 6b-iii): what a recorded op's action
 * adopts under lock 1 before it mutates, and the two refusals it runs before
 * its first mutation (moved out of `skill-recovery.run.ts`, so `--apply` /
 * `--undo` (`runRecorded`) and `--abandon` (`runAbandon`) share one copy).
 *
 *  - `adoptAll`: the metadata files the finish may unlink, each adopted from
 *    the re-plan's transcript (`adoptMetadata`): `owner.json`, a provable
 *    `record.json.tmp`, a provable `park-intent.json.tmp`, `record.json`
 *    (last), plus a verifying `park-intent.json`, which a cross-device finish
 *    reuses. An entry that is not provably this op's stops `staging-unsafe`
 *    before anything changed.
 *  - `adoptInto` / `adoptSidecarsInto`: doctor's seams on the state (the
 *    adopted sidecar unlink, its own marker rewrite).
 *  - `preMutationBlocks`: run after the adoption and before **any** mutation
 *    (the backup area's `mkdir` included), in this order: the space block
 *    (`state-root-full`), then, unless a verifying intent is reused, the
 *    park-intent precheck (`staging-unsafe`, with `RECORDED_STATE_ROOT_NOTE`).
 *    Each refuses with nothing changed.
 *
 * @module @skillsmith/core/services/skill-recovery.adopt
 */
import path from 'node:path'
import { intentBlock, rewriteMarkerAdopted, spaceBlock } from './skill-recovery.mark.js'
import { adoptMetadata, unlinkAdopted } from './skill-recovery.state.js'
import type { Adopted } from './skill-recovery.state.js'
import type { OpFacts, PlanStep, ReadTranscript } from './skill-recovery.types.js'
import { RECORDED_STATE_ROOT_NOTE } from './skill-swap.intent.js'
import { SwapFault } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { OWNER_FILE, RECORD_FILE } from './skill-swap.types.js'

/** What `adoptAll` adopted: every metadata file (`record.json` last), the reusable intent, the record's temp. */
export interface AdoptedSet {
  files: Adopted[]
  intent: Adopted | null
  tmp: Adopted | null
}

/** The metadata files a recorded op's finish may unlink (see the module comment). */
export function adoptAll(f: OpFacts, names: readonly string[], t: ReadTranscript): AdoptedSet {
  const out: Adopted[] = []
  const at = (n: string): string => path.join(f.opDir, n)
  if (names.includes(OWNER_FILE)) out.push(adoptMetadata(t, at(OWNER_FILE)))
  const tmp = f.recordTmp
  let recordTmp: Adopted | null = null
  if (tmp !== null) {
    // A marked temp whose body matches the record is this op's (a marker rewrite that crashed).
    if (!tmp.sameInode && !tmp.emptySingleLink && !tmp.bodyMatches) {
      throw new SwapFault('staging-unsafe', `${tmp.path} is not provably this operation's`)
    }
    recordTmp = adoptMetadata(t, tmp.path)
    out.push(recordTmp)
  }
  if (f.parkIntentTmp !== null) {
    if (!f.parkIntentTmp.provable) {
      throw new SwapFault(
        'staging-unsafe',
        `${f.parkIntentTmp.path} is not provably this operation's`
      )
    }
    out.push(adoptMetadata(t, f.parkIntentTmp.path))
  }
  let intent: Adopted | null = null
  if (f.parkIntent !== null) {
    if (!f.parkIntent.valid) {
      throw new SwapFault('staging-unsafe', `${f.parkIntent.path} is not this operation's`)
    }
    intent = adoptMetadata(t, f.parkIntent.path)
  }
  out.push(adoptMetadata(t, at(RECORD_FILE)))
  return { files: out, intent, tmp: recordTmp }
}

/**
 * Doctor's seams on the state: the adopted sidecar unlink and its own marker
 * rewrite. Exported for its unit test (the area-path guard).
 * @internal
 */
export function adoptInto(st: SwapState, t: ReadTranscript, a: AdoptedSet): void {
  adoptSidecarsInto(st, t)
  const record = a.files[a.files.length - 1]!
  st.rewriteMarker = (marker) => rewriteMarkerAdopted(st, record, a.tmp, marker)
}

/**
 * The adopted sidecar unlink alone (6b-ii `--clean-staging` too, which has no
 * record to mark): a sidecar or its temp in this op's area, read whole by the
 * re-plan, may be replaced by a resumed rewrite.
 * @internal
 */
export function adoptSidecarsInto(st: SwapState, t: ReadTranscript): void {
  st.unlinkAdopted = async (p, reason) => {
    // Only a sidecar or its temp in this op's area, read whole by the re-plan.
    if (path.dirname(p) !== st.areaPath) return false
    let adopted: Adopted
    try {
      adopted = adoptMetadata(t, p)
    } catch {
      return false
    }
    await unlinkAdopted(st, adopted, reason)
    return true
  }
}

/** The names the re-plan listed in OP. */
export function listedNames(t: ReadTranscript, opDir: string): string[] {
  const e = t.find((x) => x.method === 'list' && x.key === `${opDir}\0all`)
  const fact = e?.fact as { ok: boolean; names?: string[] } | undefined
  return fact?.ok === true && fact.names !== undefined ? fact.names : []
}

/** A refusal before the first mutation: what it is, and its words. */
export interface PreMutationBlock {
  reason: 'state-root-full' | 'staging-unsafe'
  detail: string
}

/** The space block, then (no intent reused) the park-intent precheck; null when neither refuses. */
export async function preMutationBlocks(
  st: SwapState,
  f: Pick<OpFacts, 'roles' | 't' | 'tPath'>,
  steps: readonly PlanStep[],
  adopted: Pick<AdoptedSet, 'intent'>
): Promise<PreMutationBlock | null> {
  // A cross-device copy that cannot fit refuses, nothing changed.
  const full = await spaceBlock(st, f, steps)
  if (full !== null) return { reason: 'state-root-full', detail: full }
  // A park intent the finish would write that the reader would refuse (none is written when one is reused).
  const unreadable = adopted.intent === null ? intentBlock(st, f, steps) : null
  if (unreadable !== null) {
    return {
      reason: 'staging-unsafe',
      detail: `${unreadable}; nothing was changed; ${RECORDED_STATE_ROOT_NOTE}`,
    }
  }
  return null
}
