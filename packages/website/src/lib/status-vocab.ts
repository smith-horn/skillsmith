/**
 * Status page vocabulary — single source of truth for the public status page
 * (SMI-5755, Wave 5).
 *
 * Imported by StatusPill.astro, UptimeBarStrip.astro, status.astro's
 * frontmatter (server-rendered scaffold), and forwarded into status.astro's
 * client script via `define:vars` for the plain constants (label/class maps
 * are JSON-serializable so they cross that boundary cleanly).
 *
 * The live API contract (`GET /functions/v1/status-public`, shipped Wave 4 /
 * SMI-5754) is: `{ cached: boolean, data: StatusData }`. Every field on
 * `component.message`, `component.name`, `incident.title`, and
 * `incident.updates[].message` is attacker-controlled admin-authored text —
 * treat as untrusted. Nothing in this file renders that text; this module is
 * vocab/types/pure-math only.
 */

// ---------------------------------------------------------------------------
// API contract types
// ---------------------------------------------------------------------------

export type ComponentStatus = 'operational' | 'degraded' | 'outage' | 'unknown'

/** Rollup days are NEVER 'unknown' — a day either happened or is absent. */
export type DayStatus = 'operational' | 'degraded' | 'outage'

export interface UptimeDay {
  day: string
  uptime_pct: number
  worst_status: DayStatus
  total_checks: number
}

export interface StatusComponent {
  slug: string
  name: string
  description: string
  display_order: number
  status: ComponentStatus
  latency_ms: number | null
  message: string
  checked_at: string | null
  /** SPARSE — a day with zero checks is ABSENT, never present with total_checks:0. */
  uptime_90d: UptimeDay[]
}

export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved'
export type IncidentImpact = 'none' | 'minor' | 'major' | 'critical'

export interface IncidentUpdate {
  status: IncidentStatus
  message: string
  posted_at: string
}

export interface StatusIncident {
  id: string
  title: string
  impact: IncidentImpact
  status: IncidentStatus
  started_at: string
  resolved_at: string | null
  /** Slugs — resolved against the current component list for a display name. */
  affected_components: string[]
  /** Ascending by posted_at within one incident. */
  updates: IncidentUpdate[]
}

export interface StatusData {
  generated_at: string
  overall_status: ComponentStatus
  /** 6 today, in display_order. */
  components: StatusComponent[]
  /** Descending by started_at. */
  incidents: StatusIncident[]
}

export interface StatusResponse {
  cached: boolean
  data: StatusData
}

// ---------------------------------------------------------------------------
// Uptime grid
// ---------------------------------------------------------------------------

export interface UptimeTile {
  date: string
  status: DayStatus | null
  uptimePct: number | null
  totalChecks: number | null
}

const DAY_STRING_RE = /^\d{4}-\d{2}-\d{2}$/

/** Guards a `day` string before it is used as a map key (Codex #6/#9). */
export function isValidDayString(value: unknown): value is string {
  return typeof value === 'string' && DAY_STRING_RE.test(value)
}

/**
 * `Number(null) === 0` and `Number('') === 0` — validate BEFORE clamping so a
 * malformed/missing `uptime_pct` falls back to "no data" instead of rendering
 * as a fabricated 0% (full-outage-looking) tile (Codex #9).
 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && Number.isInteger(value)
}

const KNOWN_DAY_STATUSES: ReadonlySet<string> = new Set<DayStatus>([
  'operational',
  'degraded',
  'outage',
])

function toDayStatus(value: unknown): DayStatus | null {
  return typeof value === 'string' && KNOWN_DAY_STATUSES.has(value) ? (value as DayStatus) : null
}

/**
 * Builds the ordered 90-tile uptime grid, oldest first / anchor day last (the
 * "most recent" tile UptimeBarStrip gives the initial `tabindex="0"`).
 *
 * FIX (Codex #6, merge-blocking): anchored to a caller-supplied ISO calendar
 * date (`anchorIsoDate`, e.g. `data.generated_at.slice(0, 10)`), NOT
 * `Date.now()`/browser-local "today" — a cached-then-repainted-after-midnight-UTC
 * paint must not misalign the 90-day window against stale data. Parsed as UTC
 * and walked back via `Date.UTC(...)` arithmetic only (never local-time `Date`
 * methods, which are DST-sensitive).
 *
 * FIX (Codex #6 + #9, merge-blocking): each `day` string is validated against
 * `/^\d{4}-\d{2}-\d{2}$/` before use as a map key; a malformed value is
 * skipped (treated as absent), not silently mismatched. If two entries share
 * the same valid `day` key, last-one-wins — an intentional, low-risk default
 * (the DB's `(component_id, day)` primary key makes this unreachable live),
 * not an oversight.
 */
