import { describe, it, expect } from 'vitest'
import {
  readCachedStatusPayload,
  STATUS_CACHE_KEY,
  STATUS_CACHE_TTL_MS,
  validateStatusPayload,
  writeCachedStatusPayload,
} from './status-payload'
import { buildUptimeGrid } from './status-vocab'

const ADVERSARIAL = '<script>alert(1)</script>'

// ---------------------------------------------------------------------------
// validateStatusPayload
// ---------------------------------------------------------------------------

describe('validateStatusPayload', () => {
  it('accepts a well-formed payload and preserves untrusted text unchanged', () => {
    const raw = {
      cached: false,
      data: {
        generated_at: '2026-07-15T00:00:00Z',
        overall_status: 'operational',
        components: [
          {
            slug: 'website',
            name: ADVERSARIAL,
            description: '',
            display_order: 0,
            status: 'operational',
            latency_ms: 12,
            message: ADVERSARIAL,
            checked_at: null,
            uptime_90d: [],
          },
        ],
        incidents: [
          {
            id: 'inc-1',
            title: ADVERSARIAL,
            impact: 'major',
            status: 'monitoring',
            started_at: '2026-07-15T00:00:00Z',
            resolved_at: null,
            affected_components: ['website'],
            updates: [
              { status: 'monitoring', message: ADVERSARIAL, posted_at: '2026-07-15T00:00:00Z' },
            ],
          },
        ],
      },
    }
    const result = validateStatusPayload(raw)
    expect(result).not.toBeNull()
    expect(result!.data.components[0].name).toBe(ADVERSARIAL)
    expect(result!.data.components[0].message).toBe(ADVERSARIAL)
    expect(result!.data.incidents[0].title).toBe(ADVERSARIAL)
    expect(result!.data.incidents[0].updates[0].message).toBe(ADVERSARIAL)
  })

  it('FIX (Codex #8): rejects a payload whose components is not an array (structural failure)', () => {
    expect(
      validateStatusPayload({
        cached: false,
        data: {
          generated_at: '',
          overall_status: 'operational',
          components: 'not-an-array',
          incidents: [],
        },
      })
    ).toBeNull()
  })

  it('FIX (Codex #8): rejects a payload whose incidents is not an array', () => {
    expect(
      validateStatusPayload({
        cached: false,
        data: { generated_at: '', overall_status: 'operational', components: [], incidents: {} },
      })
    ).toBeNull()
  })

  it('rejects non-object top-level and missing data', () => {
    expect(validateStatusPayload(null)).toBeNull()
    expect(validateStatusPayload('a string')).toBeNull()
    expect(validateStatusPayload([])).toBeNull()
    expect(validateStatusPayload({ cached: true })).toBeNull()
  })

  it('coerces an unrecognized overall_status to unknown rather than rejecting', () => {
    const result = validateStatusPayload({
      cached: false,
      data: {
        generated_at: '2026-07-15T00:00:00Z',
        overall_status: 'totally-fine',
        components: [],
        incidents: [],
      },
    })
    expect(result!.data.overall_status).toBe('unknown')
  })

  it('drops a component missing a valid slug rather than invalidating the whole payload', () => {
    const result = validateStatusPayload({
      cached: false,
      data: {
        generated_at: '',
        overall_status: 'operational',
        components: [{ name: 'no slug here' }, { slug: 'ok', name: 'Ok' }],
        incidents: [],
      },
    })
    expect(result!.data.components).toHaveLength(1)
    expect(result!.data.components[0].slug).toBe('ok')
  })

  it('drops an incident missing a valid id', () => {
    const result = validateStatusPayload({
      cached: false,
      data: {
        generated_at: '',
        overall_status: 'operational',
        components: [],
        incidents: [{ title: 'no id' }],
      },
    })
    expect(result!.data.incidents).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// End-to-end: validateStatusPayload -> buildUptimeGrid (FIX, high) — a
// malformed uptime_pct must never survive the real pipeline as a fake green
// "Operational" tile. Exercised through the ACTUAL payload-validation path
// (not a pre-sanitized object handed directly to buildUptimeGrid), since
// sanitizeUptimeDay (status-payload.ts) deliberately lets a malformed
// uptime_pct through as NaN rather than dropping the whole day entry -- the
// real fix lives downstream in buildUptimeGrid.
// ---------------------------------------------------------------------------

describe('validateStatusPayload -> buildUptimeGrid pipeline (Fix: no fake-green tile)', () => {
  const ANCHOR = '2026-07-15'

  it('a malformed uptime_pct survives payload validation but resolves as no-data through the real pipeline', () => {
    const raw = {
      cached: false,
      data: {
        generated_at: `${ANCHOR}T00:00:00Z`,
        overall_status: 'operational',
        components: [
          {
            slug: 'website',
            name: 'Website',
            description: '',
            display_order: 0,
            status: 'operational',
            latency_ms: 10,
            message: '',
            checked_at: null,
            uptime_90d: [
              {
                day: ANCHOR,
                uptime_pct: 'not-a-number', // malformed
                worst_status: 'operational', // genuinely valid on its own
                total_checks: 288,
              },
            ],
          },
        ],
        incidents: [],
      },
    }

    const validated = validateStatusPayload(raw)
    expect(validated).not.toBeNull()

    const uptime90d = validated!.data.components[0].uptime_90d
    // sanitizeUptimeDay lets the malformed entry through (day is valid, so
    // uptime_pct falls back to NaN rather than dropping the whole entry).
    expect(uptime90d).toHaveLength(1)

    const tiles = buildUptimeGrid(uptime90d, ANCHOR)
    const anchorTile = tiles[89]
    expect(anchorTile.date).toBe(ANCHOR)
    // Must render as "No data" -- never a fabricated green "Operational"
    // tile just because worst_status happened to still look valid.
    expect(anchorTile.status).toBeNull()
    expect(anchorTile.uptimePct).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// localStorage cache (Codex #7, #10)
// ---------------------------------------------------------------------------

describe('readCachedStatusPayload / writeCachedStatusPayload', () => {
  it('round-trips a valid payload written just now', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    }
    const payload = validateStatusPayload({
      cached: false,
      data: { generated_at: 'x', overall_status: 'operational', components: [], incidents: [] },
    })!
    writeCachedStatusPayload(storage, payload)
    expect(readCachedStatusPayload(storage)).toEqual(payload)
  })

  it('FIX (Codex #7): applies the same validation to a cached blob as a network response', () => {
    const store = new Map<string, string>([
      [
        STATUS_CACHE_KEY,
        JSON.stringify({
          cachedAt: Date.now(),
          payload: { cached: true, data: { components: 'nope', incidents: [] } },
        }),
      ],
    ])
    const storage = { getItem: (k: string) => store.get(k) ?? null }
    expect(readCachedStatusPayload(storage)).toBeNull()
  })

  it('discards unparseable JSON without throwing', () => {
    const store = new Map<string, string>([[STATUS_CACHE_KEY, 'not json{{']])
    const storage = { getItem: (k: string) => store.get(k) ?? null }
    expect(readCachedStatusPayload(storage)).toBeNull()
  })

  it('a storage.getItem that throws is handled (private-browsing/quota)', () => {
    const storage = {
      getItem: () => {
        throw new Error('boom')
      },
    }
    expect(readCachedStatusPayload(storage)).toBeNull()
  })

  it('a storage.setItem that throws does not propagate', () => {
    const storage = {
      setItem: () => {
        throw new Error('quota exceeded')
      },
    }
    const payload = validateStatusPayload({
      cached: false,
      data: { generated_at: '', overall_status: 'operational', components: [], incidents: [] },
    })!
    expect(() => writeCachedStatusPayload(storage, payload)).not.toThrow()
  })

  it('FIX (Codex #10): rejects a legacy bare-payload entry (pre-TTL v2 shape) as a miss, not a crash', () => {
    const store = new Map<string, string>([
      [
        STATUS_CACHE_KEY,
        JSON.stringify({
          cached: false,
          data: { generated_at: 'x', overall_status: 'operational', components: [], incidents: [] },
        }),
      ],
    ])
    const storage = { getItem: (k: string) => store.get(k) ?? null }
    expect(readCachedStatusPayload(storage)).toBeNull()
  })

  it('FIX (Codex #10, "Expire stale cached data"): an entry older than the TTL is treated as a miss', () => {
    const payload = validateStatusPayload({
      cached: false,
      data: { generated_at: 'x', overall_status: 'operational', components: [], incidents: [] },
    })!
    const store = new Map<string, string>([
      [
        STATUS_CACHE_KEY,
        JSON.stringify({ cachedAt: Date.now() - STATUS_CACHE_TTL_MS - 1, payload }),
      ],
    ])
    const storage = { getItem: (k: string) => store.get(k) ?? null }
    expect(readCachedStatusPayload(storage)).toBeNull()
  })

  it('an entry within the TTL is still used', () => {
    const payload = validateStatusPayload({
      cached: false,
      data: { generated_at: 'x', overall_status: 'operational', components: [], incidents: [] },
    })!
    const store = new Map<string, string>([
      [
        STATUS_CACHE_KEY,
        JSON.stringify({ cachedAt: Date.now() - (STATUS_CACHE_TTL_MS - 1000), payload }),
      ],
    ])
    const storage = { getItem: (k: string) => store.get(k) ?? null }
    expect(readCachedStatusPayload(storage)).toEqual(payload)
  })

  it('a malformed cachedAt (non-numeric) is treated as a miss', () => {
    const payload = validateStatusPayload({
      cached: false,
      data: { generated_at: 'x', overall_status: 'operational', components: [], incidents: [] },
    })!
    const store = new Map<string, string>([
      [STATUS_CACHE_KEY, JSON.stringify({ cachedAt: 'not-a-number', payload })],
    ])
    const storage = { getItem: (k: string) => store.get(k) ?? null }
    expect(readCachedStatusPayload(storage)).toBeNull()
  })
})
