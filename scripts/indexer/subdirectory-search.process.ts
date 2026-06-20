/**
 * Per-skill result processor: `processSearchResults` + shared types.
 * @module scripts/indexer/subdirectory-search.process
 *
 * Extracted from `subdirectory-search.helpers.ts` to keep that module under
 * the 500-line pre-commit gate after the SMI-5319 per-dispatch skill cap was
 * added. The dependency graph is strictly one-way:
 *   subdirectory-search.ts
 *     -> subdirectory-search.helpers.ts  (re-exports everything from here)
 *       -> subdirectory-search.process.ts  (this file; no upward imports)
 *
 * NOT parity-guarded (`parity.test.ts` exempts the subdirectory surface, C-2),
 * so divergence from the Deno copy is safe and intended.
 */

import { delay, type RateLimitTelemetry } from './_shared/rate-limit.ts'
import { checkSkillMdExists } from './skill-processor.ts'
// `isPermissiveLicense` is consumed ONLY by the SMI-5319 kill-switch (the legacy
// license gate); the default path resolves license as surfaced metadata only.
import { fetchRepoLicense, isPermissiveLicense } from './license-filter.ts'
import { enumerateRepoSkillPaths, type EnumerateTelemetry } from './trees-enumerate.ts'
import { buildSkillTreeUrl } from './skill-url.ts'
import type { GitHubRepository } from './topic-search.ts'
import type { SkillMdValidation } from './skill-processor.ts'

/**
 * SMI-5319: The single shared derivation of a per-run repo cache key.
 *
 * Used as the key for BOTH the `enumeratedRepos` once-guard AND the
 * `repoMetaCache` map so the write-key (when repo metadata is resolved + cached)
 * and the read-key (when cached metadata is consumed) are provably identical -- a
 * concurrency-auditor Pattern-3 (cache key-shape mismatch, SMI-4861) invariant.
 * Centralizing it here removes the inline `${owner}/${repoName}` that previously
 * lived at two call sites.
 */
export function repoCacheKey(owner: string, repoName: string): string {
  return `${owner}/${repoName}`
}

/**
 * SMI-5319: per-run cached repo metadata resolved once via the SAME
 * `GET /repos/{owner}/{repo}` call (`fetchRepoLicense`). The code-search API does
 * not return `default_branch`, so the REAL branch from this metadata -- not
 * `repo.defaultBranch` (null) -- drives both the Trees enumeration and the emitted
 * skill tree URL. A `defaultBranch` of null means the repo cannot be enumerated
 * this run (fetch failed or the field was absent) and must be skipped.
 */
export interface RepoMeta {
  /** Resolved SPDX license id (surfaced metadata), or null. */
  license: string | null
  /** Resolved default branch, or null when it could not be resolved. */
  defaultBranch: string | null
}

/**
 * Mutable per-run counters accumulated across every `processSearchResults` call.
 * Shared by the broad/fallback loop and the backfill crawl so the shape stays in
 * lock-step at all three threading sites.
 */
export interface SubdirSearchStats {
  /** Repos dropped by the legacy kill-switch license gate (~0 by default). */
  licenseFiltered: number
  /** Metadata-fetch failures (rate-limit / network, after retries). */
  licenseFetchFailed: number
  /** Skills admitted (indexed) this run. */
  admitted: number
  /** Admitted skills whose resolved SPDX is null. */
  licenseNull: number
  /**
   * SMI-5319: repos skipped because no default branch could be resolved (the
   * code-search API omits `default_branch` and the `GET /repos` fallback failed
   * or returned no branch). Skipped repos are retried on the next run.
   */
  noDefaultBranch: number
}