export function buildUptimeGrid(uptime90d: UptimeDay[], anchorIsoDate: string): UptimeTile[] {
  const byDay = new Map<string, UptimeDay>()
  for (const entry of uptime90d) {
    if (!entry || !isValidDayString(entry.day)) continue
    byDay.set(entry.day, entry)
  }

  if (!isValidDayString(anchorIsoDate)) return []
  const anchor = new Date(`${anchorIsoDate}T00:00:00Z`)
  if (Number.isNaN(anchor.getTime())) return []

  const anchorYear = anchor.getUTCFullYear()
  const anchorMonth = anchor.getUTCMonth()
  const anchorDate = anchor.getUTCDate()

  const tiles: UptimeTile[] = []
  for (let i = 89; i >= 0; i--) {
    const dayMs = Date.UTC(anchorYear, anchorMonth, anchorDate - i)
    const dateStr = new Date(dayMs).toISOString().slice(0, 10)
    const entry = byDay.get(dateStr)

    if (!entry) {
      tiles.push({ date: dateStr, status: null, uptimePct: null, totalChecks: null })
      continue
    }

    const uptimePctValid = isFiniteNumber(entry.uptime_pct)
    const uptimePct = uptimePctValid ? Math.min(100, Math.max(0, entry.uptime_pct)) : null
    // FIX (high): an invalid uptime_pct invalidates the WHOLE day, not just
    // that one field — a genuinely valid-looking `worst_status` on a row
    // whose uptime_pct is corrupt must NOT survive as a fabricated green
    // "operational" tile with no percentage shown. Forcing status: null here
    // (regardless of worst_status) collapses the tile to "no data", matching
    // the "a day is either fully absent or fully valid" invariant.
    const status = uptimePctValid ? toDayStatus(entry.worst_status) : null
    const totalChecks = isNonNegativeInteger(entry.total_checks) ? entry.total_checks : null

    tiles.push({ date: dateStr, status, uptimePct, totalChecks })
  }

  return tiles
}

/**
 * FIX: "today" never has a daily-rollup row — the rollup cron only aggregates
 * fully-elapsed calendar days (00:15 UTC for the PREVIOUS day), so
 * buildUptimeGrid's last tile is ALWAYS `status: null` ("no data") until
 * midnight, every single day. That gray tile sits immediately next to
 * yesterday's real (possibly colored) tile, and with only a loose "Today"
 * caption below the whole strip (not pointing at one specific tile), it's
 * easy to misread yesterday's status as today's — the exact confusion this
 * fixes. Overrides the LAST tile's status with the component's LIVE current
 * status (already fetched for the pill above the strip), leaving
 * `uptimePct`/`totalChecks` null (there is no historical percentage for an
 * in-progress day — never fabricate one). `uptimeTileText` renders this
 * combination (a real status with a null uptimePct) as "(current, today in
 * progress)", a qualifier no other tile can produce, so hovering it can never
 * be confused with a completed day's rollup reading. `liveStatus: 'unknown'`
 * leaves the tile as the ordinary no-data gray (there is no DayStatus value
 * for 'unknown' — it means the same thing as no data here).
 */
export function withLiveAnchorStatus(
  tiles: UptimeTile[],
  liveStatus: ComponentStatus
): UptimeTile[] {
  if (tiles.length === 0) return tiles
  const lastIndex = tiles.length - 1
  const dayStatus = toDayStatus(liveStatus)
  if (dayStatus === null) return tiles
  return tiles.map((tile, index) =>
    index === lastIndex ? { ...tile, status: dayStatus, uptimePct: null, totalChecks: null } : tile
  )
}

// ---------------------------------------------------------------------------
// Component status coercion
// ---------------------------------------------------------------------------

