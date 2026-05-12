// Phase 3a code-search env-gate test (SMI-4861 Wave 1 / SMI-4859)
//
// Source-level assertion that discovery-orchestrator.ts gates the
// `runCodeSearch` call behind `SKILLSMITH_ENABLE_CODE_SEARCH=true`. We test
// the source pattern (not runtime) because Phase 3a's runtime path requires
// a full Supabase + GitHub stack to exercise.
//
// Regression context: SMI-4859 RCA confirmed Phase 3a has produced 0 new
// repos for 25+ consecutive days due to Phase 1/2 dedup short-circuit. Phase
// 3a still costs ~1 code-search API call + 6s delay per discovery run on the
// 10rpm bucket. Default-disabling reclaims that budget without permanently
// closing the door — env-flag opt-in preserved.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ORCHESTRATOR = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'scripts',
  'indexer',
  'discovery-orchestrator.ts'
)

const SOURCE = readFileSync(ORCHESTRATOR, 'utf-8')

describe('Phase 3a env-gate — SKILLSMITH_ENABLE_CODE_SEARCH (SMI-4861 Wave 1)', () => {
  it('the runCodeSearch call is wrapped in an env check', () => {
    // Find the SKILLSMITH_ENABLE_CODE_SEARCH gate line and confirm it appears
    // BEFORE the runCodeSearch invocation. The wrap pattern mirrors Phase 3b
    // (SKILLSMITH_ENABLE_SUBDIRECTORY_SEARCH) at discovery-orchestrator.ts:230.
    const gateIdx = SOURCE.indexOf("process.env.SKILLSMITH_ENABLE_CODE_SEARCH === 'true'")
    expect(gateIdx, 'Phase 3a env gate missing').toBeGreaterThan(0)

    const callIdx = SOURCE.indexOf('await runCodeSearch(')
    expect(callIdx, 'runCodeSearch call missing').toBeGreaterThan(0)

    expect(callIdx, 'runCodeSearch must be inside the env-gate block').toBeGreaterThan(gateIdx)
  })

  it('the default-disabled disposition is surfaced in audit telemetry', () => {
    // When the env flag is unset, the code path emits a disabled marker so
    // dashboards can distinguish "ran-and-found-zero" from "not-run". See
    // SMI-4859 RCA — silent "0" was confused for a runtime regression.
    expect(SOURCE).toContain("error: 'disabled_by_env'")
  })

  it('does NOT thread SKILLSMITH_ENABLE_CODE_SEARCH through IndexerEnv', () => {
    // Convention pin: Phase 3b reads process.env.X directly at :230. Phase 3a
    // must follow the same pattern (per plan §1.2 + plan-review v1 finding #5)
    // so a future refactor migrates both phases together as one change.
    const parseEnvSrc = readFileSync(
      resolve(__dirname, '..', '..', '..', 'scripts', 'indexer', 'parse-env.ts'),
      'utf-8'
    )
    expect(parseEnvSrc).not.toContain('SKILLSMITH_ENABLE_CODE_SEARCH')
  })

  it('mirrors the Phase 3b env-gate pattern (both use direct process.env reads)', () => {
    // Phase 3b lookup MUST also be present and follow the same pattern;
    // pinning this catches a refactor that moves either gate to IndexerEnv
    // without doing the matching migration for the other.
    expect(SOURCE).toContain("process.env.SKILLSMITH_ENABLE_SUBDIRECTORY_SEARCH === 'true'")
  })
})
