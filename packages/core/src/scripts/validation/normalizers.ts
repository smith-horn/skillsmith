/**
 * SMI-863: Normalization utilities for skill validation
 */

import { createHash } from 'crypto'
import { TrustTier } from './types.js'

/**
 * Extract owner from repo URL
 */
export function extractOwnerFromRepoUrl(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null

  try {
    const url = new URL(repoUrl)
    const parts = url.pathname.split('/').filter(Boolean)
    return parts[0] || null
  } catch {
    return null
  }
}

/**
 * Generate skill ID from author and name
 */
export function generateSkillId(author: string, name: string): string {
  const sanitize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
  return `${sanitize(author)}/${sanitize(name)}`
}

/**
 * Normalize quality score to 0-100 range
 */
export function normalizeQualityScore(score: number | null | undefined): number {
  if (score === null || score === undefined) return 50 // Default score

  // If score is 0-1, convert to 0-100
  if (score >= 0 && score <= 1) {
    return Math.round(score * 100)
  }

  // Clamp to 0-100
  return Math.max(0, Math.min(100, Math.round(score)))
}

/**
 * Normalize trust tier to valid enum value
 */
export function normalizeTrustTier(tier: string | null | undefined): TrustTier {
  if (!tier) return 'unknown'

  const normalized = tier.toLowerCase().trim()

  // Map common variations
  const mappings: Record<string, TrustTier> = {
    verified: 'verified',
    official: 'verified',
    'anthropic-official': 'verified',
    community: 'community',
    experimental: 'experimental',
    beta: 'experimental',
    unknown: 'unknown',
    unverified: 'unknown',
    standard: 'community',
  }

  return mappings[normalized] || 'unknown'
}

/**
 * Normalize source name
 */
export function normalizeSource(source: string | null | undefined): string {
  if (!source) return 'unknown'
  return source.toLowerCase().trim()
}

/**
 * Generate hash for repo URL deduplication
 */
export function hashRepoUrl(repoUrl: string): string {
  return createHash('md5').update(repoUrl.toLowerCase().trim()).digest('hex')
}
