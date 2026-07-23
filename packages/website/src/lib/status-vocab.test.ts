import { describe, it, expect } from 'vitest'
import {
  buildUptimeGrid,
  buildUptimeStripAriaLabel,
  coerceComponentStatus,
  COMPONENTS,
  formatTimestamp,
  isFiniteNumber,
  isNonNegativeInteger,
  isValidDayString,
  NO_DATA_TILE_CLASS,
  OVERALL_BANNER,
  SCAFFOLD_NO_DATA_MESSAGE,
  STATUS_LABELS,
  STATUS_PILL_CLASSES,
  STATUS_TILE_CLASSES,
  uptimeTileText,
  withLiveAnchorStatus,
  type ComponentStatus,
  type DayStatus,
  type UptimeDay,
} from './status-vocab'

const ANCHOR = '2026-07-15' // arbitrary fixed calendar date, well within a plausible UTC day

function makeDay(day: string, overrides: Partial<UptimeDay> = {}): UptimeDay {
  return {
    day,
    uptime_pct: 99.9,
    worst_status: 'operational',
    total_checks: 288,
    ...overrides,
  }
}

describe('buildUptimeGrid', () => {
  it('returns exactly 90 tiles, oldest first, anchor day last', () => {
    const tiles = buildUptimeGrid([], ANCHOR)
    expect(tiles).toHaveLength(90)
    expect(tiles[89].date).toBe(ANCHOR)
    // Oldest tile is 89 days before the anchor.
    expect(tiles[0].date).toBe('2026-04-17')
  })

  it('is anchored to the supplied ISO date, not the system clock (Codex #6)', () => {
    // Regardless of when the test runs, the grid must reflect the anchor we
    // pass in, never Date.now()/local "today".
    const tiles = buildUptimeGrid([], '2020-01-01')
    expect(tiles[89].date).toBe('2020-01-01')
    expect(tiles[0].date).toBe('2019-10-04')
  })

  it('walks across a month/year boundary correctly using UTC arithmetic', () => {
    const tiles = buildUptimeGrid([], '2026-01-01')
    expect(tiles[89].date).toBe('2026-01-01')
    expect(tiles[88].date).toBe('2025-12-31')
    expect(tiles[0].date).toBe('2025-10-04')
  })

  it('places a present day at the correct tile with its real status/uptime', () => {
    const tiles = buildUptimeGrid(
      [makeDay(ANCHOR, { worst_status: 'degraded', uptime_pct: 87.5 })],
      ANCHOR
    )
    const anchorTile = tiles[89]
    expect(anchorTile.status).toBe('degraded')
    expect(anchorTile.uptimePct).toBe(87.5)
  })

  it('a day absent from uptime_90d renders as no-data (status null), never fabricated', () => {
    const tiles = buildUptimeGrid([], ANCHOR)
    for (const tile of tiles) {
      expect(tile.status).toBeNull()
      expect(tile.uptimePct).toBeNull()
    }
  })

  it('FIX (Codex #6/#9): a malformed `day` string is skipped, not silently mismatched', () => {
    const tiles = buildUptimeGrid(
      [
        makeDay('not-a-date'),
        makeDay('2026-13-40'), // wrong format, still matches nothing real
        makeDay(ANCHOR, { worst_status: 'outage' }),
      ],
      ANCHOR
    )
    // The malformed entries must not corrupt the anchor day's real entry.
    expect(tiles[89].status).toBe('outage')
    // And they must not appear as a spurious tile anywhere in the grid.
    expect(tiles.some((t) => t.date === 'not-a-date')).toBe(false)
  })

  it('FIX (Codex #6): a duplicate valid day key is last-one-wins (documented, low-risk default)', () => {
    const tiles = buildUptimeGrid(
      [
        makeDay(ANCHOR, { worst_status: 'operational', uptime_pct: 100 }),
        makeDay(ANCHOR, { worst_status: 'outage', uptime_pct: 12.3 }),
      ],
      ANCHOR
    )
    expect(tiles[89].status).toBe('outage')
    expect(tiles[89].uptimePct).toBe(12.3)
  })

  it('FIX (high): an invalid uptime_pct forces the WHOLE day to no-data, never a fake green tile', () => {
    const tiles = buildUptimeGrid(
      [makeDay(ANCHOR, { uptime_pct: null as unknown as number, worst_status: 'operational' })],
      ANCHOR
    )
    // Previously: the day's `worst_status` was kept ('operational') while
    // only `uptime_pct` fell back to null -- rendering a plain green
    // "Operational" tile with no percentage shown instead of "No data". A
    // corrupted uptime_pct signals the whole rollup row can't be trusted,
    // not just this one field, so BOTH must resolve to no-data now.
    expect(tiles[89].status).toBeNull()
    expect(tiles[89].uptimePct).toBeNull()
  })

  it('FIX (Codex #9): empty-string uptime_pct also forces no-data, never a fake 0%', () => {
    const tiles = buildUptimeGrid(
      [makeDay(ANCHOR, { uptime_pct: '' as unknown as number })],
      ANCHOR
    )
    expect(tiles[89].status).toBeNull()
    expect(tiles[89].uptimePct).toBeNull()
  })

  it('clamps an out-of-range but numeric uptime_pct into [0, 100]', () => {
    const tiles = buildUptimeGrid([makeDay(ANCHOR, { uptime_pct: 150 })], ANCHOR)
    expect(tiles[89].uptimePct).toBe(100)
    const tilesNeg = buildUptimeGrid([makeDay(ANCHOR, { uptime_pct: -10 })], ANCHOR)
    expect(tilesNeg[89].uptimePct).toBe(0)
  })

  it('validates total_checks as a non-negative finite integer, falling back to null', () => {
    const tiles = buildUptimeGrid(
      [makeDay(ANCHOR, { total_checks: -5 as unknown as number })],
      ANCHOR
    )
    expect(tiles[89].totalChecks).toBeNull()

    const tilesNonInt = buildUptimeGrid(
      [makeDay(ANCHOR, { total_checks: 1.5 as unknown as number })],
      ANCHOR
    )
    expect(tilesNonInt[89].totalChecks).toBeNull()

    const tilesGood = buildUptimeGrid([makeDay(ANCHOR, { total_checks: 288 })], ANCHOR)
    expect(tilesGood[89].totalChecks).toBe(288)
  })

  it('an unrecognized worst_status coerces the tile status to null (no-data), not a guess', () => {
    const tiles = buildUptimeGrid(
      [makeDay(ANCHOR, { worst_status: 'bogus' as unknown as DayStatus })],
      ANCHOR
    )
    expect(tiles[89].status).toBeNull()
  })

  it('returns an empty array for a malformed anchorIsoDate rather than throwing', () => {
    expect(buildUptimeGrid([], 'not-a-date')).toEqual([])
    expect(buildUptimeGrid([], '')).toEqual([])
  })
})

