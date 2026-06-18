/**
 * Local mirror of the canonical 5-tier ApiTrustTier model
 * (packages/core/src/api/types.ts API_TRUST_TIERS). ADR-113 forbids importing
 * @skillsmith/core into the extension; keep this in sync. Colors mirror
 * packages/website/src/constants/trust-tier-badges.ts.
 */
import * as vscode from 'vscode'

/**
 * The canonical 5-tier trust model exposed to the extension.
 * Mirrors ApiTrustTier from packages/core/src/api/types.ts.
 * Internal tiers (experimental, unknown) are translated server-side before
 * reaching the client; the extension never needs to display them.
 */
export type ExtensionTrustTier = 'official' | 'verified' | 'curated' | 'community' | 'unverified'

/** Canonical tiers in insertion order — used for exhaustiveness checks. */
const CANONICAL_TIERS: ExtensionTrustTier[] = [
  'official',
  'verified',
  'curated',
  'community',
  'unverified',
]

/** Legacy tier strings the server used to emit; map to the nearest canonical tier. */
const LEGACY_MAP: Readonly<Record<string, ExtensionTrustTier>> = {
  experimental: 'community',
  unknown: 'unverified',
  standard: 'unverified',
  default: 'unverified',
}

/**
 * Normalizes a raw trust-tier string to a canonical ExtensionTrustTier value.
 *
 * - Canonical values map to themselves.
 * - Legacy values follow LEGACY_MAP.
 * - Any unrecognized non-empty string falls back to `unverified` (lowest-trust).
 * - Empty / undefined / null returns `undefined` (no tier — e.g. local skills).
 */
export function normalizeTrustTier(raw?: string): ExtensionTrustTier | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined
  }
  const lower = raw.toLowerCase()
  if ((CANONICAL_TIERS as string[]).includes(lower)) {
    return lower as ExtensionTrustTier
  }
  if (Object.prototype.hasOwnProperty.call(LEGACY_MAP, lower)) {
    return LEGACY_MAP[lower]
  }
  // Unrecognized non-empty string → defensively lowest-trust
  return 'unverified'
}

/**
 * Returns the VS Code ThemeIcon for a trust tier.
 *
 * When `tier` is absent/empty (e.g. a locally-installed skill with no API tier),
 * a neutral `symbol-function` icon is returned **without** a ThemeColor so it
 * never renders as red `unverified`.
 */
export function getTrustTierIcon(tier?: string): vscode.ThemeIcon {
  const normalized = normalizeTrustTier(tier)
  switch (normalized) {
    case 'official':
      return new vscode.ThemeIcon('verified-filled', new vscode.ThemeColor('charts.green'))
    case 'verified':
      return new vscode.ThemeIcon('verified', new vscode.ThemeColor('charts.blue'))
    case 'curated':
      return new vscode.ThemeIcon('star-full', new vscode.ThemeColor('terminal.ansiCyan'))
    case 'community':
      return new vscode.ThemeIcon('organization', new vscode.ThemeColor('charts.yellow'))
    case 'unverified':
      return new vscode.ThemeIcon('question', new vscode.ThemeColor('charts.red'))
    default:
      // undefined → local/installed skill with no API tier; use neutral icon, no color
      return new vscode.ThemeIcon('symbol-function')
  }
}

/**
 * Returns the emoji character for a trust tier.
 * Returns `''` when the tier is absent/empty.
 */
export function getTrustTierEmoji(tier?: string): string {
  const normalized = normalizeTrustTier(tier)
  switch (normalized) {
    case 'official':
      return '✅'
    case 'verified':
      return '☑️'
    case 'curated':
      return '⭐'
    case 'community':
      return '👥'
    case 'unverified':
      return '❓'
    default:
      return ''
  }
}

/**
 * Returns the human-readable label for a trust tier.
 * Returns `''` when the tier is absent/empty.
 */
export function getTrustTierLabel(tier?: string): string {
  const normalized = normalizeTrustTier(tier)
  switch (normalized) {
    case 'official':
      return 'Official'
    case 'verified':
      return 'Verified'
    case 'curated':
      return 'Curated'
    case 'community':
      return 'Community'
    case 'unverified':
      return 'Unverified'
    default:
      return ''
  }
}

/**
 * Returns a VS Code codicon string (`$(icon)`) for a trust tier — for
 * string-rendered surfaces that cannot use a ThemeIcon (e.g. QuickPick item
 * labels). Icon ids mirror getTrustTierIcon(); absent/empty/unrecognized tiers
 * normalize the same way (unrecognized → `unverified`; absent → neutral
 * `$(symbol-function)`).
 */
export function getTrustTierCodicon(tier?: string): string {
  const normalized = normalizeTrustTier(tier)
  switch (normalized) {
    case 'official':
      return '$(verified-filled)'
    case 'verified':
      return '$(verified)'
    case 'curated':
      return '$(star-full)'
    case 'community':
      return '$(organization)'
    case 'unverified':
      return '$(question)'
    default:
      return '$(symbol-function)'
  }
}