const KNOWN_COMPONENT_STATUSES: ReadonlySet<string> = new Set<ComponentStatus>([
  'operational',
  'degraded',
  'outage',
  'unknown',
])

/** Graceful fallback to 'unknown' for any unrecognized value — never 'operational'. */
export function coerceComponentStatus(value: unknown): ComponentStatus {
  return typeof value === 'string' && KNOWN_COMPONENT_STATUSES.has(value)
    ? (value as ComponentStatus)
    : 'unknown'
}

// ---------------------------------------------------------------------------
// Labels, classes, icons
// ---------------------------------------------------------------------------

export const STATUS_LABELS: Record<ComponentStatus, string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  outage: 'Outage',
  unknown: 'Unknown',
}

interface PillColorConfig {
  bgColor: string
  textColor: string
  borderColor: string
}

/** Mirrors Badge.astro's tierConfig shape (bgColor/textColor/borderColor triple). */
export const STATUS_PILL_CLASSES: Record<ComponentStatus, PillColorConfig> = {
  operational: {
    bgColor: 'bg-green-500/10',
    textColor: 'text-green-400',
    borderColor: 'border-green-500/30',
  },
  degraded: {
    bgColor: 'bg-yellow-500/10',
    textColor: 'text-yellow-400',
    borderColor: 'border-yellow-500/30',
  },
  outage: {
    bgColor: 'bg-red-500/10',
    textColor: 'text-red-400',
    borderColor: 'border-red-500/30',
  },
  unknown: {
    bgColor: 'bg-gray-500/10',
    textColor: 'text-gray-400',
    borderColor: 'border-gray-500/30',
  },
}

/** heroicons-style outline paths, viewBox 0 0 24 24 (matches Badge.astro's icons). */
export const STATUS_ICONS: Record<ComponentStatus, string> = {
  operational: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
  degraded:
    'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  outage: 'M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  unknown:
    'M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
}

/** Solid tiles for the 90-day uptime strip — keyed by DayStatus only (no 'unknown'). */
export const STATUS_TILE_CLASSES: Record<DayStatus, string> = {
  operational: 'bg-green-500',
  degraded: 'bg-yellow-500',
  outage: 'bg-red-500',
}

/** A calendar day absent from uptime_90d (genuinely no checks ran that day). */
export const NO_DATA_TILE_CLASS = 'bg-gray-700'

/** Mirrors Badge.astro's exact structure. */
export const PILL_BASE = 'inline-flex items-center font-medium rounded-full border'
export const PILL_SIZE: Record<'sm' | 'md', string> = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-2.5 py-1 text-sm',
}
export const PILL_ICON_SIZE: Record<'sm' | 'md', string> = {
  sm: 'w-3 h-3',
  md: 'w-4 h-4',
}

export interface OverallBannerConfig {
  headline: string
  sub: string
  dot: string
  text: string
}

/** `unknown` must read as "Status unavailable" in neutral gray — never look operational. */
export const OVERALL_BANNER: Record<ComponentStatus, OverallBannerConfig> = {
  operational: {
    headline: 'All systems operational',
    sub: 'All Skillsmith services are running normally.',
    dot: 'bg-green-500',
    text: 'text-green-400',
  },
  degraded: {
    headline: 'Partial system disruption',
    sub: 'Some services are experiencing degraded performance.',
    dot: 'bg-yellow-500',
    text: 'text-yellow-400',
  },
  outage: {
    headline: 'Major system outage',
    sub: 'One or more services are currently unavailable.',
    dot: 'bg-red-500',
    text: 'text-red-400',
  },
  unknown: {
    headline: 'Status unavailable',
    sub: "We couldn't load live status data. This page will keep retrying.",
    dot: 'bg-gray-500',
    text: 'text-gray-400',
  },
}

export const IMPACT_LABELS: Record<IncidentImpact, string> = {
  none: 'None',
  minor: 'Minor',
  major: 'Major',
  critical: 'Critical',
}

export const IMPACT_CLASSES: Record<IncidentImpact, string> = {
  none: 'bg-gray-500/10 text-gray-400 border-gray-500/30',
  minor: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30',
  major: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
  critical: 'bg-red-500/10 text-red-400 border-red-500/30',
}

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  investigating: 'Investigating',
  identified: 'Identified',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
}

