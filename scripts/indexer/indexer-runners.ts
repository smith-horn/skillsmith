/**
 * Supabase-dependent indexer phase runners (Node port)
 * @module scripts/indexer/indexer-runners
 *
 * SMI-4852 Wave 1: Node-flavored sibling of
 * `supabase/functions/indexer/indexer-runners.ts`. Body is byte-near-identical
 * to the Deno parent modulo:
 *   - `SupabaseClient` import: npm `@supabase/supabase-js` (not esm.sh URL).
 *   - `RateLimitTelemetry` threaded through `runUpsertPhase` and re-exported
 *     `runCodeSearch` so downstream GitHub fetches record into the per-run
 *     telemetry bag.
 *
 * Contains Phase 4 (upsert), Phase 5 (categorization), and Phase 7 (audit log)
 * runners. Unlike pure helpers, this module has Supabase dependencies and is
 * exercised in integration tests against a real (or mocked) PostgREST surface.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { batchedIn } from './batch-utils.ts'
import { CATEGORY_IDS, categorizeSkill } from './categorization.ts'
import {
  getCachedValidation,
  repositoryToSkill,
  type SkillMdValidation,
} from './skill-processor.ts'
import { minimalSkillPayload, repoUpdatedAtKey } from './skill-processor.helpers.ts'
import { type RateLimitTelemetry } from './_shared/rate-limit.ts'
import { buildGitHubHeaders } from './_shared/github-auth.ts'
import type { GitHubRepository } from './topic-search.ts'
import { getHighTrustAuthor, type HighTrustAuthor } from './high-trust-authors.ts'
import {
  isVerifiedGitHubOrg,
  warmOrgVerifiedCache,
  type OrgVerifiedCache,
} from './org-verification.ts'
import { bumpDiscoveryPath, resolveHighTrustAuthor } from './indexer-runners.helpers.ts'
import { flushUpsertAccumulator, type UpsertAccumulatorItem } from './indexer-runners.batch.ts'

/**
 * Score distribution across high-trust and community skill upserts.
 */
export interface ScoreDistribution {
  highTrust: number
  community: number
  scores: number[]
}

/**
 * Phase 5: Run categorization for all indexed skills.
 * Clears stale category assignments, re-categorizes, and updates counts.
 *
 * @param supabase - Supabase admin client
 * @param repoUrls - URLs of repositories that were indexed this run
 * @returns categorizedCount, categoryAssignments, and any non-fatal errors
 */
export async function runCategorization(
  supabase: SupabaseClient,
  repoUrls: string[]
): Promise<{ categorizedCount: number; categoryAssignments: number; errors: string[] }> {
  console.log(`[Categorization] Starting categorization for indexed skills...`)
  let categorizedCount = 0
  let categoryAssignments = 0
  const errors: string[] = []

  const skillsToCheck = await batchedIn<{ id: string; tags: string[]; description: string }>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SMI-4852: PostgrestFilterBuilder strict-mode types fail TS2589; structural cast needed
    () => (supabase as any).from('skills').select('id, tags, description'),
    'repo_url',
    repoUrls
  )

  if (skillsToCheck.length > 0) {
    const skillIds = skillsToCheck.map((s) => s.id)
    const { error: deleteError } = await supabase
      .from('skill_categories')
      .delete()
      .in('skill_id', skillIds)
    if (deleteError) {
      console.log(
        `[Categorization] Warning: failed to clear stale categories: ${deleteError.message}`
      )
    }

    for (const skill of skillsToCheck) {
      const tags = Array.isArray(skill.tags) ? skill.tags : []
      const categories = categorizeSkill(tags as string[], skill.description)
      if (categories.length > 0) {
        const categoryRows = categories.map((categoryId) => ({
          skill_id: skill.id,
          category_id: categoryId,
        }))
        const { error: catError } = await supabase.from('skill_categories').insert(categoryRows)
        if (catError) {
          console.log(`[Categorization] Error for ${skill.id}: ${catError.message}`)
        } else {
          categorizedCount++
          categoryAssignments += categories.length
        }
      }
    }

    const { error: updateError } = await supabase.rpc('update_category_counts')
    if (updateError) {
      const isRpcNotFound =
        updateError.message?.includes('not found') ||
        updateError.code === '42883' ||
        updateError.code === 'PGRST202'
      if (isRpcNotFound) {
        console.log(`[Categorization] RPC not found, updating manually...`)
        for (const categoryId of Object.values(CATEGORY_IDS)) {
          const { count } = await supabase
            .from('skill_categories')
            .select('*', { count: 'exact', head: true })
            .eq('category_id', categoryId)
          await supabase
            .from('categories')
            .update({ skill_count: count || 0 })
            .eq('id', categoryId)
            .neq('id', '') // pg_safeupdate: WHERE clause required
        }
      } else {
        console.error(`[Categorization] RPC failed: ${updateError.message} (${updateError.code})`)
        errors.push(`Category count update failed: ${updateError.message}`)
      }
    }
    console.log(`[Categorization] ${categorizedCount} skills, ${categoryAssignments} assignments`)
  }

  return { categorizedCount, categoryAssignments, errors }
}

