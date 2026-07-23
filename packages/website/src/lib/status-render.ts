/**
 * Safe render-content builders for the status page (SMI-5755, Wave 5).
 * Split out of status-client.ts to stay under the repo's 500-line-per-file
 * gate — see status-client.ts's barrel re-export + header comment for the
 * full module-split rationale.
 *
 * Untrusted-field inventory handled here (Codex #1/#2): `component.message`,
 * `component.name`, `incident.title`, `incident.updates[].message`, and the
 * affected-component display-name lookup + raw-slug fallback. Every builder
 * below is pure and DOM-free; the shared applier
 * (`applyComponentRowContent`) writes via `textContent`/`className` only —
 * never `innerHTML` — for BOTH scaffold and dynamic rows alike (Codex #3
 * point 5).
 */

import {
  buildUptimeGrid,
  buildUptimeStripAriaLabel,
  coerceComponentStatus,
  formatTimestamp,
  IMPACT_CLASSES,
  IMPACT_LABELS,
  INCIDENT_STATUS_LABELS,
  isFiniteNumber,
  PILL_BASE,
  PILL_SIZE,
  SCAFFOLD_NO_DATA_MESSAGE,
  STATUS_LABELS,
  STATUS_PILL_CLASSES,
  uptimeTileClassName,
  uptimeTileText,
  withLiveAnchorStatus,
  type ComponentScaffoldEntry,
  type ComponentStatus,
  type StatusComponent,
  type StatusIncident,
  type UptimeDay,
} from './status-vocab'

export interface ComponentRowContent {
  slug: string
  /** Untrusted — apply via textContent only. */
  name: string
  /** Untrusted — apply via textContent only. */
  message: string
  status: ComponentStatus
  /** Trusted vocab label. */
  statusLabel: string
  /** Trusted vocab-only class string. */
  pillClassName: string
  /** Trusted, computed. */
  latencyText: string
  /** Trusted, computed. */
  checkedAtText: string
}

function buildPillClassName(status: ComponentStatus): string {
  const colors = STATUS_PILL_CLASSES[status] ?? STATUS_PILL_CLASSES.unknown
  return [PILL_BASE, colors.bgColor, colors.textColor, colors.borderColor, PILL_SIZE.sm].join(' ')
}

export function buildComponentRowContent(component: StatusComponent): ComponentRowContent {
  const status = coerceComponentStatus(component.status)
  return {
    slug: component.slug,
    name: component.name,
    message: component.message,
    status,
    statusLabel: STATUS_LABELS[status],
    pillClassName: buildPillClassName(status),
    latencyText: isFiniteNumber(component.latency_ms) ? `${component.latency_ms} ms` : '—',
    checkedAtText: formatTimestamp(component.checked_at),
  }
}

/** Reset content for a fixed scaffold row absent from the current payload (Codex #15). */
export function buildScaffoldResetContent(scaffold: ComponentScaffoldEntry): ComponentRowContent {
  return {
    slug: scaffold.slug,
    name: scaffold.name,
    message: SCAFFOLD_NO_DATA_MESSAGE,
    status: 'unknown',
    statusLabel: STATUS_LABELS.unknown,
    pillClassName: buildPillClassName('unknown'),
    latencyText: '—',
    checkedAtText: '—',
  }
}

/**
 * Minimal structural contract for a rendered row's DOM handles — real
 * `HTMLElement`s satisfy this interface directly (no adapter needed in
 * production); tests pass plain objects instead of standing up a DOM.
 */
export interface ComponentRowElements {
  nameEl: { textContent: string }
  messageEl: { textContent: string }
  latencyEl: { textContent: string }
  checkedAtEl: { textContent: string }
  pillTextEl: { textContent: string }
  pillEl: { className: string }
}

/**
 * The single shared row-render function used for both the initial scaffold
 * rows and any dynamically-appended row (Codex #3 point 5). Untrusted fields
 * (`content.name`, `content.message`) are written via `textContent` only.
 */
export function applyComponentRowContent(
  elements: ComponentRowElements,
  content: ComponentRowContent
): void {
  elements.nameEl.textContent = content.name
  elements.messageEl.textContent = content.message
  elements.latencyEl.textContent = content.latencyText
  elements.checkedAtEl.textContent = content.checkedAtText
  elements.pillTextEl.textContent = content.statusLabel
  elements.pillEl.className = content.pillClassName
}

/**
 * Minimal structural contract for a rendered uptime tile's DOM handle — real
 * tile `HTMLElement`s satisfy this directly.
 */
export interface UptimeTileHandle {
  className: string
  setAttribute(name: string, value: string): void
}

/**
 * Minimal structural contract for the containing strip's `[data-uptime-strip]`
 * DOM handle — real `HTMLElement`s satisfy this directly.
 */
export interface UptimeStripHandle {
  setAttribute(name: string, value: string): void
}

