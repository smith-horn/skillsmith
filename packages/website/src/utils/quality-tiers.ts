/**
 * Quality tier configuration based on GitHub star count.
 *
 * This module provides a single source of truth for quality tier logic
 * used across the skills listing and detail pages.
 */

export interface QualityTier {
  /** Minimum star count for this tier (inclusive) */
  minStars: number
  /** Tailwind CSS color class */
  color: string
  /** Human-readable tier label */
  label: string
  /** Description for accessibility and documentation */
  description: string
}

/**
 * Star count thresholds for quality tiers.
 * Used for consistency across UI and tests.
 */
export const TIER_THRESHOLDS = {
  ELITE: 10000,
  HIGH_QUALITY: 500,
  GROWING: 50,
} as const

/**
 * Quality tiers ordered from highest to lowest.
 * The first matching tier (stars >= minStars) is returned.
 */
export const QUALITY_TIERS: readonly QualityTier[] = [
  {
    minStars: TIER_THRESHOLDS.ELITE,
    color: 'text-blue-400',
    label: 'Elite',
    description: '10,000+ stars',
  },
  {
    minStars: TIER_THRESHOLDS.HIGH_QUALITY,
    color: 'text-green-400',
    label: 'High Quality',
    description: '500-9,999 stars',
  },
  {
    minStars: TIER_THRESHOLDS.GROWING,
    color: 'text-yellow-400',
    label: 'Growing',
    description: '50-499 stars',
  },
  {
    minStars: 0,
    color: 'text-red-400',
    label: 'New',
    description: 'Under 50 stars',
  },
] as const

/**
 * Get the quality tier for a given star count.
 *
 * @param stars - GitHub star count (defaults to 0 if null/undefined)
 * @returns The matching QualityTier object
 *
 * @example
 * ```ts
 * const tier = getQualityTier(15000);
 * // { minStars: 10000, color: 'text-blue-400', label: 'Elite', ... }
 * ```
 */
export function getQualityTier(stars: number | null | undefined): QualityTier {
  const starCount = stars ?? 0
  return (
    QUALITY_TIERS.find((tier) => starCount >= tier.minStars) ??
    QUALITY_TIERS[QUALITY_TIERS.length - 1]
  )
}

/**
 * Format a number with locale-aware formatting.
 *
 * @param num - Number to format
 * @returns Formatted string (e.g., "10,000")
 */
export function formatStarCount(num: number | null | undefined): string {
  return new Intl.NumberFormat().format(num ?? 0)
}

/**
 * Get accessibility attributes for a quality indicator.
 *
 * @param tier - The quality tier
 * @param stars - The star count
 * @returns Object with aria-label and title attributes
 */
export function getAccessibilityAttrs(
  tier: QualityTier,
  stars: number | null | undefined
): {
  'aria-label': string
  title: string
  role: string
} {
  const starCount = formatStarCount(stars)
  return {
    'aria-label': `${tier.label}: ${starCount} stars`,
    title: `${tier.label}: ${starCount} stars`,
    role: 'img',
  }
}
