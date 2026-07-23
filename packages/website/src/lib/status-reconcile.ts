/**
 * Dynamic-row reconciliation contract (SMI-5755, Wave 5, Codex #3,
 * merge-blocking). Split out of status-client.ts to stay under the repo's
 * 500-line-per-file gate — see status-client.ts's barrel re-export + header
 * comment for the full module-split rationale.
 */

import type { StatusComponent } from './status-vocab'

export interface ComponentDedupeResult {
  components: StatusComponent[]
  duplicateSlugs: string[]
}

/** Validates `data.components` slugs are unique; a duplicate is skipped (not rendered twice). */
export function dedupeComponentsBySlug(components: StatusComponent[]): ComponentDedupeResult {
  const seen = new Set<string>()
  const deduped: StatusComponent[] = []
  const duplicateSlugs: string[] = []
  for (const component of components) {
    if (seen.has(component.slug)) {
      duplicateSlugs.push(component.slug)
      continue
    }
    seen.add(component.slug)
    deduped.push(component)
  }
  return { components: deduped, duplicateSlugs }
}

export interface ReconcilePlan {
  /** Existing rows (scaffold or previously-dynamic) to update in place. */
  toUpsert: StatusComponent[]
  /** Payload components with no existing row — create and track as "dynamic". */
  toCreate: StatusComponent[]
  /** Dynamic rows whose slug is no longer in the payload — remove entirely. */
  toRemoveSlugs: string[]
  /** Fixed scaffold rows whose slug is absent from the payload — reset, never removed. */
  toResetSlugs: string[]
}

/**
 * The reconciliation contract run on every poll:
 *   1. Dedupe payload components by slug (skip/log duplicates).
 *   2. Existing row for a payload slug → update in place; no existing row →
 *      create + track as dynamic.
 *   3. A dynamic row whose slug is no longer present → removed entirely.
 *   4. A fixed scaffold row whose slug is absent → reset to unknown/no-data,
 *      never removed.
 */
export function planComponentReconciliation(
  payloadComponents: StatusComponent[],
  existingSlugs: ReadonlySet<string>,
  scaffoldSlugs: ReadonlySet<string>
): ReconcilePlan {
  const { components: deduped } = dedupeComponentsBySlug(payloadComponents)
  const payloadSlugs = new Set(deduped.map((c) => c.slug))

  const toUpsert: StatusComponent[] = []
  const toCreate: StatusComponent[] = []
  for (const component of deduped) {
    if (existingSlugs.has(component.slug)) {
      toUpsert.push(component)
    } else {
      toCreate.push(component)
    }
  }

  const toRemoveSlugs: string[] = []
  const toResetSlugs: string[] = []
  for (const slug of existingSlugs) {
    if (payloadSlugs.has(slug)) continue
    if (scaffoldSlugs.has(slug)) {
      toResetSlugs.push(slug)
    } else {
      toRemoveSlugs.push(slug)
    }
  }

  return { toUpsert, toCreate, toRemoveSlugs, toResetSlugs }
}