describe('isValidDayString / isFiniteNumber / isNonNegativeInteger', () => {
  it('accepts only YYYY-MM-DD strings', () => {
    expect(isValidDayString('2026-01-01')).toBe(true)
    expect(isValidDayString('2026-1-1')).toBe(false)
    expect(isValidDayString(20260101)).toBe(false)
    expect(isValidDayString(null)).toBe(false)
    expect(isValidDayString(undefined)).toBe(false)
  })

  it('isFiniteNumber rejects null/NaN/Infinity/strings', () => {
    expect(isFiniteNumber(1)).toBe(true)
    expect(isFiniteNumber(0)).toBe(true)
    expect(isFiniteNumber(null)).toBe(false)
    expect(isFiniteNumber(undefined)).toBe(false)
    expect(isFiniteNumber(Number.NaN)).toBe(false)
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isFiniteNumber('1')).toBe(false)
  })

  it('isNonNegativeInteger rejects negatives and non-integers', () => {
    expect(isNonNegativeInteger(0)).toBe(true)
    expect(isNonNegativeInteger(42)).toBe(true)
    expect(isNonNegativeInteger(-1)).toBe(false)
    expect(isNonNegativeInteger(1.5)).toBe(false)
    expect(isNonNegativeInteger(null)).toBe(false)
  })
})