/**
 * Refreshes an already-rendered 90-tile uptime strip in place (the strip
 * always starts with exactly 90 "no data" tiles from the SSR scaffold or the
 * cloned row template, so this only ever updates class/title/aria-label on
 * existing tiles — it never adds or removes tile elements).
 *
 * FIX (medium): `stripHandle`/`label` are optional so existing callers keep
 * working unchanged, but when supplied, the containing strip's OWN
 * `role="group"` `aria-label` is also recomputed from the same tile grid via
 * `buildUptimeStripAriaLabel` (../lib/status-vocab.ts) — previously only the
 * per-tile `aria-label`s were refreshed, leaving the group-level summary
 * stuck at its SSR-time "0 operational ... 90 no data" reading forever.
 *
 * FIX: `liveStatus`, when supplied, overrides today's tile with the
 * component's live current status via `withLiveAnchorStatus` (../lib/
 * status-vocab.ts) — see that function's header comment for why today's
 * rollup-derived tile is otherwise always gray/no-data and easily misread as
 * yesterday's real status. Optional/trailing for the same backward-
 * compatibility reason as `stripHandle`/`label`.
 */
export function refreshUptimeStripTiles(
  tileHandles: UptimeTileHandle[],
  uptime90d: UptimeDay[],
  anchorIsoDate: string,
  stripHandle?: UptimeStripHandle | null,
  label?: string,
  liveStatus?: ComponentStatus
): void {
  const rawTiles = buildUptimeGrid(uptime90d, anchorIsoDate)
  const tiles = liveStatus !== undefined ? withLiveAnchorStatus(rawTiles, liveStatus) : rawTiles
  const count = Math.min(tileHandles.length, tiles.length)
  for (let i = 0; i < count; i++) {
    const tile = tiles[i]
    const handle = tileHandles[i]
    const text = uptimeTileText(tile)
    handle.className = uptimeTileClassName(tile.status)
    handle.setAttribute('title', text)
    handle.setAttribute('aria-label', text)
  }

  if (stripHandle && label !== undefined) {
    stripHandle.setAttribute('aria-label', buildUptimeStripAriaLabel(tiles, label))
  }
}

/**
 * Resolves each affected-component slug to its current display name, falling
 * back to the raw slug when it doesn't match any current component. Returns
 * plain text — safe only because every caller assigns the result via
 * `textContent`, never `innerHTML`.
 */
export function buildAffectedComponentsText(
  affectedSlugs: string[],
  componentsBySlug: ReadonlyMap<string, { name: string }>
): string {
  return affectedSlugs.map((slug) => componentsBySlug.get(slug)?.name ?? slug).join(', ')
}

/**
 * Builds the affected-components lookup map FRESH from the current poll's
 * live `components` (FIX, medium: previously a static map built ONCE at
 * module scope from the compile-time scaffold, never updated with live
 * data — a renamed fixed component or an incident affecting a dynamic
 * non-scaffold component would resolve to a stale/raw-slug name forever).
 *
 * Seeded from the static scaffold first (so a fixed slug still resolves to
 * something sane if a later poll's payload omits it — mirroring the same
 * reset-to-scaffold-name semantics `buildScaffoldResetContent` already uses
 * for a missing scaffold row), then every live component overwrites its own
 * slug with its CURRENT display name — this covers both a renamed fixed
 * component and any dynamic (non-scaffold) component.
 */
export function buildComponentsBySlug(
  components: StatusComponent[],
  scaffold: ComponentScaffoldEntry[]
): Map<string, { name: string }> {
  const map = new Map<string, { name: string }>()
  for (const entry of scaffold) {
    map.set(entry.slug, { name: entry.name })
  }
  for (const component of components) {
    map.set(component.slug, { name: component.name })
  }
  return map
}

export interface IncidentUpdateContent {
  statusLabel: string
  /** Untrusted — apply via textContent only. */
  message: string
  postedAtText: string
}

export interface IncidentContent {
  id: string
  /** Untrusted — apply via textContent only. */
  title: string
  impactLabel: string
  impactClassName: string
  statusLabel: string
  /** Untrusted (component names / raw-slug fallback) — apply via textContent only. */
  affectedText: string
  startedAtText: string
  resolvedAtText: string
  updates: IncidentUpdateContent[]
}

export function buildIncidentContent(
  incident: StatusIncident,
  componentsBySlug: ReadonlyMap<string, { name: string }>
): IncidentContent {
  return {
    id: incident.id,
    title: incident.title,
    impactLabel: IMPACT_LABELS[incident.impact] ?? IMPACT_LABELS.none,
    impactClassName: IMPACT_CLASSES[incident.impact] ?? IMPACT_CLASSES.none,
    statusLabel: INCIDENT_STATUS_LABELS[incident.status] ?? incident.status,
    affectedText: buildAffectedComponentsText(incident.affected_components, componentsBySlug),
    startedAtText: formatTimestamp(incident.started_at),
    resolvedAtText: incident.resolved_at ? formatTimestamp(incident.resolved_at) : 'Ongoing',
    updates: incident.updates.map((update) => ({
      statusLabel: INCIDENT_STATUS_LABELS[update.status] ?? update.status,
      message: update.message,
      postedAtText: formatTimestamp(update.posted_at),
    })),
  }
}
