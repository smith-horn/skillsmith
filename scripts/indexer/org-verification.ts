/**
 * GitHub vendor-org verification helper (Node port)
 * @module scripts/indexer/org-verification
 *
 * SMI-4852: Node-flavored sibling of `supabase/functions/indexer/org-verification.ts`.
 * Routes every GitHub fetch through `withRateLimitTracking` (Hard Rule 1, retro
 * 2026-05-10) and threads a `RateLimitTelemetry` argument across the public
 * signatures so the run-level telemetry accumulator captures both prefetch and
 * single-owner lookup calls. The 1-second `AbortSignal.timeout` budget is
 * preserved exactly (SMI-4797). Parity with the Deno parent is guarded by
 * `scripts/indexer/tests/parity.test.ts`.
 *
 * SMI-4651: Promote skills authored by GitHub-verified vendor orgs (Stripe,
 * Notion, Atlassian, Figma, Canva, Zapier, Cloudflare, etc.) to the `curated`
 * trust tier without requiring an entry in `HIGH_TRUST_AUTHORS`.
 *
 * Reads `is_verified` from `GET /orgs/{org}`. Per-run cache is keyed by the
 * lowercased owner so `Zapier` and `zapier` collapse to one network call.
 *
 * Failure semantics (S6 in the plan):
 *  - 404 (owner is a user, not an org) → cache `false` and return `false`
 *  - 5xx / non-ok → return `false`, do NOT cache (transient retry-friendly)
 *  - thrown error → return `false`, do NOT cache
 *  - missing Authorization header (mock-mode / no PAT) → return `false`, no fetch
 */

import { withRateLimitTracking, type RateLimitTelemetry } from './_shared/rate-limit.ts'

/** Per-run cache of `lowercased owner -> is_verified` results (positives + true 404s). */
export type OrgVerifiedCache = Map<string, boolean>

/**
 * Concurrency cap for parallel org-verification prefetch (SMI-4736).
 * Raised from 10 → 25 (SMI-4760) → 50 (SMI-4797):
 * Slot-12 (`claude-skill`, `claude-skills`) discovers ~465 repos from individual
 * skill publishers — nearly all have unique owners, so ~450 unique owners need
 * verification. At concurrency=25 and 1s timeout: ceil(450/25)=18 batches × 1s
 * = 18s worst case, leaving only ~3s headroom before the 150s IDLE_TIMEOUT.
 * At concurrency=50 and 1s timeout: ceil(450/50)=9 batches × 1s = 9s worst
 * case — matches slot-6's observed headroom margin.
 */
export const ORG_PREFETCH_CONCURRENCY = 50

/**
 * Per-request fetch timeout for org-verification calls (SMI-4743, SMI-4760, SMI-4797).
 * Reduced from 8s → 2s (SMI-4760) → 1s (SMI-4797): GitHub orgs API responds
 * in <200ms under normal conditions; 1s is still 5× the typical latency and
 * sufficient even under degraded conditions. Reducing from 2s was required
 * because slot-12's ~450 unique skill-publisher owners meant worst-case prefetch
 * at 2s/timeout still exceeded the 150s IDLE_TIMEOUT on slow GitHub API days.
 * AbortError falls into the transient-failure path — not cached, retry-friendly.
 */
export const ORG_FETCH_TIMEOUT_MS = 1_000

/**
 * Determine whether an owner is a GitHub-verified vendor org.
 *
 * SMI-4852: Routes the GitHub fetch through `withRateLimitTracking` and
 * threads `telemetry`. `_throwOnRateLimit: false` is set because this helper
 * already swallows transient errors (S6) — the wrapper's role here is purely
 * to record `x-ratelimit-remaining` + 403/429 counts into telemetry.
 *
 * @param owner - GitHub login of the repo owner. Cache key is lowercased.
 * @param cache - Per-run cache. Mutated in-place.
 * @param headers - GitHub headers from `buildGitHubHeaders()`. Must include
 *                  `Authorization` for any network call to be made (S7).
 * @param telemetry - Run-level rate-limit accumulator (Hard Rule 1).
 * @returns `true` only when GitHub returns `is_verified === true`. All other
 *          paths (no auth, 404, 5xx, throw, missing field) return `false`.
 */
