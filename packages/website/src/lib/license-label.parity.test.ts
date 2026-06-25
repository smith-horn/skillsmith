/**
 * SMI-5337 retro: Parity guard for the licenseLabel() helper vs the badge
 * sites that render a license label.
 *
 * Sites:
 *   lib/skill-card.ts    — renderLicenseBadge() now calls licenseLabel() directly
 *                          (SMI-5366 extracted it from skills/index.astro; bundled,
 *                          so it imports the helper rather than mirroring it).
 *   skills/[id].astro    — still is:inline, mirrors `skill.license?.trim() || 'Unknown'`
 *                          (SMI-4907 tracks migrating that page to a bundled <script>).
 *
 * This test exists to catch any drift between the helper and the remaining
 * inline mirror ([id].astro). When a badge site changes its null-handling, this
 * test must be updated FIRST so the helper stays the authoritative source.
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
  // lib/skill-card.ts renderLicenseBadge: `escapeHtml(licenseLabel(license))` (calls the helper)
  // skills/[id].astro renderSkill:        `skill.license?.trim() || 'Unknown'` (inline mirror)
  // licenseLabel():                       `const trimmed = license?.trim(); return trimmed ? trimmed : 'Unknown'`

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
