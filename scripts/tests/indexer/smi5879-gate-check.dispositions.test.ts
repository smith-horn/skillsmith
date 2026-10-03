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
import {
  validateDispositionLedger,
  validateDispositionLedgerShape,
} from '../../indexer/smi5879-gate-check.helpers.ts'
import {
  makeAuthorizedDispositionLookup,
  makeManualOnlyDispositionLookup,
} from '../../indexer/smi5879-gate-check.gates.bulk-authorization.ts'
import type { GateResult } from '../../indexer/smi5879-gate-check.types.ts'
import type { SimRowResult } from '../../indexer/smi5879-simulate-full.types.ts'
import { makeFixtureEnv, makeFixtureTempDir } from '../_lib/git-fixture-env.ts'
import {
  DECISION_RUN_ID,
  buildRequiredArgs,
  makeFakeDb,
  makeFakeTestDeps,
  makeScratchDir,
  makeSimRow,
  makeSimulatorReportJson,
  populationFromSimRows,
  writeFixtureFile,
} from './smi5879-gate-check.fixtures.ts'
import {
  makeAttestationChecks,
  makeAttestationJson,
  makeBulkEntry,
  makeDispositionBatchJson,
  makeDispositionLedgerJson,
} from './smi5879-gate-check.fixtures.dispositions.ts'

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
          // A hard-stopped tier-3 sweep is enough to make G-2 INCONCLUSIVE,
          // which is all this test needs. SMI-6444: it deliberately replaces
          // the older "coverage.total exceeds the reported rows" setup —
          // a report that doesn't cover its own population is now refused at
          // binding, before ANY gate runs, so it can no longer exercise
          // G-1's G-2 dependency.
          rows: [makeSimRow({ id: 'r1' })],
          sweep: { passes_run: 8, hard_stopped: 'non_convergence' },
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

  it('SMI-6442: is INCONCLUSIVE when a primary_not_found row has no recorded exclude', async () => {
    const dir = makeScratchDir()
    const rows = [makeSimRow({ id: 'r1', outcome: 'primary_not_found' })]
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
    expect(findGate(report.gates, 'G-1').reason).toMatch(/primary_not_found row/)
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

/**
 * SMI-6444 (plan Item 2, steps (1)-(5)): G-1 independently AUTHORIZES every
 * `method:'bulk'` entry against the digest-verified population and the
 * authenticated report. The producer-side tests only prove the producer
 * doesn't EMIT bad data; these prove G-1 REJECTS it however it got there —
 * a hand-edited ledger included. Every rejection surfaces through the
 * existing missing-disposition reporting, never as a silent drop.
 */
describe('smi5879-gate-check.ts — G-1 bulk-entry authorization', () => {
  const BATCH_ID = 'batch-unfetchable-001'

  async function runG1(
    dir: string,
    rows: Record<string, unknown>[],
    ledgerJson: Record<string, unknown>,
    dbOverrides: Partial<Parameters<typeof makeFakeDb>[0]> = {}
  ): Promise<GateResult> {
    const dispositionsPath = writeFixtureFile(dir, 'dispositions.json', ledgerJson)
    const args = {
      ...buildRequiredArgs(dir, { simulatorJson: makeSimulatorReportJson({ rows }) }),
      dispositionsPath,
    }
    const report = await evaluateGateCheck(
      { db: makeFakeDb(dbOverrides), test: makeFakeTestDeps() },
      args
    )
    expect(report.artifact_binding_ok).toBe(true)
    return findGate(report.gates, 'G-1')
  }

  it('a bulk entry with NO matching batch is undisposed (unresolved batch_id authorizes nothing)', async () => {
    const rows = [makeSimRow({ id: 'r1', outcome: 'unfetchable' })]
    const g1 = await runG1(
      makeScratchDir(),
      rows,
      // The entry names a batch that simply is not in `batches`.
      makeDispositionLedgerJson([makeBulkEntry('r1', BATCH_ID)], DECISION_RUN_ID, [])
    )
    expect(g1.outcome).toBe('INCONCLUSIVE')
    expect(g1.reason).toMatch(/unfetchable row\(s\) lack a recorded exclude/)
    expect(g1.detail?.['missingUnfetchableExcludes']).toEqual(['r1'])
  })

  it('a batch that was staged but NEVER signed off authorizes nothing', async () => {
    const rows = [makeSimRow({ id: 'r1', outcome: 'unfetchable' })]
    const g1 = await runG1(
      makeScratchDir(),
      rows,
      makeDispositionLedgerJson([makeBulkEntry('r1', BATCH_ID)], DECISION_RUN_ID, [
        makeDispositionBatchJson({
          batchId: BATCH_ID,
          outcomeClass: 'unfetchable',
          entryIds: ['r1'],
          signed: false,
        }),
      ])
    )
    expect(g1.outcome).toBe('INCONCLUSIVE')
    expect(g1.detail?.['missingUnfetchableExcludes']).toEqual(['r1'])
  })

  it("a signed batch whose sign_off_digest doesn't match a FRESH recomputation authorizes nothing", async () => {
    const rows = [makeSimRow({ id: 'r1', outcome: 'unfetchable' })]
    const g1 = await runG1(
      makeScratchDir(),
      rows,
      makeDispositionLedgerJson([makeBulkEntry('r1', BATCH_ID)], DECISION_RUN_ID, [
        makeDispositionBatchJson({
          batchId: BATCH_ID,
          outcomeClass: 'unfetchable',
          entryIds: ['r1'],
          // A sign-off carried over from some earlier staged content — the
          // stored digest is the ONLY thing a hand-editor controls here, and
          // it is precisely what the gate refuses to trust.
          overrides: { sign_off_digest: 'f'.repeat(64) },
        }),
      ])
    )
    expect(g1.outcome).toBe('INCONCLUSIVE')
    expect(g1.detail?.['missingUnfetchableExcludes']).toEqual(['r1'])
  })

  it("a batch whose declared outcome_class differs from the row's real outcome authorizes nothing", async () => {
    const rows = [makeSimRow({ id: 'r1', outcome: 'unfetchable' })]
    const g1 = await runG1(
      makeScratchDir(),
      rows,
      makeDispositionLedgerJson([makeBulkEntry('r1', BATCH_ID)], DECISION_RUN_ID, [
        // Correctly signed, but scoped to the OTHER terminal class — a signed
        // batch for one class must never authorize entries for another.
        makeDispositionBatchJson({
          batchId: BATCH_ID,
          outcomeClass: 'primary_not_found',
          entryIds: ['r1'],
        }),
      ])
    )
    expect(g1.outcome).toBe('INCONCLUSIVE')
    expect(g1.detail?.['missingUnfetchableExcludes']).toEqual(['r1'])
  })

  it('a bulk entry pointing at an R-outcome row is undisposed regardless of what the ledger claims', async () => {
    const rows = [makeSimRow({ id: 'r1', outcome: 'newly_quarantined' })]
    const g1 = await runG1(
      makeScratchDir(),
      rows,
      makeDispositionLedgerJson([makeBulkEntry('r1', BATCH_ID)], DECISION_RUN_ID, [
        makeDispositionBatchJson({
          batchId: BATCH_ID,
          outcomeClass: 'unfetchable',
          entryIds: ['r1'],
        }),
      ])
    )
    // A security-review row can never be disposed by a batch attestation.
    expect(g1.outcome).toBe('INCONCLUSIVE')
    expect(g1.reason).toMatch(/lack any disposition/)
    expect(g1.detail?.['missingRDispositions']).toEqual(['r1'])
  })

  it('a bulk entry with verdict "confirm" is undisposed — bulk can only ever exclude', async () => {
    const rows = [makeSimRow({ id: 'r1', outcome: 'unfetchable' })]
    const g1 = await runG1(
      makeScratchDir(),
      rows,
      makeDispositionLedgerJson(
        [makeBulkEntry('r1', BATCH_ID, { verdict: 'confirm' })],
        DECISION_RUN_ID,
        [
          makeDispositionBatchJson({
            batchId: BATCH_ID,
            outcomeClass: 'unfetchable',
            entryIds: ['r1'],
          }),
        ]
      )
    )
    expect(g1.outcome).toBe('INCONCLUSIVE')
    expect(g1.detail?.['missingUnfetchableExcludes']).toEqual(['r1'])
  })

  it("a bulk unfetchable entry whose population row doesn't re-derive as unfetchable is undisposed", async () => {
    const rows = [makeSimRow({ id: 'r1', outcome: 'unfetchable' })]
    const g1 = await runG1(
      makeScratchDir(),
      rows,
      makeDispositionLedgerJson([makeBulkEntry('r1', BATCH_ID)], DECISION_RUN_ID, [
        makeDispositionBatchJson({
          batchId: BATCH_ID,
          outcomeClass: 'unfetchable',
          entryIds: ['r1'],
        }),
      ]),
      {
        // Identical to the population the report binds against, EXCEPT for a
        // perfectly parseable GitHub URL; paired with a branch map carrying
        // no not-found/unparseable resolution for it, `deriveUnfetchableSubtype`
        // returns null — so the row does not independently re-derive as
        // unfetchable no matter what the report's own label claims.
        async loadCohortRows() {
          return populationFromSimRows(rows).map((row) => ({
            ...row,
            repo_url: 'https://github.com/acme/r1',
          }))
        },
      }
    )
    expect(g1.outcome).toBe('INCONCLUSIVE')
    expect(g1.detail?.['missingUnfetchableExcludes']).toEqual(['r1'])
  })

  it('a well-formed, signed, coherent batch DOES dispose its rows and G-1 passes', async () => {
    const rows = [
      makeSimRow({ id: 'r1', outcome: 'unfetchable' }),
      makeSimRow({ id: 'r2', outcome: 'unfetchable' }),
    ]
    const g1 = await runG1(
      makeScratchDir(),
      rows,
      makeDispositionLedgerJson(
        [makeBulkEntry('r1', BATCH_ID), makeBulkEntry('r2', BATCH_ID)],
        DECISION_RUN_ID,
        [
          makeDispositionBatchJson({
            batchId: BATCH_ID,
            outcomeClass: 'unfetchable',
            entryIds: ['r1', 'r2'],
          }),
        ]
      )
    )
    expect(g1.outcome).toBe('PASS')
    expect(g1.reason).toMatch(/every unfetchable row \(2\)/)
  })

  it('the manual-only lookup is NOT redundant with the authorized one: a row that is both unfetchable AND a drift row', () => {
    // The load-bearing justification for G-2R (and G-1's own drift check)
    // using `makeManualOnlyDispositionLookup` rather than the general
    // authorized lookup. `drift_class` and the report `outcome` are
    // INDEPENDENT axes: a row can be `unfetchable` in the decision report and
    // ALSO deleted from the window generation (DR-1). For such a row the
    // general lookup's outcome-class check passes, so it authorizes the bulk
    // entry — which would silently dispose a drift row that plan Item 0
    // requires a human to review. If someone ever "simplifies" either drift
    // check to the general lookup, this test fails.
    const id = 'unfetchable-and-drifted'
    const shape = validateDispositionLedgerShape(
      makeDispositionLedgerJson([makeBulkEntry(id, BATCH_ID)], DECISION_RUN_ID, [
        makeDispositionBatchJson({
          batchId: BATCH_ID,
          outcomeClass: 'unfetchable',
          entryIds: [id],
        }),
      ])
    )
    if (!shape.ok) throw new Error(`fixture ledger invalid: ${shape.reason}`)
    const validation = validateDispositionLedger(shape.value)

    const rows = [makeSimRow({ id, outcome: 'unfetchable' })]
    const population = populationFromSimRows(rows)
    const authorized = makeAuthorizedDispositionLookup(
      validation,
      rows as unknown as SimRowResult[],
      population,
      new Map()
    )
    const manualOnly = makeManualOnlyDispositionLookup(validation)

    // The general lookup DOES authorize it — correct for the terminal-class
    // checks, wrong for a drift check.
    expect(authorized(id)).toBe('exclude')
    // The manual-only lookup categorically refuses it.
    expect(manualOnly(id)).toBeUndefined()
  })

  it('adding an unauthorized entry to a signed batch invalidates the WHOLE batch (the entry-ids digest is recomputed, not trusted)', async () => {
    const rows = [
      makeSimRow({ id: 'r1', outcome: 'unfetchable' }),
      makeSimRow({ id: 'r2', outcome: 'unfetchable' }),
    ]
    const g1 = await runG1(
      makeScratchDir(),
      rows,
      makeDispositionLedgerJson(
        // Two entries carry the batch_id, but the batch was signed over one.
        [makeBulkEntry('r1', BATCH_ID), makeBulkEntry('r2', BATCH_ID)],
        DECISION_RUN_ID,
        [
          makeDispositionBatchJson({
            batchId: BATCH_ID,
            outcomeClass: 'unfetchable',
            entryIds: ['r1'],
            // entry_count is bumped to keep the ledger SHAPE-valid, so this
            // test exercises the digest recomputation itself rather than the
            // shape validator's own entry_count cross-check.
            overrides: { entry_count: 2 },
          }),
        ]
      )
    )
    expect(g1.outcome).toBe('INCONCLUSIVE')
    expect(g1.detail?.['missingUnfetchableExcludes']).toEqual(['r1', 'r2'])
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

// ---------------------------------------------------------------------------
// SMI-6444: G-1 bulk-disposition shape-validator coverage. These tests call
// validateDispositionLedgerShape/validateDispositionLedger DIRECTLY (not via
// evaluateGateCheck) -- G-1's gate-side authorization logic (Item 2:
// batchById lookups, entry_ids_digest re-derivation, outcome-class
// coherence) is wave-2 scope, owned by a different worker; this file only
// covers the shape/consistency rules the ledger validator itself enforces
// (plan Items 3 and 7).
// ---------------------------------------------------------------------------

function makeStratumJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stratum_key: 's1',
    population_count: 3,
    selected_ids: ['id-1', 'id-2', 'id-3'],
    unavailable_ids: [],
    mismatched_ids: [],
    verified_count: 3,
    upper_bound_bp: 50,
    ...overrides,
  }
}

function makeBatchJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    batch_id: 'batch-1',
    outcome_class: 'unfetchable',
    run_id: DECISION_RUN_ID,
    reason: 'checked via a full recheck',
    tool_commit: 'a'.repeat(40),
    tool_source_digest: 'b'.repeat(64),
    population_count: 3,
    population_cohort_counts: { C1: 3 },
    strata: [makeStratumJson()],
    verified_count: 3,
    verified_at: '2026-09-01T00:00:00.000Z',
    staged_at: '2026-09-01T00:05:00.000Z',
    // Defaults to 0 (matching the empty `entries` array most fixtures below
    // pass) -- SMI-6444 queen-review correction: entry_count is validated
    // against the LEDGER's actual entries carrying this batch_id (Item 8),
    // never derived from Σ strata[].verified_count (a sample-level count
    // that is NOT the same thing for a sampled primary_not_found batch).
    // Tests exercising a real entry_count/entries pairing override this
    // explicitly via makeMatchingEntriesJson.
    entry_count: 0,
    entry_ids_digest: 'c'.repeat(64),
    stage_digest: 'd'.repeat(64),
    ...overrides,
  }
}

function makeBulkEntryJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'id-1', verdict: 'exclude', method: 'bulk', batch_id: 'batch-1', ...overrides }
}

