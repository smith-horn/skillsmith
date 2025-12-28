/**
 * SMI-644: Cache Entry Data Structure
 * Enhanced cache entry with TTL tracking and hit count for popularity detection
 */

import type { SearchResult } from './lru.js'

/**
 * TTL tiers based on query popularity
 */
export enum TTLTier {
  /** Popular queries (>10 hits/hour): 4 hours */
  POPULAR = 4 * 60 * 60 * 1000,
  /** Standard queries: 1 hour */
  STANDARD = 60 * 60 * 1000,
  /** Rare queries (<1 hit/day): 15 minutes */
  RARE = 15 * 60 * 1000,
}

/**
 * Popularity thresholds for TTL determination
 */
export const POPULARITY_THRESHOLDS = {
  /** Hits per hour to be considered "popular" */
  POPULAR_HITS_PER_HOUR: 10,
  /** Minimum age (ms) before evaluating popularity */
  MIN_AGE_FOR_EVALUATION: 60 * 1000, // 1 minute
} as const

/**
 * Enhanced cache entry with TTL and popularity tracking
 */
export interface CacheEntry<T = SearchResult[]> {
  /** Unique cache key */
  key: string
  /** Cached data */
  data: T
  /** Total count for search results */
  totalCount: number
  /** Creation timestamp (ms) */
  createdAt: number
  /** Expiration timestamp (ms) */
  expiresAt: number
  /** Number of cache hits */
  hitCount: number
  /** Last access timestamp (ms) */
  lastAccessedAt: number
  /** Current TTL tier */
  ttlTier: TTLTier
}

/**
 * Serialized format for persistent storage
 */
export interface SerializedCacheEntry {
  key: string
  data_json: string
  total_count: number
  created_at: number
  expires_at: number
  hit_count: number
  last_accessed_at: number
  ttl_tier: number
}

/**
 * Create a new cache entry with default TTL
 */
export function createCacheEntry<T = SearchResult[]>(
  key: string,
  data: T,
  totalCount: number,
  ttlTier: TTLTier = TTLTier.STANDARD
): CacheEntry<T> {
  // Validate key to prevent injection (security: standards.md §4)
  if (!isValidCacheKey(key)) {
    throw new Error('Invalid cache key: contains disallowed characters')
  }

  const now = Date.now()
  return {
    key,
    data,
    totalCount,
    createdAt: now,
    expiresAt: now + ttlTier,
    hitCount: 0,
    lastAccessedAt: now,
    ttlTier,
  }
}

/**
 * Record a hit on a cache entry
 * Returns updated entry (immutable pattern)
 */
export function recordHit<T>(entry: CacheEntry<T>): CacheEntry<T> {
  const now = Date.now()
  const newHitCount = entry.hitCount + 1

  // Calculate new TTL tier based on popularity
  const newTier = calculateTTLTier(entry.createdAt, newHitCount, now)

  // If tier upgraded, extend expiration
  const newExpiresAt = newTier > entry.ttlTier ? now + newTier : entry.expiresAt

  return {
    ...entry,
    hitCount: newHitCount,
    lastAccessedAt: now,
    ttlTier: newTier,
    expiresAt: newExpiresAt,
  }
}

/**
 * Calculate TTL tier based on hit rate
 */
export function calculateTTLTier(
  createdAt: number,
  hitCount: number,
  now: number = Date.now()
): TTLTier {
  const ageMs = now - createdAt

  // Need minimum age to evaluate popularity
  if (ageMs < POPULARITY_THRESHOLDS.MIN_AGE_FOR_EVALUATION) {
    return TTLTier.STANDARD
  }

  // Calculate hits per hour
  const ageHours = ageMs / (60 * 60 * 1000)
  const hitsPerHour = hitCount / Math.max(ageHours, 1 / 60) // Min 1 minute

  if (hitsPerHour >= POPULARITY_THRESHOLDS.POPULAR_HITS_PER_HOUR) {
    return TTLTier.POPULAR
  }

  // Check for rare: less than 1 hit per day equivalent
  const hitsPerDay = hitsPerHour * 24
  if (hitsPerDay < 1 && ageHours >= 1) {
    return TTLTier.RARE
  }

  return TTLTier.STANDARD
}

/**
 * Check if cache entry is expired
 */
export function isExpired<T>(entry: CacheEntry<T>, now: number = Date.now()): boolean {
  return now >= entry.expiresAt
}

/**
 * Check if entry should be refreshed (approaching expiration)
 * Returns true if within 10% of TTL remaining
 */
export function shouldRefresh<T>(entry: CacheEntry<T>, now: number = Date.now()): boolean {
  const ttl = entry.expiresAt - entry.createdAt
  const remaining = entry.expiresAt - now
  return remaining > 0 && remaining < ttl * 0.1
}

