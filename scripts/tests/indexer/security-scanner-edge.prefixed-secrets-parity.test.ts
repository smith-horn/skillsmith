/**
 * SMI-6508 — core <-> edge BEHAVIOURAL parity for MF-5, the always-MEDIUM
 * prefixed-keyword assignment class.
 *
 * WHY THIS FILE EXISTS. The twin guard (security-scanner-edge.test.ts,
 * PATHS_FAMILY_TWINS) asserts the two `_shared` copies are BYTE-identical to
 * each other modulo their @module line. It says nothing about whether the edge
 * pair agrees with `@skillsmith/core`, which is a separate hand-maintained
 * implementation. A refactor that preserves twin byte-equality while changing
 * the shared severity behaviour in BOTH copies would pass byte-identity and
 * still diverge from core in production — the gap the SMI-6508 cross-family
 * pre-merge gate named. Byte-identity then carries the Deno twin transitively:
 * core == Node (here) and Node == Deno (there).
 *
 * The table pins the whole MF-5 decision surface: the prefixed forms that are
 * newly detected at MEDIUM, the bare forms that must keep reaching HIGH, the
 * non-word-character prefixes that stay with the bare pattern, and the
 * non-assignment shape that must not fire at all.
 *
 * NOTE on one-finding-per-line: scanSensitivePaths `break`s on the first
 * SENSITIVE_PATH_PATTERNS entry that matches, in ARRAY order, so a line
 * carrying both a bare and a prefixed assignment yields a single HIGH finding —
 * the bare entry precedes the prefixed one. That is asserted here on both
 * surfaces, because it is exactly the kind of ordering property a port can get
 * wrong while remaining byte-identical to its own twin.
 */

import { describe, it, expect } from 'vitest'
import { scanSensitivePaths as edgeScan } from '../../indexer/_shared/security-scanner-edge.paths.ts'
import { analyzeMarkdownContext as edgeContext } from '../../indexer/_shared/security-scanner-edge.context.ts'
import { SecurityScanner } from '../../../packages/core/src/security/index.js'

/** A value the gate reads as real — deliberately not a plausible credential. */
const REAL = 'Zk29fQpL4mXv7Nd1'

/** Highest sensitive_path severity on `content` ('none' when nothing fires). */
function edgeSeverity(content: string): string {
  const findings = edgeScan(content.split('\n'), edgeContext(content)).filter(
    (f) => f.type === 'sensitive_path'
  )
  if (findings.length === 0) return 'none'
  return findings.some((f) => f.severity === 'high') ? 'high' : findings[0].severity
}

function coreSeverity(content: string): string {
  const findings = new SecurityScanner()
    .scan('t', content)
    .findings.filter((f) => f.type === 'sensitive_path')
  if (findings.length === 0) return 'none'
  return findings.some((f) => f.severity === 'high') ? 'high' : findings[0].severity
}

/** [line, expectedSeverity] — must hold identically on both surfaces. */
const CASES: Array<[string, string]> = [
  // MF-5: prefixed forms, newly detected, always MEDIUM
  [`API_SECRETS=${REAL}`, 'medium'],
  [`app_secrets=${REAL}`, 'medium'],
  [`mySecrets=${REAL}`, 'medium'],
  [`API_SECRET=${REAL}`, 'medium'], // singular — missed by the original report
  [`AWS_SECRETS: ${REAL}`, 'medium'],

  // MF-4: bare forms keep reaching HIGH, unchanged by this work
  [`secrets=${REAL}`, 'high'],
  [`SECRETS=${REAL}`, 'high'],
  // `-` and `.` are non-word characters, so the bare pattern's \b still matches
  [`MY-SECRETS=${REAL}`, 'high'],
  [`my.secrets=${REAL}`, 'high'],

  // array-order + break: a bare assignment on the line wins, either order
  [`secrets=${REAL} API_SECRETS=${REAL}`, 'high'],
  [`API_SECRETS=${REAL} secrets=${REAL}`, 'high'],

  // must not fire: not an assignment OF the keyword
  [`SECRETSTORE=${REAL}`, 'none'],
]

describe('SMI-6508 MF-5 — core <-> edge behavioural parity', () => {
  it.each(CASES)('%s → %s on BOTH surfaces', (line, expected) => {
    expect(coreSeverity(line)).toBe(expected)
    expect(edgeSeverity(line)).toBe(expected)
  })

  it('the two surfaces agree on every case (no silent divergence)', () => {
    for (const [line] of CASES) {
      expect(edgeSeverity(line)).toBe(coreSeverity(line))
    }
  })
})
