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
import { buildDisabledSubdirectorySearchMarker } from '../../indexer/subdirectory-search.ts'

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
    // SMI-4870: the marker is now selected by a ternary —
    // `error: runPhase3 ? 'disabled_by_env' : 'skipped_phase_split'` — so the
    // assertion matches the marker value, not the `error: '<marker>'` literal.
    expect(SOURCE).toContain("'disabled_by_env'")
    expect(SOURCE).toContain("'skipped_phase_split'")
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

// SMI-5930 Wave 3: Phase 3b previously had no else branch on its env-gate at
// all — result.subdirectory_search stayed `undefined` for every scheduled/
// dispatched indexer.yml run (SKILLSMITH_ENABLE_SUBDIRECTORY_SEARCH is never
// set there; only indexer-backfill.yml sets it, and that workflow has no
// `schedule:` trigger). That silent gap is exactly the "ran-and-found-zero"
// vs. "not-run" confusion SMI-4859 already fixed for Phase 3a above — Phase
// 3b never got the matching treatment, which is why no discovery audit row
// ever surfaced that `.claude/skills` (the one convention that depends
// entirely on Phase 3b's primary broad-query path, since it is deliberately
// excluded from FALLBACK_PATH_PREFIXES) had stopped being re-crawled.
describe('Phase 3b env-gate — SKILLSMITH_ENABLE_SUBDIRECTORY_SEARCH (SMI-5930 Wave 3)', () => {
  // Isolate Phase 3b's own block so assertions can't accidentally pass by
  // matching Phase 3a's occurrence of the same marker strings elsewhere in
  // the file.
  const phase3bStart = SOURCE.indexOf('// ── Phase 3b: Subdirectory code search')
  const phase3bEnd = SOURCE.indexOf('// Count total SKILL.md files on GitHub', phase3bStart)
  const PHASE_3B_BLOCK = SOURCE.slice(phase3bStart, phase3bEnd)

  it('the runSubdirectorySearchPhase call is wrapped in an env check', () => {
    expect(phase3bStart, 'Phase 3b section marker missing').toBeGreaterThan(0)
    expect(phase3bEnd, 'Phase 3b block end marker missing').toBeGreaterThan(phase3bStart)
    expect(PHASE_3B_BLOCK).toContain(
      "if (runPhase3 && process.env.SKILLSMITH_ENABLE_SUBDIRECTORY_SEARCH === 'true')"
    )
    expect(PHASE_3B_BLOCK).toContain('await runSubdirectorySearchPhase(')
  })

  it('has an else branch that sets result.subdirectory_search (regression: previously absent)', () => {
    // Prior to SMI-5930 Wave 3 this else branch did not exist at all, so
    // result.subdirectory_search stayed undefined whenever the phase was
    // gated off — this test would have failed against that code.
    const ifIdx = PHASE_3B_BLOCK.indexOf(
      "if (runPhase3 && process.env.SKILLSMITH_ENABLE_SUBDIRECTORY_SEARCH === 'true')"
    )
    const elseIdx = PHASE_3B_BLOCK.indexOf('} else {', ifIdx)
    expect(elseIdx, 'Phase 3b else branch missing').toBeGreaterThan(ifIdx)
    expect(PHASE_3B_BLOCK.slice(elseIdx)).toContain(
      'result.subdirectory_search = buildDisabledSubdirectorySearchMarker('
    )
  })

  it('the disabled disposition mirrors Phase 3a’s marker shape (disabled_by_env / skipped_phase_split)', () => {
    // Marker construction itself lives in buildDisabledSubdirectorySearchMarker
    // (subdirectory-search.ts) — this call site just picks which disposition
    // string to pass, so pin the ternary here and the marker shape there.
    expect(PHASE_3B_BLOCK).toContain("'disabled_by_env'")
    expect(PHASE_3B_BLOCK).toContain("'skipped_phase_split'")
    expect(PHASE_3B_BLOCK).toContain('runPhase3 ?')
  })

  it('does NOT thread SKILLSMITH_ENABLE_SUBDIRECTORY_SEARCH through IndexerEnv', () => {
    // Same convention pin as Phase 3a — a future refactor migrating one gate
    // to IndexerEnv without the other would silently desync the two phases.
    const parseEnvSrc = readFileSync(
      resolve(__dirname, '..', '..', '..', 'scripts', 'indexer', 'parse-env.ts'),
      'utf-8'
    )
    expect(parseEnvSrc).not.toContain('SKILLSMITH_ENABLE_SUBDIRECTORY_SEARCH')
  })

  it('buildDisabledSubdirectorySearchMarker returns a zeroed marker with the given disposition', () => {
    // Extracted to subdirectory-search.ts (SMI-5930 Wave 3 file-length split)
    // so it's shared between this else-branch and Phase 3b's own catch block
    // (runSubdirectorySearchPhase's 'phase_failed' case) instead of two
    // independently-maintained copies.
    for (const error of ['disabled_by_env', 'skipped_phase_split', 'phase_failed'] as const) {
      expect(buildDisabledSubdirectorySearchMarker(error)).toEqual({
        repos_found: 0,
        total_found: 0,
        retries: 0,
        license_filtered: 0,
        license_fetch_failed: 0,
        admitted: 0,
        license_null: 0,
        no_default_branch: 0,
        error,
      })
    }
  })
})
