import { describe, it, expect } from 'vitest'
import {
  applyComponentRowContent,
  buildAffectedComponentsText,
  buildComponentRowContent,
  buildComponentsBySlug,
  buildIncidentContent,
  buildScaffoldResetContent,
  refreshUptimeStripTiles,
  type ComponentRowElements,
} from './status-render'
import { COMPONENTS, type StatusComponent, type StatusIncident } from './status-vocab'

const ADVERSARIAL = '<script>alert(1)</script>'

function makeComponent(overrides: Partial<StatusComponent> = {}): StatusComponent {
  return {
    slug: 'website',
    name: 'Website',
    description: 'desc',
    display_order: 0,
    status: 'operational',
    latency_ms: 42,
    message: 'All good',
    checked_at: '2026-07-15T00:00:00Z',
    uptime_90d: [],
    ...overrides,
  }
}

function makeIncident(overrides: Partial<StatusIncident> = {}): StatusIncident {
  return {
    id: 'inc-1',
    title: 'Some incident',
    impact: 'minor',
    status: 'investigating',
    started_at: '2026-07-15T00:00:00Z',
    resolved_at: null,
    affected_components: [],
    updates: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Untrusted-field rendering path — proven inert (never innerHTML)
// ---------------------------------------------------------------------------

describe('buildComponentRowContent / applyComponentRowContent', () => {
  it('FIX: formats checked_at for human display, never the raw ISO string', () => {
    const content = buildComponentRowContent(makeComponent({ checked_at: '2026-07-15T00:00:00Z' }))
    expect(content.checkedAtText).not.toBe('2026-07-15T00:00:00Z')
    expect(content.checkedAtText).not.toContain('T')
  })

  it('renders a missing or invalid checked_at as the em-dash placeholder, not "Invalid Date"', () => {
    expect(buildComponentRowContent(makeComponent({ checked_at: null })).checkedAtText).toBe('—')
    expect(
      buildComponentRowContent(makeComponent({ checked_at: 'not-a-date' })).checkedAtText
    ).toBe('—')
  })

  it('preserves an adversarial name/message unchanged in the content descriptor', () => {
    const content = buildComponentRowContent(
      makeComponent({ name: ADVERSARIAL, message: ADVERSARIAL })
    )
    expect(content.name).toBe(ADVERSARIAL)
    expect(content.message).toBe(ADVERSARIAL)
  })

  it('applies content via textContent/className only — never touches innerHTML', () => {
    let innerHtmlWrites = 0
    function makeTrapEl() {
      let text = ''
      return {
        get textContent() {
          return text
        },
        set textContent(v: string) {
          text = v
        },
        get innerHTML() {
          return ''
        },
        set innerHTML(_v: string) {
          innerHtmlWrites++
        },
      }
    }
    const elements: ComponentRowElements = {
      nameEl: makeTrapEl(),
      messageEl: makeTrapEl(),
      latencyEl: makeTrapEl(),
      checkedAtEl: makeTrapEl(),
      pillTextEl: makeTrapEl(),
      pillEl: { className: '' },
    }

    const content = buildComponentRowContent(
      makeComponent({ name: ADVERSARIAL, message: ADVERSARIAL })
    )
    applyComponentRowContent(elements, content)

    expect(innerHtmlWrites).toBe(0)
    // The adversarial string is inert — it landed as a literal text value,
    // never parsed as markup (there is no element for it to have become).
    expect(elements.nameEl.textContent).toBe(ADVERSARIAL)
    expect(elements.messageEl.textContent).toBe(ADVERSARIAL)
    expect(typeof elements.pillEl.className).toBe('string')
  })

  it('never fabricates an "operational"-looking pill for an unrecognized status', () => {
    const content = buildComponentRowContent(makeComponent({ status: 'totally-bogus' as never }))
    expect(content.status).toBe('unknown')
    expect(content.statusLabel).toBe('Unknown')
  })
})

describe('buildScaffoldResetContent', () => {
  it('resets to unknown status with the distinct "No data reported." message', () => {
    const content = buildScaffoldResetContent({ slug: 'website', name: 'Website', description: '' })
    expect(content.status).toBe('unknown')
    expect(content.message).toBe('No data reported.')
  })
})

describe('buildAffectedComponentsText', () => {
  it('resolves a known slug to its display name', () => {
    const map = new Map([['website', { name: 'Website' }]])
    expect(buildAffectedComponentsText(['website'], map)).toBe('Website')
  })

  it('falls back to the raw slug when it matches no current component', () => {
    const map = new Map([['website', { name: 'Website' }]])
    expect(buildAffectedComponentsText(['website', 'deleted-service'], map)).toBe(
      'Website, deleted-service'
    )
  })

  it("preserves an adversarial name/slug unchanged (safety is the caller's textContent usage)", () => {
    const map = new Map([['x', { name: ADVERSARIAL }]])
    expect(buildAffectedComponentsText(['x'], map)).toBe(ADVERSARIAL)
    expect(buildAffectedComponentsText([ADVERSARIAL], new Map())).toBe(ADVERSARIAL)
  })
})

describe('buildComponentsBySlug', () => {
  it('FIX (medium): uses the LIVE payload display name for a fixed scaffold slug, even when renamed from the compile-time scaffold', () => {
    const scaffoldWebsite = COMPONENTS.find((c) => c.slug === 'website')!
    const map = buildComponentsBySlug(
      [makeComponent({ slug: 'website', name: 'Renamed Website Component' })],
      COMPONENTS
    )
    expect(map.get('website')?.name).toBe('Renamed Website Component')
    expect(map.get('website')?.name).not.toBe(scaffoldWebsite.name)
  })

  it('resolves a dynamic (non-scaffold) component to its live display name, not its raw slug', () => {
    const map = buildComponentsBySlug(
      [makeComponent({ slug: 'a-new-service', name: 'A New Service' })],
      COMPONENTS
    )
    expect(map.get('a-new-service')?.name).toBe('A New Service')
  })

  it('falls back to the static scaffold name for a fixed slug absent from the current payload', () => {
    const map = buildComponentsBySlug([], COMPONENTS)
    const scaffoldWebsite = COMPONENTS.find((c) => c.slug === 'website')!
    expect(map.get('website')?.name).toBe(scaffoldWebsite.name)
  })
})

describe('buildIncidentContent', () => {
  it('preserves an adversarial title/update-message unchanged', () => {
    const content = buildIncidentContent(
      makeIncident({
        title: ADVERSARIAL,
        affected_components: ['website'],
        updates: [
          { status: 'investigating', message: ADVERSARIAL, posted_at: '2026-07-15T00:00:00Z' },
        ],
      }),
      new Map([['website', { name: 'Website' }]])
    )
    expect(content.title).toBe(ADVERSARIAL)
    expect(content.updates[0].message).toBe(ADVERSARIAL)
    expect(content.affectedText).toBe('Website')
  })

  it('FIX: formats started_at/resolved_at/posted_at for human display, never the raw ISO string', () => {
    const content = buildIncidentContent(
      makeIncident({
        started_at: '2026-07-15T00:00:00Z',
        resolved_at: '2026-07-15T01:00:00Z',
        updates: [{ status: 'resolved', message: 'fixed', posted_at: '2026-07-15T01:00:00Z' }],
      }),
      new Map()
    )
    expect(content.startedAtText).not.toBe('2026-07-15T00:00:00Z')
    expect(content.startedAtText).not.toContain('T')
    expect(content.resolvedAtText).not.toBe('2026-07-15T01:00:00Z')
    expect(content.resolvedAtText).not.toContain('T')
    expect(content.updates[0].postedAtText).not.toBe('2026-07-15T01:00:00Z')
    expect(content.updates[0].postedAtText).not.toContain('T')
  })

  it('an unresolved incident (resolved_at: null) reads "Ongoing", not a formatted null', () => {
    const content = buildIncidentContent(makeIncident({ resolved_at: null }), new Map())
    expect(content.resolvedAtText).toBe('Ongoing')
  })

  it('falls back to the raw status string when the incident status is unrecognized', () => {
    const content = buildIncidentContent(makeIncident({ status: 'weird' as never }), new Map())
    expect(content.statusLabel).toBe('weird')
  })
})

// ---------------------------------------------------------------------------
// Uptime tile refresh (uses the same shared vocab helpers as the SSR render)
// ---------------------------------------------------------------------------

describe('refreshUptimeStripTiles', () => {
  it('updates exactly 90 pre-existing tile handles in place, never adding/removing', () => {
    const handles = Array.from({ length: 90 }, () => ({
      className: '',
      attrs: {} as Record<string, string>,
      setAttribute(n: string, v: string) {
        this.attrs[n] = v
      },
    }))
    refreshUptimeStripTiles(handles, [], '2026-07-15')
    expect(handles).toHaveLength(90)
    expect(handles[89].className).toContain('bg-gray-700')
    expect(handles[89].attrs['aria-label']).toContain('No data')
  })

  it('does not touch a strip handle when none is supplied (backward compatible)', () => {
    const handles = Array.from({ length: 90 }, () => ({
      className: '',
      setAttribute() {},
    }))
    expect(() => refreshUptimeStripTiles(handles, [], '2026-07-15')).not.toThrow()
  })

  it('FIX (medium): also refreshes the containing strip group aria-label from real data, not the stale SSR-time empty-scaffold summary', () => {
    const handles = Array.from({ length: 90 }, () => ({
      className: '',
      setAttribute() {},
    }))
    const stripAttrs: Record<string, string> = {}
    const stripHandle = {
      setAttribute(n: string, v: string) {
        stripAttrs[n] = v
      },
    }
    const uptime90d = [
      {
        day: '2026-07-15',
        uptime_pct: 100,
        worst_status: 'operational' as const,
        total_checks: 288,
      },
    ]

    refreshUptimeStripTiles(handles, uptime90d, '2026-07-15', stripHandle, 'Website')

    // A stale SSR-time (empty-scaffold) label would read "0 operational ...
    // 90 no data" regardless of what actually got painted.
    expect(stripAttrs['aria-label']).toBe(
      'Website: 90-day uptime — 1 operational, 0 degraded, 0 outage, 89 no data'
    )
  })

  it("FIX: a supplied liveStatus overrides today's tile instead of leaving it perpetually gray", () => {
    const handles = Array.from({ length: 90 }, () => ({
      className: '',
      attrs: {} as Record<string, string>,
      setAttribute(n: string, v: string) {
        this.attrs[n] = v
      },
    }))
    refreshUptimeStripTiles(handles, [], '2026-07-15', null, undefined, 'operational')
    expect(handles[89].className).toContain('bg-green-500')
    expect(handles[89].attrs['aria-label']).toContain('current, today in progress')
    // Untouched historical tiles remain no-data.
    expect(handles[0].className).toContain('bg-gray-700')
  })

  it("omitting liveStatus leaves today's tile as ordinary no-data (backward compatible)", () => {
    const handles = Array.from({ length: 90 }, () => ({
      className: '',
      setAttribute() {},
    }))
    refreshUptimeStripTiles(handles, [], '2026-07-15')
    expect(handles[89].className).toContain('bg-gray-700')
  })
})
