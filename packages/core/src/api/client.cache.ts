/**
 * Client-side response cache wiring
 * @module api/client.cache
 *
 * SMI-4120: Extracted from client.ts to keep the client under the 500-line
 * audit:standards gate. Contains cache construction, the per-call option
 * type, and the `withCache` helper used by search/getSkill/recommend.
 */

import { ApiCache, type CacheConfig } from './cache.js'
import type { ApiResponse } from './client.js'

/**
 * SMI-4120: Per-call cache directive, matching `fetch` RequestInit semantics.
 * `no-store` skips both cache read and write for the call.
 */
export interface CallCacheOptions {
  cache?: 'default' | 'no-store'
}

/**
 * Cache configuration accepted by `SkillsmithApiClient`. Pass `false` to
 * disable; pass a pre-built `ApiCache` to share one across clients; pass a
 * `CacheConfig` object to customize TTLs.
 */
export type ClientCacheSetting = ApiCache | CacheConfig | false

/**
 * SMI-4120: Build the response cache honoring the env kill-switch. Returns
 * `null` when disabled so callers can branch cheaply.
 */
export function buildResponseCache(setting: ClientCacheSetting | undefined): ApiCache | null {
  if (process.env.SKILLSMITH_DISABLE_CLIENT_CACHE === '1') return null
  if (setting === false) return null
  if (setting instanceof ApiCache) return setting
  return new ApiCache(setting ?? {})
}

/**
 * SMI-4120: Run a thunk through the response cache. Stored values are the
 * same `ApiResponse` reference — callers must not mutate.
 */
export async function withResponseCache<T>(
  cache: ApiCache | null,
  endpointType: 'search' | 'getSkill' | 'recommend',
  key: string,
  noStore: boolean,
  fetcher: () => Promise<ApiResponse<T>>
): Promise<ApiResponse<T>> {
  if (!cache || noStore) return fetcher()
  const hit = cache.get<ApiResponse<T>>(key)
  if (hit) return hit
  const fresh = await fetcher()
  cache.set(key, fresh, endpointType)
  return fresh
}
