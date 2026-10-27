/**
 * SMI-6531 (A1 step 7b): `updateInPlace`, the in-place update of an existing
 * tracked folder from an approved plan (A1 plan §3.1, §3.3, §3.6, §3.7).
 *
 * It builds the real manifest port (`createManifestPort`) from the plan's
 * target, with the `preEntry` and `postEntry` sealed at plan time (never
 * re-read now: a change since the plan must fail the CAS), and runs
 * `swapInPlace` with the plan's write set. The write set is the fetched bytes
 * the plan holds; nothing is fetched again here.
 *
 * The result is the swap's, plus `next` for the one case that leaves a
 * command to run: a commit whose backup publish stopped on a full state root.
 * The update has already installed the new tree and kept its record, so a
 * rerun is refused `recovery-pending`; doctor finishes it once there is room.
 *
 * No production caller until A1 step 9: `update` still calls `install()`.
 *
 * @module @skillsmith/core/services/skill-update
 */
import { createManifestPort } from './skill-manifest.port.js'
import { swapInPlace } from './skill-swap.js'
import type { SwapResult } from './skill-swap.types.js'
import type { UpdateInPlaceOptions, UpdatePlan, UpdateResult } from './skill-update.types.js'

/** The command a `state-root-full` commit leaves to run. */
export const recoveryNextStep = (opId: string): string =>
  `skillsmith doctor recovery --apply ${opId}`

/** @internal Adds `next` to a commit stopped on a full state root; every other result is unchanged. */
export function toUpdateResult(result: SwapResult): UpdateResult {
  if (result.status === 'committed' && result.incomplete?.reason === 'state-root-full') {
    return { ...result, next: recoveryNextStep(result.opId) }
  }
  return result
}

/** Updates `plan.target`'s folder in place. Never throws for an expected outcome; see `SwapResult`. */
export async function updateInPlace(
  plan: UpdatePlan,
  opts: UpdateInPlaceOptions = {}
): Promise<UpdateResult> {
  const { target } = plan
  const port = createManifestPort(
    {
      manifestPath: target.manifestPath,
      manifestKey: target.manifestKey,
      preEntry: target.preEntry,
      postEntry: plan.postEntry,
    },
    opts.onLegacyWait === undefined ? {} : { onLegacyWait: opts.onLegacyWait }
  )
  opts.onProgress?.('write', 'Updating the skill folder in place')
  const result = await swapInPlace(
    {
      skillsDir: target.skillsDir,
      client: target.client,
      scope: target.scope,
      stateRoot: target.stateRoot,
      manifestPath: target.manifestPath,
      manifestKey: target.manifestKey,
      comparedPath: target.comparedPath,
      realDir: target.realDir,
      dirName: target.dirName,
      oldIdentity: target.identity,
      preTree: target.preTree,
      writeSet: plan.files.map(({ rel, kind, bytes }) => ({ rel, kind, bytes })),
      preEntry: target.preEntry,
      postEntry: plan.postEntry,
      manifest: opts.wrapPort === undefined ? port : opts.wrapPort(port),
    },
    opts.swap ?? {}
  )
  return toUpdateResult(result)
}
