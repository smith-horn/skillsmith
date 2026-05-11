/**
 * Phase 2: Topic search loop (Node port)
 * @module scripts/indexer/phases/topic-search
 *
 * SMI-4852: Extracted from `discovery-orchestrator.ts` to keep the parent
 * orchestrator under the 350-LOC plan target (issue #14). Behavior parity
 * with the Deno parent's inline Phase 2 loop at
 * `supabase/functions/indexer/discovery-orchestrator.ts:179-275`:
 *   - Parallelized page-fetch via `pMapBounded` (concurrency=4); per-repo
 *     post-processing remains serial because seenUrls/repositories is shared
 *     mutable state.
 *   - SMI-4854 skip-gate: bypass `checkSkillMdExists` HTTP fetch when
 *     `repo.updatedAt` matches the prior upsert's `repo_updated_at`.
 *   - Deterministic (topic, page) ordering preserved via the post-fetch sort
 *     so dedup parity with the pre-parallel implementation holds.
 */

import { type GitHubRepository, searchRepositories } from '../topic-search.ts'
import { pMapBounded, type TokenBucket, type RateLimitTelemetry } from '../_shared/rate-limit.ts'
import { type SkillMdValidation, checkSkillMdExists, repoUpdatedAtKey } from '../skill-processor.ts'

export interface TopicSearchPhaseParams {
  topics: string[]
  maxPages: number
  maxTopicRepos: number
  freshnessDate: string
  seenUrls: Set<string>
  repositories: GitHubRepository[]
  validationCache: Map<string, SkillMdValidation>
  validationOptions: { strictValidation: boolean; minContentLength: number }
  searchApiTokenBucket: TokenBucket
  existingRepoUpdatedAt: Map<string, string | null>
  telemetry: RateLimitTelemetry
}

export interface TopicSearchPhaseResult {
  topicSearchFound: number
  topicRepoCount: number
  phase2SkipGateHits: number
  errors: string[]
  failed: number
}

export async function runTopicSearchPhase(
  params: TopicSearchPhaseParams
): Promise<TopicSearchPhaseResult> {
  const {
    topics,
    maxPages,
    maxTopicRepos,
    freshnessDate,
    seenUrls,
    repositories,
    validationCache,
    validationOptions,
    searchApiTokenBucket,
    existingRepoUpdatedAt,
    telemetry,
  } = params

  // SMI-4846: Phase 2 parallelized via pMapBounded with concurrency=4. The
  // singleton searchApiTokenBucket (30 rpm) paces all workers against
  // GitHub's cumulative Search API quota.
  type PageTask = { topic: string; page: number }
  type PageResult = {
    topic: string
    page: number
    repos: GitHubRepository[]
    total: number
    error?: string
  }
  const pageTasks: PageTask[] = topics.flatMap((topic) =>
    Array.from({ length: maxPages }, (_, i) => ({ topic, page: i + 1 }))
  )
  const pageResults = await pMapBounded<PageTask, PageResult>(
    pageTasks,
    async ({ topic, page }) => {
      await searchApiTokenBucket.acquire()
      const { repos, total, error } = await searchRepositories(
        topic,
        page,
        30,
        freshnessDate,
        telemetry
      )
      return { topic, page, repos, total, error }
    },
    { concurrency: 4 }
  )

  let topicRepoCount = 0
  let reachedLimit = false
  let topicSearchFound = 0
  let phase2SkipGateHits = 0
  let failed = 0
  const errors: string[] = []
  const topicTotalCounted = new Set<string>()
  // Drop trailing pages once a topic returns < 30 repos (pre-parallel behavior).
  const topicShortPage = new Map<string, number>()
  pageResults.sort((a, b) => a.topic.localeCompare(b.topic) || a.page - b.page)
  for (const pr of pageResults) {
    if (reachedLimit) break
    const earlyStopAt = topicShortPage.get(pr.topic)
    if (earlyStopAt !== undefined && pr.page > earlyStopAt) continue
    if (pr.error) {
      errors.push(`[${pr.topic}] ${pr.error}`)
      failed++
      topicShortPage.set(pr.topic, pr.page - 1)
      continue
    }
    if (!topicTotalCounted.has(pr.topic)) {
      topicSearchFound += pr.total
      topicTotalCounted.add(pr.topic)
    }
    for (const repo of pr.repos) {
      if (topicRepoCount >= maxTopicRepos) {
        console.log(`Reached topic search limit (${maxTopicRepos}), stopping collection`)
        reachedLimit = true
        break
      }
      if (!seenUrls.has(repo.url)) {
        seenUrls.add(repo.url)
        // SMI-4854: Skip-gate.
        const cachedKey = existingRepoUpdatedAt.get(repo.url)
        if (cachedKey != null && cachedKey === repoUpdatedAtKey(repo)) {
          phase2SkipGateHits++
          repositories.push(repo)
          topicRepoCount++
          continue
        }
        repo.installable = await checkSkillMdExists(
          repo.owner,
          repo.name,
          repo.defaultBranch,
          validationCache,
          telemetry,
          undefined,
          validationOptions
        )
        repositories.push(repo)
        topicRepoCount++
      }
    }
    if (pr.repos.length < 30) {
      topicShortPage.set(pr.topic, pr.page)
    }
  }

  return { topicSearchFound, topicRepoCount, phase2SkipGateHits, errors, failed }
}
