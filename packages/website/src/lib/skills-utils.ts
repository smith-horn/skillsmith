/**
 * Shared UI utilities for the skills directory pages.
 *
 * Extracts the five helpers that were previously duplicated across
 * `skills/index.astro` and `skills/[id].astro` as `is:inline` script blocks:
 *   - `TRUST_BADGE_CLASSES`  — Tailwind class strings keyed by trust tier
 *   - `TIER_THRESHOLDS`      — star-count thresholds (re-exported from quality-tiers)
 *   - `getQualityTier()`     — maps a star count to a tier label and color class (re-exported)
 *   - `escapeHtml()`         — sanitises untrusted strings before DOM injection
 *   - `formatNumber()`       — locale-friendly number formatting
 *
 * Imported by the bundler-visible `<script>` blocks in the skills pages;
 * must not import anything that requires a server/Node runtime.
 */

export { getQualityTier, TIER_THRESHOLDS } from '../utils/quality-tiers.js'
export type { QualityTier } from '../utils/quality-tiers.js'

import type { Skill } from '../types/skills.js'

export const TRUST_BADGE_CLASSES: Record<Skill['trust_tier'], string> = {
  official: 'bg-green-500/10 text-green-400 border-green-500/20',
  verified: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  curated: 'bg-teal-500/10 text-teal-300 border-teal-500/20',
  community: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  unverified: 'bg-red-500/10 text-red-400 border-red-500/20',
  experimental: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  unknown: 'bg-dark-500/10 text-dark-400 border-dark-500/20',
}

export function escapeHtml(str: string | undefined): string {
  if (!str) return ''
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

export function formatNumber(num: number): string {
  return new Intl.NumberFormat().format(num)
}
