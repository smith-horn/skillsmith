/**
 * License detection and filtering for cross-ecosystem skill indexing (Node port)
 * @module scripts/indexer/license-filter
 *
 * SMI-4852: Node-flavored sibling of `supabase/functions/indexer/license-filter.ts`.
 * Routes the GitHub repo fetch through `withRateLimitTracking` (Hard Rule 1,
 * retro 2026-05-10) and threads `headers` + `RateLimitTelemetry` so the run-level
 * accumulator captures every license-resolution call. The retry loop preserves
 * exact backoff timings from the Deno parent. Parity is guarded by
 * `scripts/indexer/tests/parity.test.ts`.
 *
 * SMI-2658: Determines whether a GitHub repository's license allows indexing.
 * Permissive open-source licenses (MIT, Apache-2.0, etc.) are accepted.
 * Strong copyleft (GPL, AGPL) and source-available licenses are excluded.
 * Weak copyleft (LGPL, MPL, EUPL) is included — indexing does not modify
 * the licensed work, so copyleft obligations do not apply.
 *
 * High-trust authors bypass license checks entirely — their licenses are
 * pre-audited and documented in high-trust-authors.ts.
 */

import { validateGitHubParams, sanitizeForLog } from './_shared/validation.ts'
import { buildGitHubHeaders } from './_shared/github-auth.ts'
import { delay, withRateLimitTracking, type RateLimitTelemetry } from './_shared/rate-limit.ts'

/**
 * SPDX identifiers for open-source licenses that allow indexing.
 * Excludes strong copyleft (GPL-2.0, GPL-3.0, AGPL-3.0) and source-available
 * licenses (SSPL, BSL, Elastic). Includes weak/library copyleft (LGPL, MPL,
 * EUPL) since indexing does not constitute modification of the licensed work.
 */
export const PERMISSIVE_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSD-4-Clause',
  'MPL-2.0',
  'LGPL-2.1',
  'LGPL-3.0',
  'EUPL-1.2',
  'Artistic-2.0',
  '0BSD',
  'Unlicense', // Explicitly public domain — allowed
])

/**
 * Returns true if the SPDX identifier is an accepted open-source license.
 * Returns false for null, undefined, NOASSERTION, OTHER, proprietary, or
 * any identifier not in the allowlist.
 *
 * @param spdxId - SPDX license identifier from GitHub API (e.g. 'MIT', 'Apache-2.0')
 */
export function isPermissiveLicense(spdxId: string | null | undefined): boolean {
  if (!spdxId) return false
  // GitHub returns 'NOASSERTION' when the license is present but unrecognised,
  // and 'OTHER' for non-SPDX custom licenses — both are excluded.
  if (spdxId === 'NOASSERTION' || spdxId === 'OTHER') return false
  return PERMISSIVE_LICENSES.has(spdxId)
}

/**
 * Result of a license fetch operation.
 * Distinguishes between a confirmed non-permissive license and a fetch failure,
 * which produce different outcomes in the caller (licenseFiltered vs licenseFetchFailed).
 */
export interface FetchLicenseResult {
  /** SPDX license identifier, or null if the repo has no detected license. */
  license: string | null
  /**
   * True when the license could not be fetched due to a rate limit or network
   * error (after retries). The repo is excluded from this run but should not
   * be counted as license-filtered — it may succeed on the next indexer run.
   */
  fetchFailed: boolean
}

/**
 * GitHub repository license response shape
 */
interface RepoLicenseResponse {
  license: {
    spdx_id: string
  } | null
}

/** Retry delays for exponential backoff on rate-limit responses (ms) */
const LICENSE_RETRY_DELAYS = [1000, 2000, 4000]

/**
 * Fetch the SPDX license identifier for a GitHub repository.
 *
 * Used for code search results which do not include license data in the
 * search response. Topic search results include license in the GitHub Search
 * API response and do not need this function.
 *
 * Returns `{ license: null, fetchFailed: false }` for repos with no license.
 * Returns `{ license: null, fetchFailed: true }` for rate-limit/network errors.
 *
 * SMI-4852: Builds headers internally (matching Deno parent), threads
 * `telemetry`, routes through `withRateLimitTracking` (Hard Rule 1).
 * `_throwOnRateLimit: false` because this helper has its own retry loop
 * that mirrors the Deno parent's behavior — the wrapper's role here is
 * purely to record telemetry, not to drive retry.
 *
 * @param owner - Repository owner (GitHub login)
 * @param repo - Repository name
 * @param telemetry - Run-level rate-limit accumulator
 */
export async function fetchRepoLicense(
  owner: string,
  repo: string,
  telemetry: RateLimitTelemetry
): Promise<FetchLicenseResult> {
  const headers = await buildGitHubHeaders()
  try {
    // SMI-2271: Validate before URL construction
    validateGitHubParams(owner, repo)
  } catch {
    console.log(`[LicenseFilter] Skipping invalid repo: ${sanitizeForLog(`${owner}/${repo}`)}`)
    return { license: null, fetchFailed: false }
  }

  const url = `https://api.github.com/repos/${owner}/${repo}`

  for (let attempt = 0; attempt <= LICENSE_RETRY_DELAYS.length; attempt++) {
    try {
      const response = await withRateLimitTracking(telemetry, url, {
        headers,
        _throwOnRateLimit: false,
      })

      if (response.ok) {
        const data = (await response.json()) as RepoLicenseResponse
        return { license: data.license?.spdx_id ?? null, fetchFailed: false }
      }

      // Rate limit — retry with backoff
      if (response.status === 403 || response.status === 429) {
        if (attempt < LICENSE_RETRY_DELAYS.length) {
          const delayMs = LICENSE_RETRY_DELAYS[attempt]
          console.log(
            `[LicenseFilter] Rate limited for ${sanitizeForLog(`${owner}/${repo}`)}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${LICENSE_RETRY_DELAYS.length})`
          )
          await delay(delayMs)
          continue
        }
        const remaining = response.headers.get('X-RateLimit-Remaining')
        console.log(
          `[LicenseFilter] Rate limit exhausted for ${sanitizeForLog(`${owner}/${repo}`)}. Remaining: ${remaining}`
        )
        return { license: null, fetchFailed: true }
      }

      // Non-retryable HTTP error (404, 5xx, etc.)
      console.log(
        `[LicenseFilter] HTTP ${response.status} for ${sanitizeForLog(`${owner}/${repo}`)}`
      )
      return { license: null, fetchFailed: response.status >= 500 }
    } catch (error) {
      if (attempt < LICENSE_RETRY_DELAYS.length) {
        const delayMs = LICENSE_RETRY_DELAYS[attempt]
        console.log(
          `[LicenseFilter] Network error for ${sanitizeForLog(`${owner}/${repo}`)}, retrying in ${delayMs}ms`
        )
        await delay(delayMs)
        continue
      }
      console.log(
        `[LicenseFilter] Network error exhausted retries for ${sanitizeForLog(`${owner}/${repo}`)}: ${error instanceof Error ? error.message : 'Unknown'}`
      )
      return { license: null, fetchFailed: true }
    }
  }

  return { license: null, fetchFailed: true }
}
