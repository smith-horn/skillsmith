/**
 * SMI-5327: Unit tests for the licenseLabel helper.
 *
 * The website renders license in two places that use identical logic:
 *   1. Skill card (createLicenseBadge in skills/index.astro inline script)
 *   2. Skill detail page (renderSkill in skills/[id].astro inline script)
 *
 * Both sites are is:inline Astro scripts with no component-test harness.
 * The label logic is extracted here so it can be covered without a browser.
 *
 * CONTRACT: null / undefined / empty => "Unknown" (NOT "no license",
 * "unrestricted", "freely usable", or "public domain").
 */

import { describe, it, expect } from 'vitest'
import { licenseLabel } from './license-label'

describe('licenseLabel — known SPDX identifiers render verbatim', () => {
  it('returns "MIT" for "MIT"', () => {
    expect(licenseLabel('MIT')).toBe('MIT')
  })

  it('returns "Apache-2.0" for "Apache-2.0"', () => {
    expect(licenseLabel('Apache-2.0')).toBe('Apache-2.0')
  })

  it('returns "GPL-3.0" for "GPL-3.0"', () => {
    expect(licenseLabel('GPL-3.0')).toBe('GPL-3.0')
  })

  it('returns "CC-BY-4.0" for "CC-BY-4.0"', () => {
    expect(licenseLabel('CC-BY-4.0')).toBe('CC-BY-4.0')
  })

  it('returns "Unlicense" for "Unlicense"', () => {
    expect(licenseLabel('Unlicense')).toBe('Unlicense')
  })
})

describe('licenseLabel — null / missing license renders as "Unknown"', () => {
  it('returns "Unknown" for null', () => {
    expect(licenseLabel(null)).toBe('Unknown')
  })

  it('returns "Unknown" for undefined', () => {
    expect(licenseLabel(undefined)).toBe('Unknown')
  })

  it('returns "Unknown" for empty string', () => {
    expect(licenseLabel('')).toBe('Unknown')
  })

  it('returns "Unknown" for whitespace-only string', () => {
    expect(licenseLabel('   ')).toBe('Unknown')
  })

  it('does not return "no license" for null', () => {
    expect(licenseLabel(null)).not.toBe('no license')
  })

  it('does not return "unrestricted" for null', () => {
    expect(licenseLabel(null)).not.toBe('unrestricted')
  })

  it('does not return "freely usable" for null', () => {
    expect(licenseLabel(null)).not.toBe('freely usable')
  })

  it('does not return "public domain" for null', () => {
    expect(licenseLabel(null)).not.toBe('public domain')
  })
})
