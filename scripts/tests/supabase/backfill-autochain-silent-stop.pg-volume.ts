/**
 * SMI-7167: candidates() at ledger volume (migration 20261025000001). Registered from
 * ./backfill-autochain-silent-stop.pg.test.ts.
 *
 * The 20261025000000 body was correct but quadratic: measured locally, 1,000 dispatched runs took
 * 3.8 s and 8,000 took 44 s (a nested-loop anti-join against the green set, and a checkpoint scan per
 * dispatched run). This file pins the behaviour that matters -- the right candidates come back from a
 * year-sized ledger inside a statement budget -- and the planner setting that delivers it.
 *
 * The volume case seeds and calls inside ONE rolled-back transaction under `SET LOCAL
 * statement_timeout`, so a quadratic body fails here with a timeout, not a slow green run.
 *
 * @module scripts/tests/supabase/backfill-autochain-silent-stop.pg-volume
 */

import { describe, it, expect } from 'vitest'
import {
  CANDIDATES,
  cand,
  dispatchedRow,
  inTxn,
  perfMigrationSql,
  perfRollbackSql,
  preparedRow,
  type Ctx,
} from './backfill-autochain-silent-stop.test-helpers.ts'

/** Dispatched runs, each with a green link_finished, spread over the last ~146 days. */
const VOLUME = 15000
const BUDGET = '10s'

const seedVolume = (n: number): string[] => [
  `INSERT INTO audit_logs (event_type, actor, action, resource, result, metadata, created_at)
   SELECT 'indexer_backfill_autochain_dispatch_resolved', 'system', 'backfill_autochain_dispatch_resolved', 'ac-' || g, 'success',
          jsonb_build_object('dispatch_token', 'ac-' || g, 'link_run_id', g::text, 'link_run_attempt', '1',
                             'supabase_env', 'prod', 'outcome', 'dispatched', 'dispatched_run_id', (500000000 + g)::text),
          now() - g * interval '14 minutes'
   FROM generate_series(1, ${n}) g;`,
  `INSERT INTO audit_logs (event_type, actor, action, resource, result, metadata, created_at)
   SELECT 'indexer_backfill_autochain_link_finished', 'system', 'backfill_autochain_link', (500000000 + g)::text, 'success',
          jsonb_build_object('completed_run_id', (500000000 + g)::text, 'status', 'success', 'link_run_id', g::text),
          now() - g * interval '14 minutes' + interval '20 seconds'
   FROM generate_series(1, ${n}) g;`,
  `INSERT INTO audit_logs (event_type, actor, action, resource, result, metadata, created_at)
   SELECT 'indexer_backfill_checkpoint', 'system', 'backfill_checkpoint', NULL, 'success',
          jsonb_build_object('run_id', (500000000 + g)::text, 'dry_run', false),
          now() - g * interval '14 minutes' + interval '10 seconds'
   FROM generate_series(1, ${n}) g;`,
]

export function registerVolumeTests(ctx: Ctx): void {
  describe('case 9: candidates() at ledger volume (20261025000001)', () => {
    it('the function carries enable_nestloop=off next to its fixed search_path', async () => {
      const r = await inTxn(ctx.ctl(), [
        "SELECT 'cfg=' || array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'public.backfill_autochain_silent_stop_candidates()'::regprocedure;",
      ])
      expect(r.lines).toEqual(['cfg=search_path=public, pg_temp,enable_nestloop=off'])
    })

    it(`returns exactly the two real candidates from ${VOLUME} resolved runs inside a ${BUDGET} statement budget`, async () => {
      const r = await inTxn(ctx.ctl(), [
        `SET LOCAL statement_timeout = '${BUDGET}';`,
        ...seedVolume(VOLUME),
        // The two real incidents hidden in the volume: an unlinked run and an unresolved prepare.
        dispatchedRow('424242', '13 hours'),
        preparedRow('ac-99999999', '1', '31 minutes'), // outside the seeded ac-1 .. ac-15000 tokens
        'ANALYZE audit_logs;',
        CANDIDATES,
      ])
      expect(r.lines).toEqual([
        cand('A', '424242', 'no_link', '-01:00:00'),
        cand('B', 'ac-99999999:1', 'unresolved', '-00:01:00'),
      ])
    })

    it('the paired rollback restores the 20261025000000 body, and the perf migration re-applies after it', async () => {
      const cfg =
        "SELECT 'cfg=' || array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'public.backfill_autochain_silent_stop_candidates()'::regprocedure;"
      const down = await ctx.ctl().send(perfRollbackSql())
      expect(down.stderr, down.stderr).not.toMatch(/ERROR/)
      const afterDown = await inTxn(ctx.ctl(), [
        cfg,
        dispatchedRow('424242', '13 hours'),
        CANDIDATES,
      ])
      // The old body: no planner setting, same answer on a small ledger.
      expect(afterDown.lines).toEqual([
        'cfg=search_path=public, pg_temp',
        cand('A', '424242', 'no_link', '-01:00:00'),
      ])
      const up = await ctx.ctl().send(perfMigrationSql())
      expect(up.stderr, up.stderr).not.toMatch(/ERROR/)
      expect(up.stderr).toMatch(/SMI-7167 candidates perf smoke: passed/)
      const afterUp = await inTxn(ctx.ctl(), [cfg])
      expect(afterUp.lines).toEqual(['cfg=search_path=public, pg_temp,enable_nestloop=off'])
    })
  })
}
