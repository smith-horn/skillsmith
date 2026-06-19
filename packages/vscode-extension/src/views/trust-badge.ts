/**
 * Trust-tier badge helpers for webview surfaces (SMI-5315).
 *
 * Extracted from skill-panel-html.ts so the Compare / Diff panels render trust
 * with the same `.badge badge-${color}` component as the detail panel. Vocabulary
 * mirrors src/sidebar/trustTier.ts (ApiTrustTier 5-tier); kept vscode-free so it
 * can be imported by any HTML-builder module. NOTE: these are for WEBVIEW badges;
 * QuickPick string surfaces use the codicon getters in src/sidebar/trustTier.ts.
 */

function normalizeTierForBadge(tier: string): string {
  const lower = tier.toLowerCase()
  const canonical = ['official', 'verified', 'curated', 'community', 'unverified']
  if (canonical.includes(lower)) return lower
  // Legacy mapping: experimental → community; all other unrecognized → unverified
  if (lower === 'experimental') return 'community'
  return 'unverified'
}

/**
 * Get the CSS class suffix for a trust tier badge color (`badge-${color}`).
 */
export function getTrustBadgeColor(tier: string): string {
  return normalizeTierForBadge(tier)
}

/**
 * Get the display text for a trust tier badge.
 */
export function getTrustBadgeText(tier: string): string {
  const normalized = normalizeTierForBadge(tier)
  switch (normalized) {
    case 'official':
      return 'Official'
    case 'verified':
      return 'Verified'
    case 'curated':
      return 'Curated'
    case 'community':
      return 'Community'
    default:
      return 'Unverified'
  }
}