export async function isVerifiedGitHubOrg(
  owner: string,
  cache: OrgVerifiedCache,
  headers: Record<string, string>,
  telemetry: RateLimitTelemetry
): Promise<boolean> {
  const ownerKey = owner.toLowerCase() // S4 — Zapier vs zapier collapse to one entry

  // Single Map.get instead of has-then-get + `as boolean` cast — narrowing
  // by `!== undefined` keeps strict-mode happy without a type assertion.
  const cached = cache.get(ownerKey)
  if (cached !== undefined) {
    return cached
  }

  // S7 — mock-mode / no PAT: skip the lookup entirely so local dev keeps working.
  if (!headers.Authorization) {
    return false
  }

  try {
    const res = await withRateLimitTracking(telemetry, `https://api.github.com/orgs/${ownerKey}`, {
      headers,
      signal: AbortSignal.timeout(ORG_FETCH_TIMEOUT_MS), // SMI-4743: bound per-request latency
      _throwOnRateLimit: false,
    })

    if (res.status === 404) {
      // Owner is a user, not an org. Cache the negative — it won't change within a run.
      cache.set(ownerKey, false)
      return false
    }

    if (!res.ok) {
      // S6 — transient (5xx, 403 rate-limit, etc). Do NOT cache; let the next
      // call within the same run retry. Test 8 in org-verification.test.ts
      // covers the 500-then-200 recovery path.
      console.warn(`[org-verify] lookup failed for "${ownerKey}": HTTP ${res.status} (not cached)`)
      return false
    }

    const body = (await res.json()) as { is_verified?: unknown }
    const verified = body.is_verified === true
    cache.set(ownerKey, verified)
    return verified
  } catch (err) {
    // S6 — network throw. Do NOT cache; let the next call retry.
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[org-verify] lookup threw for "${ownerKey}": ${message} (not cached)`)
    return false
  }
}

/**
 * Pre-warm the org-verified cache for a batch of owners in parallel.
 *
 * SMI-4736: Call once before the upsert loop to eliminate the ~150 sequential
 * fetch() calls that pushed Phase 4 past the 150-second IDLE_TIMEOUT. All
 * subsequent `isVerifiedGitHubOrg` calls in the loop become instant cache hits.
 *
 * SMI-4852: Threads `telemetry` so every prefetch call lands in the same
 * run-level accumulator as the lazy `isVerifiedGitHubOrg` lookups.
 *
 * Failure semantics: transient errors leave the affected owner uncached so the
 * loop can retry individually — identical to the pre-SMI-4736 degraded path.
 *
 * @param owners  - All repo owners to warm (duplicates and already-cached
 *                  entries are skipped automatically).
 * @param cache   - Per-run cache. Mutated in-place.
 * @param headers - GitHub headers from `buildGitHubHeaders()`. No-ops without
 *                  `Authorization` (S7 parity with `isVerifiedGitHubOrg`).
 * @param telemetry - Run-level rate-limit accumulator (Hard Rule 1).
 * @param concurrency - Max parallel fetches per batch. Default: `ORG_PREFETCH_CONCURRENCY`.
 */
export async function warmOrgVerifiedCache(
  owners: string[],
  cache: OrgVerifiedCache,
  headers: Record<string, string>,
  telemetry: RateLimitTelemetry,
  concurrency = ORG_PREFETCH_CONCURRENCY
): Promise<void> {
  // Deduplicate + skip already-cached (positives and 404s). 5xx misses are
  // not cached by isVerifiedGitHubOrg, so they correctly pass through here.
  const unique = [...new Set(owners.map((o) => o.toLowerCase()))].filter(
    (o) => cache.get(o) === undefined
  )
  if (unique.length === 0 || !headers.Authorization) return

  for (let i = 0; i < unique.length; i += concurrency) {
    const batch = unique.slice(i, i + concurrency)
    // allSettled: defensive for future refactors — current isVerifiedGitHubOrg
    // catches all errors internally, but allSettled ensures one unexpected throw
    // can never abort the remaining batch owners.
    await Promise.allSettled(
      batch.map((owner) => isVerifiedGitHubOrg(owner, cache, headers, telemetry))
    )
  }
}
