/**
 * SMI-5879 Wave 3 item 4: the final go/no-go merge gate for a production
 * security-scanner fix, evaluated against the ~314K-row skill catalog.
 * @module scripts/indexer/smi5879-gate-check
 *
 * SAFETY-CRITICAL: a false PASS here lets a broken scanner change ship to
 * production. The one rule that governs every ambiguous case in this whole
 * module tree: **absence of evidence is INCONCLUSIVE, never PASS.** There is
 * no separate FAIL state (design doc §8.5's provenance note, owner decision).
 *
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md
 *   §8.5 (merge-gating table, authoritative) and §12 (Round-8 addendum,
 *   supersedes §8.5/plan doc wherever they conflict).
 * Plan: docs/internal/implementation/smi-5879-wave3-census-simulation-plan.md
 *   §"Gates G-1 through G-8"
 *
 * Evaluation order (short-circuiting at each `->`):
 *   I-1..I-5 preconditions -> artifact binding (run_id + baseline_commit) ->
 *   per-generation binding (decision) -> G-8 -> G-7 -> G-2 -> G-3 -> G-5 ->
 *   G-2R (reconciliation mode only) -> G-1 (last — depends on G-2 and G-2R)
 *
 * CLI:
 *   varlock run -- npx tsx scripts/indexer/smi5879-gate-check.ts \
 *     --mode=<decision|reconciliation> --decision-run-id=<run_id> \
 *     --census-report=<path> --simulator-report=<path> \
 *     [--dispositions=<path>] [--attestation=<path>] \
 *     [--window-run-id=<run_id>] [--window-census-report=<path>] \
 *     [--report-path=<path>] [--skip-closure-tests]
 *
 * Exit code 0 IFF `overall === 'PASS'`.
 */

import { writeFileSync } from 'node:fs'
import { poolerSessionConnParams } from './smi5879-census.pg.ts'
import { createSmi5879GateCheckDbDeps } from './smi5879-gate-check.pg.ts'
import { runStructuralClosureTestsViaVitest } from './smi5879-gate-check.closure.ts'
import {
  bindGeneration,
  checkArtifactRunIdBinding,
  checkWindowCensusBinding,
} from './smi5879-gate-check.binding.ts'
import { evaluateG2R } from './smi5879-gate-check.g2r.ts'
import {
  evaluateG1,
  evaluateG2,
  evaluateG3,
  evaluateG5,
  evaluateG7,
  evaluateG8,
} from './smi5879-gate-check.gates.ts'
import {
  checkArtifactRunIdMatch,
  loadJsonFile,
  resolveLedger,
  validateDispositionLedgerShape,
  validateFreezeAttestationShape,
} from './smi5879-gate-check.helpers.ts'
import { loadCensusReport, loadSimulatorReport } from './smi5879-gate-check.io.ts'
import { parseArgs, type CliArgs } from './smi5879-gate-check.cli.ts'
import type { InvariantResult, Smi5879Purpose } from './smi5879-census.types.ts'
import type {
  GateResult,
  Smi5879FreezeAttestation,
  Smi5879G2rReport,
  Smi5879GateCheckDbDeps,
  Smi5879GateCheckReport,
  Smi5879GateCheckTestDeps,
  StructuralClosureResult,
} from './smi5879-gate-check.types.ts'

// Re-exported so existing `from './smi5879-gate-check.ts'` imports (e.g. the
// test fixtures' `CliArgs`) keep working after the CLAUDE.md <500-line split.
export { parseArgs, type CliArgs }

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export interface EvaluateDeps {
  db: Smi5879GateCheckDbDeps
  test: Smi5879GateCheckTestDeps
}

interface ReportFields {
  preconditions: InvariantResult[]
  preconditionsPassed: boolean
  preconditionFailureReason: string | null
  artifactBindingOk: boolean
  artifactBindingReason: string | null
  gates: GateResult[]
  g2r: Smi5879G2rReport | null
  overall: 'PASS' | 'INCONCLUSIVE'
  overallReason: string | null
}

