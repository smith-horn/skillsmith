/**
 * SMI-5881 — pattern scope model tests.
 *
 * `patterns.scope.ts` replaces the old per-source-text multiline-detection
 * heuristic (formerly `isMultilinePattern()` in SecurityScanner.helpers.ts,
 * deleted entirely — no compatibility shim) with an explicit, fail-closed
 * `PatternScope` ('line' | 'content' | 'both') declared per pattern by object
 * identity. Covers:
 *  - exhaustiveness over all three scoped pattern arrays
 *  - the fail-closed throw for an unmapped pattern (no safe default, unlike
 *    the evidence-tier map)
 *  - the module-load assertScopeCoverage() gate (SSRF never 'both')
 *  - a source-text guard that the deleted identifier never reappears, and
 *    that both scope-filtering call sites go through resolvePatternScope
 */

import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'
import {
  PATTERN_SCOPE,
  SCOPED_PATTERN_SETS,
  resolvePatternScope,
} from '../../src/security/scanner/patterns.scope.js'
import { SSRF_INSTRUCTION_PATTERNS } from '../../src/security/scanner/patterns.js'
import { AI_DEFENCE_PATTERNS } from '../../src/security/scanner/patterns.jailbreak.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const CORE_SRC_ROOT = join(__dirname, '../../src')

const VALID_SCOPES = new Set(['line', 'content', 'both'])

describe('SMI-5881 — PATTERN_SCOPE exhaustiveness', () => {
  it('has an entry for every pattern in every SCOPED_PATTERN_SETS array, with a valid value', () => {
    // `Map.has()` alone is not sufficient: `new Map([[p, undefined]])` still
    // reports `.has(p) === true`, which is exactly how an index-aligned
    // (patterns, scope) array pair drifting out of length parity would slip
    // through a has()-only check. Assert the VALUE is present and is one of
    // the three real PatternScope literals, not just that the key exists.
    for (const { name, patterns } of SCOPED_PATTERN_SETS) {
      patterns.forEach((pattern, index) => {
        expect(PATTERN_SCOPE.has(pattern), `${name}[${index}] missing a PATTERN_SCOPE entry`).toBe(
          true
        )
        const scope = PATTERN_SCOPE.get(pattern)
        expect(
          scope !== undefined && VALID_SCOPES.has(scope),
          `${name}[${index}] has an invalid PATTERN_SCOPE value: ${JSON.stringify(scope)}`
        ).toBe(true)
      })
    }
  })

  it('covers exactly JAILBREAK_PATTERNS(23) + AI_DEFENCE_PATTERNS(21) + SSRF_INSTRUCTION_PATTERNS(13) = 57 entries, no more, no fewer', () => {
    // Exact equality, not >=: a length mismatch between a PATTERNS array and
    // its index-aligned SCOPE array (patterns.scope.ts) would otherwise not
    // be caught by a floor-only assertion, since `Map` entries built from a
    // shorter scope array still populate one Map entry per pattern (with an
    // `undefined` value) — the size is unaffected by the mismatch even
    // though several entries are invalid. Combined with the per-entry
    // validity check above, this closes that gap. Growth is expected and
    // welcome — update this count deliberately when a pattern is added.
    const totalPatterns = SCOPED_PATTERN_SETS.reduce(
      (sum, { patterns }) => sum + patterns.length,
      0
    )
    expect(totalPatterns).toBe(57)
    expect(PATTERN_SCOPE.size).toBe(57)
  })
})

describe('SMI-5881 — resolvePatternScope fail-closed throw', () => {
  it('throws for a pattern with no PATTERN_SCOPE entry (no safe default)', () => {
    const unmapped = /this-pattern-was-never-registered-in-pattern-scope/i
    expect(PATTERN_SCOPE.has(unmapped)).toBe(false)
    expect(() => resolvePatternScope(unmapped)).toThrow(/has no PATTERN_SCOPE entry/)
  })

  it('resolves each of the 4 promoted AI_DEFENCE patterns to "both"', () => {
    // Index positions (not the private consts, which patterns.jailbreak.ts
    // intentionally doesn't export) are pinned by scanner-regression-guard
    // .test.ts and scanner-evidence-tiers.test.ts's own array-shape assertions.
    const promotedIndices = [2, 3, 10, 13] // AD_HTML_COMMENT_VERB/NOUN, AD_NESTED_INSTRUCTION_BLOCK, AD_ZERO_WIDTH
    for (const i of promotedIndices) {
      expect(resolvePatternScope(AI_DEFENCE_PATTERNS[i])).toBe('both')
    }
  })
})

describe('SMI-5881 — assertScopeCoverage module-load gate', () => {
  it('no SSRF_INSTRUCTION_PATTERNS member is ever scoped "both"', () => {
    // scanSsrfPatterns' older skip-based two-pass cannot correctly service
    // 'both' — this is enforced at module-load time by assertScopeCoverage()
    // (patterns.scope.ts throws and makes the module un-importable if
    // violated), re-asserted here so a future regression fails a normal test
    // run too, not just an import-time crash discovered incidentally.
    for (const pattern of SSRF_INSTRUCTION_PATTERNS) {
      expect(PATTERN_SCOPE.get(pattern)).not.toBe('both')
    }
  })

  it('the module itself imported without throwing (assertScopeCoverage ran clean)', () => {
    // If assertScopeCoverage() had found a gap, importing patterns.scope.ts
    // at the top of this file would already have thrown before any test ran.
    expect(PATTERN_SCOPE.size).toBeGreaterThan(0)
  })
})

describe('SMI-5881 — isMultilinePattern removal guard', () => {
  function collectSourceFiles(dir: string): string[] {
    const entries = readdirSync(dir)
    const files: string[] = []
    for (const entry of entries) {
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        files.push(...collectSourceFiles(full))
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
        files.push(full)
      }
    }
    return files
  }

  it('the identifier "isMultilinePattern" appears nowhere under packages/core/src/', () => {
    const files = collectSourceFiles(CORE_SRC_ROOT)
    const offenders: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      if (content.includes('isMultilinePattern')) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  it('SecurityScanner.helpers.ts filters patterns by scope via resolvePatternScope', () => {
    const content = readFileSync(
      join(CORE_SRC_ROOT, 'security/scanner/SecurityScanner.helpers.ts'),
      'utf-8'
    )
    expect(content).toContain('resolvePatternScope')
    expect(content).toMatch(/resolvePatternScope\(pattern\) === 'line'/)
    expect(content).toMatch(/resolvePatternScope\(pattern\) === 'content'/)
  })

  it('SecurityScanner.ssrf.ts filters patterns by scope via resolvePatternScope', () => {
    const content = readFileSync(
      join(CORE_SRC_ROOT, 'security/scanner/SecurityScanner.ssrf.ts'),
      'utf-8'
    )
    expect(content).toContain('resolvePatternScope')
    expect(content).toMatch(/resolvePatternScope\(pattern\) === 'line'/)
    expect(content).toMatch(/resolvePatternScope\(pattern\) === 'content'/)
  })
})