// SMI-4854: `runCodeSearch` extracted to indexer-runners.codesearch.ts to keep
// this file under the 500-line audit:standards gate. Re-exported below.
export { runCodeSearch } from './indexer-runners.codesearch.ts'

/**
 * Phase 4: Database upsert with quality gate.
 * Returns a value object — never mutates the caller's result object.
 * dryRun guard is internal: unconditionally callable, returns zero values on dry run.
 *
 * @param supabase - Supabase admin client
 * @param repositories - Repositories discovered across all phases
 * @param highTrustSkillMap - Maps repo URL to its high-trust author
 * @param validationCache - Request-scoped SKILL.md validation cache
 * @param dryRun - If true, skip all writes and return zero values
 * @param telemetry - Run-scoped rate-limit telemetry bag (SMI-4852)
 */
export async function runUpsertPhase(
  supabase: SupabaseClient,
  repositories: GitHubRepository[],
  highTrustSkillMap: Map<string, HighTrustAuthor>,
  validationCache: Map<string, SkillMdValidation>,
  dryRun: boolean,
  telemetry: RateLimitTelemetry
): Promise<{
  indexed: number
  updated: number
  failed: number
  quarantined: number
  unchanged: number
  quality_gate_filtered: number
  scoreDistribution: ScoreDistribution
  errors: string[]
  // SMI-4387: Per-discovery-path yield counts (indexed + updated only).
  discoveryPathCounts: Record<string, number>
  // SMI-4386: Count of upserts where the Phase-1 highTrustSkillMap missed but
  // the HIGH_TRUST_AUTHORS registry resolved the owner+repo. Load-bearing
  // signal for Phase-1/Phase-2 URL-scheme drift.
  high_trust_fallback_hits: number
}> {
  const zeroResult = {
    indexed: dryRun ? repositories.length : 0,
    updated: 0,
    failed: 0,
    quarantined: 0,
    unchanged: 0,
    quality_gate_filtered: 0,
    scoreDistribution: { highTrust: 0, community: 0, scores: [] as number[] },
    errors: [] as string[],
    discoveryPathCounts: {} as Record<string, number>,
    high_trust_fallback_hits: 0,
  }

  if (dryRun || repositories.length === 0) {
    return zeroResult
  }

  let indexed = 0
  let updated = 0
  let failed = 0
  let quarantined = 0
  let unchanged = 0
  let quality_gate_filtered = 0
  const scoreDistribution: ScoreDistribution = { highTrust: 0, community: 0, scores: [] }
  const errors: string[] = []
  // SMI-4387: Counter of yield (indexed + updated) per discovery path. Excludes
  // unchanged/filtered/failed by design — SMI-4385 before/after verification
  // needs new-row counts per path, not coverage.
  const discoveryPathCounts: Record<string, number> = {}
  // SMI-4386: Counter of registry fallback resolutions. highTrustSkillMap is
  // populated only in Phase 1; Phase 2/3 discoveries of high-trust repos miss
  // the map and fall back to getHighTrustAuthor. Non-zero = the fix is firing.
  let high_trust_fallback_hits = 0
  // SMI-3540: Collect IDs of hash-matched (unchanged) skills to touch last_seen_at
  const unchangedIds: string[] = []
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

  // SMI-4651: Per-run cache for GitHub-verified org lookups. Scoped to this
  // upsert phase so the same owner is fetched at most once per indexer run.
  const orgVerifiedCache: OrgVerifiedCache = new Map()
  const githubHeaders = await buildGitHubHeaders()

  // SMI-4736: Pre-warm cache for all non-high-trust unique owners in parallel
  // to eliminate sequential per-repo fetches that caused 504 IDLE_TIMEOUT.
  // getHighTrustAuthor is a pure O(1) in-memory lookup — safe in .filter().
  const nonHighTrustOwners = repositories
    .filter((r) => !highTrustSkillMap.has(r.url) && !getHighTrustAuthor(r.owner, r.repoName))
    .map((r) => r.owner)
  await warmOrgVerifiedCache(nonHighTrustOwners, orgVerifiedCache, githubHeaders, telemetry)

  const repoUrls = repositories.map((r) => r.url)

  // batchedIn chunks the IN clause to handle large repo sets safely.
  // SMI-3540: Also select id and last_seen_at for hash-matched touch + grace period.
  // SMI-4846: Also select repo_updated_at for the skip-gate prefetch.
  const existingSkills = await batchedIn<{
    id: string
    repo_url: string
    content_hash: string | null
    last_seen_at: string | null
    repo_updated_at: string | null
  }>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SMI-4852: PostgrestFilterBuilder strict-mode types fail TS2589; structural cast needed
    () =>
      (supabase as any)
        .from('skills')
        .select('id, repo_url, content_hash, last_seen_at, repo_updated_at'),
    'repo_url',
    repoUrls
  )
  const existingUrls = new Set(existingSkills.map((s: { repo_url: string }) => s.repo_url))
  const existingHashes = new Map<string, string | null>()
  const repoUrlToId = new Map<string, string>()
  const repoUrlToLastSeen = new Map<string, string | null>()
  // SMI-4846: Skip-gate map (`repo_updated_at` of existing rows). Compared
  // against `repoUpdatedAtKey(repo)` BEFORE both `getCachedValidation` and any
  // downstream fetch — H-4 case (c) requires the cache lookup runs only on
  // the prehash-MISS path so unchanged repos never thrash the cache.
  const existingRepoUpdatedAt = new Map<string, string | null>()
  for (const s of existingSkills) {
    existingHashes.set(s.repo_url, s.content_hash ?? null)
    repoUrlToId.set(s.repo_url, s.id)
    repoUrlToLastSeen.set(s.repo_url, s.last_seen_at ?? null)
    existingRepoUpdatedAt.set(s.repo_url, s.repo_updated_at ?? null)
  }

  // SMI-4846: Accumulator pattern — see indexer-runners.batch.ts for batch
  // semantics, null-url pre-batch audit logging (H-2), partial-failure diff (C-3).
  const accumulator: UpsertAccumulatorItem[] = []

  for (const repo of repositories) {
    try {
      // SMI-4386: see resolveHighTrustAuthor — Phase-1-only map miss → registry fallback.
      const [highTrustAuthor, fallbackFired] = resolveHighTrustAuthor(highTrustSkillMap, repo)
      if (fallbackFired) high_trust_fallback_hits++

      // SMI-4846: First skip-gate — `repo.updatedAt` matches the prior upsert's
      // recorded `repo_updated_at`. Bypass `getCachedValidation`, `repositoryToSkill`,
      // and the upsert. The downstream `validateSkillMd` HTTP fetch is paid in
      // Phase 1/3a; this gate lets a future PR push the skip up to those phases
      // (where the ~240s wall-clock saving from skipping `validateSkillMd` lives).
      // For this PR, the gate avoids upsert work + cache thrash, and the on-disk
      // `repo_updated_at` is what unlocks upstream phases later.
      const prehashKey = repoUpdatedAtKey(repo)
      const existingPrehash = existingRepoUpdatedAt.get(repo.url)
      if (
        existingPrehash !== undefined &&
        existingPrehash !== null &&
        existingPrehash === prehashKey
      ) {
        unchanged++
        // SMI-3540: Collect ID for last_seen_at touch (skip if recently touched).
        const id = repoUrlToId.get(repo.url)
        const lastSeen = repoUrlToLastSeen.get(repo.url)
        if (id && (!lastSeen || lastSeen < oneHourAgo)) {
          unchangedIds.push(id)
        }
        // Push minimal payload so the row's `repo_updated_at` column is reaffirmed
        // even when the value hasn't changed (no-op on the column itself; touches
        // last_seen_at to reflect this run's sighting).
        accumulator.push({ repo, skillData: minimalSkillPayload(repo), unchangedSkip: true })
        continue
      }

      // Miss path: lazy-validation cache lookup (H-4 case c — only here, never on hit path).
      const validation = getCachedValidation(
        repo.owner,
        repo.repoName,
        repo.defaultBranch,
        validationCache,
        repo.skillPath
      )
      // SMI-4651: Promote GitHub-verified vendor orgs to `curated`. Skip the
      // lookup when allowlist already resolved (verified outranks curated).
      const orgIsVerified = highTrustAuthor
        ? undefined
        : await isVerifiedGitHubOrg(repo.owner, orgVerifiedCache, githubHeaders, telemetry)
      const skillData = repositoryToSkill(repo, highTrustAuthor, validation, orgIsVerified)

      if (!highTrustAuthor && validation && validation.errors.length > 0) {
        quality_gate_filtered++
        console.log(
          `[QualityGate] FILTERED: ${repo.fullName} errors=[${validation.errors.join('; ')}]`
        )
        continue
      }

      // Second skip-gate — content_hash matches (H-1: content_hash stays
      // authoritative on the real-fetch path even though prehash is the
      // upstream gate). Catches the case where repo_updated_at changed but
      // SKILL.md content didn't (metadata-only commit, README change, etc.).
      const existingHash = existingHashes.get(repo.url)
      if (existingHash && skillData.content_hash && existingHash === skillData.content_hash) {
        unchanged++
        const id = repoUrlToId.get(repo.url)
        const lastSeen = repoUrlToLastSeen.get(repo.url)
        if (id && (!lastSeen || lastSeen < oneHourAgo)) {
          unchangedIds.push(id)
        }
        // Still write the new repo_updated_at so the next run hits the prehash
        // gate. Push minimal payload — content didn't change, only the timestamp.
        accumulator.push({ repo, skillData: minimalSkillPayload(repo), unchangedSkip: true })
        continue
      }

      if (highTrustAuthor) {
        scoreDistribution.highTrust++
      } else {
        scoreDistribution.community++
        scoreDistribution.scores.push(skillData.quality_score as number)
      }

      accumulator.push({ repo, skillData })
    } catch (error) {
      errors.push(
        `Error processing ${repo.fullName}: ${error instanceof Error ? error.message : 'Unknown'}`
      )
      failed++
    }
  }

  // SMI-4846 + C-3: Single batched upsert — drains the accumulator, writes
  // null-url audit logs pre-batch, surfaces partial failures.
  const flush = await flushUpsertAccumulator(supabase, accumulator, existingUrls)
  indexed += flush.indexed
  updated += flush.updated
  failed += flush.failed
  quarantined += flush.quarantined
  errors.push(...flush.errors)
  // SMI-4387: Credit the discovery path for each successful upsert.
  // Skip-gate items don't count as yield (they were already in the DB).
  for (const { repo, skillData, unchangedSkip } of accumulator) {
    if (unchangedSkip) continue
    const url = skillData.repo_url as string | null
    if (url && flush.upsertOkUrls.has(url)) {
      bumpDiscoveryPath(discoveryPathCounts, repo)
    }
  }

  // SMI-3540: Touch last_seen_at for hash-matched (unchanged) skills.
  // Without this, unchanged skills never refresh last_seen_at and get
  // stale-quarantined even though the indexer successfully found them.
  // Batch UPDATE in groups of 100 to avoid oversized IN clauses (E6).
  const TOUCH_BATCH_SIZE = 100
  for (let i = 0; i < unchangedIds.length; i += TOUCH_BATCH_SIZE) {
    const batch = unchangedIds.slice(i, i + TOUCH_BATCH_SIZE)

    // SMI-3540: Auto-unquarantine stale-only skills on rediscovery (E4).
    // Query quarantined skills in this batch and filter by JSONB findings.
    const { data: quarantinedInBatch } = await supabase
      .from('skills')
      .select('id, security_findings')
      .in('id', batch)
      .eq('quarantined', true)

    const staleOnlyIds = (quarantinedInBatch || [])
      .filter((s: { id: string; security_findings: unknown }) => {
        const findings = Array.isArray(s.security_findings) ? s.security_findings : []
        // Only stale findings — no security, repo_deleted, or repo_archived findings
        return findings.every((f: { type: string }) => f.type === 'stale')
      })
      .map((s: { id: string }) => s.id)

    if (staleOnlyIds.length > 0) {
      const { error: unqError } = await supabase
        .from('skills')
        .update({
          quarantined: false,
          quarantine_reason: null,
          security_findings: [],
          last_seen_at: new Date().toISOString(),
        })
        .in('id', staleOnlyIds)
      if (unqError) {
        errors.push(`Failed to auto-unquarantine batch: ${unqError.message}`)
      }
    }

    // Touch last_seen_at for the rest (non-quarantined unchanged skills)
    const nonQuarantinedIds = batch.filter((id) => !staleOnlyIds.includes(id))
    if (nonQuarantinedIds.length > 0) {
      const { error: touchError } = await supabase
        .from('skills')
        .update({ last_seen_at: new Date().toISOString() })
        .in('id', nonQuarantinedIds)
      if (touchError) {
        errors.push(`Failed to touch last_seen_at for batch: ${touchError.message}`)
      }
    }
  }
  if (unchangedIds.length > 0) {
    console.log(`[LastSeenTouch] Touched ${unchangedIds.length} unchanged skills`)
  }

  if (scoreDistribution.scores.length > 0) {
    const avg =
      scoreDistribution.scores.reduce((a, b) => a + b, 0) / scoreDistribution.scores.length
    console.log(
      `[QualityScore] HT=${scoreDistribution.highTrust} C=${scoreDistribution.community} avg=${avg.toFixed(4)}`
    )
  }

  return {
    indexed,
    updated,
    failed,
    quarantined,
    unchanged,
    quality_gate_filtered,
    scoreDistribution,
    errors,
    discoveryPathCounts,
    high_trust_fallback_hits,
  }
}

// SMI-4387: `AuditLogParams` and `writeIndexerAuditLog` were extracted to
// `./indexer-audit-log.ts` to keep this file under the 500-line CI gate.
// Re-exported here for existing import sites (no consumer change needed).
export { writeIndexerAuditLog } from './indexer-audit-log.ts'
export type { AuditLogParams } from './indexer-audit-log.ts'
// SMI-4736: `bumpDiscoveryPath` and `resolveHighTrustAuthor` were extracted to
// `./indexer-runners.helpers.ts` to keep this file under the 500-line CI gate.
// Re-exported here for existing import sites (no consumer change needed).
export { bumpDiscoveryPath, resolveHighTrustAuthor }
