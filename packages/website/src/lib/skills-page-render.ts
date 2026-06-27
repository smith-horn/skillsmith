/**
 * Client-side HTML builders for /account/skills — SMI-5393.
 *
 * Exported from a separate lib module so skills.astro stays under 500 lines.
 * All builder functions produce escaped HTML strings safe for innerHTML.
 * CSS for dynamically-built elements is injected once per session via
 * `injectSkillsPageStyles()`.
 */

import { SKILL_STATE_META, formatRelativeTime, formatAbsoluteTime } from './inventory-view'
import type { SkillState, DeviceView } from './inventory-view'

// ─── Badge config (mirrors InventoryStateBadge.astro) ─────────────────────────
// Distinct icon shape + WCAG-AA color pair per state — not color alone (WCAG 1.4.1).

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
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * XSS-safe HTML escape for user-supplied strings placed in innerHTML.
 * Pure string-replace (no DOM) so it is safe in both browser and test/SSR
 * contexts and unit-testable. Escapes the five HTML-significant characters,
 * `&` first, covering both element-text and double/single-quoted attribute
 * contexts (the only two contexts the builders below use).
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

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

/** Resolved human-readable label for a device, falling back to a truncated ID. */
export function deviceDisplayName(d: DeviceView): string {
  return d.label ?? d.hostnameDisplay ?? `Device ${d.deviceId.slice(0, 8)}`
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
  if (device.neverSynced) {
    skillsHtml = '<p class="never-synced-msg">No skills synced from this device yet.</p>'
  } else {
    const byHarness = new Map<string, typeof device.skills>()
    for (const sk of device.skills) {
      const key = sk.harness || ''
      const group = byHarness.get(key)
      if (group) group.push(sk)
      else byHarness.set(key, [sk])
    }
    for (const [harness, skills] of byHarness) {
      const hLabel = escapeHtml(harness || 'Default harness')
      skillsHtml += `<h4 class="harness-heading">${hLabel}</h4>`
      skillsHtml += `<ul class="skill-list" aria-label="Skills for ${hLabel}">`
      for (const sk of skills) {
        const ver = sk.version ? escapeHtml(sk.version) : '—'
        skillsHtml +=
          `<li class="skill-item">` +
          `<span class="skill-id">${escapeHtml(sk.skillId)}</span>` +
          `<span class="skill-version">${ver}</span>` +
          buildStateBadgeHtml(sk.state) +
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
    `</div>${skillsHtml}</section>`
  )
}

// ─── CSS injection for dynamically-built content ───────────────────────────────

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
  style.textContent = `
.device-card{background:#111114;border:1px solid #27272a;border-radius:12px;padding:1.5rem;margin-bottom:1.25rem}
.device-card--stale{opacity:.72;border-color:#3f3f46}
.device-header{margin-bottom:1rem}
.device-name-row{display:flex;align-items:baseline;gap:.75rem;flex-wrap:wrap;margin-bottom:.25rem}
.device-name{font-size:1rem;font-weight:600;margin:0;color:#fafafa}
.device-platform{font-size:.75rem;color:#71717a;font-family:'SF Mono','Fira Code',monospace}
.device-freshness{font-size:.8125rem;color:#71717a;margin:0}
.device-freshness--stale{color:#a16207}
.stale-marker{font-style:italic;color:#a16207}
.never-synced-msg{font-size:.875rem;color:#52525b;margin:0;font-style:italic}
.harness-heading{font-size:.6875rem;font-weight:600;color:#71717a;text-transform:uppercase;letter-spacing:.06em;margin:1rem 0 .5rem}
.device-card>.harness-heading:first-of-type{margin-top:0}
.skill-list{list-style:none;margin:0 0 .5rem;padding:0;display:flex;flex-direction:column;gap:.375rem}
.skill-item{display:flex;align-items:center;gap:.625rem;padding:.4rem .625rem;background:#18181b;border-radius:6px;flex-wrap:wrap}
.skill-id{font-family:'SF Mono','Fira Code',monospace;font-size:.8125rem;color:#d4d4d8;flex:1;min-width:0;word-break:break-all}
.skill-version{font-family:'SF Mono','Fira Code',monospace;font-size:.75rem;color:#52525b;white-space:nowrap}
`
  document.head.appendChild(style)
}