/**
 * Process code search results: deduplicate, validate, resolve license, and collect repos.
 * Shared by both broad and fallback search paths.
 *
 * SMI-5319: the license ADMISSION gate has been removed. The indexer now indexes
 * ALL valid skills regardless of license and records the resolved SPDX id as
 * surfaced metadata (the consumer decides). The ONLY admission filter is the
 * existing strict validity path (`enumerateRepoSkillPaths` +
 * `checkSkillMdExists`). Repo metadata (license + default branch) is resolved
 * once-per-repo, AFTER the `enumeratedRepos` once-guard but BEFORE the Trees
 * enumeration, cached in `repoMetaCache` keyed by {@link repoCacheKey} (the same
 * derivation as the once-guard, so write-key === read-key). A license-fetch
 * failure records `license: null` and never drops a skill. A kill-switch
 * (`SKILLSMITH_INDEXER_LICENSE_GATE === 'true'`) restores the legacy
 * exclude-non-permissive behavior without a deploy.
 *
 * SMI-5319 (Trees default-branch fix): the code-search API does NOT return
 * `default_branch`, so `repo.defaultBranch` is null. The REAL branch comes from
 * the same `GET /repos` metadata call and is passed to `enumerateRepoSkillPaths`
 * AND `buildSkillTreeUrl`. A repo whose default branch cannot be resolved is
 * skipped (NOT enumerated with a null branch, which 404s every Trees call) and
 * retried on the next run.
 *
 * SMI-4852: Threads `telemetry` to downstream `fetchRepoLicense` and
 * `checkSkillMdExists` calls so every GitHub API hit lands in the shared
 * collector.
 *
 * SMI-5286 Wave 1a (sec#1, C-1): per-skill (collection) extraction. Each candidate
 * repo is enumerated ONCE via the Trees API (`enumerateRepoSkillPaths`) and EVERY
 * valid SKILL.md parent dir becomes its own `GitHubRepository`, with a DISTINCT
 * per-skill tree URL (`buildSkillTreeUrl`) so N skills in one repo yield N distinct
 * `repo_url` rows that never collide on `onConflict: 'repo_url'`. Each per-path row
 * is validated independently (sec#4 strict gate) before it is collected; validated
 * rows are `installable:true` (`skill-processor.ts:440` then persists the non-null
 * tree URL).
 */