/** `count` distinct synthetic bulk entries for `batchId` -- ids deliberately
 *  don't collide with any strata sample id, so these exercise ONLY the
 *  entry_count-vs-actual-count invariant, not the withheld-id exclusion one. */
function makeMatchingEntriesJson(
  batchId: string,
  count: number,
  idPrefix = 'bulk-entry'
): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) =>
    makeBulkEntryJson({ id: `${idPrefix}-${i + 1}`, batch_id: batchId })
  )
}

function makeLedgerWithBatchesJson(
  entries: Record<string, unknown>[],
  batches: Record<string, unknown>[],
  runId = DECISION_RUN_ID
): Record<string, unknown> {
  return { run_id: runId, entries, batches }
}

describe('validateDispositionLedgerShape — legacy ledgers and full field round-trip (SMI-6444 Item 3)', () => {
  it('legacy ledgers (no method/batch_id/batches anywhere) load fine -- absent, not defaulted', () => {
    const raw = { run_id: DECISION_RUN_ID, entries: [{ id: 'r1', verdict: 'confirm' }] }
    const result = validateDispositionLedgerShape(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.entries[0]).toEqual({ id: 'r1', verdict: 'confirm' })
    expect(result.value.batches).toBeUndefined()
  })

  it('a batch-bearing ledger survives validateDispositionLedgerShape with no field stripped', () => {
    // entry_count:1 matches the single entry below -- SMI-6444 queen
    // correction: entry_count is checked against the ledger's ACTUAL
    // entries for this batch_id, not derived from strata.
    const batch = makeBatchJson({ entry_count: 1 })
    const entry = makeBulkEntryJson()
    const raw = makeLedgerWithBatchesJson([entry], [batch])
    const result = validateDispositionLedgerShape(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.batches).toHaveLength(1)
    expect(result.value.batches?.[0]).toEqual(batch)
    expect(result.value.entries[0]).toEqual(entry)
  })

  // SMI-6444 adversarial review: Item 3's schema states `run_id` "must match
  // the ledger's own run_id". The PRODUCER enforces it at stage time
  // (`stageBatch`'s `run_id_mismatch` refusal), but the shape validator did
  // not — making it a producer-only invariant, which is exactly the
  // "gate trusts the producer to self-police" posture the plan's architecture
  // decision rejects as option (c). Concrete accidental path: an operator
  // copies a previous run's ledger, edits the top-level `run_id` to the new
  // run, and every batch inside still carries the OLD run_id plus sampling
  // evidence gathered against a different population — yet its sign-off digest
  // still verifies, because `run_id` is digest-covered and unmodified.
  it('rejects a batch whose run_id does not match the ledger’s own run_id (Item 3)', () => {
    const foreignBatch = makeBatchJson({ run_id: 'run-from-a-different-census' })
    const result = validateDispositionLedgerShape(
      makeLedgerWithBatchesJson([], [foreignBatch], DECISION_RUN_ID)
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/run_id/)
  })
})

