/**
 * Shared UI utilities for the skills directory pages.
 *
 * Extracts the UI helpers that were previously duplicated across
 * `skills/index.astro` and `skills/[id].astro` as `is:inline` script blocks:
 *   - `TIER_THRESHOLDS`      — star-count thresholds (re-exported from quality-tiers)
 *   - `getQualityTier()`     — maps a star count to a tier label and color class (re-exported)
 *   - `escapeHtml()`         — sanitises untrusted strings before DOM injection
 *   - `formatNumber()`       — locale-friendly number formatting
 *
 * Trust-tier badge classes are NOT here — they live in the canonical
 * `constants/trust-tier-badges.ts` (SMI-5217 single source of truth, pinned by a
 * parity test). `skill-card.ts` imports them directly.
 *
 * Imported by the bundler-visible `<script>` blocks in the skills pages;
 * must not import anything that requires a server/Node runtime.
 */

export { getQualityTier, TIER_THRESHOLDS } from '../utils/quality-tiers.js'
export type { QualityTier } from '../utils/quality-tiers.js'

export function escapeHtml(str: string | undefined): string {
  if (!str) return ''
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

export function formatNumber(num: number): string {
  return new Intl.NumberFormat().format(num)
}
