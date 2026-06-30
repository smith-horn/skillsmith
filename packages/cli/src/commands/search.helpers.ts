/**
 * @fileoverview Helpers for the `search` command.
 *
 * SMI-5427: remote-default search. autoSyncIfEmpty (SMI-4917 Bug-3) is removed
 * because the CLI now routes searches through the remote skills-search edge fn
 * first; local DB is a fallback, not a primary store. An empty local DB is
 * therefore NORMAL for fresh installs — no auto-sync is triggered.
 *
 * The only remaining local helpers are:
 *   isLocalIndexEmpty — used to distinguish "true empty index" from "no match"
 *     in the offline-fallback path.
 *   formatEmptyIndexHint — shown when remote is unavailable AND local is empty.
 *   searchRemoteOrLocal — remote-first search with typed error outcomes.
 */
import chalk from 'chalk'
import {
  SkillRepository,
  SearchService,
  SkillsmithApiClient,
  ApiClientError,
  SkillsmithError,
  ErrorCodes,
  createApiClient,
  loadStoredAccessToken,
  type SearchOptions,
  type SearchResult,
  type DatabaseType,
} from '@skillsmith/core'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome of searchRemoteOrLocal — typed to let callers branch cleanly. */
export type SearchOutcome =
  | {
      kind: 'results'
      items: SearchResult[]
      hasMore: boolean
      /** Approximate total for display; exact for local, estimated for remote. */
      totalHint: number
    }
  | { kind: 'quota'; message: string }
  | { kind: 'auth' }
  /** Remote unavailable AND local DB is empty — genuine nothing to show. */
  | { kind: 'empty' }

// ---------------------------------------------------------------------------
// Remote-first search
// ---------------------------------------------------------------------------

/**
 * Try the remote skills-search edge fn; fall back to local only on network
 * errors when the local index has rows.
 *
 * Error classification:
 *   QUOTA (SkillsmithError NETWORK_QUOTA_EXCEEDED): returned as kind:'quota' —
 *     the caller must surface the message; no silent fallback.
 *   AUTH (ApiClientError 401/403): returned as kind:'auth' — caller prompts
 *     `skillsmith login`; no fallback.
 *   NETWORK (TypeError / ENOTFOUND / ECONNREFUSED / AbortError): fall back to
 *     local if count()>0; otherwise kind:'empty'.
 *   Unknown errors: re-thrown.
 */
export async function searchRemoteOrLocal(
  searchOptions: SearchOptions,
  db: DatabaseType
): Promise<SearchOutcome> {
  // Try remote first.
  try {
    const jwtToken = await loadStoredAccessToken()
    const apiClient = createApiClient(jwtToken ? { jwtToken } : {})
    if (!apiClient.isOffline()) {
      const response = await apiClient.search(searchOptions)
      const items: SearchResult[] = response.data.map((r, i) => ({
        skill: SkillsmithApiClient.toSkill(r),
        rank: i,
        highlights: {},
      }))
      const limit = searchOptions.limit ?? 10
      const offset = searchOptions.offset ?? 0
      const hasMore = items.length >= limit
      // Conservative total estimate: don't claim to know the full count.
      const totalHint = offset + items.length + (hasMore ? 1 : 0)
      return { kind: 'results', items, hasMore, totalHint }
    }
  } catch (error) {
    if (error instanceof SkillsmithError && error.code === ErrorCodes.NETWORK_QUOTA_EXCEEDED) {
      return { kind: 'quota', message: error.message }
    }
    if (error instanceof ApiClientError && (error.statusCode === 401 || error.statusCode === 403)) {
      return { kind: 'auth' }
    }
    if (!isNetworkError(error)) {
      throw error
    }
    // Network error: fall through to local fallback.
  }

  // Local fallback — only viable when the index has rows.
  if (new SkillRepository(db).count() === 0) {
    return { kind: 'empty' }
  }
  const local = new SearchService(db).search(searchOptions)
  return {
    kind: 'results',
    items: local.items,
    hasMore: local.hasMore,
    totalHint: local.total,
  }
}

// ---------------------------------------------------------------------------
// Local index state
// ---------------------------------------------------------------------------

/**
 * Whether the local `skills` table has no rows.
 *
 * SMI-4926: a 0-result search against an empty index is meaningfully different
 * from a genuine no-match — the registry has not been synced locally yet.
 */
export function isLocalIndexEmpty(db: DatabaseType): boolean {
  return new SkillRepository(db).count() === 0
}

/**
 * Build an offline-aware hint when both remote and local are unavailable.
 *
 * SMI-5427: with remote-default search, an empty local DB is normal.
 * This hint is only shown when the remote is also unreachable (offline
 * fallback triggered, local count=0). It does NOT push `skillsmith sync`
 * because sync requires connectivity too.
 *
 * Carries leading/trailing newlines to match displayResults padding.
 */
export function formatEmptyIndexHint(): string {
  return chalk.yellow(
    '\nℹ Skillsmith is offline and your local skill index is empty. Check your connection and try again.\n'
  )
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true
  if (error instanceof Error) {
    return /ENOTFOUND|ECONNREFUSED|AbortError|ETIMEDOUT|ENETUNREACH/.test(error.message)
  }
  return false
}
