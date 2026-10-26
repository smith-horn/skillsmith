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
  fixtureSql,
  inTxn,
  perfMigrationSql,
  perfRollbackSql,
  preparedRow,
  type Ctx,
} from './backfill-autochain-silent-stop.test-helpers.ts'

/** Dispatched runs, each with a green link_finished, spread over ~389 days (the 1-year window keeps ~37,500). At 15,000 the body WITHOUT enable_nestloop = off still finished in 3.4 s; at 40,000 it takes 23.5 s, so this budget pins the setting behaviourally, not just by its string (governance 2026-10-25). */
const VOLUME = 40000
const BUDGET = '10s'
/** Retro finding 3: the open-run and Arm B volumes. */
const OPEN_A = 5000
const PAIRS_B = 30000
const OPEN_B = 500
const ACKED_A = 1000
const GREEN_A = 1000
const ACKED_B = 100

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
        preparedRow('ac-99999999', '1', '31 minutes'), // outside the seeded ac-1 .. ac-40000 tokens
        'ANALYZE audit_logs;',
        CANDIDATES,
      ])
      expect(r.lines).toEqual([
        cand('A', '424242', 'no_link', '-01:00:00'),
        cand('B', 'ac-99999999:1', 'unresolved', '-00:01:00'),
      ])
    })

    // Retro on PR #3172, finding 3: the shapes the old plan made quadratic, seeded together -- many
    // UNRESOLVED runs, each with a checkpoint (the checkpoint join), and many prepared/resolved pairs
    // (Arm B's anti-join). Exact counts, inside the same statement budget.
    it(`${OPEN_A} open Arm A runs with checkpoints and ${PAIRS_B} resolved Arm B pairs (+${OPEN_B} open) come back exactly, inside ${BUDGET}`, async () => {
      const r = await inTxn(ctx.ctl(), [
        `SET LOCAL statement_timeout = '${BUDGET}';`,
        // Arm A: dispatched runs with no green finish, each with a checkpoint 31+ minutes old
        `INSERT INTO audit_logs (event_type, actor, action, resource, result, metadata, created_at)
         SELECT 'indexer_backfill_autochain_dispatch_resolved', 'system', 'r', 'ac-a' || g, 'success',
                jsonb_build_object('dispatch_token', 'ac-' || (700000 + g), 'link_run_attempt', '1',
                                   'outcome', 'dispatched', 'dispatched_run_id', (600000000 + g)::text),
                now() - interval '2 hours' - g * interval '1 second'
         FROM generate_series(1, ${OPEN_A}) g;`,
        `INSERT INTO audit_logs (event_type, actor, action, resource, result, metadata, created_at)
         SELECT 'indexer_backfill_checkpoint', 'system', 'c', NULL, 'success',
                jsonb_build_object('run_id', (600000000 + g)::text, 'dry_run', false),
                now() - interval '1 hour' - g * interval '1 second'
         FROM generate_series(1, ${OPEN_A}) g;`,
        // Arm B: resolved pairs (closed) and a tail of prepared rows with no resolved row (open)
        `INSERT INTO audit_logs (event_type, actor, action, resource, result, metadata, created_at)
         SELECT 'indexer_backfill_autochain_dispatch_prepared', 'system', 'p', NULL, 'success',
                jsonb_build_object('dispatch_token', 'ac-' || g, 'link_run_attempt', '1'),
                now() - interval '1 hour' - g * interval '1 second'
         FROM generate_series(1, ${PAIRS_B + OPEN_B}) g;`,
        `INSERT INTO audit_logs (event_type, actor, action, resource, result, metadata, created_at)
         SELECT 'indexer_backfill_autochain_dispatch_resolved', 'system', 'r', NULL, 'success',
                jsonb_build_object('dispatch_token', 'ac-' || g, 'link_run_attempt', '1', 'outcome', 'not_dispatched'),
                now() - interval '1 hour' - g * interval '1 second' + interval '1 minute'
         FROM generate_series(1, ${PAIRS_B}) g;`,
        // Retro governance S2: the ack and green anti-joins at volume. Runs 1..ACKED_A get an Arm A
        // ack; the next GREEN_A runs get a green link_finished; ACKED_B of the open prepares get an
        // Arm B ack. Each set must drop out of the count.
        `INSERT INTO audit_logs (event_type, actor, action, resource, result, metadata, created_at)
         SELECT 'indexer_backfill_autochain_silent_stop_ack', 'operator', 'ack', NULL, 'success',
                jsonb_build_object('arm', 'A', 'key', (600000000 + g)::text), now() - interval '5 minutes'
         FROM generate_series(1, ${ACKED_A}) g;`,
        `INSERT INTO audit_logs (event_type, actor, action, resource, result, metadata, created_at)
         SELECT 'indexer_backfill_autochain_link_finished', 'system', 'l', NULL, 'success',
                jsonb_build_object('completed_run_id', (600000000 + g)::text, 'status', 'success'),
                now() - interval '50 minutes'
         FROM generate_series(${ACKED_A + 1}, ${ACKED_A + GREEN_A}) g;`,
        `INSERT INTO audit_logs (event_type, actor, action, resource, result, metadata, created_at)
         SELECT 'indexer_backfill_autochain_silent_stop_ack', 'operator', 'ack', NULL, 'success',
                jsonb_build_object('arm', 'B', 'key', 'ac-' || g || ':1'), now() - interval '5 minutes'
         FROM generate_series(${PAIRS_B + 1}, ${PAIRS_B + ACKED_B}) g;`,
        // Retro governance S3: a NEWER dry-run checkpoint for every open run. If the dry-run filter
        // were ignored, the latest checkpoint would be 10 minutes old and no Arm A run would be due.
        `INSERT INTO audit_logs (event_type, actor, action, resource, result, metadata, created_at)
         SELECT 'indexer_backfill_checkpoint', 'system', 'c', NULL, 'success',
                jsonb_build_object('run_id', (600000000 + g)::text, 'dry_run', true),
                now() - interval '10 minutes'
         FROM generate_series(1, ${OPEN_A}) g;`,
        'ANALYZE audit_logs;',
        "SELECT 'count=' || arm || ':' || sub_kind || ':' || count(*) FROM public.backfill_autochain_silent_stop_candidates() GROUP BY arm, sub_kind ORDER BY arm, sub_kind;",
      ])
      expect(r.lines).toEqual([
        `count=A:no_link:${OPEN_A - ACKED_A - GREEN_A}`,
        `count=B:unresolved:${OPEN_B - ACKED_B}`,
      ])
    })

    it('the paired rollback restores the 20261025000000 body, and the perf migration re-applies after it', async () => {
      const cfg =
        "SELECT 'cfg=' || array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'public.backfill_autochain_silent_stop_candidates()'::regprocedure;"
      try {
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
        expect(up.stderr).toMatch(
          /SMI-7167 candidates perf smoke: passed \(0 open candidate\(s\)\)/
        )
        const afterUp = await inTxn(ctx.ctl(), [cfg])
        expect(afterUp.lines).toEqual(['cfg=search_path=public, pg_temp,enable_nestloop=off'])
      } finally {
        // Leave the latest body installed whatever failed above (beforeEach would heal it, but a
        // failure here must not depend on test order).
        await ctx.ctl().send(perfMigrationSql())
      }
    })

    // Cross-family gate, PR #3172. Rows seeded in one transaction share now(), so equal intervals give
    // equal created_at: a true tie, broken only by audit_logs.id.
    it('a created_at tie on the resolved rows naming one run is broken by the lower audit_logs.id', async () => {
      const r = await inTxn(ctx.ctl(), [
        dispatchedRow('424242', '13 hours', { supabase_env: 'second' }),
        dispatchedRow('424242', '13 hours', { supabase_env: 'first' }),
        "UPDATE audit_logs SET id = 'tie-b' WHERE metadata->>'supabase_env' = 'second';",
        "UPDATE audit_logs SET id = 'tie-a' WHERE metadata->>'supabase_env' = 'first';",
        "SELECT 'env=' || supabase_env FROM public.backfill_autochain_silent_stop_candidates();",
      ])
      expect(r.lines).toEqual(['env=first'])
      const flipped = await inTxn(ctx.ctl(), [
        dispatchedRow('424242', '13 hours', { supabase_env: 'second' }),
        dispatchedRow('424242', '13 hours', { supabase_env: 'first' }),
        "UPDATE audit_logs SET id = 'tie-a' WHERE metadata->>'supabase_env' = 'second';",
        "UPDATE audit_logs SET id = 'tie-b' WHERE metadata->>'supabase_env' = 'first';",
        "SELECT 'env=' || supabase_env FROM public.backfill_autochain_silent_stop_candidates();",
      ])
      expect(flipped.lines).toEqual(['env=second'])
    })

    it('a created_at tie on the prepared rows for one token and attempt is broken by the lower audit_logs.id', async () => {
      const seed = (lowId: string, highId: string) => [
        preparedRow('ac-555', '1', '31 minutes', { link_run_id: '1111' }),
        preparedRow('ac-555', '1', '31 minutes', { link_run_id: '2222' }),
        `UPDATE audit_logs SET id = '${lowId}' WHERE metadata->>'link_run_id' = '1111';`,
        `UPDATE audit_logs SET id = '${highId}' WHERE metadata->>'link_run_id' = '2222';`,
        "SELECT 'link=' || link_run_id FROM public.backfill_autochain_silent_stop_candidates();",
      ]
      expect((await inTxn(ctx.ctl(), seed('tie-a', 'tie-b'))).lines).toEqual(['link=1111'])
      expect((await inTxn(ctx.ctl(), seed('tie-b', 'tie-a'))).lines).toEqual(['link=2222'])
    })

    it('the 1-year window is inclusive: a resolved row exactly 1 year old is still a candidate', async () => {
      const r = await inTxn(ctx.ctl(), [dispatchedRow('424242', '1 year'), CANDIDATES])
      expect(r.lines).toHaveLength(1)
      expect(r.lines[0]).toMatch(/^c=A\|424242\|no_link\|/)
    })

    it("the perf migration's own smoke runs the new body: it counts an open candidate seeded before it", async () => {
      // Committed seed (the migration has its own BEGIN/COMMIT), cleared by fixtureSql afterwards.
      await ctx.ctl().send(dispatchedRow('424242', '13 hours'))
      try {
        const up = await ctx.ctl().send(perfMigrationSql())
        expect(up.stderr, up.stderr).not.toMatch(/ERROR/)
        expect(up.stderr).toMatch(
          /SMI-7167 candidates perf smoke: passed \(1 open candidate\(s\)\)/
        )
      } finally {
        await ctx.ctl().send(fixtureSql())
      }
    })
  })
}
