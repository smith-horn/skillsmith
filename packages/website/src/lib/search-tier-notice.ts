/**
 * Friendly copy for a search the registry declines by design (SMI-7246).
 *
 * Since SMI-7236, `skills-search` answers a query combined with a tier that
 * full-text search does not cover (today: `unverified`) with HTTP 400 and
 * `details.reason = "tier_not_searchable"`. That is an owner decision, not a
 * failure, so the page explains it instead of showing a generic error.
 *
 * The decision is read from the server's reason, never re-derived from the
 * tier name here, so the website cannot drift from the edge's rule.
 */

export const TIER_NOT_SEARCHABLE_REASON = 'tier_not_searchable'

export interface SearchTierNotice {
  heading: string
  message: string
}

/**
 * Returns the notice to show when `status` and the parsed response `body`
 * describe a tier the registry does not full-text search; otherwise null.
 */
export function tierNotSearchableNotice(status: number, body: unknown): SearchTierNotice | null {
  if (status !== 400 || typeof body !== 'object' || body === null) return null
  const details = (body as { details?: unknown }).details
  if (typeof details !== 'object' || details === null) return null
  if ((details as { reason?: unknown }).reason !== TIER_NOT_SEARCHABLE_REASON) return null
  return {
    heading: 'Unverified skills are browse-only',
    message:
      'Text search covers official, verified, curated and community skills. ' +
      'To see unverified skills, clear the search box and browse with the Unverified filter.',
  }
}
