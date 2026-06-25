/** Shared browser/SSR-safe helpers for the skills pages (SMI-5366). */
export { getQualityTier, TIER_THRESHOLDS } from '../utils/quality-tiers.js'
export type { QualityTier } from '../utils/quality-tiers.js'

/**
 * Pure-string HTML escaping — SSR-safe and node-testable (no `document`).
 * Escapes quotes too (the old DOM-based version did not), which is correct for
 * the aria-label / title attribute contexts the card interpolates into.
 */
export function escapeHtml(str: string | null | undefined): string {
  if (!str) return ''
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Locale-aware number formatting; null/undefined coerces to 0. */
export function formatNumber(num: number | null | undefined): string {
  return new Intl.NumberFormat().format(num ?? 0)
}
