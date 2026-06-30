/**
 * SMI-5393 (umbrella SMI-5382): view-model tests for the /account/skills
 * inventory page.
 *
 * All helpers are pure; `now` is injected as a millisecond epoch value so
 * there is no real-clock dependency anywhere in this suite.
 */

import { describe, expect, it } from 'vitest'
import {
  buildInventoryView,
  detectEmptyState,
  formatAbsoluteTime,
  formatRelativeTime,
  SKILL_STATE_META,
  STALE_AFTER_HOURS,
  type EmptyState,
  type InventoryRow,
  type SkillState,
} from './inventory-view'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Build a complete InventoryRow with sensible defaults. Override only the
 * fields each test cares about.
 */
function makeRow(partial: Partial<InventoryRow>): InventoryRow {
  return {
    device_id: 'device-default',
    device_label: null,
    hostname_display: null,
    platform: null,
    device_last_seen: '2026-06-25T10:00:00.000Z',
    device_state: 'fresh',
    harness: null,
    skill_id: null,
    version: null,
    present: null,
    pinned: null,
    registry_hash: null,
    skill_state: null,
    author: null,
    repository: null,
    license: null,
    ...partial,
  }
}

// ─── buildInventoryView ───────────────────────────────────────────────────────

describe('buildInventoryView', () => {
  it('returns an empty array when given no rows', () => {
    expect(buildInventoryView([])).toEqual([])
  })

  it('marks a device whose only row is the all-null sentinel as neverSynced', () => {
    const rows = [makeRow({ device_id: 'dev-1', device_label: 'laptop' })]
    const result = buildInventoryView(rows)
    expect(result).toHaveLength(1)
    expect(result[0].neverSynced).toBe(true)
    expect(result[0].skills).toEqual([])
    expect(result[0].label).toBe('laptop')
  })

  it('groups rows across two devices: one with 3 skills, one never-synced', () => {
    const rows: InventoryRow[] = [
      // Device A — 3 skills across 2 harnesses
      makeRow({
        device_id: 'dev-a',
        device_label: 'workstation',
        device_state: 'fresh',
        harness: 'zed',
        skill_id: 'skill-1',
        version: '1.0.0',
        present: true,
        pinned: false,
        registry_hash: 'abc123',
        skill_state: 'current',
      }),
      makeRow({
        device_id: 'dev-a',
        harness: 'zed',
        skill_id: 'skill-2',
        version: '0.9.0',
        present: true,
        pinned: false,
        registry_hash: 'def456',
        skill_state: 'drifted',
      }),
      makeRow({
        device_id: 'dev-a',
        harness: 'cursor',
        skill_id: 'skill-3',
        version: null,
        present: false,
        pinned: true,
        registry_hash: null,
        skill_state: 'pinned',
      }),
      // Device B — never-synced sentinel row (all skill columns null)
      makeRow({ device_id: 'dev-b', device_label: 'laptop', device_state: 'stale' }),
    ]

    const result = buildInventoryView(rows)

    expect(result).toHaveLength(2)

    // Device A: 3 skills, not never-synced
    const devA = result[0]
    expect(devA.deviceId).toBe('dev-a')
    expect(devA.label).toBe('workstation')
    expect(devA.deviceState).toBe('fresh')
    expect(devA.neverSynced).toBe(false)
    expect(devA.skills).toHaveLength(3)
    expect(devA.skills[0]).toMatchObject({ harness: 'zed', skillId: 'skill-1', state: 'current' })
    expect(devA.skills[1]).toMatchObject({ harness: 'zed', skillId: 'skill-2', state: 'drifted' })
    expect(devA.skills[2]).toMatchObject({
      harness: 'cursor',
      skillId: 'skill-3',
      state: 'pinned',
    })

    // Device B: never-synced
    const devB = result[1]
    expect(devB.deviceId).toBe('dev-b')
    expect(devB.deviceState).toBe('stale')
    expect(devB.neverSynced).toBe(true)
    expect(devB.skills).toEqual([])
  })

  it('preserves the RPC device ordering (first device in rows appears first in result)', () => {
    const rows: InventoryRow[] = [
      makeRow({ device_id: 'first', skill_id: 'sk-1', skill_state: 'current', harness: 'zed' }),
      makeRow({ device_id: 'second', skill_id: 'sk-2', skill_state: 'missing', harness: 'zed' }),
    ]
    const result = buildInventoryView(rows)
    expect(result[0].deviceId).toBe('first')
    expect(result[1].deviceId).toBe('second')
  })

  it('passes all seven RPC-emittable SkillStates through to SkillView.state', () => {
    // 'pending' is display-only and never emitted by the RPC; not included here.
    const rpcStates: Array<NonNullable<InventoryRow['skill_state']>> = [
      'current',
      'drifted',
      'missing',
      'pinned',
      'unknown',
      'local',
      'source-identified',
    ]
    const rows = rpcStates.map((s, i) =>
      makeRow({
        device_id: 'dev-all-states',
        skill_id: `skill-${i}`,
        harness: 'zed',
        skill_state: s,
      })
    )
    const result = buildInventoryView(rows)
    expect(result).toHaveLength(1)
    expect(result[0].skills).toHaveLength(7)
    expect(result[0].skills.map((sk) => sk.state)).toEqual(rpcStates)
  })

  it('threads author, repository, license from RPC row into SkillView', () => {
    const rows = [
      makeRow({
        device_id: 'dev-src',
        skill_id: 'acme/widget',
        harness: 'zed',
        skill_state: 'source-identified',
        author: 'acme-org',
        repository: 'https://github.com/acme/widget',
        license: 'MIT',
      }),
    ]
    const result = buildInventoryView(rows)
    const skill = result[0].skills[0]
    expect(skill.author).toBe('acme-org')
    expect(skill.repository).toBe('https://github.com/acme/widget')
    expect(skill.license).toBe('MIT')
  })

  it('preserves null for author/repository/license when RPC row omits them', () => {
    const rows = [
      makeRow({
        device_id: 'dev-local',
        skill_id: 'my/local-skill',
        harness: 'cursor',
        skill_state: 'local',
      }),
    ]
    const result = buildInventoryView(rows)
    const skill = result[0].skills[0]
    expect(skill.author).toBeNull()
    expect(skill.repository).toBeNull()
    expect(skill.license).toBeNull()
  })

  it('drops null-skill_state sentinel rows even when mixed with real skill rows', () => {
    const rows: InventoryRow[] = [
      makeRow({ device_id: 'dev-x', skill_id: 'sk-1', harness: 'zed', skill_state: 'current' }),
      makeRow({ device_id: 'dev-x', skill_id: null, skill_state: null }),
    ]
    const result = buildInventoryView(rows)
    expect(result[0].skills).toHaveLength(1)
    expect(result[0].neverSynced).toBe(false)
  })

  it('falls back to false for null present/pinned fields and preserves version', () => {
    const rows = [
      makeRow({
        device_id: 'dev-y',
        skill_id: 'sk-pin',
        harness: 'cursor',
        skill_state: 'pinned',
        present: null,
        pinned: true,
        version: '2.1.0',
      }),
    ]
    const result = buildInventoryView(rows)
    const skill = result[0].skills[0]
    expect(skill.present).toBe(false)
    expect(skill.pinned).toBe(true)
    expect(skill.version).toBe('2.1.0')
  })

  it('falls back to empty string for null harness on a real skill row', () => {
    const rows = [
      makeRow({
        device_id: 'dev-z',
        skill_id: 'sk-noharness',
        harness: null,
        skill_state: 'unknown',
      }),
    ]
    const result = buildInventoryView(rows)
    expect(result[0].skills[0].harness).toBe('')
  })
})

