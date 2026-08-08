/**
 * SMI-5879 Wave 3 item 1: claim / heartbeat / release / GC sequence — including
 * the round-3-review parameter-validation guards on `smi5879_claim_run` and
 * `smi5879_gc_force_abandon` (design doc 8.3.5.2.5) — against a REAL local
 * Postgres. See smi5879-census.test-helpers.ts for the harness this requires.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { runPsql, queryRows, nullable, type PgConnParams } from '../../indexer/smi5879-census.pg.ts'
import {
  requireTestConn,
  resetSchema,
  createOpenRun,
  sealAnyOpenGeneration,
  backdateAbandonedAt,
  backdateHeartbeat,
  prePushNoLiveTestPg,
} from './smi5879-census.test-helpers.ts'

let conn: PgConnParams

beforeAll(async () => {
  if (prePushNoLiveTestPg) return
  // Own schema — see resetSchema's doc comment (cross-file vitest parallelism).
  conn = await resetSchema(requireTestConn(), 'smi5879_test_claimgc')
}, 60_000)

afterEach(async () => {
  if (prePushNoLiveTestPg) return
  await sealAnyOpenGeneration(conn)
})

describe.skipIf(prePushNoLiveTestPg)(
  'claim / heartbeat / release / takeover (design doc 8.3.5.2.5)',
  () => {
    it('claim succeeds on an unclaimed generation', async () => {
      const runId = `t-claim-fresh-${randomUUID()}`
      await createOpenRun(conn, runId)
      const token = randomUUID()
      const rows = await queryRows(
        conn,
        `SELECT run_id, runner_token FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`,
        { run_id: runId, token }
      )
      expect(rows).toHaveLength(1)
      expect(rows[0][1]).toBe(token)
    })

    it('a second claim attempt is refused (0 rows) while the heartbeat is fresh', async () => {
      const runId = `t-claim-held-${randomUUID()}`
      await createOpenRun(conn, runId)
      const tokenA = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token: tokenA,
      })
      const tokenB = randomUUID()
      const rows = await queryRows(
        conn,
        `SELECT run_id FROM smi5879_claim_run(:'run_id', :'token', 'holder-b', interval '30 minutes');`,
        { run_id: runId, token: tokenB }
      )
      expect(rows).toHaveLength(0)
    })

    it('takeover succeeds once the heartbeat is stale beyond p_takeover_after', async () => {
      const runId = `t-claim-takeover-${randomUUID()}`
      await createOpenRun(conn, runId)
      const tokenA = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token: tokenA,
      })
      await backdateHeartbeat(conn, runId, 61) // 61 min ago > default 30-min takeover threshold

      const tokenB = randomUUID()
      const rows = await queryRows(
        conn,
        `SELECT run_id, runner_token FROM smi5879_claim_run(:'run_id', :'token', 'holder-b');`,
        { run_id: runId, token: tokenB }
      )
      expect(rows).toHaveLength(1)
      expect(rows[0][1]).toBe(tokenB)
    })

    it('heartbeat succeeds (returns a timestamp) for the true holder', async () => {
      const runId = `t-heartbeat-ok-${randomUUID()}`
      await createOpenRun(conn, runId)
      const token = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token,
      })
      const rows = await queryRows(conn, `SELECT smi5879_heartbeat(:'run_id', :'token');`, {
        run_id: runId,
        token,
      })
      expect(rows).toHaveLength(1)
      expect(rows[0][0]).not.toBe('')
    })

    it('heartbeat returns NULL for a stolen/mismatched token — the runner must abort', async () => {
      // smi5879_heartbeat RETURNS a plain timestamptz (not a TABLE), so a scalar
      // SQL function call in a SELECT target list always yields exactly ONE output
      // row — the row's VALUE is NULL when the underlying UPDATE...RETURNING
      // touched zero rows. Design doc 8.3.5.2.5 states this exactly: "A NULL
      // return from smi5879_heartbeat is fatal and immediate."
      const runId = `t-heartbeat-stolen-${randomUUID()}`
      await createOpenRun(conn, runId)
      const realToken = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token: realToken,
      })
      const wrongToken = randomUUID()
      const rows = await queryRows(conn, `SELECT smi5879_heartbeat(:'run_id', :'token');`, {
        run_id: runId,
        token: wrongToken,
      })
      expect(rows).toHaveLength(1)
      expect(nullable(rows[0][0])).toBeNull()
    })

    it('release clears runner_token/runner_holder for the true holder', async () => {
      const runId = `t-release-${randomUUID()}`
      await createOpenRun(conn, runId)
      const token = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token,
      })
      await runPsql(conn, `SELECT smi5879_release_run(:'run_id', :'token');`, {
        run_id: runId,
        token,
      })
      const rows = await queryRows(
        conn,
        `SELECT runner_token, runner_holder FROM smi5879_run WHERE run_id = :'run_id'`,
        { run_id: runId }
      )
      expect(nullable(rows[0][0])).toBeNull()
      expect(nullable(rows[0][1])).toBeNull()
    })
  }
)

describe.skipIf(prePushNoLiveTestPg)(
  'GC — force-abandon three-condition CAS (design doc 8.3.5.2.5)',
  () => {
    it('refuses on a fresh heartbeat, even with the correct token', async () => {
      const runId = `t-gc-fresh-heartbeat-${randomUUID()}`
      await createOpenRun(conn, runId)
      const token = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token,
      })
      // Heartbeat is fresh (just claimed, milliseconds ago) — GC must refuse under
      // the REAL default p_stale_after (2h). A deliberately tiny p_stale_after
      // here (e.g. 1ms) would be indistinguishable from ordinary psql-subprocess
      // spawn latency and would not actually test "fresh" staleness.
      const rows = await queryRows(
        conn,
        `SELECT run_id FROM smi5879_gc_force_abandon(:'run_id', :'token', 'test');`,
        { run_id: runId, token }
      )
      expect(rows).toHaveLength(0)
      const status = await queryRows(
        conn,
        `SELECT status FROM smi5879_run WHERE run_id = :'run_id'`,
        {
          run_id: runId,
        }
      )
      expect(status[0][0]).toBe('open')
    })

    it('refuses on a token mismatch, even with a genuinely stale heartbeat', async () => {
      const runId = `t-gc-token-mismatch-${randomUUID()}`
      await createOpenRun(conn, runId)
      const realToken = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token: realToken,
      })
      await backdateHeartbeat(conn, runId, 180) // genuinely stale
      const wrongToken = randomUUID()
      const rows = await queryRows(
        conn,
        `SELECT run_id FROM smi5879_gc_force_abandon(:'run_id', :'token', 'test', interval '1 millisecond');`,
        { run_id: runId, token: wrongToken }
      )
      expect(rows).toHaveLength(0)
      const status = await queryRows(
        conn,
        `SELECT status FROM smi5879_run WHERE run_id = :'run_id'`,
        {
          run_id: runId,
        }
      )
      expect(status[0][0]).toBe('open')
    })

    it('refuses on a never-claimed (sealed but unclaimed) generation', async () => {
      const runId = `t-gc-never-claimed-${randomUUID()}`
      await createOpenRun(conn, runId)
      // Never claimed — runner_token IS NULL. Any observed_token fails condition (1).
      const bogusToken = randomUUID()
      const rows = await queryRows(
        conn,
        `SELECT run_id FROM smi5879_gc_force_abandon(:'run_id', :'token', 'test', interval '1 millisecond');`,
        { run_id: runId, token: bogusToken }
      )
      expect(rows).toHaveLength(0)

      // The correct, deliberate act for this case succeeds instead:
      const abandoned = await queryRows(
        conn,
        `SELECT run_id FROM smi5879_abandon_unclaimed_run(:'run_id', 'never claimed');`,
        { run_id: runId }
      )
      expect(abandoned).toHaveLength(1)
    })

    it('succeeds when the token matches AND the heartbeat is genuinely stale', async () => {
      const runId = `t-gc-succeeds-${randomUUID()}`
      await createOpenRun(conn, runId)
      const token = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token,
      })
      await backdateHeartbeat(conn, runId, 180)
      const rows = await queryRows(
        conn,
        `SELECT run_id, abandoned_at FROM smi5879_gc_force_abandon(:'run_id', :'token', 'genuinely stale', interval '2 hours');`,
        { run_id: runId, token }
      )
      expect(rows).toHaveLength(1)
      const status = await queryRows(
        conn,
        `SELECT status FROM smi5879_run WHERE run_id = :'run_id'`,
        {
          run_id: runId,
        }
      )
      expect(status[0][0]).toBe('abandoned')
    })

    it('phase 2 (smi5879_gc_delete_population) refuses inside the 24h grace period', async () => {
      const runId = `t-gc-phase2-inside-grace-${randomUUID()}`
      await createOpenRun(conn, runId)
      // A row must actually exist, or the DELETE matches zero rows and the
      // per-row guard trigger never fires at all — the DELETE would then
      // "succeed" trivially (0 rows deleted) instead of raising.
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at) VALUES (:'run_id', 'x', now(), '1', now());`,
        { run_id: runId }
      )
      const token = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token,
      })
      await backdateHeartbeat(conn, runId, 180)
      await runPsql(
        conn,
        `SELECT * FROM smi5879_gc_force_abandon(:'run_id', :'token', 'test', interval '2 hours');`,
        { run_id: runId, token }
      )
      // abandoned_at = now() — well inside the 24h grace period.
      await expect(
        runPsql(conn, `SELECT * FROM smi5879_gc_delete_population(:'run_id');`, { run_id: runId })
      ).rejects.toThrow(/inside the 24 h GC grace period/)
    })

    it('phase 2 succeeds once the grace period has genuinely elapsed', async () => {
      const runId = `t-gc-phase2-past-grace-${randomUUID()}`
      await createOpenRun(conn, runId)
      const token = randomUUID()
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at) VALUES (:'run_id', 'x', now(), '1', now());`,
        { run_id: runId }
      )
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token,
      })
      await backdateHeartbeat(conn, runId, 180)
      await runPsql(
        conn,
        `SELECT * FROM smi5879_gc_force_abandon(:'run_id', :'token', 'test', interval '2 hours');`,
        { run_id: runId, token }
      )
      await backdateAbandonedAt(conn, runId, 25)

      const rows = await queryRows(
        conn,
        `SELECT snapshot_rows_deleted FROM smi5879_gc_delete_population(:'run_id');`,
        { run_id: runId }
      )
      expect(rows[0][0]).toBe('1')
      // Registry row itself is NEVER deleted (8.3.5.2.1/8.3.5.2.5).
      const stillRegistered = await queryRows(
        conn,
        `SELECT run_id FROM smi5879_run WHERE run_id = :'run_id'`,
        { run_id: runId }
      )
      expect(stillRegistered).toHaveLength(1)
    })
  }
)

describe.skipIf(prePushNoLiveTestPg)(
  'parameter-validation guards (round-3 review finding, design doc 8.3.5.2.5)',
  () => {
    it('smi5879_claim_run raises on a non-positive p_takeover_after', async () => {
      const runId = `t-guard-takeover-neg-${randomUUID()}`
      await createOpenRun(conn, runId)
      await expect(
        runPsql(
          conn,
          `SELECT * FROM smi5879_claim_run(:'run_id', gen_random_uuid(), 'h', interval '0 seconds');`,
          { run_id: runId }
        )
      ).rejects.toThrow(/p_takeover_after must be a positive interval/)
      await expect(
        runPsql(
          conn,
          `SELECT * FROM smi5879_claim_run(:'run_id', gen_random_uuid(), 'h', interval '-5 minutes');`,
          { run_id: runId }
        )
      ).rejects.toThrow(/p_takeover_after must be a positive interval/)
    })

    it('smi5879_claim_run raises on a NULL p_new_token', async () => {
      const runId = `t-guard-null-token-${randomUUID()}`
      await createOpenRun(conn, runId)
      await expect(
        runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', NULL, 'h');`, { run_id: runId })
      ).rejects.toThrow(/p_new_token must not be NULL/)
    })

    it('smi5879_gc_force_abandon raises on a non-positive p_stale_after', async () => {
      const runId = `t-guard-stale-neg-${randomUUID()}`
      await createOpenRun(conn, runId)
      await expect(
        runPsql(
          conn,
          `SELECT * FROM smi5879_gc_force_abandon(:'run_id', gen_random_uuid(), 'r', interval '0 seconds');`,
          { run_id: runId }
        )
      ).rejects.toThrow(/p_stale_after must be a positive interval/)
      await expect(
        runPsql(
          conn,
          `SELECT * FROM smi5879_gc_force_abandon(:'run_id', gen_random_uuid(), 'r', interval '-1 hours');`,
          { run_id: runId }
        )
      ).rejects.toThrow(/p_stale_after must be a positive interval/)
    })

    it('smi5879_gc_force_abandon raises on an empty or NULL p_reason', async () => {
      const runId = `t-guard-empty-reason-${randomUUID()}`
      await createOpenRun(conn, runId)
      await expect(
        runPsql(conn, `SELECT * FROM smi5879_gc_force_abandon(:'run_id', gen_random_uuid(), '');`, {
          run_id: runId,
        })
      ).rejects.toThrow(/p_reason must be a non-empty string/)
      await expect(
        runPsql(
          conn,
          `SELECT * FROM smi5879_gc_force_abandon(:'run_id', gen_random_uuid(), '   ');`,
          {
            run_id: runId,
          }
        )
      ).rejects.toThrow(/p_reason must be a non-empty string/)
      await expect(
        runPsql(
          conn,
          `SELECT * FROM smi5879_gc_force_abandon(:'run_id', gen_random_uuid(), NULL);`,
          {
            run_id: runId,
          }
        )
      ).rejects.toThrow(/p_reason must be a non-empty string/)
    })
  }
)
