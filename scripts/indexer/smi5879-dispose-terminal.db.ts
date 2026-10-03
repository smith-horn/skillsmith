/**
 * Production DB dependency adapter for the SMI-6444 bulk disposition
 * producer CLI (`smi5879-dispose-terminal.ts`). Mirrors
 * `smi5879-gate-check.pg.ts`'s delegation pattern exactly: a narrow `Pick`
 * of `Smi5879SimulateFullDbDeps`, satisfied entirely by delegating to the
 * EXISTING, already-verified `createSmi5879SimulateFullDbDeps` adapter — no
 * new SQL objects, no new trust surface.
 * @module scripts/indexer/smi5879-dispose-terminal.db
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 1 — "The producer's DB dependency type should be a narrow pick —
 *   `Pick<Smi5879SimulateFullDbDeps, 'getRunSummary' | 'verifyDigest' |
 *   'loadCohortRows' | 'loadBranchMap'>` — matching the precedent
 *   `Smi5879MergeShardsDbDeps` already sets (`population.ts:51-54`). The
 *   existing production adapter `createSmi5879SimulateFullDbDeps`
 *   (`smi5879-simulate-full.db.ts:56`) satisfies it with zero new
 *   DB-access code — the producer is a new consumer of an existing,
 *   already-verified loading path, not a new trust surface."
 */

import { createSmi5879SimulateFullDbDeps } from './smi5879-simulate-full.db.ts'
import type { PgConnParams } from './smi5879-census.pg.ts'
import type { Smi5879SimulateFullDbDeps } from './smi5879-simulate-full.types.ts'

/**
 * The narrow DB surface the bulk disposition producer needs: run-summary +
 * digest verification (mirroring `loadVerifiedPopulation`'s trust chain,
 * `smi5879-merge-shards.population.ts`) plus the population and
 * branch-resolution reads `deriveUnfetchableSubtype`
 * (`smi5879-terminal-derivation.ts`) and the `primary_not_found` live
 * re-check both need.
 */
export type Smi5879DisposeTerminalDbDeps = Pick<
  Smi5879SimulateFullDbDeps,
  'getRunSummary' | 'verifyDigest' | 'loadCohortRows' | 'loadBranchMap'
>

/**
 * Build the real, psql-backed dependency set for a given connection —
 * delegates entirely to the simulator's own already-shipped adapter, the
 * same delegation `smi5879-gate-check.pg.ts` already performs for
 * `loadCohortRows`/`loadBranchMap`. No new SQL is written or run here.
 */
export function createSmi5879DisposeTerminalDbDeps(
  conn: PgConnParams
): Smi5879DisposeTerminalDbDeps {
  const deps = createSmi5879SimulateFullDbDeps(conn)
  return {
    getRunSummary: deps.getRunSummary,
    verifyDigest: deps.verifyDigest,
    loadCohortRows: deps.loadCohortRows,
    loadBranchMap: deps.loadBranchMap,
  }
}
