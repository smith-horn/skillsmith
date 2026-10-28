/**
 * SMI-6531 (A1 step 6b-ii): O1's writer side, the attribution an op dir
 * carries before it has a record (design `step6b-design.md` § 2 O1).
 *
 * From step 1 the swap writes `client`, `scope`, `dirName`, `manifestKey` and
 * `stateRoot` (the native real path of `dirname(manifestPath)`, which is
 * `SwapState.stateRootReal`) into `owner.json`, and abort cleanup's
 * `abort-new` park intent copies them (schema 2). They let `doctor recovery
 * --clean-staging` file a no-record op dir's trees in the update's own backup
 * area and find a keep abort cleanup had started there.
 *
 * They are **routing hints, not authority**: doctor validates them all or
 * nothing (`skill-recovery.attribution.ts`), and they decide only where a kept
 * tree is filed and what its sidecar and parked-index line say, never what is
 * kept, whether an action is offered, or which skill is changed. The writer
 * writes them as plain strings; it is the reader that checks them.
 *
 * @module @skillsmith/core/services/skill-swap.attribution
 */
import type { SwapState } from './skill-swap.ops.js'

export const ATTRIBUTION_FIELDS = [
  'client',
  'scope',
  'dirName',
  'manifestKey',
  'stateRoot',
] as const

export type AttributionField = (typeof ATTRIBUTION_FIELDS)[number]

/** The attribution as written: one string per field, unvalidated. */
export type AttributionHint = { readonly [K in AttributionField]: string }

/** What this run writes: its input's routing fields and its state root's native real path. */
export function attributionOf(st: SwapState): AttributionHint {
  return {
    client: st.input.client,
    scope: st.input.scope,
    dirName: st.input.dirName,
    manifestKey: st.input.manifestKey,
    stateRoot: st.stateRootReal,
  }
}

/** True when `o` carries every attribution field, each a string (the schema check; not validation). */
export function hasAttributionStrings(o: Record<string, unknown>): boolean {
  return ATTRIBUTION_FIELDS.every((k) => typeof o[k] === 'string')
}