/**
 * Validate cache key for security (standards.md §4)
 * Prevents injection attacks through cache keys
 */
export function isValidCacheKey(key: string): boolean {
  // Max key length
  if (key.length > 1024) {
    return false
  }

  // Must be non-empty string
  if (!key || typeof key !== 'string') {
    return false
  }

  // Block null bytes and control characters
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(key)) {
    return false
  }

  return true
}

/**
 * Serialize cache entry for persistence
 * Uses safe JSON serialization to prevent prototype pollution
 */
export function serializeCacheEntry<T>(entry: CacheEntry<T>): SerializedCacheEntry {
  return {
    key: entry.key,
    data_json: JSON.stringify(entry.data),
    total_count: entry.totalCount,
    created_at: entry.createdAt,
    expires_at: entry.expiresAt,
    hit_count: entry.hitCount,
    last_accessed_at: entry.lastAccessedAt,
    ttl_tier: entry.ttlTier,
  }
}

/** Pattern to detect prototype pollution attempts (standards.md §4.4) */
const PROTOTYPE_POLLUTION_PATTERN = /"(__proto__|prototype|constructor)"\s*:/i

/**
 * SMI-684: Recursively check for dangerous keys in parsed objects
 * Prevents prototype pollution bypass via unicode escapes (e.g., \u005f\u005fproto\u005f\u005f)
 * which are decoded by JSON.parse before we can detect them with regex
 */
function hasDangerousKeys(obj: unknown, depth = 0): boolean {
  // Prevent stack overflow on deeply nested objects
  if (depth > 100) return false

  // Handle null, primitives
  if (typeof obj !== 'object' || obj === null) return false

  // Handle arrays - check each element
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (hasDangerousKeys(item, depth + 1)) {
        return true
      }
    }
    return false
  }

  // Handle objects - check keys and recurse into values
  const keys = Object.keys(obj)
  for (const key of keys) {
    // Check for dangerous keys
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      return true
    }
    // Recursively check nested objects
    if (hasDangerousKeys((obj as Record<string, unknown>)[key], depth + 1)) {
      return true
    }
  }

  return false
}

/** Valid TTL tier values */
const VALID_TTL_TIERS = new Set([TTLTier.POPULAR, TTLTier.STANDARD, TTLTier.RARE])

/**
 * Deserialize cache entry from persistence
 * Validates data to prevent prototype pollution (security: standards.md §4)
 */
export function deserializeCacheEntry<T = SearchResult[]>(
  serialized: SerializedCacheEntry
): CacheEntry<T> {
  // Check for prototype pollution before parsing (standards.md §4.4)
  // This catches simple cases like {"__proto__": {}}
  if (PROTOTYPE_POLLUTION_PATTERN.test(serialized.data_json)) {
    throw new Error('Prototype pollution attempt detected in cache data')
  }

  // Parse JSON safely
  let data: T
  try {
    data = JSON.parse(serialized.data_json) as T
  } catch {
    throw new Error('Failed to deserialize cache entry data')
  }

  // SMI-684: Post-parse validation to catch unicode escape bypasses
  // e.g., {"\\u005f\\u005fproto\\u005f\\u005f": {}} becomes {"__proto__": {}} after parse
  if (hasDangerousKeys(data)) {
    throw new Error('Prototype pollution attempt detected in cache data')
  }

  // Validate all numeric fields
  if (
    typeof serialized.created_at !== 'number' ||
    typeof serialized.expires_at !== 'number' ||
    typeof serialized.hit_count !== 'number' ||
    typeof serialized.last_accessed_at !== 'number' ||
    typeof serialized.total_count !== 'number'
  ) {
    throw new Error('Invalid cache entry: numeric fields must be numbers')
  }

  // Validate TTL tier is a known value
  if (!VALID_TTL_TIERS.has(serialized.ttl_tier as TTLTier)) {
    throw new Error('Invalid cache entry: unknown TTL tier')
  }

  return {
    key: serialized.key,
    data,
    totalCount: serialized.total_count,
    createdAt: serialized.created_at,
    expiresAt: serialized.expires_at,
    hitCount: serialized.hit_count,
    lastAccessedAt: serialized.last_accessed_at,
    ttlTier: serialized.ttl_tier as TTLTier,
  }
}

/**
 * Get human-readable TTL tier name
 */
export function getTTLTierName(tier: TTLTier): string {
  switch (tier) {
    case TTLTier.POPULAR:
      return 'popular'
    case TTLTier.STANDARD:
      return 'standard'
    case TTLTier.RARE:
      return 'rare'
    default:
      return 'unknown'
  }
}
