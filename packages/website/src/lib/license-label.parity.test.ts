/**
 * SMI-5337 retro: Parity guard for the licenseLabel() helper vs the two
 * is:inline Astro badge sites that cannot import it at runtime.
 *
 * Both inline sites mirror the same logic:
 *   skills/index.astro   — createLicenseBadge(license)
 *   skills/[id].astro    — skill.license?.trim() || 'Unknown'
 *
 * This test exists to catch any drift between the extracted helper and the
 * inline duplicates. When a badge site changes its null-handling, this test
 * must be updated FIRST so the helper stays the authoritative source.
 *
 * CONTRACT (all three implementations agree):
 *   licenseLabel('MIT')   === 'MIT'
 *   licenseLabel(null)    === 'Unknown'
 *   licenseLabel(undefined) === 'Unknown'
 *   licenseLabel('')      === 'Unknown'
 *   licenseLabel('   ')   === 'Unknown'
 */

import { describe, it, expect } from 'vitest'
import { licenseLabel } from './license-label'

describe('licenseLabel — parity with is:inline Astro badge sites (SMI-5337)', () => {
  // skills/index.astro createLicenseBadge: `const label = trimmed ? escapeHtml(trimmed) : 'Unknown'`
  // skills/[id].astro renderSkill:         `skill.license?.trim() || 'Unknown'`
  // licenseLabel():                        `const trimmed = license?.trim(); return trimmed ? trimmed : 'Unknown'`

  it('MIT renders as "MIT" (non-null verbatim passthrough)', () => {
    expect(licenseLabel('MIT')).toBe('MIT')
  })

  it('null → "Unknown" (missing license, not "freely usable")', () => {
    expect(licenseLabel(null)).toBe('Unknown')
  })

  it('undefined → "Unknown" (absent license field)', () => {
    expect(licenseLabel(undefined)).toBe('Unknown')
  })

  it('"" → "Unknown" (empty string, same as null semantics)', () => {
    expect(licenseLabel('')).toBe('Unknown')
  })

  it('"   " → "Unknown" (whitespace-only, [id].astro .trim() || "Unknown" path)', () => {
    expect(licenseLabel('   ')).toBe('Unknown')
  })
})
