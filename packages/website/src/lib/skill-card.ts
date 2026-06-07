/**
 * Typed renderer for the skill card HTML fragment.
 *
 * Replaces the untyped `createSkillCard()` / `createCompatibilityBadges()` /
 * `createOrgMatchBadge()` helpers that were previously inlined as `is:inline`
 * script blocks in `skills/index.astro`.
 *
 * Must remain browser-only — `escapeHtml` calls `document.createElement`.
 * Import only from bundler-visible `<script>` blocks, not from Astro frontmatter.
 */

import type { Skill } from '../types/skills.js'
import { TRUST_BADGE_CLASSES, getQualityTier, formatNumber, escapeHtml } from './skills-utils.js'

export interface SkillCardProps {
  skill: Skill
  href: string
}

// SMI-5178: display labels for compatibility slugs. MIRRORS the canonical
// map in @skillsmith/core (COMPATIBILITY_LABELS, compatibility/slugs.ts) —
// the website client bundle cannot import core, so a parity test asserts
// these stay in sync. Unknown slugs fall back to the raw (escaped) value.
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

// SMI-5178: unique id sequence for "+N more" aria-controls wiring.
let _compatSeq = 0

function renderOrgMatchBadge(orgName: string | undefined): string {
  if (!orgName) return ''
  return `<span class="inline-flex items-center gap-1 px-2 py-0.5 mt-2 rounded-full text-xs font-medium bg-primary-500/10 text-primary-300 border border-primary-500/30" aria-label="Matches your org: ${escapeHtml(orgName)}">
    <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2a6 6 0 100 12 6 6 0 000-12zm0 2a4 4 0 110 8 4 4 0 010-8z"/></svg>
    Matches your org: ${escapeHtml(orgName)}
  </span>`
}

// SMI-2760 / SMI-5178: compatibility badge row (max 4 visible; +N more
// expands, keyboard-operable with aria-expanded/aria-controls). Renders
// display labels, not raw slugs. `[]`/absent compatibility = no badges.
function renderCompatibilityBadges(compatibility: string[] | undefined): string {
  if (!Array.isArray(compatibility) || compatibility.length === 0) return ''

  const visible = compatibility.slice(0, MAX_VISIBLE)
  const extra = compatibility.slice(MAX_VISIBLE)

  const badge = (tag: string): string => {
    const label = COMPAT_LABELS[tag] ?? tag
    return `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-primary-500/10 text-primary-400 border border-primary-500/20">${escapeHtml(label)}</span>`
  }

  const visibleHtml = visible.map(badge).join('')

  if (extra.length === 0) {
    return `<div class="mt-3 pt-3 border-t border-dark-800 flex flex-wrap gap-1">${visibleHtml}</div>`
  }

  const hiddenHtml = extra.map(badge).join('')
  const extraId = `compat-extra-${++_compatSeq}`

  // Expand-only: on reveal, show the hidden badges, mark aria-expanded, and
  // hide the toggle (no collapse) so aria-expanded never desyncs.
  return `<div class="mt-3 pt-3 border-t border-dark-800 flex flex-wrap gap-1 items-center">
    ${visibleHtml}
    <span id="${extraId}" style="display:none">${hiddenHtml}</span>
    <button
      type="button"
      class="px-1.5 py-0.5 rounded text-xs text-dark-400 hover:text-primary-400 transition-colors focus:outline-none focus:ring-1 focus:ring-primary-500"
      aria-label="Show ${extra.length} more compatibility tags"
      aria-expanded="false"
      aria-controls="${extraId}"
      onclick="event.preventDefault(); event.stopPropagation(); document.getElementById('${extraId}').style.display='contents'; this.setAttribute('aria-expanded','true'); this.style.display='none';"
    >+${extra.length} more</button>
  </div>`
}

export function renderSkillCard({ skill, href }: SkillCardProps): string {
  const trustClass = TRUST_BADGE_CLASSES[skill.trust_tier] ?? TRUST_BADGE_CLASSES.unverified
  const stars = skill.stars ?? 0
  const tier = getQualityTier(stars)
  const ariaLabel = `${tier.label}: ${formatNumber(stars)} stars`

  return `
  <a href="${href}" class="card-hover block bg-dark-900 rounded-xl border border-dark-800 p-6 hover:border-primary-500/50">
    <div class="flex items-start justify-between mb-4">
      <div class="flex-1 min-w-0">
        <h3 class="text-lg font-semibold text-white truncate">${escapeHtml(skill.name)}</h3>
        <p class="text-dark-500 text-sm">${escapeHtml(skill.author || 'Unknown author')}</p>
        ${renderOrgMatchBadge(skill._orgMatch)}
      </div>
      <span class="ml-4 px-2.5 py-1 text-xs font-medium rounded-full border ${trustClass}">
        ${escapeHtml(skill.trust_tier)}
      </span>
    </div>
    <p class="text-dark-400 text-sm mb-4 line-clamp-2">${escapeHtml(skill.description || 'No description available')}</p>
    <div class="flex items-center justify-between text-sm">
      <div class="flex items-center space-x-4">
        ${
          skill.categories?.[0]
            ? `<span class="text-dark-500">
                <svg class="w-4 h-4 inline-block mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                </svg>
                ${escapeHtml(skill.categories[0])}
              </span>`
            : ''
        }
        ${skill.version ? `<span class="text-dark-500">v${escapeHtml(skill.version)}</span>` : ''}
      </div>
      <span class="${tier.color} text-lg" role="img" aria-label="${ariaLabel}" title="${ariaLabel}">●<span class="sr-only">${ariaLabel}</span></span>
    </div>
    ${
      skill.repo_url?.startsWith('https://')
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
  </a>`
}
