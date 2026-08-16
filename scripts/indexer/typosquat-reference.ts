/**
 * Typosquat reference-name list — live query (SMI-6033 Wave 1, Gap 7)
 * @module scripts/indexer/typosquat-reference
 *
 * Builds the run-scoped `ReadonlySet<string>` consumed by
 * `packages/core/src/security/scanner/typosquat.ts`'s `scanTyposquat()` /
 * `detectTyposquat()`, via `buildTyposquatReferenceList()`
 * (`typosquat-reference-list.ts`). Two sources, unioned:
 *
 *  1. Every `skills` row whose `author` is one of this indexer's own
 *     high-trust author owners (`HIGH_TRUST_AUTHORS`, `high-trust-authors.ts`
 *     — NOT core's `HIGH_TRUST_OWNERS` from `signal-of-intent.ts`; the Deno
 *     twin of this file can't import `packages/core`, and both indexer trees
 *     already maintain their own parity-guarded `HIGH_TRUST_AUTHORS` list for
 *     exactly this reason — see `high-trust-authors.ts`'s own header).
 *  2. The top 200 `skills` rows by `stars DESC NULLS LAST` where
 *     `quarantined = false AND installable = true` — a real, populated,
 *     4h-refreshed popularity signal. `skills.install_count` does NOT exist
 *     (`skills_optimized.install_count` exists but is currently empty) — see
 *     the plan doc's Surface Grounding table (`docs/internal/implementation/
 *     smi-6033-clawhavoc-scanner-gaps.md`) for the citations that corrected
 *     the original `install_count`-based design.
 *
 * Built ONCE per indexer batch run, not rebuilt per skill — see the plan's
 * Shared-State Audit: the returned `ReadonlySet` is a plain run-local value,
 * never persisted to a cache table or shared across concurrent workers.
 *
 * Parity with `supabase/functions/indexer/typosquat-reference.ts` (query
 * shape, not implementation — the Deno twin cannot import
 * `packages/core`'s `buildTyposquatReferenceList`, so it re-implements the
 * same union-of-two-sources + brand-alias-fold logic directly) is enforced by
 * `parity.test.ts`.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { HIGH_TRUST_AUTHORS } from './high-trust-authors.ts'
import type { SkillMdValidationOptions } from './skill-processor.helpers.ts'
import { batchedIn } from './batch-utils.ts'
import {
  buildTyposquatReferenceList,
  type ReferenceSkillEntry,
  type InstalledSkillEntry,
} from '../../packages/core/src/security/scanner/index.js'

/** SMI-6033 Gap 7: top-N cutoff for the stars-ranked popularity source. */
export const TOP_STARRED_REFERENCE_LIMIT = 200

interface SkillNameRow {
  author: string | null
  name: string | null
}

interface StarredSkillRow extends SkillNameRow {
  stars: number | null
}

/**
 * Query `skills` for the two reference-list source sets and build the
 * combined typosquat reference set. Call ONCE per indexer batch run and pass
 * the result down — never rebuild per skill.
 */
export async function fetchTyposquatReferenceSet(
  supabase: SupabaseClient
): Promise<ReadonlySet<string>> {
  const highTrustOwners = [...new Set(HIGH_TRUST_AUTHORS.map((a) => a.owner))]

  // SMI-4852 convention (see indexer-runners.ts:80-85): batchedIn's factory
  // signature is narrower than SupabaseClient's builder type, so the query
  // builder is cast through `any` at the call boundary only.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabaseAny: any = supabase
  const highTrustRows = await batchedIn<SkillNameRow>(
    () => supabaseAny.from('skills').select('author, name'),
    'author',
    highTrustOwners
  )

  const { data: topStarredRows, error: topStarredError } = await supabase
    .from('skills')
    .select('author, name, stars')
    .eq('quarantined', false)
    .eq('installable', true)
    .order('stars', { ascending: false, nullsFirst: false })
    .limit(TOP_STARRED_REFERENCE_LIMIT)

  if (topStarredError) {
    console.error(
      JSON.stringify({
        event: 'typosquat_reference_query_failed',
        source: 'top_starred',
        error: topStarredError.message,
      })
    )
  }

  const highTrustOwnerSkills: ReferenceSkillEntry[] = highTrustRows
    .filter((r): r is SkillNameRow & { author: string; name: string } =>
      Boolean(r.author && r.name)
    )
    .map((r) => ({ author: r.author, name: r.name }))

  const installedSkills: InstalledSkillEntry[] = ((topStarredRows ?? []) as StarredSkillRow[])
    .filter((r): r is StarredSkillRow & { author: string; name: string } =>
      Boolean(r.author && r.name)
    )
    .map((r) => ({ author: r.author, name: r.name, installCount: r.stars ?? 0 }))

  return buildTyposquatReferenceList({
    highTrustOwnerSkills,
    installedSkills,
    topInstalledLimit: TOP_STARRED_REFERENCE_LIMIT,
  })
}

/**
 * Fail-soft wrapper around `fetchTyposquatReferenceSet` for run entrypoints.
 * Call ONCE per run; returns `undefined` (⇒ no typosquat check) instead of
 * throwing.
 *
 * Deliberately fail-soft: typosquat is warn-tier/advisory (SMI-595 `warn` mode
 * caps severity at medium and it can never quarantine alone — see the plan's
 * §9 reconciliation table), so a reference-list query failure must degrade to
 * "no typosquat findings" rather than abort an otherwise-healthy indexer run
 * whose primary job is discovery and quarantine of real threats.
 */
export async function fetchTyposquatReferenceSetSafe(
  supabase: SupabaseClient,
  label = 'run'
): Promise<ReadonlySet<string> | undefined> {
  try {
    const names = await fetchTyposquatReferenceSet(supabase)
    console.log(`[Typosquat] reference set built: ${names.size} names (once per ${label})`)
    return names
  } catch (err) {
    console.warn(
      `[Typosquat] reference-set build failed — continuing without the typosquat check: ${
        err instanceof Error ? err.message : 'Unknown'
      }`
    )
    return undefined
  }
}

/**
 * Merge a run-scoped typosquat reference set into the discovery
 * `validationOptions` bag, in ONE call at the top of a run.
 *
 * This is the single seam that makes the detector actually execute: the scan
 * happens inside `validateSkillMd` -> `scanSkillBundle`, reached from every
 * discovery phase via `checkSkillMdExists`, and all of them forward this same
 * options object. (`runUpsertPhase` only reads the already-populated
 * `validationCache`, so wiring typosquat there would never have run it.)
 *
 * Fail-soft via `fetchTyposquatReferenceSetSafe` — a failed reference-list
 * query yields `undefined` (⇒ no typosquat check), never a thrown run.
 */
export async function withTyposquatReferenceNames(
  supabase: SupabaseClient,
  base: SkillMdValidationOptions
): Promise<SkillMdValidationOptions> {
  return { ...base, typosquatReferenceNames: await fetchTyposquatReferenceSetSafe(supabase) }
}
