/**
 * Typed renderer for the skill card HTML fragment (SMI-5366 / GH #1377).
 *
 * Extracted verbatim from the inline createSkillCard() / createOrgMatchBadge() /
 * createCompatibilityBadges() / createLicenseBadge() closures that lived in the
 * skills/index.astro <script> block. Now bundler-visible and unit-tested
 * (skill-card.test.ts pins the markup via an inline snapshot + assertion set;
 * skill-card.parity.test.ts pins COMPAT_LABELS against the core contract).
 *
 * Browser/SSR-safe: escapeHtml is pure-string (no `document`). The caller builds
 * `href` so the renderer stays URL-policy-agnostic.
 */

import type { WireSkill } from '../types/skills.js'
import { getQualityTier, escapeHtml, formatNumber } from './skills-utils.js'
import { licenseLabel } from './license-label.js'
import { TRUST_TIER_BADGE_CLASSES, DEFAULT_TRUST_TIER } from '../constants/trust-tier-badges.js'

export interface SkillCardProps {
  skill: WireSkill
  href: string
}

// SMI-5178: display labels for compatibility slugs. MIRRORS the canonical map in
// @skillsmith/core (COMPATIBILITY_LABELS, compatibility/slugs.ts) — the website
// client bundle cannot import core, so skill-card.parity.test.ts asserts these
// stay in sync. Unknown slugs fall back to the raw (escaped) value.
export const COMPAT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  windsurf: 'Windsurf',
  antigravity: 'Antigravity',
  codex: 'Codex',
  gemini: 'Gemini',
}

const MAX_VISIBLE = 4

// SMI-5178: module-scope id sequence for "+N more" aria-controls wiring. The
// module evaluates once, so the counter is monotonic across both grids and
// across ClientRouter navigations — ids never collide or reset.
let compatBadgeSeq = 0

// SMI-4401 Wave 2 A-M9-2: render a "Matches your org" badge when signal-boost applies.
function renderOrgMatchBadge(orgName: string | undefined): string {
  if (!orgName) return ''
  return `<span class="inline-flex items-center gap-1 px-2 py-0.5 mt-2 rounded-full text-xs font-medium bg-primary-500/10 text-primary-300 border border-primary-500/30" aria-label="Matches your org: ${escapeHtml(orgName)}">
    <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2a6 6 0 100 12 6 6 0 000-12zm0 2a4 4 0 110 8 4 4 0 010-8z"/></svg>
    Matches your org: ${escapeHtml(orgName)}
  </span>`
}

// SMI-5327: License badge. Null / absent / whitespace-only means "unknown / not
// detected" — render as "License: Unknown". NEVER imply "no restrictions" or
// "freely usable". Uses the canonical licenseLabel() (single source of truth).
function renderLicenseBadge(license: string | null | undefined): string {
  const label = escapeHtml(licenseLabel(license))
  return `<div class="mt-2">
    <span class="inline-flex items-center gap-1 text-xs text-dark-500" aria-label="License: ${label}">
      <svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
      <span>License: <span class="font-medium">${label}</span></span>
    </span>
  </div>`
}

