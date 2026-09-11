/**
 * Client-side HTML builders for /account/skills — SMI-5393.
 *
 * Exported from a separate lib module so skills.astro stays under 500 lines.
 * All builder functions produce escaped HTML strings safe for innerHTML.
 * CSS for dynamically-built elements is injected once per session via
 * `injectSkillsPageStyles()`.
 */

import {
  SKILL_STATE_META,
  formatRelativeTime,
  formatAbsoluteTime,
  computeDeviceBatchTip,
} from './inventory-view'
import type { SkillState, DeviceView, SkillView } from './inventory-view'
import { escapeHtml } from './skills-utils'

export { escapeHtml }

// ─── Badge config ─────────────────────────────────────────────────────────────
// Distinct icon shape + WCAG-AA color pair per state — not color alone (WCAG 1.4.1).
//
// Inline-style hex rather than an Astro component, deliberately. Device cards are
// built as HTML strings and assigned via `innerHTML` (see `skills.astro`), so
// there is no server render pass an Astro component could hook into. A component
// form, `InventoryStateBadge.astro`, existed until SMI-6504 and was unreachable
// for exactly that reason: it duplicated every entry below and could have drifted
// from the live path without anyone noticing. Do NOT re-extract one unless the
// card rendering stops using `innerHTML` first — that is the larger change this
// config is downstream of, not a cleanup.
//
// Labels, descriptions and suggested actions live separately in `SKILL_STATE_META`
// (`inventory-view.ts`). That split is intentional — text there, visuals here —
// and is not the duplication SMI-6504 removed.

interface BadgeEntry {
  bg: string
  color: string
  border: string
  /** Heroicons outline SVG path, viewBox 0 0 24 24. */
  icon: string
}