describe('coerceComponentStatus', () => {
  it('passes through known statuses unchanged', () => {
    for (const status of ['operational', 'degraded', 'outage', 'unknown'] as ComponentStatus[]) {
      expect(coerceComponentStatus(status)).toBe(status)
    }
  })

  it('falls back to unknown for any unrecognized value -- never operational', () => {
    expect(coerceComponentStatus('healthy')).toBe('unknown')
    expect(coerceComponentStatus(null)).toBe('unknown')
    expect(coerceComponentStatus(undefined)).toBe('unknown')
    expect(coerceComponentStatus(1)).toBe('unknown')
    expect(coerceComponentStatus('<script>alert(1)</script>')).toBe('unknown')
  })
})

describe('vocab coverage', () => {
  const ALL_COMPONENT_STATUSES: ComponentStatus[] = ['operational', 'degraded', 'outage', 'unknown']
  const ALL_DAY_STATUSES: DayStatus[] = ['operational', 'degraded', 'outage']

  it('STATUS_LABELS / STATUS_PILL_CLASSES / OVERALL_BANNER cover exactly the 4 ComponentStatus values', () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([...ALL_COMPONENT_STATUSES].sort())
    expect(Object.keys(STATUS_PILL_CLASSES).sort()).toEqual([...ALL_COMPONENT_STATUSES].sort())
    expect(Object.keys(OVERALL_BANNER).sort()).toEqual([...ALL_COMPONENT_STATUSES].sort())
  })

  it('STATUS_TILE_CLASSES covers exactly the 3 DayStatus values (no "unknown" key)', () => {
    expect(Object.keys(STATUS_TILE_CLASSES).sort()).toEqual([...ALL_DAY_STATUSES].sort())
    expect(STATUS_TILE_CLASSES).not.toHaveProperty('unknown')
  })

  it('unknown overall banner reads as neutral "Status unavailable", never operational-looking', () => {
    expect(OVERALL_BANNER.unknown.headline).toBe('Status unavailable')
    expect(OVERALL_BANNER.unknown.dot).toContain('gray')
    expect(OVERALL_BANNER.unknown.text).toContain('gray')
    expect(OVERALL_BANNER.unknown.headline).not.toBe(OVERALL_BANNER.operational.headline)
  })

  it('COMPONENTS has exactly the 6 fixed rows', () => {
    expect(COMPONENTS).toHaveLength(6)
    expect(COMPONENTS.map((c) => c.slug)).toEqual([
      'website',
      'search-api',
      'mcp-backend',
      'database',
      'skill-indexer',
      'billing',
    ])
  })

  it('FIX (Codex #15): the three "no data"-ish strings are textually distinct', () => {
    const noDataTileText = uptimeTileText({
      date: ANCHOR,
      status: null,
      uptimePct: null,
      totalChecks: null,
    })
    expect(noDataTileText).toContain('No data')
    expect(STATUS_LABELS.unknown).toBe('Unknown')
    expect(SCAFFOLD_NO_DATA_MESSAGE).toBe('No data reported.')

    const distinctStrings = new Set([
      noDataTileText,
      STATUS_LABELS.unknown,
      SCAFFOLD_NO_DATA_MESSAGE,
    ])
    expect(distinctStrings.size).toBe(3)
  })

  it('NO_DATA_TILE_CLASS is a solid gray fill (no border utility)', () => {
    expect(NO_DATA_TILE_CLASS).toBe('bg-gray-700')
    expect(NO_DATA_TILE_CLASS).not.toContain('border')
  })
})

