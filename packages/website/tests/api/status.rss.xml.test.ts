import { describe, it, expect, vi, afterEach } from 'vitest'
import type { APIContext } from 'astro'
import rss from '@astrojs/rss'
import { GET } from '../../src/pages/status.rss.xml'

// FIX (high): wraps the REAL @astrojs/rss implementation by default (so
// every existing test below is unaffected) but lets one test below force
// the library itself to throw on a specific call — proving the fallback
// path (the catch block's own "empty feed" rss() call) can no longer
// escape as an uncaught rejection.
vi.mock('@astrojs/rss', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof rss }>()
  return { default: vi.fn(actual.default) }
})

const SITE = new URL('https://www.skillsmith.app')

function makeContext(): APIContext {
  return { site: SITE } as APIContext
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

// SMI-5812: a single regex verifying href/rel/type are all attributes on ONE
// <atom:link> element (not three independent substrings that could exist
// unrelated to each other, e.g. on different elements). Attribute order
// (href, rel, type) verified empirically against the actual serialized
// output of @astrojs/rss@4.0.19 with this code's customData string, and it
// matches the STATIC_FALLBACK_RSS_XML literal in status.rss.xml.ts exactly.
const ATOM_SELF_LINK_RE =
  /<atom:link[^>]*href="https:\/\/www\.skillsmith\.app\/status\.rss\.xml"[^>]*rel="self"[^>]*type="application\/rss\+xml"[^>]*\/>/

function expectAtomSelfLink(xml: string): void {
  expect(xml).toMatch(ATOM_SELF_LINK_RE)
  // The atom namespace declaration must be on the root <rss> element.
  expect(xml).toMatch(/<rss[^>]*xmlns:atom="http:\/\/www\.w3\.org\/2005\/Atom"[^>]*>/)
}

async function parseItems(
  xml: string
): Promise<{ titles: string[]; links: string[]; guids: string[] }> {
  const titles = [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>/g)].map((m) => m[1])
  const links = [...xml.matchAll(/<item>[\s\S]*?<link>([\s\S]*?)<\/link>/g)].map((m) => m[1])
  const guids = [...xml.matchAll(/<guid[^>]*>([\s\S]*?)<\/guid>/g)].map((m) => m[1])
  return { titles, links, guids }
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function mockFetchJson(payload: unknown, ok = true, status = 200): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => payload,
  }) as unknown as typeof fetch
}

const VALID_PAYLOAD = {
  cached: false,
  data: {
    generated_at: '2026-07-15T12:00:00Z',
    overall_status: 'operational',
    components: [],
    incidents: [
      {
        id: 'inc-older',
        title: 'Older incident',
        impact: 'minor',
        status: 'resolved',
        started_at: '2026-07-10T00:00:00Z',
        resolved_at: '2026-07-10T02:00:00Z',
        affected_components: ['website'],
        updates: [
          {
            status: 'investigating',
            message: 'Looking into it.',
            posted_at: '2026-07-10T00:00:00Z',
          },
          { status: 'resolved', message: 'Fixed.', posted_at: '2026-07-10T02:00:00Z' },
        ],
      },
      {
        id: 'inc-newer',
        title: 'Newer incident',
        impact: 'major',
        status: 'monitoring',
        started_at: '2026-07-15T00:00:00Z',
        resolved_at: null,
        affected_components: ['search-api'],
        updates: [
          {
            status: 'investigating',
            message: 'Newer investigating.',
            posted_at: '2026-07-15T00:00:00Z',
          },
          { status: 'monitoring', message: 'Newer monitoring.', posted_at: '2026-07-15T01:00:00Z' },
        ],
      },
    ],
  },
}

