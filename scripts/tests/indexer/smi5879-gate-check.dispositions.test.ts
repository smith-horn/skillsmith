/**
 * SMI-5879 Wave 3 item 4: smi5879-gate-check.ts test suite (part 2) — G-7/
 * G-8 attestation, G-1 hand review, the full decision-mode end-to-end PASS
 * path, and §12.1's dirty-worktree hardening. Split out of
 * smi5879-gate-check.test.ts (that file plus this one together exceeded
 * ~450 lines, matching item 3's precedent of splitting by concern).
 * @module scripts/tests/indexer/smi5879-gate-check.dispositions
 *
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.5, §12
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { evaluateGateCheck } from '../../indexer/smi5879-gate-check.ts'
import {
  checkGitTreeClean,
  CLOSURE_TEST_FILES,
  CLOSURE_WATCHED_SOURCE_PATHS,
} from '../../indexer/smi5879-gate-check.closure.ts'
import type { GateResult } from '../../indexer/smi5879-gate-check.types.ts'
import { makeFixtureEnv, makeFixtureTempDir } from '../_lib/git-fixture-env.ts'
import {
  DECISION_RUN_ID,
  buildRequiredArgs,
  makeAttestationChecks,
  makeAttestationJson,
  makeDispositionLedgerJson,
  makeFakeDb,
  makeFakeTestDeps,
  makeScratchDir,
  makeSimRow,
  makeSimulatorReportJson,
  writeFixtureFile,
} from './smi5879-gate-check.fixtures.ts'

const G7_IDS = [
  'F-1',
  'F-2',
  'F-3',
  'F-4',
  'F-5',
  'F-6',
  'F-7',
  'F-8',
  'F-9',
  'F-1S',
  'F-2S',
  'F-3S',
  'F-4S',
  'F-5S',
  'F-6S',
]
const G8_IDS = ['P-0.1', 'P-0.2', 'P-0.3', 'P-0.4', 'P-0.5', 'P-0.6']

function findGate(gates: readonly GateResult[], id: string): GateResult {
  const gate = gates.find((g) => g.id === id)
  if (!gate) throw new Error(`gate ${id} not found in report.gates`)
  return gate
}

describe('smi5879-gate-check.ts — G-7/G-8 attestation', () => {
  it('G-7/G-8 are INCONCLUSIVE with a distinct reason when the attestation file is missing entirely', async () => {
    const dir = makeScratchDir()
    const args = buildRequiredArgs(dir)
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(findGate(report.gates, 'G-7').reason).toMatch(/unavailable/)
    expect(findGate(report.gates, 'G-8').reason).toMatch(/unavailable/)
  })

  it('G-7 distinguishes a MISSING required id from a present-but-red one', async () => {
    const dir = makeScratchDir()
    const checks = makeAttestationChecks(G7_IDS.filter((id) => id !== 'F-9')) // F-9 never recorded
    const attestationPath = writeFixtureFile(
      dir,
      'attestation.json',
      makeAttestationJson({
        checks: checks.filter((c) => c['id'] !== 'F-8').concat([{ id: 'F-8', status: 'red' }]),
      })
    )
    const args = { ...buildRequiredArgs(dir), attestationPath }
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    const g7 = findGate(report.gates, 'G-7')
    expect(g7.outcome).toBe('INCONCLUSIVE')
    expect(g7.reason).toMatch(/missing \(never recorded\).*F-9/)
    expect(g7.reason).toMatch(/present but red.*F-8/)
  })

  it('G-7 PASSes when F-1..F-9/F-1S..F-6S are all green and the backfill kill switch was clean', async () => {
    const dir = makeScratchDir()
    const attestationPath = writeFixtureFile(
      dir,
      'attestation.json',
      makeAttestationJson({ checks: makeAttestationChecks(G7_IDS.concat(G8_IDS)) })
    )
    const args = { ...buildRequiredArgs(dir), attestationPath }
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(findGate(report.gates, 'G-7').outcome).toBe('PASS')
  })

  it('finding #5: an attestation file with a run_id from a DIFFERENT run is INCONCLUSIVE for both G-7 and G-8', async () => {
    const dir = makeScratchDir()
    const attestationPath = writeFixtureFile(
      dir,
      'attestation.json',
      makeAttestationJson({
        run_id: 'a-stale-run-from-last-week',
        checks: makeAttestationChecks(G7_IDS.concat(G8_IDS)),
      })
    )
    const args = { ...buildRequiredArgs(dir), attestationPath }
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(findGate(report.gates, 'G-7').outcome).toBe('INCONCLUSIVE')
    expect(findGate(report.gates, 'G-7').reason).toMatch(/malformed/)
    expect(findGate(report.gates, 'G-8').outcome).toBe('INCONCLUSIVE')
    const g7 = findGate(report.gates, 'G-7')
    // The underlying reason names the mismatched run_id.
    expect(g7.reason).toMatch(/a-stale-run-from-last-week/)
  })

  it('finding #8: a RED then GREEN duplicate record for the same check id is a conflict, never last-write-wins', async () => {
    const dir = makeScratchDir()
    const checks = makeAttestationChecks(G7_IDS.concat(G8_IDS)).concat([
      // F-1 recorded twice with DISAGREEING status — the array's GREEN entry
      // for F-1 (from makeAttestationChecks above) is followed by a
      // conflicting RED one.
      { id: 'F-1', status: 'red' },
    ])
    const attestationPath = writeFixtureFile(
      dir,
      'attestation.json',
      makeAttestationJson({ checks })
    )
    const args = { ...buildRequiredArgs(dir), attestationPath }
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    const g7 = findGate(report.gates, 'G-7')
    expect(g7.outcome).toBe('INCONCLUSIVE')
    expect(g7.reason).toMatch(/conflicting duplicate records/)
    expect(g7.reason).toMatch(/F-1/)
    expect(g7.detail?.['conflictingIds']).toEqual(['F-1'])
  })

  it('G-8 independently re-derives the 24h settle window from the DB, never the file', async () => {
    const dir = makeScratchDir()
    const attestationPath = writeFixtureFile(
      dir,
      'attestation.json',
      makeAttestationJson({
        checks: makeAttestationChecks(G7_IDS.concat(G8_IDS)),
        // File claims the merge was ages ago...
        pr2192a_merged_at: '2020-01-01T00:00:00.000000Z',
      })
    )
    const args = { ...buildRequiredArgs(dir), attestationPath }
    // ...but the DB-sourced decision snapshot_started_at is fixed at
    // 2026-07-29T20:15:00Z (fixtures.ts's DECISION_STARTED_AT) — since G-8
    // must use the DB value, not trust the file, a merge only ~1h15m before
    // that DB timestamp must still be INCONCLUSIVE even though the file
    // itself would have looked fine if trusted directly.
    const attestationPathRecent = writeFixtureFile(
      dir,
      'attestation-recent.json',
      makeAttestationJson({
        checks: makeAttestationChecks(G7_IDS.concat(G8_IDS)),
        pr2192a_merged_at: '2026-07-29T19:00:00.000000Z',
      })
    )
    const reportOld = await evaluateGateCheck(
      { db: makeFakeDb(), test: makeFakeTestDeps() },
      { ...args, attestationPath }
    )
    // 2020 merge date is >24h before the DB's fixed snapshot_started_at -> PASS.
    expect(findGate(reportOld.gates, 'G-8').outcome).toBe('PASS')

    const reportRecent = await evaluateGateCheck(
      { db: makeFakeDb(), test: makeFakeTestDeps() },
      { ...args, attestationPath: attestationPathRecent }
    )
    expect(findGate(reportRecent.gates, 'G-8').outcome).toBe('INCONCLUSIVE')
    expect(findGate(reportRecent.gates, 'G-8').reason).toMatch(/24h required/)
  })

  it("a G-4/G-6-shaped attestation input (bogus ids) can't accidentally satisfy G-7 or G-8", async () => {
    const dir = makeScratchDir()
    const attestationPath = writeFixtureFile(
      dir,
      'attestation.json',
      makeAttestationJson({ checks: makeAttestationChecks(['G-4', 'G-6']) })
    )
    const args = { ...buildRequiredArgs(dir), attestationPath }
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(findGate(report.gates, 'G-7').outcome).toBe('INCONCLUSIVE')
    expect(findGate(report.gates, 'G-8').outcome).toBe('INCONCLUSIVE')
  })
})

describe('smi5879-gate-check.ts — G-1 hand review', () => {
  it('is INCONCLUSIVE because R cannot be computed when G-2 has not passed', async () => {
    const dir = makeScratchDir()
    // An empty-but-present ledger, so the ledger-validity check (which G-1
    // evaluates FIRST — a malformed/missing ledger is its own distinct
    // reason) passes trivially and the G-2-dependency check is what fires.
    const dispositionsPath = writeFixtureFile(
      dir,
      'dispositions.json',
      makeDispositionLedgerJson([])
    )
    const args = {
      ...buildRequiredArgs(dir, {
        simulatorJson: makeSimulatorReportJson({
          // status:'partial' alone is enough to make G-2 INCONCLUSIVE (which
          // is all this test needs) — unevaluable stays 0, matching the
          // (empty) `rows` array, so finding #7's coverage/rows
          // cross-validation doesn't short-circuit before G-2 even runs.
          coverage: {
            C1: { status: 'partial', scanned: 0, total: 1, unevaluable: 0, unfetchable: 0 },
            C2: { status: 'full', scanned: 0, total: 0, unevaluable: 0, unfetchable: 0 },
            C3: { status: 'full', scanned: 0, total: 0, unevaluable: 0, unfetchable: 0 },
            C4: { status: 'full', scanned: 0, total: 0, unevaluable: 0, unfetchable: 0 },
          },
        }),
      }),
      dispositionsPath,
    }
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(findGate(report.gates, 'G-1').reason).toMatch(/G-2 has not passed/)
  })

  it('finding #5: a disposition ledger with a run_id from a DIFFERENT run is INCONCLUSIVE, never silently trusted', async () => {
    const dir = makeScratchDir()
    const rows = [makeSimRow({ id: 'r1', outcome: 'newly_quarantined' })]
    const dispositionsPath = writeFixtureFile(
      dir,
      'dispositions.json',
      makeDispositionLedgerJson([{ id: 'r1', verdict: 'confirm' }], 'a-stale-run-from-last-week')
    )
    const args = {
      ...buildRequiredArgs(dir, { simulatorJson: makeSimulatorReportJson({ rows }) }),
      dispositionsPath,
    }
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    const g1 = findGate(report.gates, 'G-1')
    expect(g1.outcome).toBe('INCONCLUSIVE')
    expect(g1.reason).toMatch(/disposition ledger unavailable/)
    expect(g1.reason).toMatch(/a-stale-run-from-last-week/)
    expect(g1.reason).toMatch(new RegExp(DECISION_RUN_ID))
  })

  it('rejects a disposition ledger with conflicting verdicts for the same id (never last-write-wins)', async () => {
    const dir = makeScratchDir()
    const rows = [makeSimRow({ id: 'r1', outcome: 'newly_quarantined' })]
    const dispositionsPath = writeFixtureFile(
      dir,
      'dispositions.json',
      makeDispositionLedgerJson([
        { id: 'r1', verdict: 'confirm' },
        { id: 'r1', verdict: 'exclude' },
      ])
    )
    const args = {
      ...buildRequiredArgs(dir, { simulatorJson: makeSimulatorReportJson({ rows }) }),
      dispositionsPath,
    }
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(findGate(report.gates, 'G-1').outcome).toBe('INCONCLUSIVE')
    expect(findGate(report.gates, 'G-1').reason).toMatch(/conflicting verdicts/)
  })

  it('is INCONCLUSIVE when a row in R has no disposition at all', async () => {
    const dir = makeScratchDir()
    const rows = [makeSimRow({ id: 'r1', outcome: 'newly_quarantined' })]
    // The ledger EXISTS and is well-formed, but has zero entries — r1 is
    // genuinely undisposed, distinct from "no ledger was provided at all".
    const dispositionsPath = writeFixtureFile(
      dir,
      'dispositions.json',
      makeDispositionLedgerJson([])
    )
    const args = {
      ...buildRequiredArgs(dir, { simulatorJson: makeSimulatorReportJson({ rows }) }),
      dispositionsPath,
    }
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(findGate(report.gates, 'G-1').outcome).toBe('INCONCLUSIVE')
    expect(findGate(report.gates, 'G-1').reason).toMatch(/lack any disposition/)
  })

  it('is INCONCLUSIVE when an unfetchable row has no recorded exclude', async () => {
    const dir = makeScratchDir()
    const rows = [makeSimRow({ id: 'r1', outcome: 'unfetchable' })]
    const dispositionsPath = writeFixtureFile(
      dir,
      'dispositions.json',
      makeDispositionLedgerJson([])
    )
    const args = {
      ...buildRequiredArgs(dir, { simulatorJson: makeSimulatorReportJson({ rows }) }),
      dispositionsPath,
    }
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(findGate(report.gates, 'G-1').outcome).toBe('INCONCLUSIVE')
    expect(findGate(report.gates, 'G-1').reason).toMatch(/unfetchable row/)
  })

  it('PASSes when every row in R and every unfetchable row has a recorded disposition', async () => {
    const dir = makeScratchDir()
    const rows = [
      makeSimRow({ id: 'r1', outcome: 'newly_quarantined' }),
      makeSimRow({ id: 'r2', outcome: 'newly_cleared' }),
      makeSimRow({ id: 'r3', outcome: 'unfetchable' }),
    ]
    const dispositionsPath = writeFixtureFile(
      dir,
      'dispositions.json',
      makeDispositionLedgerJson([
        { id: 'r1', verdict: 'confirm' },
        { id: 'r2', verdict: 'confirm' },
        { id: 'r3', verdict: 'exclude' },
      ])
    )
    const args = {
      ...buildRequiredArgs(dir, { simulatorJson: makeSimulatorReportJson({ rows }) }),
      dispositionsPath,
    }
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(findGate(report.gates, 'G-1').outcome).toBe('PASS')
  })
})

describe('smi5879-gate-check.ts — full end-to-end PASS (decision mode)', () => {
  it('overall is PASS when every gate independently passes', async () => {
    const dir = makeScratchDir()
    const rows = [
      makeSimRow({ id: 'r1', outcome: 'newly_quarantined' }),
      makeSimRow({ id: 'r2', outcome: 'newly_cleared' }),
    ]
    const attestationPath = writeFixtureFile(
      dir,
      'attestation.json',
      makeAttestationJson({ checks: makeAttestationChecks(G7_IDS.concat(G8_IDS)) })
    )
    const dispositionsPath = writeFixtureFile(
      dir,
      'dispositions.json',
      makeDispositionLedgerJson([
        { id: 'r1', verdict: 'confirm' },
        { id: 'r2', verdict: 'confirm' },
      ])
    )
    const args = {
      ...buildRequiredArgs(dir, { simulatorJson: makeSimulatorReportJson({ rows }) }),
      attestationPath,
      dispositionsPath,
    }
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(report.overall).toBe('PASS')
    expect(report.gates.every((g) => g.outcome === 'PASS' || g.outcome === 'NOT_APPLICABLE')).toBe(
      true
    )
    // Decision mode: G-2R is NOT_APPLICABLE, never blocks.
    expect(findGate(report.gates, 'G-2R').outcome).toBe('NOT_APPLICABLE')
  })
})

describe('smi5879-gate-check.closure.ts — §12.1 dirty-worktree hardening', () => {
  it('checkGitTreeClean detects uncommitted changes on the watched paths in a real temp git repo', () => {
    const tmpRepo = makeFixtureTempDir('smi5879-gate-check-dirty-tree')
    const env = makeFixtureEnv()
    execFileSync('git', ['init', '-q'], { cwd: tmpRepo, env })
    const trackedPath = 'watched-file.ts'
    writeFileSync(join(tmpRepo, trackedPath), 'export const x = 1\n')
    execFileSync('git', ['add', trackedPath], { cwd: tmpRepo, env })
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmpRepo, env })

    // Clean immediately after commit.
    const cleanResult = checkGitTreeClean([trackedPath], tmpRepo)
    expect(cleanResult.clean).toBe(true)

    // Dirty the watched file WITHOUT committing.
    writeFileSync(join(tmpRepo, trackedPath), 'export const x = 2\n')
    const dirtyResult = checkGitTreeClean([trackedPath], tmpRepo)
    expect(dirtyResult.clean).toBe(false)
  })

  it('finding #4: the DEFAULT watch list also catches dirtiness in the scanner implementation, not just the 3 test files', () => {
    const tmpRepo = makeFixtureTempDir('smi5879-gate-check-dirty-tree-broadened')
    const env = makeFixtureEnv()
    execFileSync('git', ['init', '-q'], { cwd: tmpRepo, env })
    // Materialize every CLOSURE_WATCHED_SOURCE_PATHS entry as a tracked file.
    for (const relPath of CLOSURE_WATCHED_SOURCE_PATHS) {
      const full = join(tmpRepo, relPath)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, `// ${relPath}\n`)
    }
    execFileSync('git', ['add', '-A'], { cwd: tmpRepo, env })
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmpRepo, env })

    // Clean immediately after commit, using the REAL default (no explicit
    // paths arg) — proves the production default really is the broadened list.
    expect(checkGitTreeClean(undefined, tmpRepo).clean).toBe(true)

    // Dirty a NON-test-file path (the scanner implementation itself) that the
    // OLD 3-file-only watch list would have completely missed.
    const scannerPath = join(tmpRepo, 'packages/core/src/security/scanner/SecurityScanner.ts')
    writeFileSync(scannerPath, '// dirty, uncommitted\n')
    expect(checkGitTreeClean(undefined, tmpRepo).clean).toBe(false)

    // Proof the gap existed before the fix: the OLD narrow 3-file list would
    // have reported this exact worktree state as clean.
    expect(checkGitTreeClean(CLOSURE_TEST_FILES, tmpRepo).clean).toBe(true)
  })

  it('round-2 re-verification finding: the DEFAULT watch list also catches dirtiness in parity-utils.ts, not just fixtures.ts itself', () => {
    const tmpRepo = makeFixtureTempDir('smi5879-gate-check-dirty-tree-parity-utils')
    const env = makeFixtureEnv()
    execFileSync('git', ['init', '-q'], { cwd: tmpRepo, env })
    for (const relPath of CLOSURE_WATCHED_SOURCE_PATHS) {
      const full = join(tmpRepo, relPath)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, `// ${relPath}\n`)
    }
    execFileSync('git', ['add', '-A'], { cwd: tmpRepo, env })
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmpRepo, env })

    expect(checkGitTreeClean(undefined, tmpRepo).clean).toBe(true)

    // Dirty parity-utils.ts — the shared fixtures.ts imports `isGitCryptEncrypted`
    // from it and calls it at module-load time, so an uncommitted edit here can
    // change what the fixtures (and thus the closure suite) evaluate exactly
    // like a dirty fixtures.ts would, yet a fixtures.ts-only watch list misses it.
    const parityUtilsPath = join(tmpRepo, 'scripts/tests/indexer/parity-utils.ts')
    writeFileSync(parityUtilsPath, '// dirty, uncommitted\n')
    expect(checkGitTreeClean(undefined, tmpRepo).clean).toBe(false)

    // Proof the gap existed before this fix: a watch list without parity-utils.ts
    // would have reported this exact worktree state as clean.
    const withoutParityUtils = CLOSURE_WATCHED_SOURCE_PATHS.filter(
      (p) => p !== 'scripts/tests/indexer/parity-utils.ts'
    )
    expect(checkGitTreeClean(withoutParityUtils, tmpRepo).clean).toBe(true)
  })

  // round-3 re-verification finding: an exhaustive transitive-import trace of
  // every already-watched file (not just the obvious scanner/fixture ones)
  // surfaced 4 more runtime dependencies of the self-invoked vitest run that
  // were still unwatched — each parameterized here the same way parity-utils.ts
  // was above, one dedicated case per path so a future removal of any one of
  // them from CLOSURE_WATCHED_SOURCE_PATHS fails exactly one named test.
  const ROUND_3_NEW_WATCHED_PATHS = [
    // patterns.scope.ts imports SSRF_INSTRUCTION_PATTERNS from here and runs
    // assertScopeCoverage() against it at module load.
    'packages/core/src/security/scanner/patterns.ts',
    // vitest.config.ts imports sharedTestConfig/coverageDefaults/coverageThresholds from here.
    'vitest.preset.ts',
    // named in vitest.config.ts's setupFiles -- runs before every test, closure tests included.
    'vitest.setup.ts',
    // read by vitest.config.ts's gitCryptLocked() sentinel check, which decides
    // whether supabase/functions/** test paths are excluded from the run.
    'supabase/functions/_shared/cors.ts',
  ] as const

  it.each(ROUND_3_NEW_WATCHED_PATHS)(
    'round-3 re-verification finding: the DEFAULT watch list also catches dirtiness in %s',
    (dirtyPath) => {
      const tmpRepo = makeFixtureTempDir('smi5879-gate-check-dirty-tree-round3')
      const env = makeFixtureEnv()
      execFileSync('git', ['init', '-q'], { cwd: tmpRepo, env })
      for (const relPath of CLOSURE_WATCHED_SOURCE_PATHS) {
        const full = join(tmpRepo, relPath)
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, `// ${relPath}\n`)
      }
      execFileSync('git', ['add', '-A'], { cwd: tmpRepo, env })
      execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmpRepo, env })

      expect(checkGitTreeClean(undefined, tmpRepo).clean).toBe(true)

      writeFileSync(join(tmpRepo, dirtyPath), '// dirty, uncommitted\n')
      expect(checkGitTreeClean(undefined, tmpRepo).clean).toBe(false)

      // Proof the gap existed before this fix: a watch list without this exact
      // path would have reported this exact worktree state as clean.
      const withoutThisPath = CLOSURE_WATCHED_SOURCE_PATHS.filter((p) => p !== dirtyPath)
      expect(checkGitTreeClean(withoutThisPath, tmpRepo).clean).toBe(true)
    }
  )
})
