/**
 * HIGH_TRUST_AUTHORS array invariants
 * @module scripts/tests/indexer/high-trust-authors
 *
 * SMI-4843 Phase 5: Structural assertions on the Node port of
 * `scripts/indexer/high-trust-authors.ts`. Guards against accidental
 * duplicates, malformed entries, non-permissive licenses, and unintended
 * wildcard-path depth that would bloat the trees-search expansion budget.
 *
 * Companion: parity test (`parity.test.ts`) asserts byte-identity between
 * the Node port and the Deno parent. The two together ensure (a) the data
 * is shaped correctly and (b) both runtimes see the same data.
 */

import { describe, it, expect } from 'vitest'
import { HIGH_TRUST_AUTHORS } from '../../../scripts/indexer/high-trust-authors.js'

/**
 * Permissive license allowlist. The interface currently declares
 * `'Apache-2.0' | 'MIT' | 'Mixed'`, but the test accepts the broader set
 * the indexer treats as installable so future additions don't need a test
 * change alongside the type widening.
 */
const PERMISSIVE_LICENSES = new Set([
  'Apache-2.0',
  'MIT',
  'Mixed',
  'BSD-3-Clause',
  'BSD-2-Clause',
  'MPL-2.0',
  'ISC',
])

describe('HIGH_TRUST_AUTHORS', () => {
  it('contains 34 entries (16 baseline + 18 phase-5 additions)', () => {
    expect(HIGH_TRUST_AUTHORS).toHaveLength(34)
  })

  it('has no duplicate (owner, repo) pairs', () => {
    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const a of HIGH_TRUST_AUTHORS) {
      const key = `${a.owner.toLowerCase()}/${a.repo.toLowerCase()}`
      if (seen.has(key)) duplicates.push(key)
      seen.add(key)
    }
    expect(duplicates).toEqual([])
  })

  it('every entry has non-empty owner, repo, license, description', () => {
    for (const a of HIGH_TRUST_AUTHORS) {
      expect(a.owner, `owner missing for ${JSON.stringify(a)}`).toBeTruthy()
      expect(a.repo, `repo missing for ${a.owner}/?`).toBeTruthy()
      expect(a.license, `license missing for ${a.owner}/${a.repo}`).toBeTruthy()
      expect(a.description, `description missing for ${a.owner}/${a.repo}`).toBeTruthy()
      expect(a.description.length, `description empty for ${a.owner}/${a.repo}`).toBeGreaterThan(0)
    }
  })

  it('every license is in the permissive allowlist', () => {
    for (const a of HIGH_TRUST_AUTHORS) {
      expect(
        PERMISSIVE_LICENSES.has(a.license),
        `license "${a.license}" for ${a.owner}/${a.repo} not in permissive allowlist`
      ).toBe(true)
    }
  })

  it('every skillsPaths value is a non-empty string array', () => {
    for (const a of HIGH_TRUST_AUTHORS) {
      if (a.skillsPaths === undefined) continue // default path applied at index time
      expect(Array.isArray(a.skillsPaths), `${a.owner}/${a.repo} skillsPaths not array`).toBe(true)
      expect(a.skillsPaths.length, `${a.owner}/${a.repo} skillsPaths empty`).toBeGreaterThan(0)
      for (const p of a.skillsPaths) {
        expect(typeof p, `${a.owner}/${a.repo} skillsPaths element not string`).toBe('string')
        expect(p.length, `${a.owner}/${a.repo} skillsPaths element empty`).toBeGreaterThan(0)
      }
    }
  })

  it('every wildcard skillsPaths pattern has single-segment depth', () => {
    // Wildcard expansion is bounded — `**` (recursive) is not supported by
    // the trees-search expander and would silently produce no matches.
    // Slash count <= 3 keeps depth to {plugins/*/skills, .github/plugins/*/skills, skills/*/skills}.
    for (const a of HIGH_TRUST_AUTHORS) {
      if (!a.skillsPaths) continue
      for (const p of a.skillsPaths) {
        expect(p, `${a.owner}/${a.repo} path "${p}" uses ** (unsupported)`).not.toContain('**')
        const slashCount = (p.match(/\//g) ?? []).length
        expect(
          slashCount,
          `${a.owner}/${a.repo} path "${p}" depth ${slashCount} exceeds 3-slash budget`
        ).toBeLessThanOrEqual(3)
      }
    }
  })

  it('baseQualityScore is in [0.0, 1.0]', () => {
    for (const a of HIGH_TRUST_AUTHORS) {
      expect(a.baseQualityScore, `${a.owner}/${a.repo}`).toBeGreaterThanOrEqual(0)
      expect(a.baseQualityScore, `${a.owner}/${a.repo}`).toBeLessThanOrEqual(1)
    }
  })

  it('trustTier when present is one of {verified, curated}', () => {
    for (const a of HIGH_TRUST_AUTHORS) {
      if (a.trustTier === undefined) continue
      expect(
        ['verified', 'curated'].includes(a.trustTier),
        `${a.owner}/${a.repo} trustTier "${a.trustTier}" invalid`
      ).toBe(true)
    }
  })
})