describe('status.rss.xml GET', () => {
  it('FIX (Codex #12): emits one item PER incident update, not one per incident', async () => {
    mockFetchJson(VALID_PAYLOAD)
    const response = await GET(makeContext())
    expect(response.status).toBe(200)
    const xml = await response.text()
    expect(countOccurrences(xml, '<item>')).toBe(4) // 2 incidents x 2 updates each
  })

  it('SMI-5812: channel <link> points at /status (not the bare origin), and the feed advertises a complete atom:link self reference', async () => {
    mockFetchJson(VALID_PAYLOAD)
    const xml = await (await GET(makeContext())).text()
    expect(xml).toContain('<link>https://www.skillsmith.app/status</link>')
    expectAtomSelfLink(xml)
  })

  it('sorts items descending by pubDate ACROSS incidents, not grouped by incident', async () => {
    mockFetchJson(VALID_PAYLOAD)
    const xml = await (await GET(makeContext())).text()
    const { titles } = await parseItems(xml)
    // Newest posted_at first: newer-monitoring (07-15T01), newer-investigating (07-15T00),
    // older-resolved (07-10T02), older-investigating (07-10T00).
    expect(titles[0]).toContain('Newer incident')
    expect(titles[0]).toContain('Monitoring')
    expect(titles[3]).toContain('Older incident')
    expect(titles[3]).toContain('Investigating')
  })

  it('title is "<incident title> — <update status label>"; description is that update\'s own message', async () => {
    mockFetchJson(VALID_PAYLOAD)
    const xml = await (await GET(makeContext())).text()
    expect(xml).toContain('Newer incident — Monitoring')
    expect(xml).toContain('Newer monitoring.')
    // Must not blend a different update's message onto this item.
    expect(xml.indexOf('Newer monitoring.')).toBeGreaterThan(-1)
  })

  it('FIX (Codex #11): each item has a stable, unique guid', async () => {
    mockFetchJson(VALID_PAYLOAD)
    const xml = await (await GET(makeContext())).text()
    const { guids } = await parseItems(xml)
    expect(guids).toHaveLength(4)
    expect(new Set(guids).size).toBe(4)
    expect(guids).toContain('inc-newer:2026-07-15T01:00:00Z')
  })

  it('FIX (Codex #11, "duplicate-timestamp rule"): two updates on the same incident sharing an identical posted_at still get distinct guids', async () => {
    mockFetchJson({
      cached: false,
      data: {
        generated_at: 'x',
        overall_status: 'operational',
        components: [],
        incidents: [
          {
            id: 'inc-clock-skew',
            title: 'Clock skew incident',
            impact: 'minor',
            status: 'resolved',
            started_at: '2026-07-15T00:00:00Z',
            resolved_at: '2026-07-15T00:00:00Z',
            affected_components: [],
            updates: [
              {
                status: 'investigating',
                message: 'First update, same timestamp.',
                posted_at: '2026-07-15T00:00:00Z',
              },
              {
                status: 'resolved',
                message: 'Second update, same timestamp.',
                posted_at: '2026-07-15T00:00:00Z',
              },
            ],
          },
        ],
      },
    })
    const xml = await (await GET(makeContext())).text()
    const { guids } = await parseItems(xml)
    expect(guids).toHaveLength(2)
    expect(new Set(guids).size).toBe(2)
    expect(guids).toContain('inc-clock-skew:2026-07-15T00:00:00Z')
    expect(guids).toContain('inc-clock-skew:2026-07-15T00:00:00Z:1')
  })

  it('the item link points at #incident-<id> without a spurious trailing slash after the hash', async () => {
    mockFetchJson(VALID_PAYLOAD)
    const xml = await (await GET(makeContext())).text()
    const { links } = await parseItems(xml)
    expect(links[0]).toBe('https://www.skillsmith.app/status/#incident-inc-newer')
    expect(links[0].endsWith('/')).toBe(false)
  })

  it('FIX (Codex #11): an invalid posted_at is skipped rather than emitting Invalid Date', async () => {
    mockFetchJson({
      cached: false,
      data: {
        generated_at: 'x',
        overall_status: 'operational',
        components: [],
        incidents: [
          {
            id: 'inc-1',
            title: 'T',
            impact: 'none',
            status: 'resolved',
            started_at: '2026-07-15T00:00:00Z',
            resolved_at: null,
            affected_components: [],
            updates: [
              { status: 'investigating', message: 'good one', posted_at: 'not-a-date' },
              { status: 'resolved', message: 'also good', posted_at: '2026-07-15T00:00:00Z' },
            ],
          },
        ],
      },
    })
    const xml = await (await GET(makeContext())).text()
    expect(countOccurrences(xml, '<item>')).toBe(1)
    expect(xml).not.toContain('Invalid Date')
    expect(xml).toContain('also good')
    expect(xml).not.toContain('good one</description>')
  })

  it('escapes XML-unsafe characters in title/description via the library only (no double-escaping)', async () => {
    mockFetchJson({
      cached: false,
      data: {
        generated_at: 'x',
        overall_status: 'operational',
        components: [],
        incidents: [
          {
            id: 'inc-xss',
            title: '<script>alert(1)</script>',
            impact: 'none',
            status: 'resolved',
            started_at: '2026-07-15T00:00:00Z',
            resolved_at: null,
            affected_components: [],
            updates: [
              { status: 'resolved', message: 'a & b < c > d', posted_at: '2026-07-15T00:00:00Z' },
            ],
          },
        ],
      },
    })
    const xml = await (await GET(makeContext())).text()
    expect(xml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(xml).not.toContain('<script>alert(1)</script>')
    expect(xml).not.toContain('&amp;lt;') // not double-escaped
    expect(xml).toContain('a &amp; b &lt; c &gt; d')
  })

  it('FIX (Codex #11): strips illegal raw control characters before passing to rss()', async () => {
    mockFetchJson({
      cached: false,
      data: {
        generated_at: 'x',
        overall_status: 'operational',
        components: [],
        incidents: [
          {
            id: 'inc-ctl',
            title: 'Bad\x07Title',
            impact: 'none',
            status: 'resolved',
            started_at: '2026-07-15T00:00:00Z',
            resolved_at: null,
            affected_components: [],
            updates: [
              {
                status: 'resolved',
                message: 'line1\nline2\ttabbed',
                posted_at: '2026-07-15T00:00:00Z',
              },
            ],
          },
        ],
      },
    })
    const xml = await (await GET(makeContext())).text()
    expect(xml).not.toContain('\x07')
    expect(xml).toContain('BadTitle')
    // Tab/LF/CR are explicitly preserved.
    expect(xml).toContain('line1\nline2\ttabbed')
  })

  it('FIX (Codex #5): a fetch rejection returns a valid, well-formed, zero-item feed (not an error response)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch
    const response = await GET(makeContext())
    expect(response.status).toBe(200)
    const xml = await response.text()
    expect(xml).toContain('<rss')
    expect(countOccurrences(xml, '<item>')).toBe(0)
    // SMI-5812: the empty-feed fallback still advertises a complete atom:link self reference.
    expectAtomSelfLink(xml)
  })

  it('FIX (Codex #5): a non-OK upstream response returns a zero-item feed', async () => {
    mockFetchJson({}, false, 502)
    const response = await GET(makeContext())
    expect(response.status).toBe(200)
    expect(countOccurrences(await response.text(), '<item>')).toBe(0)
  })

  it('FIX (Codex #5 + #8): a structurally invalid payload (components not an array) returns a zero-item feed', async () => {
    mockFetchJson({
      cached: false,
      data: { generated_at: 'x', overall_status: 'operational', components: 'nope', incidents: [] },
    })
    const response = await GET(makeContext())
    expect(response.status).toBe(200)
    const xml = await response.text()
    expect(countOccurrences(xml, '<item>')).toBe(0)
    expect(xml).toContain('<rss')
  })

  it('a malformed (non-JSON-parseable) upstream response returns a zero-item feed', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
    }) as unknown as typeof fetch
    const response = await GET(makeContext())
    expect(response.status).toBe(200)
    expect(countOccurrences(await response.text(), '<item>')).toBe(0)
  })

  it("sends X-Content-Type-Options: nosniff without disturbing the library's Content-Type", async () => {
    mockFetchJson(VALID_PAYLOAD)
    const response = await GET(makeContext())
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-type')).toContain('xml')
  })

  it('an incident with zero updates contributes zero items (no fabricated placeholder item)', async () => {
    mockFetchJson({
      cached: false,
      data: {
        generated_at: 'x',
        overall_status: 'operational',
        components: [],
        incidents: [
          {
            id: 'inc-no-updates',
            title: 'T',
            impact: 'none',
            status: 'investigating',
            started_at: '2026-07-15T00:00:00Z',
            resolved_at: null,
            affected_components: [],
            updates: [],
          },
        ],
      },
    })
    const xml = await (await GET(makeContext())).text()
    expect(countOccurrences(xml, '<item>')).toBe(0)
  })

  // ---------------------------------------------------------------------
  // FIX (high): the fallback path can no longer throw uncaught, and
  // context.site is never actually undefined at either rss() call site.
  // ---------------------------------------------------------------------

  it('FIX (high): context.site undefined does not throw -- falls back to a default site URL', async () => {
    mockFetchJson(VALID_PAYLOAD)
    const contextNoSite = { site: undefined } as unknown as APIContext
    const response = await GET(contextNoSite)
    expect(response.status).toBe(200)
    const xml = await response.text()
    expect(xml).toContain('<rss')
    expect(countOccurrences(xml, '<item>')).toBe(4)
  })

  it('FIX (high): context.site undefined on the failure path still returns a valid zero-item feed', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch
    const contextNoSite = { site: undefined } as unknown as APIContext
    const response = await GET(contextNoSite)
    expect(response.status).toBe(200)
    const xml = await response.text()
    expect(xml).toContain('<rss')
    expect(countOccurrences(xml, '<item>')).toBe(0)
  })

  it('FIX (high): the fallback rss() call itself throwing still returns a valid static feed, not an uncaught rejection', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch
    // Force the NEXT rss() call (the catch block's own "empty feed"
    // fallback, since the primary path never reaches rss() when fetch
    // itself rejects) to throw, simulating a library-internal failure
    // unrelated to fetch/parse/shape.
    vi.mocked(rss).mockImplementationOnce(() => {
      throw new Error('rss library exploded')
    })

    const response = await GET(makeContext())
    expect(response.status).toBe(200)
    const xml = await response.text()
    expect(xml).toContain('<rss')
    expect(countOccurrences(xml, '<item>')).toBe(0)
    expect(response.headers.get('content-type')).toContain('rss')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    // SMI-5812: this is the hand-built STATIC_FALLBACK_RSS_XML string --
    // it too must advertise a complete atom:link self reference.
    expectAtomSelfLink(xml)
  })

  it('FIX (high): a primary rss() call throwing for a non-fetch/parse/shape reason still recovers via the fallback', async () => {
    mockFetchJson(VALID_PAYLOAD)
    // The primary rss() call throws for a reason unrelated to
    // fetch/parse/shape (e.g. an internal library failure) -- the outer
    // catch must still recover via the (unmocked, real) fallback call.
    vi.mocked(rss).mockImplementationOnce(() => {
      throw new Error('unexpected internal rss() failure')
    })

    const response = await GET(makeContext())
    expect(response.status).toBe(200)
    const xml = await response.text()
    expect(xml).toContain('<rss')
    expect(countOccurrences(xml, '<item>')).toBe(0)
  })
})