export const BADGE_CONFIG: Record<SkillState, BadgeEntry> = {
  current: {
    bg: 'rgba(34,197,94,0.1)',
    color: '#4ade80',
    border: 'rgba(34,197,94,0.3)',
    icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z', // checkmark-circle
  },
  drifted: {
    bg: 'rgba(234,179,8,0.1)',
    color: '#facc15',
    border: 'rgba(234,179,8,0.3)',
    icon: 'M7 11l5-5m0 0l5 5m-5-5v12', // arrow-up
  },
  missing: {
    bg: 'rgba(239,68,68,0.1)',
    color: '#f87171',
    border: 'rgba(239,68,68,0.3)',
    icon: 'M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z', // x-circle
  },
  pinned: {
    bg: 'rgba(96,165,250,0.1)',
    color: '#60a5fa',
    border: 'rgba(96,165,250,0.3)',
    icon: 'M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z', // bookmark
  },
  unknown: {
    bg: 'rgba(161,161,170,0.1)',
    color: '#d4d4d8',
    border: 'rgba(161,161,170,0.3)',
    icon: 'M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z', // question-circle
  },
  local: {
    bg: 'rgba(20,184,166,0.1)',
    color: '#2dd4bf',
    border: 'rgba(20,184,166,0.3)',
    icon: 'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z', // desktop/computer
  },
  'source-identified': {
    bg: 'rgba(245,158,11,0.1)',
    color: '#fbbf24',
    border: 'rgba(245,158,11,0.3)',
    icon: 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z', // tag/label
  },
  pending: {
    bg: 'rgba(139,92,246,0.1)',
    color: '#a78bfa',
    border: 'rgba(139,92,246,0.3)',
    icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z', // clock
  },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns an HTML string for a WCAG-compliant skill-state badge.
 * Uses inline styles so the badge renders correctly inside innerHTML-built cards.
 */
export function buildStateBadgeHtml(state: SkillState): string {
  const cfg = BADGE_CONFIG[state] ?? BADGE_CONFIG.unknown
  const meta = SKILL_STATE_META[state] ?? SKILL_STATE_META.unknown
  const st = [
    `display:inline-flex;align-items:center;gap:4px`,
    `font-size:0.75rem;font-weight:500;white-space:nowrap`,
    `padding:0.2em 0.55em;border-radius:9999px`,
    `border:1px solid ${cfg.border};background:${cfg.bg};color:${cfg.color}`,
  ].join(';')
  return (
    `<span style="${st}" title="${escapeHtml(meta.description)}" data-testid="skill-badge" data-state="${state}">` +
    `<svg width="12" height="12" style="flex-shrink:0" fill="none" stroke="currentColor"` +
    ` viewBox="0 0 24 24" aria-hidden="true">` +
    `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${cfg.icon}"/>` +
    `</svg>${escapeHtml(meta.label)}</span>`
  )
}

// States whose author/repository values are registry-verified (safe to hyperlink).
const REGISTRY_MATCHED_STATES = new Set<SkillState>(['current', 'drifted', 'missing', 'pinned'])

/**
 * Builds an optional HTML snippet showing skill provenance below the badge.
 *
 * Trust model:
 * - Registry-matched states (current/drifted/missing/pinned): repository is
 *   registry-verified — rendered as an anchor with rel="noopener noreferrer".
 * - source-identified: author/repository are SELF-ASSERTED and UNVERIFIED.
 *   Rendered as plain text with an explicit "(unverified)" label to prevent
 *   trust-laundering a self-asserted URL (WCAG 1.4.1 — non-color cue).
 * - local / pending / unknown: no source to display.
 */
function buildSkillSourceHtml(sk: SkillView): string {
  if (REGISTRY_MATCHED_STATES.has(sk.state) && sk.repository) {
    const repo = escapeHtml(sk.repository)
    return (
      `<span class="skill-source">` +
      `<a href="${repo}" rel="noopener noreferrer" class="skill-source-link">${repo}</a>` +
      `</span>`
    )
  }
  if (sk.state === 'source-identified') {
    const parts: string[] = []
    if (sk.author) parts.push(escapeHtml(sk.author))
    if (sk.repository) parts.push(escapeHtml(sk.repository))
    if (parts.length === 0) return ''
    return (
      `<span class="skill-source skill-source--unverified" ` +
      `title="Source declared in the skill&#39;s own metadata (not registry-verified)">` +
      parts.join(' \xB7 ') +
      ` <span class="skill-source-tag">(unverified)</span></span>`
    )
  }
  return ''
}

/**
 * Converts a suggestedAction template (backtick-delimited code spans, an
 * optional `<skill>` placeholder inside those spans) into safe HTML.
 * Splits on backticks FIRST (the template is our own trusted static string,
 * so backtick count is always balanced) — only THEN substitutes `<skill>`
 * inside the already-identified code segments. Substituting before splitting
 * would let a skill_id containing a literal backtick shift segment parity.
 */
function renderSuggestedActionHtml(template: string, skillId: string): string {
  const parts = template.split('`')
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        const withSkill = part.split('<skill>').join(skillId)
        return `<code>${escapeHtml(withSkill)}</code>`
      }
      return escapeHtml(part)
    })
    .join('')
}

/** Resolved human-readable label for a device, falling back to a truncated ID. */
export function deviceDisplayName(d: DeviceView): string {
  return d.label ?? d.hostnameDisplay ?? `Device ${d.deviceId.slice(0, 8)}`
}

/**
 * Presentation labels for harness slugs on THIS page (SMI-6503).
 *
 * Deliberately page-local, NOT `CLIENT_DISPLAY_LABELS` from
 * `@skillsmith/core/install`. That map feeds mid-sentence install guidance in
 * four call sites across core, mcp-server and cli — e.g.
 * `Start a new ${label} session…` in cli's install-skill.ts — so its
 * `agents: 'your agent'` value is written for prose, not for a standalone
 * heading. Importing it here would couple a UI heading to CLI copy and make
 * either one unable to change without breaking the other.
 *
 * Unmapped slugs fall through to the raw value (still escaped at the call
 * site), so a newly-supported client still renders rather than showing a blank
 * heading. That fallback is a safety net, not the intended path -- a client
 * Skillsmith actually supports should have a real label here, and the raw slug
 * is a degraded rendering.
 *
 * Because the website bundle cannot import @skillsmith/core at runtime, keys
 * cannot be checked against the ClientId union at compile time. The parity
 * guard in skills-page-render.harness-parity.test.ts is that enforcement
 * boundary instead -- the same pattern skill-card.parity.test.ts uses for
 * COMPAT_LABELS. Add a client to core's ClientId and this map goes red.
 */
export const HARNESS_HEADING_LABELS: Record<string, string> = {
  agents: 'Shared (AGENTS.md)',
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  windsurf: 'Windsurf',
  opencode: 'OpenCode',
  hermes: 'Hermes',
  grok: 'Grok Build',
  antigravity: 'Antigravity',
}

