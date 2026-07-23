/**
 * Status page payload validation + localStorage cache (SMI-5755, Wave 5).
 * Split out of status-client.ts to stay under the repo's 500-line-per-file
 * gate — see status-client.ts's barrel re-export + header comment for the
 * full module-split rationale.
 */

import {
  coerceComponentStatus,
  isFiniteNumber,
  isNonNegativeInteger,
  type StatusComponent,
  type StatusData,
  type StatusIncident,
  type StatusResponse,
  type UptimeDay,
} from './status-vocab'

// ---------------------------------------------------------------------------
// Payload validation (Codex #7, #8) — applied identically to a fresh network
// response AND to a `localStorage`-cached blob. Structural failures (missing/
// non-array `components`/`incidents`) invalidate the WHOLE payload (return
// null) rather than partially repainting; per-field enum values are coerced
// to 'unknown' rather than hard-failing the payload.
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeUptimeDay(raw: unknown): UptimeDay | null {
  if (!isPlainObject(raw)) return null
  if (typeof raw.day !== 'string') return null
  return {
    day: raw.day,
    uptime_pct: isFiniteNumber(raw.uptime_pct) ? raw.uptime_pct : Number.NaN,
    worst_status:
      raw.worst_status === 'operational' ||
      raw.worst_status === 'degraded' ||
      raw.worst_status === 'outage'
        ? raw.worst_status
        : 'operational',
    total_checks: isNonNegativeInteger(raw.total_checks) ? raw.total_checks : 0,
  }
}

function sanitizeComponent(raw: unknown): StatusComponent | null {
  if (!isPlainObject(raw)) return null
  if (typeof raw.slug !== 'string' || raw.slug.length === 0) return null
  const uptimeRaw = Array.isArray(raw.uptime_90d) ? raw.uptime_90d : []
  return {
    slug: raw.slug,
    name: typeof raw.name === 'string' ? raw.name : raw.slug,
    description: typeof raw.description === 'string' ? raw.description : '',
    display_order: typeof raw.display_order === 'number' ? raw.display_order : 0,
    status: coerceComponentStatus(raw.status),
    latency_ms: isFiniteNumber(raw.latency_ms) ? raw.latency_ms : null,
    message: typeof raw.message === 'string' ? raw.message : '',
    checked_at: typeof raw.checked_at === 'string' ? raw.checked_at : null,
    uptime_90d: uptimeRaw.map(sanitizeUptimeDay).filter((d): d is UptimeDay => d !== null),
  }
}

const KNOWN_INCIDENT_STATUSES = new Set(['investigating', 'identified', 'monitoring', 'resolved'])
const KNOWN_IMPACTS = new Set(['none', 'minor', 'major', 'critical'])

function sanitizeIncident(raw: unknown): StatusIncident | null {
  if (!isPlainObject(raw)) return null
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null
  const updatesRaw = Array.isArray(raw.updates) ? raw.updates : []
  const updates = updatesRaw.filter(isPlainObject).map((u) => ({
    status: KNOWN_INCIDENT_STATUSES.has(String(u.status))
      ? (u.status as StatusIncident['status'])
      : 'investigating',
    message: typeof u.message === 'string' ? u.message : '',
    posted_at: typeof u.posted_at === 'string' ? u.posted_at : '',
  }))
  return {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : '',
    impact: KNOWN_IMPACTS.has(String(raw.impact))
      ? (raw.impact as StatusIncident['impact'])
      : 'none',
    status: KNOWN_INCIDENT_STATUSES.has(String(raw.status))
      ? (raw.status as StatusIncident['status'])
      : 'investigating',
    started_at: typeof raw.started_at === 'string' ? raw.started_at : '',
    resolved_at: typeof raw.resolved_at === 'string' ? raw.resolved_at : null,
    affected_components: Array.isArray(raw.affected_components)
      ? raw.affected_components.filter((s): s is string => typeof s === 'string')
      : [],
    updates,
  }
}

/**
 * Validates+sanitizes an unknown blob (network JSON or a `localStorage`
 * cache read) into a well-formed `StatusResponse`, or `null` if the payload
 * is structurally invalid. A `null` result must be treated the same as a
 * fetch failure by the caller — never partially repaint from an invalid
 * shape (Codex #8).
 */
export function validateStatusPayload(raw: unknown): StatusResponse | null {
  if (!isPlainObject(raw)) return null
  if (!isPlainObject(raw.data)) return null
  const data = raw.data
  if (!Array.isArray(data.components)) return null
  if (!Array.isArray(data.incidents)) return null

  const components = data.components
    .map(sanitizeComponent)
    .filter((c): c is StatusComponent => c !== null)
  const incidents = data.incidents
    .map(sanitizeIncident)
    .filter((i): i is StatusIncident => i !== null)

  const sanitizedData: StatusData = {
    generated_at: typeof data.generated_at === 'string' ? data.generated_at : '',
    overall_status: coerceComponentStatus(data.overall_status),
    components,
    incidents,
  }

  return {
    cached: raw.cached === true,
    data: sanitizedData,
  }
}

// ---------------------------------------------------------------------------
// localStorage cache (Codex #7 + #10) — cache key bumped to v3 (envelope shape
// changed: a bare payload is no longer valid, so v2 entries are naturally
// discarded rather than partially trusted). Every read/write independently
// wrapped in its own try/catch (existing convention).
//
// FIX (Codex #10, high, "Expire stale cached data"): mirrors index.astro's
// existing `{ ..., timestamp }` + `Date.now() - timestamp < CACHE_TTL` pattern
// (see index.astro's CACHE_TTL = 5 * 60 * 1000 for skill/GitHub counts) with a
// shorter TTL appropriate to a live status page — an unbounded-age cached
// payload could otherwise paint arbitrarily stale "all operational" data
// indefinitely for a returning visitor before the first live poll resolves.
// ---------------------------------------------------------------------------

export const STATUS_CACHE_KEY = 'skillsmith_status_v3'

/** Slightly above the 45s poll interval — only bridges the instant-paint gap
 * before the first live poll resolves, never substitutes for one. */
export const STATUS_CACHE_TTL_MS = 60_000

interface CachedEnvelope {
  cachedAt: number
  payload: unknown
}

function isCachedEnvelope(value: unknown): value is CachedEnvelope {
  return (
    isPlainObject(value) && typeof value.cachedAt === 'number' && Number.isFinite(value.cachedAt)
  )
}

export function readCachedStatusPayload(storage: Pick<Storage, 'getItem'>): StatusResponse | null {
  try {
    const raw = storage.getItem(STATUS_CACHE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isCachedEnvelope(parsed)) return null
    if (Date.now() - parsed.cachedAt > STATUS_CACHE_TTL_MS) return null // expired (Codex #10)
    return validateStatusPayload(parsed.payload)
  } catch {
    return null
  }
}

export function writeCachedStatusPayload(
  storage: Pick<Storage, 'setItem'>,
  payload: StatusResponse
): void {
  try {
    const envelope: CachedEnvelope = { cachedAt: Date.now(), payload }
    storage.setItem(STATUS_CACHE_KEY, JSON.stringify(envelope))
  } catch {
    // Storage full/unavailable (private browsing, quota) — non-fatal.
  }
}