function buildReport(args: CliArgs, f: ReportFields): Smi5879GateCheckReport {
  return {
    report_kind: 'gate_check',
    mode: args.mode,
    decision_run_id: args.decisionRunId,
    window_run_id: args.windowRunId ?? null,
    preconditions: f.preconditions,
    preconditions_passed: f.preconditionsPassed,
    precondition_failure_reason: f.preconditionFailureReason,
    artifact_binding_ok: f.artifactBindingOk,
    artifact_binding_reason: f.artifactBindingReason,
    gates: f.gates,
    g2r: f.g2r,
    overall: f.overall,
    overall_reason: f.overallReason,
    generated_at: new Date().toISOString(),
  }
}

/**
 * Run the full evaluation and return the assembled report. Exported for the
 * test suite; `main()` below is the CLI entrypoint that calls this and
 * decides the process exit code.
 */
export async function evaluateGateCheck(
  deps: EvaluateDeps,
  args: CliArgs
): Promise<Smi5879GateCheckReport> {
  // --- Required inputs -------------------------------------------------
  const censusLoad = loadCensusReport(args.censusReportPath, 'census-report')
  if (censusLoad.status !== 'ok') {
    const reason = `decision census report unavailable: ${censusLoad.reason}`
    return buildReport(args, {
      preconditions: [],
      preconditionsPassed: false,
      preconditionFailureReason: reason,
      artifactBindingOk: false,
      artifactBindingReason: null,
      gates: [],
      g2r: null,
      overall: 'INCONCLUSIVE',
      overallReason: reason,
    })
  }

  const simLoad = loadSimulatorReport(args.simulatorReportPath, 'simulator-report')
  if (simLoad.status !== 'ok') {
    const reason = `simulator report unavailable: ${simLoad.reason}`
    return buildReport(args, {
      preconditions: censusLoad.value.invariants,
      preconditionsPassed: true,
      preconditionFailureReason: null,
      artifactBindingOk: false,
      artifactBindingReason: reason,
      gates: [],
      g2r: null,
      overall: 'INCONCLUSIVE',
      overallReason: reason,
    })
  }

  let windowInvariants: InvariantResult[] = []
  let windowCensusRunId: string | null = null
  let windowCensusPurpose: Smi5879Purpose | null = null
  if (args.mode === 'reconciliation') {
    const windowCensusLoad = loadCensusReport(args.windowCensusReportPath, 'window-census-report')
    if (windowCensusLoad.status !== 'ok') {
      const reason = `window census report unavailable: ${windowCensusLoad.reason}`
      return buildReport(args, {
        preconditions: censusLoad.value.invariants,
        preconditionsPassed: true,
        preconditionFailureReason: null,
        artifactBindingOk: false,
        artifactBindingReason: reason,
        gates: [],
        g2r: null,
        overall: 'INCONCLUSIVE',
        overallReason: reason,
      })
    }
    windowInvariants = windowCensusLoad.value.invariants
    windowCensusRunId = windowCensusLoad.value.run_id
    windowCensusPurpose = windowCensusLoad.value.purpose
  }

  // --- I-1..I-5 preconditions, fail-closed, before any gate ------------
  const allInvariants = [...censusLoad.value.invariants, ...windowInvariants]
  const failedInvariants = allInvariants.filter((i) => !i.passed)
  if (failedInvariants.length > 0) {
    const reason = `${failedInvariants.length} invariant(s) failed: ${failedInvariants.map((i) => i.id).join(', ')}`
    return buildReport(args, {
      preconditions: allInvariants,
      preconditionsPassed: false,
      preconditionFailureReason: reason,
      artifactBindingOk: false,
      artifactBindingReason: null,
      gates: [],
      g2r: null,
      overall: 'INCONCLUSIVE',
      overallReason: 'preconditions failed — see precondition_failure_reason',
    })
  }

  // --- Artifact binding: run_id cross-check, then baseline_commit -------
  const runIdBinding = checkArtifactRunIdBinding(
    args.decisionRunId,
    censusLoad.value.run_id,
    simLoad.value.run_id
  )
  if (!runIdBinding.bound) {
    return buildReport(args, {
      preconditions: allInvariants,
      preconditionsPassed: true,
      preconditionFailureReason: null,
      artifactBindingOk: false,
      artifactBindingReason: runIdBinding.reason,
      gates: [],
      g2r: null,
      overall: 'INCONCLUSIVE',
      overallReason: runIdBinding.reason,
    })
  }

  // Finding #2 (adversarial review): the window census report is loaded
  // above but was never itself bound to --window-run-id — apply the SAME
  // artifact-binding check used for the decision census/simulator reports.
  if (args.mode === 'reconciliation') {
    if (!args.windowRunId || windowCensusRunId === null || windowCensusPurpose === null) {
      const reason =
        'internal error: reconciliation mode reached window binding without a window census report'
      return buildReport(args, {
        preconditions: allInvariants,
        preconditionsPassed: true,
        preconditionFailureReason: null,
        artifactBindingOk: false,
        artifactBindingReason: reason,
        gates: [],
        g2r: null,
        overall: 'INCONCLUSIVE',
        overallReason: reason,
      })
    }
    const windowBinding = checkWindowCensusBinding(
      args.windowRunId,
      windowCensusRunId,
      windowCensusPurpose
    )
    if (!windowBinding.bound) {
      return buildReport(args, {
        preconditions: allInvariants,
        preconditionsPassed: true,
        preconditionFailureReason: null,
        artifactBindingOk: false,
        artifactBindingReason: windowBinding.reason,
        gates: [],
        g2r: null,
        overall: 'INCONCLUSIVE',
        overallReason: windowBinding.reason,
      })
    }
  }

  // §12.1: the closure test is bound on baseline_commit, not run_id — this
  // is the ONLY place the (expensive) self-invoked vitest run happens; G-5
  // later reuses this SAME result rather than re-running it. Skipped
  // entirely when --skip-closure-tests is set (no vitest spawn, no git
  // check) — G-5 alone is then forced INCONCLUSIVE, everything else can
  // still evaluate and pass, per the flag's documented scope.
  //
  // Finding #10 (adversarial review): a thrown/rejected
  // runStructuralClosureTests must never make the WHOLE evaluator reject —
  // it becomes G-5 INCONCLUSIVE via the SAME `!closure.ran` branch that
  // already handles a non-throwing failure result (`evaluateG5` in
  // smi5879-gate-check.gates.ts), by synthesizing the identical
  // `{ran:false, ...}` shape `runStructuralClosureTestsViaVitest` itself
  // returns for its own internal failure paths. Deliberately does NOT run
  // the baseline_commit "mismatch" check below in this case (that check is
  // for git-derivable-HEAD mismatches, not dependency exceptions) so
  // execution proceeds to evaluate every OTHER gate normally — only G-5 is
  // affected, exactly as the finding specifies.
  let closureResult: StructuralClosureResult | null = null
  if (!args.skipClosureTests) {
    let closureThrew: string | null = null
    try {
      closureResult = await deps.test.runStructuralClosureTests()
    } catch (err) {
      closureThrew = (err as Error).message ?? String(err)
      closureResult = {
        ran: false,
        passed: false,
        baseline_commit: null,
        unavailable_reason: `runStructuralClosureTests threw: ${closureThrew}`,
        fixtureCorpusCorroborationVerified: false,
      }
    }
    if (closureThrew === null) {
      const mismatch =
        closureResult.baseline_commit === null
          ? `structural closure test could not derive a baseline_commit: ${closureResult.unavailable_reason ?? '(no reason recorded)'}`
          : closureResult.baseline_commit !== simLoad.value.baseline_commit
            ? `structural closure test baseline_commit="${closureResult.baseline_commit}" does not match simulator report baseline_commit="${simLoad.value.baseline_commit}" (§12.1)`
            : null
      if (mismatch) {
        return buildReport(args, {
          preconditions: allInvariants,
          preconditionsPassed: true,
          preconditionFailureReason: null,
          artifactBindingOk: false,
          artifactBindingReason: mismatch,
          gates: [],
          g2r: null,
          overall: 'INCONCLUSIVE',
          overallReason: mismatch,
        })
      }
    }
  }

  // --- Per-generation binding (decision) --------------------------------
  const decisionBinding = await bindGeneration(deps.db, args.decisionRunId, 'decision')
  if (!decisionBinding.bound) {
    return buildReport(args, {
      preconditions: allInvariants,
      preconditionsPassed: true,
      preconditionFailureReason: null,
      artifactBindingOk: false,
      artifactBindingReason: decisionBinding.reason,
      gates: [],
      g2r: null,
      overall: 'INCONCLUSIVE',
      overallReason: decisionBinding.reason,
    })
  }

  // --- Numbered gates, in order: G-8 -> G-7 -> G-2 -> G-3 -> G-5 -> G-2R -> G-1 ---
  // Finding #5 (adversarial review): the freeze attestation's and disposition
  // ledger's own run_id must be bound to --decision-run-id, same as the
  // census/simulator reports — a stale artifact from a DIFFERENT run must
  // never silently satisfy G-1/G-7/G-8.
  const attestationLoad = checkArtifactRunIdMatch(
    loadJsonFile<Smi5879FreezeAttestation>(
      args.attestationPath,
      'attestation',
      validateFreezeAttestationShape
    ),
    args.decisionRunId,
    'attestation'
  )

  const gates: GateResult[] = []
  gates.push(evaluateG8(attestationLoad, decisionBinding.summary?.snapshot_started_at ?? null))
  gates.push(evaluateG7(attestationLoad))
  const g2 = evaluateG2(simLoad.value, args.decisionRunId)
  gates.push(g2)
  gates.push(evaluateG3(simLoad.value))
  gates.push(evaluateG5(args.skipClosureTests, closureResult, simLoad.value))

  const dispositionsLoad = checkArtifactRunIdMatch(
    loadJsonFile(args.dispositionsPath, 'dispositions', validateDispositionLedgerShape),
    args.decisionRunId,
    'dispositions'
  )
  const resolvedLedger = resolveLedger(dispositionsLoad)

  const { gate: g2rGate, report: g2rReport } = await evaluateG2R(
    args.mode,
    deps.db,
    args.decisionRunId,
    args.windowRunId ?? null,
    resolvedLedger
  )
  gates.push(g2rGate)

  const g1 = evaluateG1(
    args.mode,
    simLoad.value,
    resolvedLedger,
    g2,
    g2rGate,
    g2rReport?.drift_rows ?? []
  )
  gates.push(g1)

  const blocking = gates.filter((g) => g.outcome === 'INCONCLUSIVE')
  const overall: 'PASS' | 'INCONCLUSIVE' = blocking.length === 0 ? 'PASS' : 'INCONCLUSIVE'
  const overallReason =
    overall === 'PASS'
      ? null
      : `${blocking.length} gate(s) INCONCLUSIVE: ${blocking.map((g) => g.id).join(', ')}`

  return buildReport(args, {
    preconditions: allInvariants,
    preconditionsPassed: true,
    preconditionFailureReason: null,
    artifactBindingOk: true,
    artifactBindingReason: 'all binding checks passed',
    gates,
    g2r: g2rReport,
    overall,
    overallReason,
  })
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

function printSummary(report: Smi5879GateCheckReport): void {
  console.log(
    `\n── Gate-Check Summary (mode=${report.mode}, decision=${report.decision_run_id}` +
      `${report.window_run_id ? `, window=${report.window_run_id}` : ''}) ──\n` +
      `  preconditions:      ${report.preconditions_passed ? 'PASS' : 'FAIL'} (${report.preconditions.length} checked)\n` +
      (report.precondition_failure_reason ? `    -> ${report.precondition_failure_reason}\n` : '') +
      `  artifact binding:    ${report.artifact_binding_ok ? 'OK' : 'FAILED'}\n` +
      (report.artifact_binding_reason && !report.artifact_binding_ok
        ? `    -> ${report.artifact_binding_reason}\n`
        : '')
  )
  for (const gate of report.gates) {
    console.log(`  [${gate.outcome}] ${gate.id} — ${gate.reason}`)
  }
  console.log(
    `\n  OVERALL: ${report.overall}${report.overall_reason ? ` — ${report.overall_reason}` : ''}\n`
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const conn = poolerSessionConnParams()
  const db = createSmi5879GateCheckDbDeps(conn)
  const report = await evaluateGateCheck(
    { db, test: { runStructuralClosureTests: runStructuralClosureTestsViaVitest } },
    args
  )
  writeFileSync(args.reportPath, JSON.stringify(report, null, 2))
  printSummary(report)
  console.log(`Report written to ${args.reportPath}`)
  process.exitCode = report.overall === 'PASS' ? 0 : 1
}

// Run only when invoked directly (not when imported by the test suite).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
