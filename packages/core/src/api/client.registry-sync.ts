/**
 * @fileoverview Registry-sync endpoint builder.
 * @module @skillsmith/core/api/client.registry-sync
 * @see supabase/functions/registry-sync/index.ts (Team/Enterprise bulk-sync transport this calls)
 * @see client.health.ts / client.private-registry.ts — the existing
 *   companion-module convention used to keep client.ts under the 500-line
 *   standard.
 *
 * Pure endpoint-string builder extracted from client.ts. Unlike
 * client.private-registry.ts's `getPrivateRegistrySkillContent()`, this does
 * NOT reimplement fetch/retry/auth — `SkillsmithApiClient.syncRegistry()`
 * still calls the class's own private `request()` (which already owns
 * retry-on-5xx/429, auth-header selection, and schema validation); this file
 * only builds the query string so that logic doesn't have to live inline in
 * client.ts.
 *
 * Reuse-vs-new-schema note: registry-sync's row shape (id, name,
 * description, author, repo_url, quality_score, trust_tier, tags,
 * quarantined, created_at, updated_at) is already a fully optional/nullable
 * subset of `ApiSearchResultSchema`'s fields (see schemas.ts) — Zod's
 * default "strip unknown keys" object mode passes every one of these
 * through unchanged, so `SearchResponseSchema` is reused as-is for
 * `syncRegistry()`'s response validation rather than declaring a new schema.
 */

import type { RegistrySyncOptions } from './client.types.js'

/** Build the `/registry-sync` endpoint path + query string. */
export function buildRegistrySyncEndpoint(options: RegistrySyncOptions): string {
  const params = new URLSearchParams()
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.offset !== undefined) params.set('offset', String(options.offset))
  if (options.since !== undefined) params.set('since', options.since)
  return `/registry-sync?${params.toString()}`
}
