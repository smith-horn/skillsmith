/**
 * SMI-5879 Wave 1: `computeFixtureCorpusCorroborationVerified`
 * (`smi5879-gate-check.closure.ts`) test suite. Split out of
 * `smi5879-gate-check.test.ts` (that file plus this one together exceeded
 * ~450 lines, matching item 3's precedent of splitting by concern).
 * @module scripts/tests/indexer/smi5879-gate-check.closure-corroboration
 *
 * Exercises the function DIRECTLY against realistic `--reporter=json`-shaped
 * vitest summaries — a matching-snapshot pass case, and three ways a
 * deliberately-mismatched snapshot must verify false with a specific,
 * named reason (never inferred from an aggregate `success` boolean). This is
 * the "real corroboration path" coverage `smi5879-gate-check.test.ts`'s own
 * G-5 tests intentionally do NOT provide — those inject a fake
 * `Smi5879GateCheckTestDeps.runStructuralClosureTests` and never call
 * `runStructuralClosureTestsViaVitest`/`computeFixtureCorpusCorroborationVerified`
 * for real (module doc rationale: a real invocation spawns a nested vitest
 * process, which this suite must never do).
 *
 * Design: docs/internal/implementation/smi-5879-g5-corroboration-spec.md §6.
 */

import { describe, expect, it } from 'vitest'
import { computeFixtureCorpusCorroborationVerified } from '../../indexer/smi5879-gate-check.closure.ts'
import { CORROBORATION_COLLECTION } from '../../indexer/smi5879-corroboration.types.ts'

describe('smi5879-gate-check.closure.ts — computeFixtureCorpusCorroborationVerified (SMI-5879 Wave 1)', () => {
  const CORE_FILE = 'packages/core/tests/security/smi5879-corroboration.core.test.ts'
  const EDGE_FILE = 'scripts/tests/indexer/smi5879-corroboration.edge.test.ts'
  const CORE_SENTINELS =
    CORROBORATION_COLLECTION.find((s) => s.file === CORE_FILE)?.sentinelFullNames ?? []
  const EDGE_SENTINELS =
    CORROBORATION_COLLECTION.find((s) => s.file === EDGE_FILE)?.sentinelFullNames ?? []

  function passingAssertionResults(
    sentinels: readonly string[]
  ): Array<{ fullName: string; status: string }> {
    return sentinels.map((fullName) => ({ fullName, status: 'passed' }))
  }

  function makeVitestSummary(overrides: {
    coreStatus?: string
    coreAssertions?: Array<{ fullName: string; status: string }>
    edgeStatus?: string
    edgeAssertions?: Array<{ fullName: string; status: string }>
    coreName?: string
    edgeName?: string
  }): Record<string, unknown> {
    return {
      testResults: [
        {
          name: overrides.coreName ?? `/app/${CORE_FILE}`,
          status: overrides.coreStatus ?? 'passed',
          assertionResults: overrides.coreAssertions ?? passingAssertionResults(CORE_SENTINELS),
        },
        {
          name: overrides.edgeName ?? `/app/${EDGE_FILE}`,
          status: overrides.edgeStatus ?? 'passed',
          assertionResults: overrides.edgeAssertions ?? passingAssertionResults(EDGE_SENTINELS),
        },
      ],
    }
  }

  it('a matching snapshot (both files collected, container-absolute name, every sentinel passed) verifies true', () => {
    const result = computeFixtureCorpusCorroborationVerified(makeVitestSummary({}))
    expect(result).toEqual({ verified: true, reason: null })
  })

  it('a deliberately-mismatched snapshot (a sentinel assertion missing) is INCONCLUSIVE-shaped: verified false, with a reason naming the exact file and sentinel', () => {
    const mismatched = makeVitestSummary({
      edgeAssertions: passingAssertionResults(EDGE_SENTINELS.slice(1)), // drop the first sentinel
    })
    const result = computeFixtureCorpusCorroborationVerified(mismatched)
    expect(result.verified).toBe(false)
    expect(result.reason).toContain(EDGE_FILE)
    expect(result.reason).toContain(EDGE_SENTINELS[0])
  })

  it('a file that was never collected (no matching testResults[].name suffix) verifies false, naming the missing file', () => {
    const result = computeFixtureCorpusCorroborationVerified(
      makeVitestSummary({ coreName: '/app/some/other/file.test.ts' })
    )
    expect(result.verified).toBe(false)
    expect(result.reason).toContain(CORE_FILE)
  })

  it('a non-passed assertion (e.g. skipped) verifies false, never inferred from an aggregate success boolean', () => {
    const result = computeFixtureCorpusCorroborationVerified(
      makeVitestSummary({
        edgeAssertions: [
          { fullName: EDGE_SENTINELS[0], status: 'skipped' },
          ...passingAssertionResults(EDGE_SENTINELS.slice(1)),
        ],
      })
    )
    expect(result.verified).toBe(false)
    expect(result.reason).toMatch(/non-passed assertion/)
  })
})
