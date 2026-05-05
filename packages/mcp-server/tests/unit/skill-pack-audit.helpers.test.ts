/**
 * @fileoverview Unit tests for skill-pack-audit.helpers — pure helpers.
 * @module @skillsmith/mcp-server/tests/unit/skill-pack-audit-helpers
 *
 * SMI-4737: derivePackDomain returns null when the inferred domain string
 * exceeds FIELD_LIMITS.packDomain (64 chars). Strategies 1 and 2 each cap
 * the result independently; an early bail also short-circuits adversarial
 * pack names before strategy execution.
 */

import { describe, it, expect } from 'vitest'
import { derivePackDomain } from '../../src/tools/skill-pack-audit.helpers.js'
import { FIELD_LIMITS } from '../../src/tools/validate.types.js'
import type { GenericTriggersStoplist } from '@skillsmith/core'

const EMPTY_STOPLIST: GenericTriggersStoplist = Object.freeze({
  triggerWords: Object.freeze([]),
  namespaces: Object.freeze([]),
  locale: 'en',
  notes: 'unit-fixture',
}) as GenericTriggersStoplist

describe('derivePackDomain — SMI-4737 packDomain caps', () => {
  it('Strategy 1: returns null when stripped prefix > FIELD_LIMITS.packDomain (64)', () => {
    // 70-char prefix + '-skills' = 77-char pack name; fits under the early-bail
    // threshold (71 + slack) but exceeds the strategy-1 prefix cap (64).
    const longPrefix = 'a'.repeat(70)
    const packName = `${longPrefix}-skills`
    const result = derivePackDomain(packName, [], EMPTY_STOPLIST)
    expect(result).toBeNull()
  })

  it('Strategy 1: returns prefix at the 64-char boundary', () => {
    const exactPrefix = 'a'.repeat(64)
    const packName = `${exactPrefix}-skills`
    const result = derivePackDomain(packName, [], EMPTY_STOPLIST)
    expect(result).toBe(exactPrefix)
  })

  it('Strategy 2: returns null when mode tag > FIELD_LIMITS.packDomain (64)', () => {
    // Pack name does NOT end with `-skills` so Strategy 1 is skipped.
    // All skills tagged with the same 70-char tag → tag is the mode but
    // exceeds the cap, so derivation returns null.
    const longTag = 'b'.repeat(70)
    const allSkills = [{ tags: [longTag] }, { tags: [longTag] }]
    const result = derivePackDomain('mypack', allSkills, EMPTY_STOPLIST)
    expect(result).toBeNull()
  })

  it('Strategy 2: returns mode tag at the 64-char boundary', () => {
    const exactTag = 'c'.repeat(FIELD_LIMITS.packDomain)
    const allSkills = [{ tags: [exactTag] }, { tags: [exactTag] }]
    const result = derivePackDomain('mypack', allSkills, EMPTY_STOPLIST)
    expect(result).toBe(exactTag)
  })

  it('early bail: returns null when packName exceeds 71-char (cap + "-skills") threshold', () => {
    // 72-char pack name — exceeds the early-bail threshold; both strategies
    // are skipped entirely.
    const adversarial = 'd'.repeat(72)
    const result = derivePackDomain(adversarial, [], EMPTY_STOPLIST)
    expect(result).toBeNull()
  })

  it('legitimate domain identifiers pass unchanged (regression guard)', () => {
    expect(derivePackDomain('planning-skills', [], EMPTY_STOPLIST)).toBe('planning')
    expect(derivePackDomain('cicd-skills', [], EMPTY_STOPLIST)).toBe('cicd')
  })
})
