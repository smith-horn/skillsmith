/**
 * Phase 1: High-trust author indexing loop (Node port)
 * @module scripts/indexer/phases/high-trust
 *
 * SMI-4852 plan issue #14: Extracted from `discovery-orchestrator.ts` to keep
 * the parent orchestrator under the 350-LOC plan target (also helps the
 * audit:standards 500-line gate). Behavior parity with the Deno parent's
 * inline Phase 1 loop at
 * `supabase/functions/indexer/discovery-orchestrator.ts:139-177`.
 *
 * Changes from the Deno inline form:
 *   1. Parallelized via `pMapBounded` (SMI-4852) — concurrency is caller-controlled
 *      via `parseEnv().concurrency`. Default 2; `CONCURRENCY_KILL_SWITCH=1` forces 1.
 *   2. Each per-author call is wrapped in `withBackoff(() => indexHighTrustRepository(...))`
 *      so secondary rate-limit incidents surfaced by the `withRateLimitTracking`
 *      wrapper get exponential-backoff retry without breaking the loop.
 *   3. Aggregation of per-author results (skills, errors, wildcard counters)
 *      runs serially after the parallel map completes, preserving deterministic
 *      seenUrls/repositories/highTrustSkillMap order keyed by HIGH_TRUST_AUTHORS
 *      array index.
 */

import { HIGH_TRUST_AUTHORS, type HighTrustAuthor } from '../high-trust-authors.ts'
import {
  GITHUB_API_DELAY,
  delay,
  pMapBounded,
  withBackoff,
  type RateLimitTelemetry,
} from '../_shared/rate-limit.ts'
import { indexHighTrustRepository } from '../high-trust-indexer.ts'
import type { GitHubRepository } from '../topic-search.ts'
import type { SkillMdValidation } from '../skill-processor.ts'

export interface HighTrustPhaseResult {
  /** Repositories surfaced this phase, in HIGH_TRUST_AUTHORS deterministic order. */
  repos: GitHubRepository[]
  /** Map of repo URL → author; passed to Phase 4 upsert for trust-tier resolution. */
  highTrustSkillMap: Map<string, HighTrustAuthor>
  /** Per-author errors, concatenated. */
  errors: string[]
  /** Telemetry surfaced into IndexerResult.high_trust_wildcard. */
  wildcardExpansionCount: number
  authorsWithWildcards: number
  treesApiCallCount: number
  truncatedResponseCount: number
}

export interface HighTrustPhaseParams {
  validationCache: Map<string, SkillMdValidation>
  validationOptions: { strictValidation: boolean; minContentLength: number }
  /** SMI-4852 Hard Rule 1: rate-limit telemetry threaded into the indexer. */
  telemetry: RateLimitTelemetry
  /**
   * SMI-4846: Worker concurrency for the per-author loop. Resolved by
   * `parseEnv()` in the entrypoint (default 2; 1 if CONCURRENCY_KILL_SWITCH=1).
   */
  concurrency: number
}

/**
 * Run Phase 1 — scan HIGH_TRUST_AUTHORS for SKILL.md files.
 *
 * Returns a deterministic-ordered list of repositories (input order of
 * HIGH_TRUST_AUTHORS) plus the highTrustSkillMap downstream phases consume.
 */
export async function runHighTrustPhase(
  params: HighTrustPhaseParams
): Promise<HighTrustPhaseResult> {
  const { validationCache, validationOptions, telemetry, concurrency } = params

  console.log(`Indexing ${HIGH_TRUST_AUTHORS.length} high-trust authors...`)

  // SMI-4852: parallel per-author fan-out. Each worker wraps the indexer call
  // in withBackoff so a single 403/429 doesn't fail the whole map.
  const perAuthorResults = await pMapBounded(
    HIGH_TRUST_AUTHORS,
    async (author) => {
      return withBackoff(
        () => indexHighTrustRepository(author, validationCache, validationOptions, telemetry),
        { baseMs: 1000, maxMs: 60000, maxRetries: 5 }
      )
    },
    { concurrency }
  )

  // Serial aggregation — preserves deterministic seenUrls/repositories order.
  const seenUrls = new Set<string>()
  const repos: GitHubRepository[] = []
  const highTrustSkillMap = new Map<string, HighTrustAuthor>()
  const errors: string[] = []
  let wildcardExpansionCount = 0
  let authorsWithWildcards = 0
  let treesApiCallCount = 0
  let truncatedResponseCount = 0

  for (let i = 0; i < HIGH_TRUST_AUTHORS.length; i++) {
    const author = HIGH_TRUST_AUTHORS[i]
    const r = perAuthorResults[i]
    for (const skill of r.skills) {
      if (!seenUrls.has(skill.url)) {
        seenUrls.add(skill.url)
        repos.push(skill)
        highTrustSkillMap.set(skill.url, author)
      }
    }
    errors.push(...r.errors)
    wildcardExpansionCount += r.wildcardExpansionCount
    const authorHasWildcard = (author.skillsPaths ?? []).some((p) => p.includes('*'))
    if (authorHasWildcard) {
      authorsWithWildcards++
    }
    treesApiCallCount += r.treesApiCallCount ?? 0
    truncatedResponseCount += r.truncatedResponseCount ?? 0
    // Preserve the per-author inter-call pacing from the Deno parent
    // (140ms). pMapBounded already paces via concurrency, but the small
    // delay reduces burstiness when concurrency=1 (kill-switch path).
    await delay(GITHUB_API_DELAY)
  }

  if (wildcardExpansionCount) {
    console.log(
      `[HighTrust/Trees] wildcard expansion: ${wildcardExpansionCount} paths resolved via Trees API`
    )
  }
  console.log(`Found ${highTrustSkillMap.size} skills from high-trust authors`)

  return {
    repos,
    highTrustSkillMap,
    errors,
    wildcardExpansionCount,
    authorsWithWildcards,
    treesApiCallCount,
    truncatedResponseCount,
  }
}