/** Human-readable heading for a harness slug; falls back to the raw slug. */
export function harnessHeadingLabel(harness: string): string {
  if (!harness) return 'Default harness'
  return HARNESS_HEADING_LABELS[harness] ?? harness
}

/**
 * Builds a `<section>` HTML string for one device card, including all skill rows
 * grouped by harness. Output is safe for innerHTML assignment.
 */
export function buildDeviceCardHtml(device: DeviceView): string {
  const name = escapeHtml(deviceDisplayName(device))
  const platform = device.platform ? escapeHtml(device.platform) : ''
  const relTime = escapeHtml(formatRelativeTime(device.lastSeen, Date.now()))
  const absTime = escapeHtml(formatAbsoluteTime(device.lastSeen))
  const isStale = device.deviceState === 'stale'
  const staleTag = isStale ? ` <span class="stale-marker" aria-label="stale">(stale)</span>` : ''

  let skillsHtml = ''
  let batchTipHtml = ''
  if (device.neverSynced) {
    skillsHtml = '<p class="never-synced-msg">No skills synced from this device yet.</p>'
  } else {
    const batchTip = computeDeviceBatchTip(device.skills)
    if (batchTip) {
      batchTipHtml = `<p class="device-batch-tip">${renderSuggestedActionHtml(batchTip, '')}</p>`
    }

    const byHarness = new Map<string, typeof device.skills>()
    for (const sk of device.skills) {
      const key = sk.harness || ''
      const group = byHarness.get(key)
      if (group) group.push(sk)
      else byHarness.set(key, [sk])
    }
    // One "Skills" section heading per device, above the per-harness subgroups
    // (SMI-6503). Device name is <h3>, so the outline is h3 > h4 > h5 — emitting
    // both levels as <h4> would make the section and its subgroups peers.
    skillsHtml += `<h4 class="skills-section-heading">Skills</h4>`
    for (const [harness, skills] of byHarness) {
      const hLabel = escapeHtml(harnessHeadingLabel(harness))
      skillsHtml += `<h5 class="harness-heading">${hLabel}</h5>`
      skillsHtml += `<ul class="skill-list" aria-label="Skills for ${hLabel}">`
      for (const sk of skills) {
        const ver = sk.version ? escapeHtml(sk.version) : '—'
        const meta = SKILL_STATE_META[sk.state] ?? SKILL_STATE_META.unknown
        const actionHtml = meta?.suggestedAction
          ? `<span class="skill-action">${renderSuggestedActionHtml(meta.suggestedAction, sk.skillId)}</span>`
          : ''
        skillsHtml +=
          `<li class="skill-item">` +
          `<span class="skill-id">${escapeHtml(sk.skillId)}</span>` +
          `<span class="skill-version">${ver}</span>` +
          buildStateBadgeHtml(sk.state) +
          buildSkillSourceHtml(sk) +
          actionHtml +
          `</li>`
      }
      skillsHtml += '</ul>'
    }
  }

  return (
    `<section class="device-card${isStale ? ' device-card--stale' : ''}" aria-label="Device: ${name}" data-testid="device-card">` +
    `<div class="device-header">` +
    `<div class="device-name-row"><h3 class="device-name">${name}</h3>` +
    (platform ? `<span class="device-platform">${platform}</span>` : '') +
    `</div>` +
    `<p class="device-freshness${isStale ? ' device-freshness--stale' : ''}" title="${absTime}">` +
    `Last synced ${relTime}${staleTag}</p>` +
    `</div>${batchTipHtml}${skillsHtml}</section>`
  )
}

// ─── CSS injection for dynamically-built content ───────────────────────────────

/**
 * CSS for the dynamically-built device card elements.
 *
 * Exported as a plain string, not just injected, so the contrast and
 * link-affordance rules it encodes can be asserted in a `node`-environment unit
 * test without a DOM (SMI-6503).
 */
