/**
 * SMI-6444 bulk disposition producer CLI — shared `dispose` subcommand setup:
 * verified-population + branch-map load, simulator-report load + run_id
 * binding, tool-provenance resolution (dirty-worktree refusal), candidate
 * filtering, and dispatch to the outcome-class-specific flow
 * (`smi5879-dispose-terminal.action.unfetchable.ts` /
 * `.action.primary-not-found.ts`).
 * @module scripts/indexer/smi5879-dispose-terminal.action.dispose
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 1 (sourcing fetch identity from the sealed population, reusing
 *   `loadVerifiedPopulation`), Item 7 (tool provenance / dirty-worktree
 *   guard).
 */

import { loadVerifiedPopulation } from './smi5879-merge-shards.population.ts'
import { loadSimulatorReport } from './smi5879-gate-check.io.ts'
import { checkArtifactRunIdMatch, computeR } from './smi5879-gate-check.helpers.ts'
import {
  resolveToolProvenance,
  type GitRunner,
  type SourceReader,
} from './smi5879-dispose-terminal.provenance.ts'
import { disposeUnfetchableAction } from './smi5879-dispose-terminal.action.unfetchable.ts'
import { disposePrimaryNotFoundAction } from './smi5879-dispose-terminal.action.primary-not-found.ts'
import { logOf, type CliActionDeps } from './smi5879-dispose-terminal.action.ts'
import type { LedgerIoDeps } from './smi5879-dispose-terminal.ledger.ts'
import type { SidecarIoDeps } from './smi5879-dispose-terminal.sidecar.ts'
import type { Smi5879DisposeTerminalDbDeps } from './smi5879-dispose-terminal.db.ts'
import type { SimRowResult } from './smi5879-simulate-full.types.ts'
import type { ParsedSkillUrl } from './_shared/skill-md-fetch.ts'
import type { FetchRetryOutcome } from './smi5879-fetch-retry.ts'

export interface DisposeOptions {
  dispositions: string
  runId: string
  outcomeClass: 'unfetchable' | 'primary_not_found'
  simulatorReport: string
  operator: string
  allowDirtyWorktree?: string
  timeoutMs?: number
  /** primary_not_found only. */
  sidecar?: string
  sidecarTimeoutMs?: number
  seed?: string
  confidencePct?: number
  mismatchThresholdBp?: number
  stratumThresholdBp?: number
  designPointBadDrawsPerStratum?: number
  fetchConcurrency?: number
}

export interface DisposeActionDeps extends CliActionDeps {
  db: Smi5879DisposeTerminalDbDeps
  ledgerDeps?: Partial<LedgerIoDeps>
  sidecarDeps?: Partial<SidecarIoDeps>
  repoRoot?: string
  git?: GitRunner
  readSource?: SourceReader
  /** Overrides the producer's own source-file list for `tool_source_digest` — test-only. */
  provenanceFiles?: readonly string[]
  getHeaders?: () => Promise<Record<string, string>>
  fetchConcurrency?: number
  /** Test-only injection seam for the primary_not_found live re-fetch — see
   *  `LiveRecheckDeps.fetchPrimary` (`.action.primary-not-found.fetch.ts`). */
  fetchPrimary?: (parsed: ParsedSkillUrl) => Promise<FetchRetryOutcome>
  /** Test-only override for batch_id generation (default `crypto.randomUUID()`). */
  batchId?: () => string
}

/**
 * The `dispose` subcommand's full flow: bind to the sealed, digest-verified
 * population (`loadVerifiedPopulation`, Item 1), load + run_id-bind the
 * simulator report, resolve tool provenance (refusing a dirty worktree
 * without the override), filter candidates by outcome class — defensively
 * excluding any row that also appears in `R` (Items 2/9: a bulk entry may
 * never satisfy a security-review disposition, even though a row's `outcome`
 * is structurally singular so this should never actually trigger) — then
 * dispatch to the outcome-class-specific staging flow.
 */
export async function disposeAction(
  opts: DisposeOptions,
  deps: DisposeActionDeps
): Promise<number> {
  const logger = logOf(deps)

  let population: Awaited<ReturnType<typeof loadVerifiedPopulation>>
  try {
    population = await loadVerifiedPopulation(deps.db, opts.runId)
  } catch (error) {
    logger(`REFUSED: ${(error as Error).message}`)
    return 1
  }

  const reportLoad = checkArtifactRunIdMatch(
    loadSimulatorReport(opts.simulatorReport, 'simulator-report'),
    opts.runId,
    'simulator-report'
  )
  if (reportLoad.status !== 'ok') {
    logger(`REFUSED [simulator-report ${reportLoad.status}]: ${reportLoad.reason}`)
    return 1
  }
  const report = reportLoad.value

  const provenanceResult = resolveToolProvenance({
    repoRoot: deps.repoRoot ?? process.cwd(),
    ...(opts.allowDirtyWorktree !== undefined
      ? { allowDirtyWorktreeReason: opts.allowDirtyWorktree }
      : {}),
    ...(deps.provenanceFiles !== undefined ? { files: deps.provenanceFiles } : {}),
    ...(deps.git !== undefined ? { git: deps.git } : {}),
    ...(deps.readSource !== undefined ? { readSource: deps.readSource } : {}),
  })
  if (!provenanceResult.ok) {
    logger(`REFUSED: ${provenanceResult.reason}`)
    return 1
  }
  const provenance = provenanceResult.provenance

  const rIds = new Set(computeR(report.rows).map((r) => r.id))
  const allCandidates = report.rows.filter((r) => r.outcome === opts.outcomeClass)
  const candidates: SimRowResult[] = []
  const excludedForR: string[] = []
  for (const row of allCandidates) {
    if (rIds.has(row.id)) excludedForR.push(row.id)
    else candidates.push(row)
  }
  if (excludedForR.length > 0) {
    logger(
      `WARNING: ${excludedForR.length} candidate row(s) also appear in R (newly_quarantined/` +
        `newly_cleared) — a bulk entry can never satisfy a security-review disposition, so these ` +
        `are excluded from this batch and must be individually disposed: ${excludedForR.join(', ')}`
    )
  }
  if (candidates.length === 0) {
    logger(`No --outcome-class=${opts.outcomeClass} candidate row(s) to stage.`)
    return 0
  }

  if (opts.outcomeClass === 'unfetchable') {
    return disposeUnfetchableAction(
      {
        opts,
        candidates,
        population: population.population,
        branchMap: await deps.db.loadBranchMap(opts.runId),
        provenance,
      },
      deps,
      logger
    )
  }
  return disposePrimaryNotFoundAction(
    { opts, candidates, population: population.population, provenance },
    deps,
    logger
  )
}