// SMI-2760 / SMI-5178: compatibility badge row (max 4 visible; +N more expands,
// keyboard-operable with aria-expanded/aria-controls). Renders display labels,
// not raw slugs. `[]`/absent compatibility = no badges.
function renderCompatibilityBadges(compatibility: string[] | undefined): string {
  if (!Array.isArray(compatibility) || compatibility.length === 0) return ''

  const visible = compatibility.slice(0, MAX_VISIBLE)
  const extra = compatibility.slice(MAX_VISIBLE)

  const badge = (tag: string): string => {
    const label = COMPAT_LABELS[tag] || tag
    return `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-primary-500/10 text-primary-400 border border-primary-500/20">${escapeHtml(label)}</span>`
  }

  const visibleHtml = visible.map(badge).join('')

  if (extra.length === 0) {
    return `<div class="mt-3 pt-3 border-t border-dark-800 flex flex-wrap gap-1">${visibleHtml}</div>`
  }

  const hiddenHtml = extra.map(badge).join('')
  const extraId = `compat-extra-${++compatBadgeSeq}`

  // Expand-only: on reveal, show the hidden badges, mark aria-expanded, and hide
  // the toggle (no collapse) so aria-expanded never desyncs. The inline onclick
  // keeps event.preventDefault()+stopPropagation() so the click never bubbles to
  // the card <a> and navigates (SMI-3529 nested-interactive guard).
  return `<div class="mt-3 pt-3 border-t border-dark-800 flex flex-wrap gap-1 items-center">
    ${visibleHtml}
    <span id="${extraId}" style="display:none">${hiddenHtml}</span>
    <button
      type="button"
      class="px-1.5 py-0.5 rounded text-xs text-dark-400 hover:text-primary-400 transition-colors focus:outline-none focus:ring-1 focus:ring-primary-500"
      aria-label="Show ${extra.length} more compatibility tag${extra.length === 1 ? '' : 's'}"
      aria-expanded="false"
      aria-controls="${extraId}"
      onclick="event.preventDefault(); event.stopPropagation(); document.getElementById('${extraId}').style.display='contents'; this.setAttribute('aria-expanded','true'); this.style.display='none';"
    >+${extra.length} more</button>
  </div>`
}

/**
 * Render the full skill card HTML fragment. `href` is supplied by the caller
 * (e.g. `/skills/${encodeURIComponent(skill.id)}`).
 */
export function renderSkillCard({ skill, href }: SkillCardProps): string {
  // SMI-5365: preserve the original runtime fallback — an absent OR runtime-unknown
  // trust_tier degrades to the default tier's class, never an undefined fragment.
  const trustClass =
    TRUST_TIER_BADGE_CLASSES[skill.trust_tier ?? DEFAULT_TRUST_TIER] ??
    TRUST_TIER_BADGE_CLASSES[DEFAULT_TRUST_TIER]
  const stars = skill.stars ?? 0
  const tier = getQualityTier(stars)
  const ariaLabel = `${tier.label}: ${formatNumber(stars)} stars`
  const orgMatchBadge = renderOrgMatchBadge(skill._orgMatch)

  return `
        <a href="${href}" class="card-hover block bg-dark-900 rounded-xl border border-dark-800 p-6 hover:border-primary-500/50">
          <div class="flex items-start justify-between mb-4">
            <div class="flex-1 min-w-0">
              <h3 class="text-lg font-semibold text-white truncate">${escapeHtml(skill.name)}</h3>
              <p class="text-dark-500 text-sm">${escapeHtml(skill.author || 'Unknown author')}</p>
              ${orgMatchBadge}
            </div>
            <span class="ml-4 px-2.5 py-1 text-xs font-medium rounded-full border ${trustClass}">
              ${escapeHtml(skill.trust_tier || DEFAULT_TRUST_TIER)}
            </span>
          </div>
          <p class="text-dark-400 text-sm mb-4 line-clamp-2">${escapeHtml(skill.description || 'No description available')}</p>
          <div class="flex items-center justify-between text-sm">
            <div class="flex items-center space-x-4">
              ${
                skill.categories?.[0]
                  ? `
                <span class="text-dark-500">
                  <svg class="w-4 h-4 inline-block mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                  </svg>
                  ${escapeHtml(skill.categories[0])}
                </span>
              `
                  : ''
              }
              ${skill.version ? `<span class="text-dark-500">v${escapeHtml(skill.version)}</span>` : ''}
            </div>
            <span class="${tier.color} text-lg" role="img" aria-label="${ariaLabel}" title="${ariaLabel}">●<span class="sr-only">${ariaLabel}</span></span>
          </div>
          ${
            skill.repo_url && skill.repo_url.startsWith('https://')
              ? `<div class="mt-3 pt-3 border-t border-dark-800">
              <span class="inline-flex items-center gap-1 text-xs text-dark-500">
                <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z"/>
                </svg>
                View source
              </span>
            </div>`
              : ''
          }
          ${renderCompatibilityBadges(skill.compatibility)}
          ${renderLicenseBadge(skill.license)}
        </a>
      `
}