describe('DispositionBatch accounting invariants (Item 7)', () => {
  it('accepts a batch whose per-stratum and aggregate accounting is internally consistent', () => {
    const raw = makeLedgerWithBatchesJson([], [makeBatchJson()])
    expect(validateDispositionLedgerShape(raw).ok).toBe(true)
  })

  it('rejects a stratum where verified_count + |mismatched_ids| + |unavailable_ids| != |selected_ids|', () => {
    const badBatch = makeBatchJson({ strata: [makeStratumJson({ verified_count: 2 })] })
    const result = validateDispositionLedgerShape(makeLedgerWithBatchesJson([], [badBatch]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/verified_count \+ \|mismatched_ids\|/)
  })

  it('rejects unavailable_ids not a subset of selected_ids', () => {
    const badBatch = makeBatchJson({
      strata: [makeStratumJson({ unavailable_ids: ['not-selected'] })],
    })
    const result = validateDispositionLedgerShape(makeLedgerWithBatchesJson([], [badBatch]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/unavailable_ids must be a subset/)
  })

  it('rejects mismatched_ids not a subset of selected_ids', () => {
    const badBatch = makeBatchJson({
      strata: [makeStratumJson({ mismatched_ids: ['not-selected'] })],
    })
    const result = validateDispositionLedgerShape(makeLedgerWithBatchesJson([], [badBatch]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/mismatched_ids must be a subset/)
  })

  it('rejects unavailable_ids and mismatched_ids overlapping (disjointness)', () => {
    const badBatch = makeBatchJson({
      strata: [
        makeStratumJson({
          unavailable_ids: ['id-1'],
          mismatched_ids: ['id-1'],
          verified_count: 1,
        }),
      ],
    })
    const result = validateDispositionLedgerShape(makeLedgerWithBatchesJson([], [badBatch]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/must be disjoint/)
  })

  it('rejects an id-list that is not sorted ascending', () => {
    const badBatch = makeBatchJson({
      strata: [makeStratumJson({ selected_ids: ['id-2', 'id-1', 'id-3'] })],
    })
    const result = validateDispositionLedgerShape(makeLedgerWithBatchesJson([], [badBatch]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/sorted ascending with no duplicates/)
  })

  it('rejects an id-list containing a duplicate id', () => {
    const badBatch = makeBatchJson({
      strata: [makeStratumJson({ selected_ids: ['id-1', 'id-1', 'id-3'] })],
    })
    const result = validateDispositionLedgerShape(makeLedgerWithBatchesJson([], [badBatch]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/sorted ascending with no duplicates/)
  })

  it('rejects population_count inconsistent with the sum of strata[].population_count', () => {
    const badBatch = makeBatchJson({ population_count: 99 })
    const result = validateDispositionLedgerShape(makeLedgerWithBatchesJson([], [badBatch]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/population_count.*must equal the sum/)
  })

  // SMI-6444 queen-review correction: entry_count is NEVER cross-checked
  // against Σ strata[].verified_count -- that invariant only coincidentally
  // held for unfetchable's full-census batches. For a sampled
  // primary_not_found batch, staged ledger entries cover the whole
  // population this batch disposes minus mismatched/unavailable/already-
  // active-skipped rows (Item 8), which is unrelated to the SAMPLE-level
  // strata verified_count total. entry_count is instead validated against
  // the ledger's own actual entries -- see the two tests below.
  it('accepts a sampled batch whose entry_count is far greater than Σ strata[].verified_count (ledger entries cover the whole disposed population, not just the sample)', () => {
    const batch = makeBatchJson({
      outcome_class: 'primary_not_found',
      entry_count: 8,
    })
    const entries = makeMatchingEntriesJson('batch-1', 8)
    const result = validateDispositionLedgerShape(makeLedgerWithBatchesJson(entries, [batch]))
    expect(result.ok).toBe(true)
  })

  it('rejects a batch whose entry_count disagrees with the actual number of ledger entries carrying its batch_id', () => {
    const badBatch = makeBatchJson({ entry_count: 5 })
    // Only 2 real entries exist for batch-1, but the batch claims 5.
    const entries = makeMatchingEntriesJson('batch-1', 2)
    const result = validateDispositionLedgerShape(makeLedgerWithBatchesJson(entries, [badBatch]))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(
        /entry_count \(5\) must equal the actual number of ledger entries carrying this batch_id \(2\)/
      )
    }
  })

  it('does not check entry_count for a revoked batch -- its real entries have already been removed by revoke-batch', () => {
    const batch = makeBatchJson({
      entry_count: 3, // stale, frozen from staging time -- the real entries are gone now.
      revoked: { revoked_by: 'operator-1', revoked_at: '2026-09-01T02:00:00.000Z', reason: 'oops' },
    })
    // No matching entries in the ledger at all (revoke-batch removed them).
    const result = validateDispositionLedgerShape(makeLedgerWithBatchesJson([], [batch]))
    expect(result.ok).toBe(true)
  })

  it('rejects an unfetchable batch with a non-empty unavailable_ids (no transient-failure mode)', () => {
    const badBatch = makeBatchJson({
      outcome_class: 'unfetchable',
      verified_count: 2,
      entry_count: 2,
      strata: [makeStratumJson({ unavailable_ids: ['id-1'], verified_count: 2 })],
    })
    const result = validateDispositionLedgerShape(makeLedgerWithBatchesJson([], [badBatch]))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/unfetchable batches must have empty unavailable_ids/)
    }
  })

  it('rejects a negative population_count', () => {
    const badBatch = makeBatchJson({ population_count: -1 })
    const result = validateDispositionLedgerShape(makeLedgerWithBatchesJson([], [badBatch]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/population_count must be a non-negative integer/)
  })

  it('rejects a non-integer confidence_pct', () => {
    const badBatch = makeBatchJson({ confidence_pct: 95.5 })
    const result = validateDispositionLedgerShape(makeLedgerWithBatchesJson([], [badBatch]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/confidence_pct must be a non-negative integer/)
  })

  it('rejects a non-ISO-8601 verified_at', () => {
    const badBatch = makeBatchJson({ verified_at: 'not-a-date' })
    const result = validateDispositionLedgerShape(makeLedgerWithBatchesJson([], [badBatch]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/verified_at must be an ISO 8601/)
  })

  it('rejects a batch whose mismatched id also has a generated entry for the same batch', () => {
    const batch = makeBatchJson({
      strata: [makeStratumJson({ mismatched_ids: ['id-2'], verified_count: 2 })],
      verified_count: 2,
      // entry_count matches the single (bad) entry below -- isolates this
      // test to the withheld-id-exclusion rule, not the entry_count check.
      entry_count: 1,
    })
    // id-2 is withheld (mismatched) but ALSO has a generated ledger entry --
    // this must never happen (Item 7).
    const badEntry = makeBulkEntryJson({ id: 'id-2' })
    const result = validateDispositionLedgerShape(makeLedgerWithBatchesJson([badEntry], [batch]))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/withheld.*also has a generated ledger entry/)
    }
  })

  it('rejects a batch whose unavailable id also has a generated entry for the same batch', () => {
    const batch = makeBatchJson({
      // primary_not_found, not unfetchable -- unfetchable batches forbid a
      // non-empty unavailable_ids outright (a separate rule, tested above);
      // this test isolates the withheld-id-exclusion rule instead.
      outcome_class: 'primary_not_found',
      strata: [makeStratumJson({ unavailable_ids: ['id-2'], verified_count: 2 })],
      verified_count: 2,
      entry_count: 1,
    })
    // id-2 is withheld (unavailable) but ALSO has a generated ledger entry.
    const badEntry = makeBulkEntryJson({ id: 'id-2' })
    const result = validateDispositionLedgerShape(makeLedgerWithBatchesJson([badEntry], [batch]))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/withheld.*also has a generated ledger entry/)
    }
  })
})

describe('sign-off triple joint presence (Item 7)', () => {
  it('accepts a batch with all three of signed_off_by/signed_off_at/sign_off_digest present', () => {
    const batch = makeBatchJson({
      signed_off_by: 'operator-1',
      signed_off_at: '2026-09-01T01:00:00.000Z',
      sign_off_digest: 'e'.repeat(64),
    })
    expect(validateDispositionLedgerShape(makeLedgerWithBatchesJson([], [batch])).ok).toBe(true)
  })

  it('accepts a batch with all three absent (staged, unsigned)', () => {
    expect(
      validateDispositionLedgerShape(makeLedgerWithBatchesJson([], [makeBatchJson()])).ok
    ).toBe(true)
  })

  it('rejects a batch with only signed_off_by present', () => {
    const batch = makeBatchJson({ signed_off_by: 'operator-1' })
    const result = validateDispositionLedgerShape(makeLedgerWithBatchesJson([], [batch]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/jointly present or jointly absent/)
  })

  it('rejects a batch missing only sign_off_digest', () => {
    const batch = makeBatchJson({
      signed_off_by: 'operator-1',
      signed_off_at: '2026-09-01T01:00:00.000Z',
    })
    const result = validateDispositionLedgerShape(makeLedgerWithBatchesJson([], [batch]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/jointly present or jointly absent/)
  })
})

describe('entry method/batch_id consistency (Item 7)', () => {
  it('rejects a bulk entry with no batch_id', () => {
    const raw = makeLedgerWithBatchesJson([{ id: 'id-1', verdict: 'exclude', method: 'bulk' }], [])
    const result = validateDispositionLedgerShape(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/method:"bulk" but no batch_id/)
  })

  it('rejects a manual entry carrying a batch_id', () => {
    const raw = makeLedgerWithBatchesJson(
      [{ id: 'id-1', verdict: 'exclude', method: 'manual', batch_id: 'batch-1' }],
      []
    )
    const result = validateDispositionLedgerShape(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/only bulk entries may carry batch_id/)
  })

  it('rejects a method-absent entry carrying a batch_id (legacy-compatible absence still forbids batch_id)', () => {
    const raw = makeLedgerWithBatchesJson(
      [{ id: 'id-1', verdict: 'exclude', batch_id: 'batch-1' }],
      []
    )
    const result = validateDispositionLedgerShape(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/only bulk entries may carry batch_id/)
  })

  it('accepts a well-formed bulk entry with a matching batch_id', () => {
    const raw = makeLedgerWithBatchesJson(
      [makeBulkEntryJson()],
      [makeBatchJson({ entry_count: 1 })]
    )
    expect(validateDispositionLedgerShape(raw).ok).toBe(true)
  })
})

describe('batch_id uniqueness (Item 7)', () => {
  it('rejects a ledger with two batches sharing the same batch_id', () => {
    const raw = makeLedgerWithBatchesJson(
      [],
      [makeBatchJson(), makeBatchJson({ reason: 'a second batch, same id' })]
    )
    const result = validateDispositionLedgerShape(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/is a duplicate/)
  })
})

describe('revocation shape rules (Item 7/8)', () => {
  const REVOKED = {
    revoked_by: 'operator-1',
    revoked_at: '2026-09-01T02:00:00.000Z',
    reason: 'oops',
  }

  it('accepts a revoked batch with no active sign-off triple', () => {
    const batch = makeBatchJson({ revoked: REVOKED })
    expect(validateDispositionLedgerShape(makeLedgerWithBatchesJson([], [batch])).ok).toBe(true)
  })

  it('rejects a revoked batch that still carries an active sign-off triple', () => {
    const batch = makeBatchJson({
      signed_off_by: 'operator-1',
      signed_off_at: '2026-09-01T01:00:00.000Z',
      sign_off_digest: 'e'.repeat(64),
      revoked: REVOKED,
    })
    const result = validateDispositionLedgerShape(makeLedgerWithBatchesJson([], [batch]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/must not have an active sign-off triple/)
  })

  it('rejects a non-revoked entry whose batch_id resolves to a revoked batch (hard shape-reject)', () => {
    const revokedBatch = makeBatchJson({ revoked: REVOKED })
    const raw = makeLedgerWithBatchesJson([makeBulkEntryJson()], [revokedBatch])
    const result = validateDispositionLedgerShape(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/references batch_id .*, which is revoked/)
  })

  it('accepts a REVOKED entry whose batch_id resolves to a revoked batch (the hard-reject rule is scoped to non-revoked entries only)', () => {
    const revokedBatch = makeBatchJson({ revoked: REVOKED })
    const revokedEntry = makeBulkEntryJson({ revoked: REVOKED })
    const raw = makeLedgerWithBatchesJson([revokedEntry], [revokedBatch])
    expect(validateDispositionLedgerShape(raw).ok).toBe(true)
  })
})

describe('validateDispositionLedger — one-active-entry conflict rule (Item 7, round 5)', () => {
  const REVOKED = {
    revoked_by: 'operator-1',
    revoked_at: '2026-09-01T00:00:00.000Z',
    reason: 'wrong',
  }

  it('accepts two entries for the same id when the first is revoked (revoke-then-add is never a conflict)', () => {
    const shapeResult = validateDispositionLedgerShape(
      makeLedgerWithBatchesJson(
        [
          { id: 'id-1', verdict: 'confirm', revoked: REVOKED },
          { id: 'id-1', verdict: 'exclude' },
        ],
        []
      )
    )
    expect(shapeResult.ok).toBe(true)
    if (!shapeResult.ok) return
    const validation = validateDispositionLedger(shapeResult.value)
    expect(validation.valid).toBe(true)
    expect(validation.conflictingIds).toEqual([])
    expect(validation.byId.get('id-1')).toBe('exclude')
  })

  it('rejects two ACTIVE entries for the same id, even when outwardly identical', () => {
    const shapeResult = validateDispositionLedgerShape(
      makeLedgerWithBatchesJson(
        [
          { id: 'id-1', verdict: 'confirm' },
          { id: 'id-1', verdict: 'confirm' },
        ],
        []
      )
    )
    expect(shapeResult.ok).toBe(true)
    if (!shapeResult.ok) return
    const validation = validateDispositionLedger(shapeResult.value)
    expect(validation.valid).toBe(false)
    expect(validation.conflictingIds).toEqual(['id-1'])
  })

  it('rejects two active entries with different verdicts for the same id (the original conflict case)', () => {
    const shapeResult = validateDispositionLedgerShape(
      makeLedgerWithBatchesJson(
        [
          { id: 'id-1', verdict: 'confirm' },
          { id: 'id-1', verdict: 'exclude' },
        ],
        []
      )
    )
    expect(shapeResult.ok).toBe(true)
    if (!shapeResult.ok) return
    const validation = validateDispositionLedger(shapeResult.value)
    expect(validation.valid).toBe(false)
    expect(validation.conflictingIds).toEqual(['id-1'])
  })
})

describe('validateDispositionLedger — provenanceById/batchById (Item 3)', () => {
  it('builds provenanceById for a manual entry (method absent, legacy-compatible) as method:"manual"', () => {
    const shapeResult = validateDispositionLedgerShape(
      makeLedgerWithBatchesJson([{ id: 'id-1', verdict: 'confirm' }], [])
    )
    expect(shapeResult.ok).toBe(true)
    if (!shapeResult.ok) return
    const validation = validateDispositionLedger(shapeResult.value)
    expect(validation.provenanceById.get('id-1')).toEqual({ method: 'manual' })
  })

  it('builds provenanceById for a bulk entry with its batch_id', () => {
    const shapeResult = validateDispositionLedgerShape(
      makeLedgerWithBatchesJson([makeBulkEntryJson()], [makeBatchJson({ entry_count: 1 })])
    )
    expect(shapeResult.ok).toBe(true)
    if (!shapeResult.ok) return
    const validation = validateDispositionLedger(shapeResult.value)
    expect(validation.provenanceById.get('id-1')).toEqual({ method: 'bulk', batch_id: 'batch-1' })
  })

  it('excludes a revoked entry from both provenanceById and byId entirely', () => {
    const shapeResult = validateDispositionLedgerShape(
      makeLedgerWithBatchesJson(
        [
          {
            id: 'id-1',
            verdict: 'confirm',
            revoked: {
              revoked_by: 'op',
              revoked_at: '2026-09-01T00:00:00.000Z',
              reason: 'oops',
            },
          },
        ],
        []
      )
    )
    expect(shapeResult.ok).toBe(true)
    if (!shapeResult.ok) return
    const validation = validateDispositionLedger(shapeResult.value)
    expect(validation.provenanceById.has('id-1')).toBe(false)
    expect(validation.byId.has('id-1')).toBe(false)
  })

  it('excludes a revoked batch from batchById', () => {
    const revoked = { revoked_by: 'op', revoked_at: '2026-09-01T00:00:00.000Z', reason: 'oops' }
    const revokedBatch = makeBatchJson({ revoked })
    const revokedEntry = makeBulkEntryJson({ revoked })
    const shapeResult = validateDispositionLedgerShape(
      makeLedgerWithBatchesJson([revokedEntry], [revokedBatch])
    )
    expect(shapeResult.ok).toBe(true)
    if (!shapeResult.ok) return
    const validation = validateDispositionLedger(shapeResult.value)
    expect(validation.batchById.has('batch-1')).toBe(false)
  })

  it('includes a non-revoked batch in batchById, keyed by batch_id', () => {
    const shapeResult = validateDispositionLedgerShape(
      makeLedgerWithBatchesJson([], [makeBatchJson()])
    )
    expect(shapeResult.ok).toBe(true)
    if (!shapeResult.ok) return
    const validation = validateDispositionLedger(shapeResult.value)
    expect(validation.batchById.get('batch-1')?.batch_id).toBe('batch-1')
  })
})
