/**
 * SMI-6508 — the prefixed `secrets` assignment form (MF-5).
 *
 * `SECRETS_ASSIGN_PATTERN` carries `\b`, and `_` is a word character, so it
 * cannot match after an underscore or a camelCase hump. `API_SECRETS=<real>`,
 * `app_secrets=<real>` and `mySecrets=<real>` were therefore unflagged in
 * production, while `DB_PASSWORD=` and `AWS_CREDENTIALS=` were caught — their
 * patterns never carried a boundary.
 *
 * The fix adds a complementary pattern rather than removing the boundary,
 * because removing it would have routed these through MF-4 (HIGH by default,
 * which BLOCKS installation with no allowlist in that path). Measured against
 * 66,495 real skill contents: MF-4 would have called 191 of 418 newly-reached
 * lines "real value", newly blocking 132 skills, and ~46% of those 191 had
 * false-positive-looking shapes. So MF-5 ships the detection at MEDIUM.
 *
 * THE COMPLEMENTARITY IS LOAD-BEARING. The two patterns must never both fire on
 * one line: double-firing would emit two findings for one credential and make
 * the severity depend on array order. The bare pattern keeps `MY-SECRETS=` and
 * `my.secrets=` (both `-` and `.` are non-word characters its `\b` accepts);
 * the prefixed one takes exactly what the boundary excludes.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { SecurityScanner } from '../../src/security/index.js'
import type { SecurityFinding } from '../../src/security/scanner/types.js'
import {
  SENSITIVE_PATH_PATTERNS,
  OBSERVE_ONLY_MEDIUM_PATTERNS,
  VALUE_GATED_ASSIGNMENT_PATTERNS,
} from '../../src/security/scanner/patterns.js'

/** A value the gate would call "real" — deliberately not a plausible credential. */
const REAL = 'Zk29fQpL4mXv7Nd1'

let scanner: SecurityScanner
beforeEach(() => {
  scanner = new SecurityScanner()
})

const sensitivePathFindings = (content: string): SecurityFinding[] =>
  scanner.scan('t', content).findings.filter((f) => f.type === 'sensitive_path')

describe('SMI-6508: prefixed secrets assignment (MF-5)', () => {
  describe('newly detected, at MEDIUM', () => {
    const PREFIXED = [
      [`API_SECRETS=${REAL}`, 'SCREAMING_SNAKE, the dominant env-var convention'],
      [`app_secrets=${REAL}`, 'snake_case'],
      [`mySecrets=${REAL}`, 'camelCase hump'],
      [`API_SECRET=${REAL}`, 'SINGULAR prefixed form — missed by the original report'],
      [`AWS_SECRETS: ${REAL}`, 'colon form with space'],
    ] as const

    it.each(PREFIXED)('%s flags at MEDIUM (%s)', (line) => {
      const findings = sensitivePathFindings(line)
      expect(findings.length).toBeGreaterThan(0)
      // MF-5 is never HIGH, regardless of how real the value looks.
      expect(findings.every((f) => f.severity === 'medium')).toBe(true)
    })

    it('does not block installation — a MEDIUM sensitive_path keeps the report passing', () => {
      // The install service rejects on report.passed; MF-5 must not flip it.
      const report = scanner.scan('t', `API_SECRETS=${REAL}`)
      expect(report.findings.some((f) => f.type === 'sensitive_path')).toBe(true)
      expect(
        report.findings.some((f) => f.type === 'sensitive_path' && f.severity === 'high')
      ).toBe(false)
    })
  })

  describe('existing behaviour unchanged', () => {
    it.each([
      [`secrets=${REAL}`, 'bare, lowercase'],
      [`SECRETS=${REAL}`, 'bare, uppercase'],
      [`MY-SECRETS=${REAL}`, 'hyphen is a non-word char — stays with the bare pattern'],
      [`my.secrets=${REAL}`, 'dot is a non-word char — stays with the bare pattern'],
    ])('%s still reaches HIGH via MF-4 (%s)', (line) => {
      const findings = sensitivePathFindings(line)
      expect(findings.some((f) => f.severity === 'high')).toBe(true)
    })
  })

  describe('must not fire', () => {
    it('SECRETSTORE= is not an assignment OF secrets', () => {
      expect(sensitivePathFindings(`SECRETSTORE=${REAL}`)).toHaveLength(0)
    })

    it('a prose mention with no assignment does not fire', () => {
      expect(sensitivePathFindings('The app_secrets module documents rotation.')).toHaveLength(0)
    })
  })

  describe('complementarity — the two patterns never both fire', () => {
    const ALL = [
      `API_SECRETS=${REAL}`,
      `app_secrets=${REAL}`,
      `mySecrets=${REAL}`,
      `API_SECRET=${REAL}`,
      `secrets=${REAL}`,
      `SECRETS=${REAL}`,
      `MY-SECRETS=${REAL}`,
      `my.secrets=${REAL}`,
      `  secrets: ${REAL}`,
    ]

    it.each(ALL)('%s matches at most one of the two secrets-assignment patterns', (line) => {
      const bare = [...VALUE_GATED_ASSIGNMENT_PATTERNS].filter(
        (p) => p.source.includes('secrets') && p.test(line)
      )
      const prefixed = [...OBSERVE_ONLY_MEDIUM_PATTERNS].filter((p) => p.test(line))
      expect(bare.length + prefixed.length).toBeLessThanOrEqual(1)
    })
  })

  describe('classification wiring', () => {
    it('the prefixed pattern is registered in the scanned array', () => {
      const [prefixed] = [...OBSERVE_ONLY_MEDIUM_PATTERNS]
      expect(SENSITIVE_PATH_PATTERNS).toContain(prefixed)
    })

    it('it is NOT value-gated — routing it through MF-4 is what this fix avoids', () => {
      const [prefixed] = [...OBSERVE_ONLY_MEDIUM_PATTERNS]
      expect(VALUE_GATED_ASSIGNMENT_PATTERNS.has(prefixed)).toBe(false)
    })
  })
})