export async function processSearchResults(
  resultRepos: GitHubRepository[],
  seenUrls: Set<string>,
  validationCache: Map<string, SkillMdValidation>,
  validationOptions: { strictValidation?: boolean; minContentLength?: number },
  repos: GitHubRepository[],
  stats: SubdirSearchStats,
  telemetry: RateLimitTelemetry,
  enumerateTelemetry: EnumerateTelemetry,
  enumeratedRepos: Set<string>,
  repoMetaCache: Map<string, RepoMeta>
): Promise<void> {
  // SMI-5319 kill-switch: when set to the literal string 'true', restore the
  // legacy pre-validity license ADMISSION gate (exclude non-permissive repos)
  // so ops can re-enable the old behavior without a deploy. Default (unset /
  // anything else) = OFF = the new no-gate behavior.
  const legacyLicenseGate = process.env.SKILLSMITH_INDEXER_LICENSE_GATE === 'true'

  for (const repo of resultRepos) {
    // Deduplication key includes skillPath: one repo can have multiple skills
    const dedupKey = repo.skillPath ? `${repo.url}/${repo.skillPath}` : repo.url
    if (seenUrls.has(dedupKey)) continue

    // SMI-5319: keyed via the shared `repoCacheKey` derivation so the once-guard
    // key (enumeratedRepos) and the repoMetaCache key are provably identical
    // (concurrency-auditor Pattern-3 invariant).
    const repoKey = repoCacheKey(repo.owner, repo.repoName)

    // SMI-5319 kill-switch (legacy path only): the OLD pre-validity admission gate.
    // Fetch repo metadata from the GitHub API and drop the repo if it could not be
    // fetched (retry next run) or the license is confirmed non-permissive. Disabled
    // by default -- the new behavior resolves metadata once-per-repo AFTER the
    // once-guard and never drops a skill. When the gate admits a repo, the
    // just-fetched metadata is seeded into `repoMetaCache` so the post-once-guard
    // resolution below reuses it (no second fetch there). NOTE: this break-glass
    // loop runs before the `enumeratedRepos` once-guard, so a repo surfacing via
    // multiple skillPaths is re-fetched here per hit -- acceptable on the
    // default-off legacy path.
    if (legacyLicenseGate) {
      const {
        license: spdxId,
        defaultBranch,
        fetchFailed,
      } = await fetchRepoLicense(repo.owner, repo.repoName, telemetry)

      if (fetchFailed) {
        // API failure -- skip this run but don't count as license-filtered.
        // NOT added to seenUrls so the repo is retried on the next indexer run.
        console.log(`[BroadDiscovery] License fetch failed (will retry next run): ${repo.fullName}`)
        stats.licenseFetchFailed++
        await delay(200)
        continue
      }

      if (!isPermissiveLicense(spdxId)) {
        // Confirmed non-permissive license -- permanently excluded.
        console.log(`[BroadDiscovery] License excluded: ${repo.fullName} spdx=${spdxId ?? 'null'}`)
        stats.licenseFiltered++
        await delay(200)
        continue
      }

      // Admitted by the legacy gate: reuse this metadata for the resolution below.
      if (!repoMetaCache.has(repoKey)) {
        repoMetaCache.set(repoKey, { license: spdxId, defaultBranch })
      }
    }

    // Mark this code-search result consumed (per-repo+skillPath identity) so the
    // same surfaced file is not re-processed across pages/prefixes.
    seenUrls.add(dedupKey)

    // SMI-5286 Wave 1a (sec#1): enumerate the repo's full tree ONCE. The broad query
    // can surface the same repo via multiple SKILL.md hits; guard re-enumeration.
    if (enumeratedRepos.has(repoKey)) {
      await delay(50)
      continue
    }
    enumeratedRepos.add(repoKey)

    // SMI-5319: resolve repo metadata (license + default branch) ONCE per repo,
    // AFTER the once-guard but BEFORE enumeration, cached on `repoKey` (the SAME
    // key as the once-guard above, so write-key === read-key). The code-search API
    // does NOT return `default_branch` (`repo.defaultBranch` is null), so the REAL
    // branch comes from this `GET /repos` call. A metadata-fetch failure records
    // `license: null` + `defaultBranch: null`. The repo is enumerated once per run,
    // so a cache miss here means exactly one fetch.
    let meta: RepoMeta
    if (repoMetaCache.has(repoKey)) {
      meta = repoMetaCache.get(repoKey) ?? { license: null, defaultBranch: null }
    } else {
      const { license, defaultBranch, fetchFailed } = await fetchRepoLicense(
        repo.owner,
        repo.repoName,
        telemetry
      )
      // Ignore fetchFailed for license: record null and proceed (never drop, never
      // retry-storm). A failed fetch also leaves `defaultBranch` null -> the repo is
      // skipped below and retried next run.
      meta = { license: fetchFailed ? null : license, defaultBranch }
      if (fetchFailed) stats.licenseFetchFailed++
      repoMetaCache.set(repoKey, meta)
    }
    const spdx = meta.license
    const branch = meta.defaultBranch
    if (spdx === null) stats.licenseNull++

    // SMI-5319: without a resolvable default branch we CANNOT enumerate the repo
    // (`GET /git/trees/null` -> 404 for every path) and MUST NOT emit a row with a
    // null branch. Skip. Retry happens on the NEXT indexer run: `seenUrls` and
    // `enumeratedRepos` are run-scoped (allocated fresh per `runSubdirectorySearch`),
    // so a later run with a resolvable branch re-discovers and re-enumerates this
    // repo. (Within THIS run it is not retried -- the `enumeratedRepos` once-guard
    // already holds `repoKey`, and this hit's `dedupKey` is already in `seenUrls`.)
    if (branch === null) {
      console.log(`[BroadDiscovery] No default branch, skipping (retry next run): ${repo.fullName}`)
      stats.noDefaultBranch++
      await delay(50)
      continue
    }

    const { entries, truncatedByApi, truncatedByCap } = await enumerateRepoSkillPaths(
      repo.owner,
      repo.repoName,
      branch,
      telemetry,
      enumerateTelemetry
    )

    if (truncatedByApi) {
      // Trees API truncated -- do NOT emit a partial set (deterministic skip).
      console.log(
        `[BroadDiscovery] Trees truncated, skipping for manual handling: ${repo.fullName}`
      )
      await delay(50)
      continue
    }
    if (truncatedByCap) {
      console.log(`[BroadDiscovery] Per-repo cap reached, taking first N: ${repo.fullName}`)
    }

    // Validate each enumerated SKILL.md independently (sec#4 strict gate) and emit
    // one per-skill GitHubRepository with a distinct tree URL (C-1) per valid path.
    for (const entry of entries) {
      const skillPath = entry.path
      const installable = await checkSkillMdExists(
        repo.owner,
        repo.repoName,
        branch,
        validationCache,
        telemetry,
        skillPath,
        validationOptions
      )

      // C-1: build the per-skill tree URL from the BARE repo html_url
      // (reconstructed from owner/repoName), NOT from `repo.url` -- by this point
      // `repo.url` is already the code-search mapper's tree URL, so reusing it
      // would double the `/tree/<branch>` segment. `skillUrl` already encodes
      // `skillPath`, so it alone is the dedup key. SMI-5319: built with the FETCHED
      // `branch` (not `repo.defaultBranch`, which is null from code search).
      const skillUrl = buildSkillTreeUrl(
        `https://github.com/${repo.owner}/${repo.repoName}`,
        branch,
        skillPath
      )
      if (seenUrls.has(skillUrl)) continue
      seenUrls.add(skillUrl)

      // SMI-5319: emit with the cached license as surfaced metadata (possibly
      // null). Admission was already governed by the strict validity gate above.
      repos.push({
        ...repo,
        url: skillUrl,
        installable,
        skillPath,
        treeHash: entry.blobSha,
        license: spdx,
      })
      stats.admitted++
      await delay(50)
    }
  }
}