export const SKILLS_PAGE_CSS = `
/* Colors below reference the four --sk-* custom properties declared in
   src/styles/account-skills.css, which skills.astro imports (SMI-6503). They
   are deliberately NOT declared here: this stylesheet is injected behind a
   document.querySelector('style[data-skills-page]') guard, so a stale copy left
   in the DOM by a pre-deploy ClientRouter navigation would make the guard return
   early and every var() below resolve to nothing. The static block always ships
   with the document. See the tier table in the SMI-6503 plan. */
.device-card{background:#111114;border:1px solid #27272a;border-radius:12px;padding:1.5rem;margin-bottom:1.25rem}
/* No opacity here: it composites the whole card as a group, dragging every
   color down ~35% and pushing six text elements under WCAG AA (SMI-6503).
   standards-astro.md:460 — "opacity compounds contrast". Staleness is signalled
   by this border plus the amber "(stale)" marker instead. */
.device-card--stale{border-color:#3f3f46;border-left:3px solid var(--sk-accent-stale)}
.device-header{margin-bottom:1rem}
.device-name-row{display:flex;align-items:baseline;gap:.75rem;flex-wrap:wrap;margin-bottom:.25rem}
.device-name{font-size:1rem;font-weight:600;margin:0;color:var(--sk-text-primary)}
.device-platform{font-size:.75rem;color:var(--sk-text-muted);font-family:'SF Mono','Fira Code',monospace}
.device-freshness{font-size:.8125rem;color:var(--sk-text-muted);margin:0}
.device-freshness--stale{color:var(--sk-accent-stale)}
.stale-marker{font-style:italic;color:var(--sk-accent-stale)}
.never-synced-msg{font-size:.875rem;color:var(--sk-text-muted);margin:0;font-style:italic}
.skills-section-heading{font-size:.6875rem;font-weight:600;color:var(--sk-text-muted);text-transform:uppercase;letter-spacing:.06em;margin:1.25rem 0 .5rem}
.device-card>.skills-section-heading:first-of-type{margin-top:0}
/* Sentence case, not uppercase — these carry real product names now
   ("Claude Code", not "CLAUDE CODE"). */
.harness-heading{font-size:.75rem;font-weight:600;color:var(--sk-text-muted);letter-spacing:.01em;margin:.75rem 0 .375rem}
.skill-list{list-style:none;margin:0 0 .5rem;padding:0;display:flex;flex-direction:column;gap:.375rem}
.skill-item{display:flex;align-items:center;gap:.625rem;padding:.4rem .625rem;background:#18181b;border-radius:6px;flex-wrap:wrap}
.skill-id{font-family:'SF Mono','Fira Code',monospace;font-size:.8125rem;font-weight:500;color:var(--sk-text-primary);flex:1;min-width:0;word-break:break-all}
.skill-version{font-family:'SF Mono','Fira Code',monospace;font-size:.75rem;color:var(--sk-text-muted);white-space:nowrap}
.skill-source{font-size:.75rem;color:var(--sk-text-muted);flex-basis:100%;margin-top:.25rem;word-break:break-all}
.skill-source--unverified{font-style:italic}
.skill-source-tag{font-size:.75rem;color:var(--sk-text-muted)}
/* Underlined at rest, not only on hover — standards-astro.md:465 requires links
   in text blocks to be distinguishable by more than color. */
.skill-source-link{color:var(--sk-text-muted);text-decoration:underline}
.skill-source-link:hover{color:var(--sk-text-secondary)}
.skill-action{font-size:.75rem;color:var(--sk-text-secondary);flex-basis:100%;margin-top:.25rem;word-break:break-word}
.skill-action code{font-family:'SF Mono','Fira Code',monospace;word-break:break-all}
.device-batch-tip{font-size:.8125rem;color:var(--sk-text-secondary);margin:0 0 1rem;padding:.5rem .75rem;background:#18181b;border-radius:6px;word-break:break-word}
.device-batch-tip code{font-family:'SF Mono','Fira Code',monospace;word-break:break-all}
`

/**
 * Injects the CSS required by dynamically-built device card elements into
 * `document.head`. Safe to call on every `astro:page-load` — idempotent.
 *
 * The guard checks actual DOM presence, NOT a module flag: ClientRouter swaps
 * <head> on SPA navigation and drops this runtime <style> (it is neither a
 * stylesheet link nor transition-persisted), so a module flag would stay true
 * and the cards would render unstyled after a navigate-away-and-back.
 */
export function injectSkillsPageStyles(): void {
  if (document.querySelector('style[data-skills-page]')) return
  const style = document.createElement('style')
  style.dataset['skillsPage'] = '1'
  style.textContent = SKILLS_PAGE_CSS
  document.head.appendChild(style)
}
