/**
 * SMI-6033 Wave 4 item 5 — lint-style guard: no advisory-tier category ever
 * emits `high` severity.
 *
 * Split out of co-signal-escalation.test.ts (which holds the escalation-model
 * and end-to-end fixtures) because this is a STRUCTURAL check over detector
 * SOURCE text, not a behavioral one over scan output. A fixture-driven sweep
 * can only prove the branches its fixtures happen to reach; this proves the
 * branch does not exist to reach.
 *
 * Every one of these detectors is designed as `low` (documentation) /
 * `medium` (advisory, co-signal-eligible) / `critical` (provenance-
 * conditioned standalone). `high` is deliberately absent from all of them:
 * `high` alone trips core's `passed` gate (`!hasCritical && !hasHigh &&
 * !exceedsThreshold`, SecurityScanner.ts) WITHOUT carrying the provenance
 * condition that justifies a standalone block — which is exactly the
 * contradiction the plan's Gap 6 co-signal model exists to avoid.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const SCANNER_DIR = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  'src',
  'security',
  'scanner'
)

// ============================================================================
// Lint-style guard — no Wave 2/4 advisory category ever emits 'high'
// ============================================================================

/**
 * Structural, not fixture-driven: greps each detector's own source for a
 * `severity:` expression mentioning the literal `'high'`. A fixture-based
 * sweep can only prove the branches its fixtures happen to reach; this
 * proves the branch does not exist to reach. Every one of these detectors is
 * designed as `low` (documentation) / `medium` (advisory) / `critical`
 * (provenance-conditioned standalone) — `high` is deliberately absent from
 * all of them, because `high` alone trips core's `passed` gate without
 * carrying the provenance condition that justifies it.
 */
describe('SMI-6033 Wave 4 item 5 — no new advisory category ever emits `high` severity', () => {
  const DETECTOR_SOURCES: ReadonlyArray<[string, string]> = [
    ['decoy_misdirection', 'SecurityScanner.decoy.ts'],
    ['archive_evasion', 'SecurityScanner.archive.ts'],
    ['paste_host_fetch', 'SecurityScanner.paste-host.ts'],
    ['encoded_payload', 'SecurityScanner.encoding.ts'],
  ]

  it.each(DETECTOR_SOURCES)(
    "%s's detector source contains no `severity: ... 'high'` expression",
    (_type, fileName) => {
      const source = readFileSync(join(SCANNER_DIR, fileName), 'utf-8')
      // Match the `severity:` property value expression up to the line end —
      // covers both the plain form and the nested-ternary form every one of
      // these detectors uses.
      const severityExprs = source.match(/^\s*severity:.*$/gm) ?? []
      expect(
        severityExprs.length,
        `${fileName} has no severity: assignment at all`
      ).toBeGreaterThan(0)
      for (const expr of severityExprs) {
        expect(expr, `${fileName} emits 'high' severity: ${expr.trim()}`).not.toMatch(/'high'/)
      }
    }
  )

  // gatekeeper_bypass lives in the shared compound module alongside
  // scanChmodFetchCompound, which legitimately DOES emit 'high' — so this one
  // is scoped to the gatekeeper function's own body rather than the file.
  it("gatekeeper_bypass's own function body contains no `severity: ... 'high'` expression", () => {
    const source = readFileSync(join(SCANNER_DIR, 'SecurityScanner.compound.ts'), 'utf-8')
    const start = source.indexOf('export function scanGatekeeperBypass')
    expect(start, 'scanGatekeeperBypass not found in SecurityScanner.compound.ts').toBeGreaterThan(
      -1
    )
    const body = source.slice(start)
    const severityExprs = body.match(/^\s*severity:.*$/gm) ?? []
    expect(severityExprs.length).toBeGreaterThan(0)
    for (const expr of severityExprs) {
      expect(expr, `scanGatekeeperBypass emits 'high' severity: ${expr.trim()}`).not.toMatch(
        /'high'/
      )
    }
  })
})