describe('buildUptimeStripAriaLabel', () => {
  it('counts tiles into operational/degraded/outage/no-data buckets', () => {
    const tiles = buildUptimeGrid(
      [
        makeDay('2026-07-14', { worst_status: 'degraded' }),
        makeDay('2026-07-13', { worst_status: 'outage' }),
      ],
      ANCHOR
    )
    const label = buildUptimeStripAriaLabel(tiles, 'Website')
    expect(label).toBe('Website: 90-day uptime — 0 operational, 1 degraded, 1 outage, 88 no data')
  })

  it('an all-empty grid (SSR scaffold, no live data yet) reads as entirely no-data', () => {
    const tiles = buildUptimeGrid([], ANCHOR)
    const label = buildUptimeStripAriaLabel(tiles, 'Website')
    expect(label).toBe('Website: 90-day uptime — 0 operational, 0 degraded, 0 outage, 90 no data')
  })

  it('reflects the supplied label, not a hardcoded one', () => {
    const tiles = buildUptimeGrid([], ANCHOR)
    expect(buildUptimeStripAriaLabel(tiles, 'Search API')).toContain('Search API: 90-day uptime')
  })
})

// ---------------------------------------------------------------------------
// formatTimestamp (SMI-5755 follow-up fix — checked_at/started_at/resolved_at/
// posted_at were each displayed as raw, unreadable ISO strings)
// ---------------------------------------------------------------------------

describe('formatTimestamp', () => {
  it('formats a valid ISO timestamp as a locale-aware string, never the raw ISO form', () => {
    const result = formatTimestamp('2026-07-15T12:34:56Z')
    expect(result).not.toBe('2026-07-15T12:34:56Z')
    expect(result).not.toContain('T')
    expect(result.length).toBeGreaterThan(0)
  })

  it('returns the em-dash placeholder for null/undefined/empty input', () => {
    expect(formatTimestamp(null)).toBe('—')
    expect(formatTimestamp(undefined)).toBe('—')
    expect(formatTimestamp('')).toBe('—')
  })

  it('returns the em-dash placeholder for an unparseable string, never "Invalid Date"', () => {
    expect(formatTimestamp('not-a-real-date')).toBe('—')
  })
})

// ---------------------------------------------------------------------------
// withLiveAnchorStatus (UX follow-up: today always has no rollup row until
// 00:15 UTC the next day, so it was previously perpetually gray — easily
// misread as yesterday's real, colored tile right next to it)
// ---------------------------------------------------------------------------

describe('withLiveAnchorStatus', () => {
  it("overrides only the LAST (today) tile with the component's live status", () => {
    const tiles = buildUptimeGrid(
      [makeDay('2026-07-14', { worst_status: 'degraded', uptime_pct: 90 })],
      ANCHOR
    )
    const result = withLiveAnchorStatus(tiles, 'operational')
    expect(result[89].status).toBe('operational')
    // Yesterday's real rollup tile is untouched.
    expect(result[88].status).toBe('degraded')
    expect(result[88].uptimePct).toBe(90)
  })

  it("today's overridden tile never carries a fabricated percentage", () => {
    const tiles = buildUptimeGrid([], ANCHOR)
    const result = withLiveAnchorStatus(tiles, 'outage')
    expect(result[89].status).toBe('outage')
    expect(result[89].uptimePct).toBeNull()
    expect(result[89].totalChecks).toBeNull()
  })

  it("a live status of 'unknown' leaves today as ordinary no-data (there is no DayStatus for it)", () => {
    const tiles = buildUptimeGrid([], ANCHOR)
    const result = withLiveAnchorStatus(tiles, 'unknown')
    expect(result[89].status).toBeNull()
  })

  it('does not throw on an empty tile array', () => {
    expect(withLiveAnchorStatus([], 'operational')).toEqual([])
  })

  it("uptimeTileText renders the override as 'current, today in progress', not a fake percentage", () => {
    const tiles = buildUptimeGrid([], ANCHOR)
    const result = withLiveAnchorStatus(tiles, 'degraded')
    expect(uptimeTileText(result[89])).toBe(`${ANCHOR}: Degraded (current, today in progress)`)
  })

  it('a completed day with a real percentage is unaffected by the qualifier', () => {
    const tiles = buildUptimeGrid([makeDay(ANCHOR, { uptime_pct: 99.5 })], '2026-07-16')
    // ANCHOR (2026-07-15) is now yesterday relative to the new anchor 2026-07-16.
    const yesterday = tiles.find((t) => t.date === ANCHOR)!
    expect(uptimeTileText(yesterday)).toContain('99.50% uptime')
    expect(uptimeTileText(yesterday)).not.toContain('current')
  })
})
