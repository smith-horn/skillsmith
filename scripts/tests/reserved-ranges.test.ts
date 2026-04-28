/**
 * SMI-4530: Tests for scripts/lib/reserved-ranges.mjs.
 *
 * The module is intentionally tiny and pure — these tests pin the contract
 * that both `prepare-release.ts` and `check-publish-collision.mjs` consume.
 * Drift between the two collision implementations is the failure mode the
 * shared module exists to prevent (see SMI-4207 / ADR-115).
 */
import { describe, it, expect } from 'vitest'
import semver from 'semver'

import { RESERVED_RANGES, filterReservedVersions, isReserved } from '../lib/reserved-ranges.mjs'

describe('RESERVED_RANGES', () => {
  it('contains only @skillsmith/core today and is frozen', () => {
    expect(Object.keys(RESERVED_RANGES)).toEqual(['@skillsmith/core'])
    expect(RESERVED_RANGES['@skillsmith/core']).toBe('>=2.0.0 <3.0.0')
    expect(Object.isFrozen(RESERVED_RANGES)).toBe(true)
  })
})

describe('isReserved', () => {
  it('returns true for @skillsmith/core@2.0.0 and 2.1.2 (range boundary + interior)', () => {
    expect(isReserved('@skillsmith/core', '2.0.0', semver)).toBe(true)
    expect(isReserved('@skillsmith/core', '2.1.2', semver)).toBe(true)
  })

  it('returns false for @skillsmith/core@0.5.6, 0.5.7, 3.0.0', () => {
    expect(isReserved('@skillsmith/core', '0.5.6', semver)).toBe(false)
    expect(isReserved('@skillsmith/core', '0.5.7', semver)).toBe(false)
    // 3.0.0 is the next major — outside reserved range.
    expect(isReserved('@skillsmith/core', '3.0.0', semver)).toBe(false)
  })

  it('returns false for any version of a package not in RESERVED_RANGES', () => {
    expect(isReserved('@skillsmith/mcp-server', '2.1.2', semver)).toBe(false)
    expect(isReserved('@skillsmith/cli', '2.0.0', semver)).toBe(false)
    expect(isReserved('@skillsmith/some-future-pkg', '99.99.99', semver)).toBe(false)
  })
})

describe('filterReservedVersions', () => {
  it('removes only the reserved range and preserves input order', () => {
    const input = ['0.5.6', '2.0.0', '2.1.2', '0.5.7']
    const out = filterReservedVersions('@skillsmith/core', input, semver)
    expect(out).toEqual(['0.5.6', '0.5.7'])
  })

  it('returns the input unchanged for a package with no reserved range', () => {
    const input = ['0.4.12', '2.0.0', '0.4.13']
    const out = filterReservedVersions('@skillsmith/mcp-server', input, semver)
    expect(out).toEqual(input)
  })

  it('returns an empty array when every entry is in the reserved range', () => {
    const input = ['2.0.0', '2.1.0', '2.1.2']
    const out = filterReservedVersions('@skillsmith/core', input, semver)
    expect(out).toEqual([])
  })
})
