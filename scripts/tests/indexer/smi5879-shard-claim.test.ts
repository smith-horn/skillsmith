/**
 * SMI-6015 Wave 0: per-shard claim / heartbeat / release / GC, canonical
 * shard-count agreement, the forced-release audit log, and the
 * abandon-vs-active-shard interaction — against a REAL local Postgres, same
 * harness as smi5879-census.claim-gc.test.ts (see that file's helpers for
 * the standup command). Covers only what's NEW in
 * 20260825000000_smi5879_shard_claim.sql — the already-reviewed parent
 * single-holder claim/GC logic has its own coverage in the sibling file.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  runPsql,
  queryRows,
  queryScalar,
  nullable,
  type PgConnParams,
} from '../../indexer/smi5879-census.pg.ts'
import {
  requireTestConn,
  resetSchema,
  createOpenRun,
  sealAnyOpenGeneration,
  backdateShardHeartbeat,
  prePushNoLiveTestPg,
} from './smi5879-census.test-helpers.ts'

let conn: PgConnParams

beforeAll(async () => {
  if (prePushNoLiveTestPg) return
  conn = await resetSchema(requireTestConn(), 'smi5879_test_shardclaim')
}, 60_000)

afterEach(async () => {
  if (prePushNoLiveTestPg) return
  await sealAnyOpenGeneration(conn)
})

async function claimShard(
  runId: string,
  shardIndex: number,
  shardCount: number,
  token: string,
  holder = 'holder-a'
): Promise<string[][]> {
  return queryRows(
    conn,
    `SELECT run_id, shard_index, runner_token FROM smi5879_claim_run_shard(:'run_id', :'shard_index'::integer, :'shard_count'::integer, :'token', :'holder');`,
    {
      run_id: runId,
      shard_index: String(shardIndex),
      shard_count: String(shardCount),
      token,
      holder,
    }
  )
}

describe.skipIf(prePushNoLiveTestPg)('per-shard claim (SMI-6015 Wave 0)', () => {
  it('claim succeeds on an unclaimed (run_id, shard_index)', async () => {
    const runId = `t-shard-claim-fresh-${randomUUID()}`
    await createOpenRun(conn, runId)
    const token = randomUUID()
    const rows = await claimShard(runId, 0, 3, token)
    expect(rows).toHaveLength(1)
    expect(rows[0][2]).toBe(token)
  })

  it('a second claim for the SAME shard is refused (0 rows) while the heartbeat is fresh', async () => {
    const runId = `t-shard-claim-held-${randomUUID()}`
    await createOpenRun(conn, runId)
    await claimShard(runId, 0, 3, randomUUID())
    const rows = await claimShard(runId, 0, 3, randomUUID(), 'holder-b')
    expect(rows).toHaveLength(0)
  })

  it('different shard indices of the same run_id claim independently — the whole point of Wave 0', async () => {
    const runId = `t-shard-claim-independent-${randomUUID()}`
    await createOpenRun(conn, runId)
    const rows0 = await claimShard(runId, 0, 3, randomUUID())
    const rows1 = await claimShard(runId, 1, 3, randomUUID())
    const rows2 = await claimShard(runId, 2, 3, randomUUID())
    expect(rows0).toHaveLength(1)
    expect(rows1).toHaveLength(1)
    expect(rows2).toHaveLength(1)
  })

  it('claim raises when the run is not open/sealed (or does not exist)', async () => {
    await expect(
      claimShard(`t-shard-claim-nonexistent-${randomUUID()}`, 0, 3, randomUUID())
    ).rejects.toThrow(/is not open\/sealed/)
  })

  it('raises on a NULL p_new_token', async () => {
    const runId = `t-shard-guard-null-token-${randomUUID()}`
    await createOpenRun(conn, runId)
    await expect(
      runPsql(conn, `SELECT * FROM smi5879_claim_run_shard(:'run_id', 0, 3, NULL, 'h');`, {
        run_id: runId,
      })
    ).rejects.toThrow(/p_new_token must not be NULL/)
  })

  it('raises on shard_index out of [0, shard_count) bounds', async () => {
    const runId = `t-shard-guard-bounds-${randomUUID()}`
    await createOpenRun(conn, runId)
    await expect(
      runPsql(
        conn,
        `SELECT * FROM smi5879_claim_run_shard(:'run_id', 3, 3, gen_random_uuid(), 'h');`,
        { run_id: runId }
      )
    ).rejects.toThrow(/must be non-NULL, non-negative, and less than/)
  })
})

describe.skipIf(prePushNoLiveTestPg)('canonical shard_count agreement (round-2 review H1)', () => {
  it('the FIRST claim for a run_id establishes the canonical shard_count', async () => {
    const runId = `t-shard-count-first-${randomUUID()}`
    await createOpenRun(conn, runId)
    await claimShard(runId, 0, 3, randomUUID())
    const canonical = await queryScalar(
      conn,
      `SELECT shard_count FROM smi5879_run_shard_config WHERE run_id = :'run_id';`,
      { run_id: runId }
    )
    expect(canonical).toBe('3')
  })

  it('a NEVER-BEFORE-CLAIMED shard_index with a MISMATCHED shard_count is rejected — round-2 H1', async () => {
    const runId = `t-shard-count-mismatch-${randomUUID()}`
    await createOpenRun(conn, runId)
    // shard 0 establishes canonical shard_count = 3
    await claimShard(runId, 0, 3, randomUUID())
    // shard 1 has never been claimed before — the bug this fix closes is that
    // the plain per-row check alone would let this INSERT succeed with a
    // DIFFERENT shard_count, silently breaking the partition.
    await expect(claimShard(runId, 1, 4, randomUUID())).rejects.toThrow(/shard_count mismatch/)
  })

  it('a matching shard_count for a new shard_index succeeds', async () => {
    const runId = `t-shard-count-match-${randomUUID()}`
    await createOpenRun(conn, runId)
    await claimShard(runId, 0, 3, randomUUID())
    const rows = await claimShard(runId, 1, 3, randomUUID())
    expect(rows).toHaveLength(1)
  })
})

describe.skipIf(prePushNoLiveTestPg)('per-shard heartbeat / release (SMI-6015 Wave 0)', () => {
  it('heartbeat succeeds (returns a timestamp) for the true holder', async () => {
    const runId = `t-shard-heartbeat-ok-${randomUUID()}`
    await createOpenRun(conn, runId)
    const token = randomUUID()
    await claimShard(runId, 0, 3, token)
    const rows = await queryRows(conn, `SELECT smi5879_heartbeat_shard(:'run_id', 0, :'token');`, {
      run_id: runId,
      token,
    })
    expect(nullable(rows[0][0])).not.toBeNull()
  })

  it('heartbeat returns NULL for a stolen/mismatched token', async () => {
    const runId = `t-shard-heartbeat-stolen-${randomUUID()}`
    await createOpenRun(conn, runId)
    await claimShard(runId, 0, 3, randomUUID())
    const rows = await queryRows(conn, `SELECT smi5879_heartbeat_shard(:'run_id', 0, :'token');`, {
      run_id: runId,
      token: randomUUID(),
    })
    expect(nullable(rows[0][0])).toBeNull()
  })

  it('heartbeat returns NULL once the parent run is no longer open/sealed (round-2 C1 defense-in-depth)', async () => {
    const runId = `t-shard-heartbeat-parent-abandoned-${randomUUID()}`
    await createOpenRun(conn, runId)
    const token = randomUUID()
    await claimShard(runId, 0, 3, token)
    // Test-only escape hatch simulating an out-of-band abandonment (the exact
    // scenario this defense-in-depth check exists for, per the migration's
    // own comment) — the normal smi5879_abandon_unclaimed_run path cannot
    // reach this state while a shard holds a live token, by construction.
    await runPsql(
      conn,
      `UPDATE smi5879_run SET status = 'abandoned', abandoned_at = now(), abandoned_reason = 'test' WHERE run_id = :'run_id';`,
      { run_id: runId }
    )
    const rows = await queryRows(conn, `SELECT smi5879_heartbeat_shard(:'run_id', 0, :'token');`, {
      run_id: runId,
      token,
    })
    expect(nullable(rows[0][0])).toBeNull()
  })

  it('release clears runner_token/runner_holder for the true holder', async () => {
    const runId = `t-shard-release-${randomUUID()}`
    await createOpenRun(conn, runId)
    const token = randomUUID()
    await claimShard(runId, 0, 3, token)
    await runPsql(conn, `SELECT smi5879_release_run_shard(:'run_id', 0, :'token');`, {
      run_id: runId,
      token,
    })
    const rows = await queryRows(
      conn,
      `SELECT runner_token, runner_holder FROM smi5879_run_shard_claim WHERE run_id = :'run_id' AND shard_index = 0;`,
      { run_id: runId }
    )
    expect(nullable(rows[0][0])).toBeNull()
    expect(nullable(rows[0][1])).toBeNull()
  })
})

describe.skipIf(prePushNoLiveTestPg)('shard GC + release audit log (round-2 H2)', () => {
  it('refuses on a fresh heartbeat, even with the correct token', async () => {
    const runId = `t-shard-gc-fresh-${randomUUID()}`
    await createOpenRun(conn, runId)
    const token = randomUUID()
    await claimShard(runId, 0, 3, token)
    const rows = await queryRows(
      conn,
      `SELECT run_id FROM smi5879_gc_force_release_shard(:'run_id', 0, :'token', 'test');`,
      { run_id: runId, token }
    )
    expect(rows).toHaveLength(0)
  })

  it('refuses on a token mismatch, even with a genuinely stale heartbeat', async () => {
    const runId = `t-shard-gc-mismatch-${randomUUID()}`
    await createOpenRun(conn, runId)
    const realToken = randomUUID()
    await claimShard(runId, 0, 3, realToken)
    await backdateShardHeartbeat(conn, runId, 0, 180)
    const rows = await queryRows(
      conn,
      `SELECT run_id FROM smi5879_gc_force_release_shard(:'run_id', 0, :'token', 'test', interval '1 millisecond');`,
      { run_id: runId, token: randomUUID() }
    )
    expect(rows).toHaveLength(0)
  })

  it('succeeds when the token matches AND the heartbeat is genuinely stale — and logs the release', async () => {
    const runId = `t-shard-gc-succeeds-${randomUUID()}`
    await createOpenRun(conn, runId)
    const token = randomUUID()
    await claimShard(runId, 0, 3, token)
    await backdateShardHeartbeat(conn, runId, 0, 180)
    const rows = await queryRows(
      conn,
      `SELECT run_id, shard_index FROM smi5879_gc_force_release_shard(:'run_id', 0, :'token', 'genuinely stale', interval '2 hours');`,
      { run_id: runId, token }
    )
    expect(rows).toHaveLength(1)
    // round-2 H2: the release must be logged, not just performed silently.
    const logRows = await queryRows(
      conn,
      `SELECT shard_index, observed_token, reason FROM smi5879_shard_release_log WHERE run_id = :'run_id';`,
      { run_id: runId }
    )
    expect(logRows).toHaveLength(1)
    expect(logRows[0][0]).toBe('0')
    expect(logRows[0][1]).toBe(token)
    expect(logRows[0][2]).toBe('genuinely stale')
  })

  it('a REFUSED forced release does NOT write an audit log row', async () => {
    const runId = `t-shard-gc-no-log-on-refusal-${randomUUID()}`
    await createOpenRun(conn, runId)
    const token = randomUUID()
    await claimShard(runId, 0, 3, token)
    await queryRows(
      conn,
      `SELECT run_id FROM smi5879_gc_force_release_shard(:'run_id', 0, :'token', 'test');`,
      { run_id: runId, token }
    )
    const logRows = await queryRows(
      conn,
      `SELECT 1 FROM smi5879_shard_release_log WHERE run_id = :'run_id';`,
      { run_id: runId }
    )
    expect(logRows).toHaveLength(0)
  })

  it('raises on a non-positive p_stale_after', async () => {
    const runId = `t-shard-gc-guard-stale-${randomUUID()}`
    await createOpenRun(conn, runId)
    await expect(
      runPsql(
        conn,
        `SELECT * FROM smi5879_gc_force_release_shard(:'run_id', 0, gen_random_uuid(), 'r', interval '0 seconds');`,
        { run_id: runId }
      )
    ).rejects.toThrow(/p_stale_after must be a positive interval/)
  })

  it('raises on an empty or NULL p_reason', async () => {
    const runId = `t-shard-gc-guard-reason-${randomUUID()}`
    await createOpenRun(conn, runId)
    await expect(
      runPsql(
        conn,
        `SELECT * FROM smi5879_gc_force_release_shard(:'run_id', 0, gen_random_uuid(), '');`,
        { run_id: runId }
      )
    ).rejects.toThrow(/p_reason must be a non-empty string/)
  })
})

describe.skipIf(prePushNoLiveTestPg)(
  'smi5879_abandon_unclaimed_run vs. an active shard claim (round-2 C1 / round-3 snapshot-timing fix)',
  () => {
    it('refuses to abandon a run while ANY shard still holds a live claim token', async () => {
      const runId = `t-abandon-vs-shard-blocked-${randomUUID()}`
      await createOpenRun(conn, runId)
      await claimShard(runId, 0, 3, randomUUID())
      const rows = await queryRows(
        conn,
        `SELECT run_id FROM smi5879_abandon_unclaimed_run(:'run_id', 'attempted abandon');`,
        { run_id: runId }
      )
      expect(rows).toHaveLength(0)
      const status = await queryScalar(
        conn,
        `SELECT status FROM smi5879_run WHERE run_id = :'run_id';`,
        { run_id: runId }
      )
      expect(status).toBe('open')
    })

    it('succeeds once every shard claim has been released — no live token remains', async () => {
      const runId = `t-abandon-vs-shard-released-${randomUUID()}`
      await createOpenRun(conn, runId)
      const token = randomUUID()
      await claimShard(runId, 0, 1, token)
      await runPsql(conn, `SELECT smi5879_release_run_shard(:'run_id', 0, :'token');`, {
        run_id: runId,
        token,
      })
      const rows = await queryRows(
        conn,
        `SELECT run_id FROM smi5879_abandon_unclaimed_run(:'run_id', 'no live shards');`,
        { run_id: runId }
      )
      expect(rows).toHaveLength(1)
    })

    it('succeeds on a run that was never sharded at all (plain single-holder case, unaffected)', async () => {
      const runId = `t-abandon-plain-unclaimed-${randomUUID()}`
      await createOpenRun(conn, runId)
      const rows = await queryRows(
        conn,
        `SELECT run_id FROM smi5879_abandon_unclaimed_run(:'run_id', 'never claimed at all');`,
        { run_id: runId }
      )
      expect(rows).toHaveLength(1)
    })
  }
)
