/**
 * CLI argument parsing for smi5879-gate-check.ts — split out of that file
 * (CLAUDE.md's <500-line-per-file convention).
 * @module scripts/indexer/smi5879-gate-check.cli
 *
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.5, §12
 */

import type { Smi5879GateCheckMode } from './smi5879-gate-check.types.ts'

export interface CliArgs {
  mode: Smi5879GateCheckMode
  decisionRunId: string
  censusReportPath: string
  simulatorReportPath: string
  dispositionsPath?: string
  attestationPath?: string
  windowRunId?: string
  windowCensusReportPath?: string
  reportPath: string
  skipClosureTests: boolean
}

export function parseArgs(argv: string[]): CliArgs {
  const find = (name: string): string | undefined => {
    const prefix = `--${name}=`
    const hit = argv.find((a) => a.startsWith(prefix))
    return hit ? hit.slice(prefix.length) : undefined
  }
  const mode = find('mode')
  if (mode !== 'decision' && mode !== 'reconciliation') {
    throw new Error(
      `SMI-5879: --mode=<decision|reconciliation> is required, got ${mode ?? '(missing)'}.`
    )
  }
  const decisionRunId = find('decision-run-id')
  if (!decisionRunId) throw new Error('SMI-5879: --decision-run-id=<run_id> is required.')
  const censusReportPath = find('census-report')
  if (!censusReportPath) throw new Error('SMI-5879: --census-report=<path> is required.')
  const simulatorReportPath = find('simulator-report')
  if (!simulatorReportPath) throw new Error('SMI-5879: --simulator-report=<path> is required.')

  const dispositionsPath = find('dispositions')
  const attestationPath = find('attestation')
  const windowRunId = find('window-run-id')
  const windowCensusReportPath = find('window-census-report')
  if (mode === 'reconciliation') {
    if (!windowRunId) {
      throw new Error('SMI-5879: --window-run-id=<run_id> is required when --mode=reconciliation.')
    }
    if (!windowCensusReportPath) {
      throw new Error(
        'SMI-5879: --window-census-report=<path> is required when --mode=reconciliation.'
      )
    }
  }
  const reportPath = find('report-path') ?? `smi5879-gate-check-report-${Date.now()}.json`
  const skipClosureTests = argv.includes('--skip-closure-tests')

  return {
    mode,
    decisionRunId,
    censusReportPath,
    simulatorReportPath,
    ...(dispositionsPath !== undefined ? { dispositionsPath } : {}),
    ...(attestationPath !== undefined ? { attestationPath } : {}),
    ...(windowRunId !== undefined ? { windowRunId } : {}),
    ...(windowCensusReportPath !== undefined ? { windowCensusReportPath } : {}),
    reportPath,
    skipClosureTests,
  }
}
