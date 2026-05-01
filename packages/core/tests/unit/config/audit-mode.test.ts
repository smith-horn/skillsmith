/**
 * Unit tests for {@link resolveAuditMode} (SMI-4587 NEW-E-1).
 *
 * Pure resolver — no IO. Tests cover:
 *   - tier defaults for all four tiers (community/individual/team/enterprise)
 *   - explicit override path (all four AuditMode values)
 *   - invalid override falls through to tier default
 *   - unknown tier fail-safes to 'preventative'
 */

import { describe, expect, it } from 'vitest'

import {
  isAuditMode,
  resolveAuditMode,
  tierDefault,
  type AuditMode,
  type Tier,
} from '../../../src/config/audit-mode.js'

describe('resolveAuditMode — tier defaults', () => {
  it('community defaults to preventative', () => {
    expect(resolveAuditMode({ tier: 'community' })).toBe('preventative')
  })

  it('individual defaults to preventative', () => {
    expect(resolveAuditMode({ tier: 'individual' })).toBe('preventative')
  })

  it('team defaults to power_user', () => {
    expect(resolveAuditMode({ tier: 'team' })).toBe('power_user')
  })

  it('enterprise defaults to governance', () => {
    expect(resolveAuditMode({ tier: 'enterprise' })).toBe('governance')
  })

  it('unknown tier falls back to preventative (fail-safe)', () => {
    // Cast through unknown to feed the resolver an out-of-band tier value
    // and verify the fail-safe branch.
    expect(resolveAuditMode({ tier: 'platinum' as unknown as Tier })).toBe('preventative')
  })
})

describe('resolveAuditMode — override path', () => {
  const allTiers: Tier[] = ['community', 'individual', 'team', 'enterprise']
  const allModes: AuditMode[] = ['preventative', 'power_user', 'governance', 'off']

  for (const tier of allTiers) {
    for (const override of allModes) {
      it(`tier=${tier} override=${override} -> ${override}`, () => {
        expect(resolveAuditMode({ tier, override })).toBe(override)
      })
    }
  }

  it('null override falls through to tier default', () => {
    expect(resolveAuditMode({ tier: 'team', override: null })).toBe('power_user')
  })

  it('undefined override falls through to tier default', () => {
    expect(resolveAuditMode({ tier: 'enterprise', override: undefined })).toBe('governance')
  })

  it('invalid override string falls through to tier default', () => {
    // Forward an invalid string to confirm the resolver does not propagate it.
    const result = resolveAuditMode({
      tier: 'community',
      override: 'noisy' as unknown as AuditMode,
    })
    expect(result).toBe('preventative')
  })
})

describe('tierDefault', () => {
  it('returns the same value as resolveAuditMode without an override', () => {
    expect(tierDefault('community')).toBe('preventative')
    expect(tierDefault('individual')).toBe('preventative')
    expect(tierDefault('team')).toBe('power_user')
    expect(tierDefault('enterprise')).toBe('governance')
  })

  it('unknown tier returns preventative', () => {
    expect(tierDefault('whatever')).toBe('preventative')
  })
})

describe('isAuditMode', () => {
  it('accepts the four valid modes', () => {
    expect(isAuditMode('preventative')).toBe(true)
    expect(isAuditMode('power_user')).toBe(true)
    expect(isAuditMode('governance')).toBe(true)
    expect(isAuditMode('off')).toBe(true)
  })

  it('rejects unknown strings', () => {
    expect(isAuditMode('strict')).toBe(false)
    expect(isAuditMode('')).toBe(false)
    expect(isAuditMode('PREVENTATIVE')).toBe(false)
  })

  it('rejects non-string values', () => {
    expect(isAuditMode(null)).toBe(false)
    expect(isAuditMode(undefined)).toBe(false)
    expect(isAuditMode(0)).toBe(false)
    expect(isAuditMode({})).toBe(false)
  })
})