// ---------------------------------------------------------------------------
// Fixed component scaffold (server-rendered, no-JS baseline)
// ---------------------------------------------------------------------------

export interface ComponentScaffoldEntry {
  slug: string
  name: string
  description: string
}

/** The 6 fixed rows, in display order — used to build the server-rendered scaffold. */
export const COMPONENTS: ComponentScaffoldEntry[] = [
  { slug: 'website', name: 'Website', description: 'www.skillsmith.app and the marketing site' },
  {
    slug: 'search-api',
    name: 'Search API',
    description: 'Skill search, get, and recommend edge functions',
  },
  {
    slug: 'mcp-backend',
    name: 'MCP Backend',
    description: 'MCP server tool calls (search, install, audit, etc.)',
  },
  { slug: 'database', name: 'Database', description: 'Supabase Postgres (skills, users, billing)' },
  {
    slug: 'skill-indexer',
    name: 'Skill Indexer',
    description: 'Registry discovery, metadata refresh, and maintenance jobs',
  },
  {
    slug: 'billing',
    name: 'Billing',
    description: 'Stripe checkout, subscriptions, and invoicing',
  },
]

/** "No data reported." — distinct from a tile's "No data" and a live 'unknown' status (Codex #15). */
export const SCAFFOLD_NO_DATA_MESSAGE = 'No data reported.'

/**
 * Formats an ISO timestamp for human display (locale-aware date + time),
 * never the raw ISO string. Shared by every builder in status-render.ts
 * that surfaces a timestamp (component checked_at, incident started_at/
 * resolved_at, incident-update posted_at) so none of them can independently
 * regress back to displaying a raw ISO string — the bug this function fixes
 * (SMI-5755 follow-up: `checkedAtText`/`startedAtText`/`resolvedAtText`/
 * `postedAtText` were each assigned directly from the raw API string with
 * no formatting at all).
 */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—'
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return '—'
  return parsed.toLocaleString()
}

// ---------------------------------------------------------------------------
// Uptime tile presentation — shared by UptimeBarStrip.astro's SSR render and
// status-client.ts's client-side tile refresh, so the two never drift.
// ---------------------------------------------------------------------------

const UPTIME_TILE_BASE_CLASS = 'h-6 w-1.5 rounded-sm sm:w-2'

export function uptimeTileClassName(status: DayStatus | null): string {
  const fill = status ? STATUS_TILE_CLASSES[status] : NO_DATA_TILE_CLASS
  return `${UPTIME_TILE_BASE_CLASS} ${fill}`
}

/** "No data" (a calendar day with no checks) — distinct from STATUS_LABELS.unknown (Codex #15). */
export function uptimeTileText(tile: UptimeTile): string {
  if (tile.status === null) return `${tile.date}: No data`
  // A real status with a null uptimePct only ever comes from
  // withLiveAnchorStatus's live override on today's tile (every OTHER tile
  // either has a real rollup percentage or is no-data) — the qualifier makes
  // this unambiguous on hover, never mistakable for a completed day's rollup.
  if (tile.uptimePct === null)
    return `${tile.date}: ${STATUS_LABELS[tile.status]} (current, today in progress)`
  return `${tile.date}: ${STATUS_LABELS[tile.status]} (${tile.uptimePct.toFixed(2)}% uptime)`
}

/**
 * The `role="group"` uptime strip's own accessible summary — "X
 * operational, Y degraded, Z outage, W no data". Shared by
 * UptimeBarStrip.astro's SSR render AND status-render.ts's client-side
 * `refreshUptimeStripTiles` refresh path so the two can never drift (FIX,
 * medium: previously computed only once at SSR time from the empty
 * scaffold, then never recomputed after live data painted).
 */
export function buildUptimeStripAriaLabel(tiles: UptimeTile[], label: string): string {
  const counts = tiles.reduce(
    (acc, tile) => {
      if (tile.status === null) acc.noData += 1
      else acc[tile.status] += 1
      return acc
    },
    { operational: 0, degraded: 0, outage: 0, noData: 0 }
  )
  return (
    `${label}: 90-day uptime — ${counts.operational} operational, ${counts.degraded} degraded, ` +
    `${counts.outage} outage, ${counts.noData} no data`
  )
}