// ─── formatRelativeTime ───────────────────────────────────────────────────────

describe('formatRelativeTime', () => {
  // Anchor: 2026-06-26T12:00:00.000Z
  const NOW = new Date('2026-06-26T12:00:00.000Z').getTime()

  it('"just now" for delta = 0 s', () => {
    expect(formatRelativeTime(new Date(NOW).toISOString(), NOW)).toBe('just now')
  })

  it('"just now" for delta = 30 s (< 60 s)', () => {
    expect(formatRelativeTime(new Date(NOW - 30_000).toISOString(), NOW)).toBe('just now')
  })

  it('"1 minute ago" for delta = 60 s (singular)', () => {
    expect(formatRelativeTime(new Date(NOW - 60_000).toISOString(), NOW)).toBe('1 minute ago')
  })

  it('"5 minutes ago" for delta = 5 min (plural)', () => {
    expect(formatRelativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5 minutes ago')
  })

  it('"1 hour ago" for delta = 60 min (singular)', () => {
    expect(formatRelativeTime(new Date(NOW - 3_600_000).toISOString(), NOW)).toBe('1 hour ago')
  })

  it('"3 hours ago" for delta = 3 h (plural)', () => {
    expect(formatRelativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3 hours ago')
  })

  it('"1 day ago" for delta = 24 h (singular)', () => {
    expect(formatRelativeTime(new Date(NOW - 24 * 3_600_000).toISOString(), NOW)).toBe('1 day ago')
  })

  it('"2 days ago" for delta = 48 h (plural)', () => {
    expect(formatRelativeTime(new Date(NOW - 2 * 24 * 3_600_000).toISOString(), NOW)).toBe(
      '2 days ago'
    )
  })

  it('YYYY-MM-DD for delta >= 7 days (old-date bucket)', () => {
    const result = formatRelativeTime('2026-01-01T00:00:00.000Z', NOW)
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(result).toBe('2026-01-01')
  })

  it('returns the original string unchanged for an invalid ISO', () => {
    expect(formatRelativeTime('not-a-date', NOW)).toBe('not-a-date')
  })
})

// ─── formatAbsoluteTime ───────────────────────────────────────────────────────

describe('formatAbsoluteTime', () => {
  it('returns a non-empty string containing the year for a valid ISO timestamp', () => {
    const result = formatAbsoluteTime('2026-06-26T12:00:00.000Z')
    expect(result.length).toBeGreaterThan(0)
    expect(result).toMatch(/2026/)
  })

  it('returns the original string unchanged for an invalid ISO', () => {
    expect(formatAbsoluteTime('not-a-date')).toBe('not-a-date')
  })
})

// ─── SKILL_STATE_META ─────────────────────────────────────────────────────────

describe('SKILL_STATE_META', () => {
  const allStates: SkillState[] = [
    'current',
    'drifted',
    'missing',
    'pinned',
    'unknown',
    'local',
    'source-identified',
    'pending',
  ]

  it('has an entry for every SkillState', () => {
    for (const state of allStates) {
      expect(SKILL_STATE_META[state]).toBeDefined()
    }
  })

  it('each entry has a non-empty label and description', () => {
    for (const state of allStates) {
      const meta = SKILL_STATE_META[state]
      expect(meta.label.length).toBeGreaterThan(0)
      expect(meta.description.length).toBeGreaterThan(0)
    }
  })

  it('descriptions match the spec copy for existing states', () => {
    expect(SKILL_STATE_META.current.description).toBe('Up to date with the registry')
    expect(SKILL_STATE_META.drifted.description).toBe(
      'A newer version is available in the registry'
    )
    expect(SKILL_STATE_META.missing.description).toBe(
      'Installed before but not seen in the latest sync'
    )
    expect(SKILL_STATE_META.pinned.description).toBe('Pinned to a version; drift checks suppressed')
    expect(SKILL_STATE_META.unknown.description).toBe(
      'Not matched to a registry skill (local or custom)'
    )
  })

  it('local state has a neutral label and description (no warning/error connotation)', () => {
    expect(SKILL_STATE_META.local.label).toBe('Local')
    expect(SKILL_STATE_META.local.description).toBe(
      'Installed locally; no registry or declared source'
    )
  })

  it('source-identified state conveys claimed-but-unverified provenance', () => {
    expect(SKILL_STATE_META['source-identified'].label).toBe('Claimed source')
    expect(SKILL_STATE_META['source-identified'].description).toBe(
      "Source declared in the skill's own metadata (not registry-verified)"
    )
  })

  it('pending state conveys transient resolution (not a terminal error)', () => {
    expect(SKILL_STATE_META.pending.label).toBe('Checking…')
    expect(SKILL_STATE_META.pending.description).toBe('Resolving source — check back shortly')
  })
})

// ─── STALE_AFTER_HOURS ────────────────────────────────────────────────────────

describe('STALE_AFTER_HOURS', () => {
  it('equals 24 (matches the RPC p_stale_after default of INTERVAL "24 hours")', () => {
    expect(STALE_AFTER_HOURS).toBe(24)
  })
})

// ─── detectEmptyState ─────────────────────────────────────────────────────────

describe('detectEmptyState', () => {
  // consent = false → always 'consent-off', regardless of device count
  const consentOffCases: Array<[number, EmptyState]> = [
    [0, 'consent-off'],
    [1, 'consent-off'],
    [2, 'consent-off'],
    [10, 'consent-off'],
  ]
  it.each(consentOffCases)('consent=false, count=%i → consent-off', (count, expected) => {
    expect(detectEmptyState(false, count)).toBe(expected)
  })

  it('consent=true, count=0 → opted-in-no-devices', () => {
    expect(detectEmptyState(true, 0)).toBe('opted-in-no-devices')
  })

  it('consent=true, count=1 → single-machine', () => {
    expect(detectEmptyState(true, 1)).toBe('single-machine')
  })

  it('consent=true, count=2 → populated', () => {
    expect(detectEmptyState(true, 2)).toBe('populated')
  })

  it('consent=true, count>2 → populated', () => {
    expect(detectEmptyState(true, 5)).toBe('populated')
    expect(detectEmptyState(true, 100)).toBe('populated')
  })
})
