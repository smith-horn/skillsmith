/**
 * Unit tests for the shared trustTier module (SMI-5290)
 * Covers the canonical 5-tier model, legacy normalization, and neutral icon
 * behavior for local/installed skills that carry no API tier.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('vscode', () => ({
  ThemeIcon: class {
    constructor(
      public id: string,
      public color?: unknown
    ) {}
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
}))

import {
  normalizeTrustTier,
  getTrustTierIcon,
  getTrustTierEmoji,
  getTrustTierLabel,
} from '../sidebar/trustTier.js'
import * as vscode from 'vscode'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function iconId(tier?: string): string {
  const icon = getTrustTierIcon(tier) as InstanceType<typeof vscode.ThemeIcon>
  return icon.id
}

function iconColorId(tier?: string): string | undefined {
  const icon = getTrustTierIcon(tier) as InstanceType<typeof vscode.ThemeIcon>
  if (!icon.color) return undefined
  return (icon.color as InstanceType<typeof vscode.ThemeColor>).id
}

// ---------------------------------------------------------------------------
// normalizeTrustTier
// ---------------------------------------------------------------------------

describe('normalizeTrustTier', () => {
  it('maps canonical tiers to themselves', () => {
    expect(normalizeTrustTier('official')).toBe('official')
    expect(normalizeTrustTier('verified')).toBe('verified')
    expect(normalizeTrustTier('curated')).toBe('curated')
    expect(normalizeTrustTier('community')).toBe('community')
    expect(normalizeTrustTier('unverified')).toBe('unverified')
  })

  it('is case-insensitive for canonical tiers', () => {
    expect(normalizeTrustTier('Official')).toBe('official')
    expect(normalizeTrustTier('VERIFIED')).toBe('verified')
    expect(normalizeTrustTier('Community')).toBe('community')
  })

  it('maps legacy experimental → community', () => {
    expect(normalizeTrustTier('experimental')).toBe('community')
  })

  it('maps legacy unknown → unverified', () => {
    expect(normalizeTrustTier('unknown')).toBe('unverified')
  })

  it('maps legacy standard → unverified', () => {
    expect(normalizeTrustTier('standard')).toBe('unverified')
  })

  it('maps legacy default → unverified', () => {
    expect(normalizeTrustTier('default')).toBe('unverified')
  })

  it('maps unrecognized non-empty strings → unverified (defensive lowest-trust)', () => {
    expect(normalizeTrustTier('bogus')).toBe('unverified')
    expect(normalizeTrustTier('some-future-tier')).toBe('unverified')
  })

  it('returns undefined for empty string', () => {
    expect(normalizeTrustTier('')).toBeUndefined()
  })

  it('returns undefined for undefined input', () => {
    expect(normalizeTrustTier(undefined)).toBeUndefined()
  })

  it('NOTHING normalizes to curated from legacy inputs', () => {
    // curated must only arrive as the literal string 'curated'
    const legacyInputs = ['experimental', 'unknown', 'standard', 'default', 'local', 'bogus', '']
    for (const input of legacyInputs) {
      expect(normalizeTrustTier(input)).not.toBe('curated')
    }
  })
})

// ---------------------------------------------------------------------------
// getTrustTierIcon — canonical tiers
// ---------------------------------------------------------------------------

describe('getTrustTierIcon — canonical tiers', () => {
  it('official → verified-filled + charts.green', () => {
    expect(iconId('official')).toBe('verified-filled')
    expect(iconColorId('official')).toBe('charts.green')
  })

  it('verified → verified + charts.blue', () => {
    expect(iconId('verified')).toBe('verified')
    expect(iconColorId('verified')).toBe('charts.blue')
  })

  it('curated → star-full + terminal.ansiCyan', () => {
    expect(iconId('curated')).toBe('star-full')
    expect(iconColorId('curated')).toBe('terminal.ansiCyan')
  })

  it('community → organization + charts.yellow', () => {
    expect(iconId('community')).toBe('organization')
    expect(iconColorId('community')).toBe('charts.yellow')
  })

  it('unverified → question + charts.red', () => {
    expect(iconId('unverified')).toBe('question')
    expect(iconColorId('unverified')).toBe('charts.red')
  })
})

// ---------------------------------------------------------------------------
// getTrustTierIcon — unrecognized / absent tier
// ---------------------------------------------------------------------------

describe('getTrustTierIcon — absent/empty tier (neutral, no color)', () => {
  it('undefined input → symbol-function with NO color', () => {
    expect(iconId(undefined)).toBe('symbol-function')
    expect(iconColorId(undefined)).toBeUndefined()
  })

  it('empty string input → symbol-function with NO color', () => {
    expect(iconId('')).toBe('symbol-function')
    expect(iconColorId('')).toBeUndefined()
  })
})

describe('getTrustTierIcon — unrecognized string falls back to unverified (red)', () => {
  it('bogus → question + charts.red', () => {
    expect(iconId('bogus')).toBe('question')
    expect(iconColorId('bogus')).toBe('charts.red')
  })
})

// ---------------------------------------------------------------------------
// getTrustTierEmoji
// ---------------------------------------------------------------------------

describe('getTrustTierEmoji', () => {
  it('official → ✅', () => expect(getTrustTierEmoji('official')).toBe('✅'))
  it('verified → ☑️', () => expect(getTrustTierEmoji('verified')).toBe('☑️'))
  it('curated → ⭐', () => expect(getTrustTierEmoji('curated')).toBe('⭐'))
  it('community → 👥', () => expect(getTrustTierEmoji('community')).toBe('👥'))
  it('unverified → ❓', () => expect(getTrustTierEmoji('unverified')).toBe('❓'))
  it('undefined → empty string', () => expect(getTrustTierEmoji(undefined)).toBe(''))
  it('empty string → empty string', () => expect(getTrustTierEmoji('')).toBe(''))
})

// ---------------------------------------------------------------------------
// getTrustTierLabel
// ---------------------------------------------------------------------------

describe('getTrustTierLabel', () => {
  it('official → Official', () => expect(getTrustTierLabel('official')).toBe('Official'))
  it('verified → Verified', () => expect(getTrustTierLabel('verified')).toBe('Verified'))
  it('curated → Curated', () => expect(getTrustTierLabel('curated')).toBe('Curated'))
  it('community → Community', () => expect(getTrustTierLabel('community')).toBe('Community'))
  it('unverified → Unverified', () => expect(getTrustTierLabel('unverified')).toBe('Unverified'))
  it('undefined → empty string', () => expect(getTrustTierLabel(undefined)).toBe(''))
  it('empty string → empty string', () => expect(getTrustTierLabel('')).toBe(''))
})

// ---------------------------------------------------------------------------
// Legacy normalization via icon / emoji / label
// ---------------------------------------------------------------------------

describe('legacy tier pass-through via higher-level functions', () => {
  it('experimental normalizes to community icon (organization + charts.yellow)', () => {
    expect(iconId('experimental')).toBe('organization')
    expect(iconColorId('experimental')).toBe('charts.yellow')
  })

  it('unknown normalizes to unverified icon (question + charts.red)', () => {
    expect(iconId('unknown')).toBe('question')
    expect(iconColorId('unknown')).toBe('charts.red')
  })

  it('standard normalizes to unverified emoji (❓)', () => {
    expect(getTrustTierEmoji('standard')).toBe('❓')
  })

  it('default normalizes to unverified label (Unverified)', () => {
    expect(getTrustTierLabel('default')).toBe('Unverified')
  })
})
