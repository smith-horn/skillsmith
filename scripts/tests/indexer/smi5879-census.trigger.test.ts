/**
 * SMI-5879 Wave 3 item 1: the immutability guard's full state-transition matrix
 * (design doc 8.3.5.2.3), the insert-vs-seal race fix, and digest determinism
 * under a changed session `TimeZone`/`DateStyle` — against a REAL local
 * Postgres. See smi5879-census.test-helpers.ts for the harness this requires.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { runPsql, queryScalar, type PgConnParams } from '../../indexer/smi5879-census.pg.ts'
import {
  requireTestConn,
  resetSchema,
  createOpenRun,
  sealRun,
  sealAnyOpenGeneration,
  backdateAbandonedAt,
  prePushNoLiveTestPg,
} from './smi5879-census.test-helpers.ts'

let conn: PgConnParams

beforeAll(async () => {
  if (prePushNoLiveTestPg) return
  // Own schema — see resetSchema's doc comment (cross-file vitest parallelism).
  conn = await resetSchema(requireTestConn(), 'smi5879_test_trigger')
}, 60_000)

afterEach(async () => {
  if (prePushNoLiveTestPg) return
  await sealAnyOpenGeneration(conn)
})

/** Force `runId` to `abandoned` via the real claim + GC dance (never a raw UPDATE bypass). */
async function forceAbandon(conn: PgConnParams, runId: string): Promise<void> {
  const token = randomUUID()
  await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'test-holder');`, {
    run_id: runId,
    token,
  })
  // Backdate the heartbeat far enough that a 1ms p_stale_after considers it stale.
  await runPsql(
    conn,
    `UPDATE smi5879_run SET runner_heartbeat_at = now() - interval '1 hour' WHERE run_id = :'run_id';`,
    { run_id: runId }
  )
  await runPsql(
    conn,
    `SELECT * FROM smi5879_gc_force_abandon(:'run_id', :'token', 'trigger-matrix test', interval '1 millisecond');`,
    { run_id: runId, token }
  )
}

describe.skipIf(prePushNoLiveTestPg)(
  'immutability guard — full state-transition matrix (design doc 8.3.5.2.3)',
  () => {
    it('INSERT while open = permitted', async () => {
      const runId = `t-ins-open-${randomUUID()}`
      await createOpenRun(conn, runId)
      await expect(
        runPsql(
          conn,
          `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at) VALUES (:'run_id', 'x', now(), '1', now());`,
          { run_id: runId }
        )
      ).resolves.toBeDefined()
    })

    it('INSERT while sealed = refused', async () => {
      const runId = `t-ins-sealed-${randomUUID()}`
      await createOpenRun(conn, runId)
      await sealRun(conn, runId)
      await expect(
        runPsql(
          conn,
          `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at) VALUES (:'run_id', 'x', now(), '1', now());`,
          { run_id: runId }
        )
      ).rejects.toThrow(/not "open" -- INSERT/)
    })

    it('INSERT while abandoned = refused', async () => {
      const runId = `t-ins-abandoned-${randomUUID()}`
      await createOpenRun(conn, runId)
      await forceAbandon(conn, runId)
      await expect(
        runPsql(
          conn,
          `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at) VALUES (:'run_id', 'x', now(), '1', now());`,
          { run_id: runId }
        )
      ).rejects.toThrow(/not "open" -- INSERT/)
    })

    it('INSERT with no registry row = refused', async () => {
      await expect(
        runPsql(
          conn,
          `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at) VALUES ('nonexistent-run', 'x', now(), '1', now());`
        )
      ).rejects.toThrow(/no smi5879_run row for run_id/)
    })

    it('UPDATE while open = permitted', async () => {
      const runId = `t-upd-open-${randomUUID()}`
      await createOpenRun(conn, runId)
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at) VALUES (:'run_id', 'x', now(), '1', now());`,
        { run_id: runId }
      )
      await expect(
        runPsql(
          conn,
          `UPDATE smi5879_snapshot_pre SET row_xmin = '2' WHERE run_id = :'run_id' AND id = 'x';`,
          { run_id: runId }
        )
      ).resolves.toBeDefined()
    })

    it('UPDATE while sealed = refused', async () => {
      const runId = `t-upd-sealed-${randomUUID()}`
      await createOpenRun(conn, runId)
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at) VALUES (:'run_id', 'x', now(), '1', now());`,
        { run_id: runId }
      )
      await sealRun(conn, runId)
      await expect(
        runPsql(
          conn,
          `UPDATE smi5879_snapshot_pre SET row_xmin = '2' WHERE run_id = :'run_id' AND id = 'x';`,
          { run_id: runId }
        )
      ).rejects.toThrow(/not "open" -- UPDATE/)
    })

    it('UPDATE while abandoned = refused', async () => {
      const runId = `t-upd-abandoned-${randomUUID()}`
      await createOpenRun(conn, runId)
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at) VALUES (:'run_id', 'x', now(), '1', now());`,
        { run_id: runId }
      )
      await forceAbandon(conn, runId)
      await expect(
        runPsql(
          conn,
          `UPDATE smi5879_snapshot_pre SET row_xmin = '2' WHERE run_id = :'run_id' AND id = 'x';`,
          { run_id: runId }
        )
      ).rejects.toThrow(/not "open" -- UPDATE/)
    })

    it('UPDATE of run_id itself = refused, even while open', async () => {
      // The trigger looks up the DESTINATION run_id's status first (v_run_id :=
      // NEW.run_id for an UPDATE, not OLD.run_id) — so which of the two refusal
      // messages fires depends on the DESTINATION's status, independent of the
      // source row's own generation. `smi5879_run_one_open` allows only one open
      // generation database-wide, so each destination is created and sealed
      // before the next is opened.
      const runId = `t-upd-runid-${randomUUID()}`
      const sealedDest = `t-upd-runid-sealed-dest-${randomUUID()}`
      const openDest = `t-upd-runid-open-dest-${randomUUID()}`

      await createOpenRun(conn, runId)
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at) VALUES (:'run_id', 'x', now(), '1', now());`,
        { run_id: runId }
      )
      await sealRun(conn, runId)

      await createOpenRun(conn, sealedDest)
      await sealRun(conn, sealedDest)
      await expect(
        runPsql(
          conn,
          `UPDATE smi5879_snapshot_pre SET run_id = :'dest' WHERE run_id = :'run_id' AND id = 'x';`,
          { run_id: runId, dest: sealedDest }
        )
      ).rejects.toThrow(/not "open" -- UPDATE/)

      await createOpenRun(conn, openDest)
      await expect(
        runPsql(
          conn,
          `UPDATE smi5879_snapshot_pre SET run_id = :'dest' WHERE run_id = :'run_id' AND id = 'x';`,
          { run_id: runId, dest: openDest }
        )
      ).rejects.toThrow(/run_id is immutable/)
    })

    it('DELETE while open = refused', async () => {
      const runId = `t-del-open-${randomUUID()}`
      await createOpenRun(conn, runId)
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at) VALUES (:'run_id', 'x', now(), '1', now());`,
        { run_id: runId }
      )
      await expect(
        runPsql(conn, `DELETE FROM smi5879_snapshot_pre WHERE run_id = :'run_id' AND id = 'x';`, {
          run_id: runId,
        })
      ).rejects.toThrow(/not "abandoned" -- DELETE/)
    })

    it('DELETE while sealed = refused', async () => {
      const runId = `t-del-sealed-${randomUUID()}`
      await createOpenRun(conn, runId)
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at) VALUES (:'run_id', 'x', now(), '1', now());`,
        { run_id: runId }
      )
      await sealRun(conn, runId)
      await expect(
        runPsql(conn, `DELETE FROM smi5879_snapshot_pre WHERE run_id = :'run_id' AND id = 'x';`, {
          run_id: runId,
        })
      ).rejects.toThrow(/not "abandoned" -- DELETE/)
    })

    it('DELETE while abandoned but inside the 24h grace period = refused', async () => {
      const runId = `t-del-grace-inside-${randomUUID()}`
      await createOpenRun(conn, runId)
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at) VALUES (:'run_id', 'x', now(), '1', now());`,
        { run_id: runId }
      )
      await forceAbandon(conn, runId) // abandoned_at = now()
      await expect(
        runPsql(conn, `DELETE FROM smi5879_snapshot_pre WHERE run_id = :'run_id' AND id = 'x';`, {
          run_id: runId,
        })
      ).rejects.toThrow(/inside the 24 h GC grace period/)
    })

    it('DELETE while abandoned and past the 24h grace period = permitted', async () => {
      const runId = `t-del-grace-past-${randomUUID()}`
      await createOpenRun(conn, runId)
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at) VALUES (:'run_id', 'x', now(), '1', now());`,
        { run_id: runId }
      )
      await forceAbandon(conn, runId)
      await backdateAbandonedAt(conn, runId, 25) // 25h ago — past the 24h grace period
      await expect(
        runPsql(conn, `DELETE FROM smi5879_snapshot_pre WHERE run_id = :'run_id' AND id = 'x';`, {
          run_id: runId,
        })
      ).resolves.toBeDefined()
      const remaining = await queryScalar(
        conn,
        `SELECT count(*)::text FROM smi5879_snapshot_pre WHERE run_id = :'run_id'`,
        { run_id: runId }
      )
      expect(remaining).toBe('0')
    })

    it('TRUNCATE is refused unconditionally, regardless of status', async () => {
      const runId = `t-truncate-${randomUUID()}`
      await createOpenRun(conn, runId)
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at) VALUES (:'run_id', 'x', now(), '1', now());`,
        { run_id: runId }
      )
      await expect(runPsql(conn, `TRUNCATE smi5879_snapshot_pre;`)).rejects.toThrow(
        /TRUNCATE is refused/
      )
      await sealRun(conn, runId)
      await expect(runPsql(conn, `TRUNCATE smi5879_snapshot_pre;`)).rejects.toThrow(
        /TRUNCATE is refused/
      )
    })

    it('the same guard is wired on smi5879_repo_branch too (INSERT while sealed refused)', async () => {
      const runId = `t-branch-guard-${randomUUID()}`
      await createOpenRun(conn, runId, 'decision')
      await sealRun(conn, runId)
      await expect(
        runPsql(
          conn,
          `INSERT INTO smi5879_repo_branch (run_id, owner, repo, resolution) VALUES (:'run_id', 'acme', 'x', 'not-found');`,
          { run_id: runId }
        )
      ).rejects.toThrow(/not "open" -- INSERT/)
    })
  }
)

/** Spawn a persistent interactive psql session so a test can hold a transaction open across steps. */
function openInteractiveSession(conn: PgConnParams): {
  send: (sql: string) => void
  waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<string>
  close: () => void
} {
  // `stdbuf -oL -eL`: psql's stdout is fully-buffered (not line-buffered) once it
  // detects stdout is a pipe rather than a tty, so this test's incremental
  // `waitFor` would otherwise never see output until the process exits (which
  // never happens before the timeout, since the whole point is to hold the
  // session open mid-transaction). Forcing line buffering is what makes the
  // synchronization below deterministic rather than relying on a blind sleep.
  const child = spawn(
    'stdbuf',
    // Deliberately NOT `-q` here (unlike smi5879-census.pg.ts's runPsql/queryRows):
    // `-q` suppresses command-completion tags ("INSERT 0 1", "BEGIN", "COMMIT",
    // "UPDATE 1") entirely — confirmed live — and this helper's whole
    // synchronization mechanism is `waitFor` matching on exactly those tags.
    ['-oL', '-eL', 'psql', '--no-psqlrc', '-X', '-v', 'ON_ERROR_STOP=1'],
    {
      env: {
        ...process.env,
        PGHOST: conn.host,
        PGPORT: String(conn.port),
        PGUSER: conn.user,
        PGPASSWORD: conn.password,
        PGDATABASE: conn.database,
        ...(conn.searchPath ? { PGOPTIONS: `-c search_path=${conn.searchPath}` } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  )
  let buffer = ''
  child.stdout.on('data', (d: Buffer) => (buffer += d.toString('utf8')))
  child.stderr.on('data', (d: Buffer) => (buffer += d.toString('utf8')))

  return {
    send(sql: string) {
      child.stdin.write(sql + '\n')
    },
    async waitFor(pattern: RegExp, timeoutMs = 5000): Promise<string> {
      const start = Date.now()
      while (!pattern.test(buffer)) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(`SMI-5879 test: timed out waiting for ${pattern} in:\n${buffer}`)
        }
        await new Promise((r) => setTimeout(r, 25))
      }
      return buffer
    },
    close() {
      child.stdin.end()
      child.kill()
    },
  }
}

describe.skipIf(prePushNoLiveTestPg)(
  'insert-vs-seal race fix (design doc 8.3.5.2.3 — SELECT ... FOR UPDATE)',
  () => {
    it('a writer that acquires the lock BEFORE the sealer is counted by the seal', async () => {
      const runId = `t-race-counted-${randomUUID()}`
      await createOpenRun(conn, runId)

      const writer = openInteractiveSession(conn)
      try {
        // Writer opens a transaction and holds the registry-row lock, but does not
        // commit yet — this is the trigger's own FOR UPDATE, taken implicitly by
        // the INSERT below once sent (a plain BEGIN alone acquires nothing).
        writer.send('BEGIN;')
        writer.send(
          `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at) VALUES ('${runId}', 'race-row', now(), '1', now());`
        )
        await writer.waitFor(/INSERT 0 1/)

        // Sealer's own FOR UPDATE now blocks behind the writer's open transaction.
        const sealPromise = sealRun(conn, runId)
        // Give the sealer a moment to actually issue its SELECT ... FOR UPDATE and block.
        await new Promise((r) => setTimeout(r, 300))

        // Writer commits — sealer's FOR UPDATE unblocks, re-reads status='open' (still),
        // proceeds to count + digest AFTER this commit, so the row IS counted.
        writer.send('COMMIT;')
        await writer.waitFor(/COMMIT/)

        await sealPromise
      } finally {
        writer.close()
      }

      const rowCount = await queryScalar(
        conn,
        `SELECT row_count::text FROM smi5879_run WHERE run_id = :'run_id'`,
        { run_id: runId }
      )
      expect(rowCount).toBe('1')
    }, 15_000)

    it('a writer that arrives AFTER the seal is refused entirely — never lands post-seal', async () => {
      const runId = `t-race-refused-${randomUUID()}`
      await createOpenRun(conn, runId)

      const sealer = openInteractiveSession(conn)
      try {
        sealer.send('BEGIN;')
        sealer.send(
          `SELECT run_id FROM smi5879_run WHERE run_id = '${runId}' AND status = 'open' FOR UPDATE;`
        )
        await sealer.waitFor(new RegExp(runId))

        // Writer attempts to insert while the sealer holds the lock — it blocks.
        // The `.catch(() => {})` on a SEPARATE reference is deliberate: this promise
        // rejects while nothing has awaited it yet (the sealer is still mid-flight
        // below), which Node's unhandledRejection tracking flags even though
        // `expect(writerPromise).rejects...` attaches its own handler moments
        // later — attaching a harmless handler immediately silences that noise
        // without affecting the real assertion on the same promise.
        const writerPromise = runPsql(
          conn,
          `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at) VALUES (:'run_id', 'late-row', now(), '1', now());`,
          { run_id: runId }
        )
        writerPromise.catch(() => {})
        await new Promise((r) => setTimeout(r, 300)) // let the writer actually queue behind the lock

        // Sealer completes the seal and commits WITHOUT ever seeing the writer's row.
        sealer.send(
          `UPDATE smi5879_run r SET status = 'sealed', snapshot_sealed_at = now(), row_count = c.n,
                population_digest = smi5879_population_digest('${runId}'), branch_digest = smi5879_branch_digest('${runId}')
           FROM (SELECT count(*) AS n FROM smi5879_snapshot_pre WHERE run_id = '${runId}') c
          WHERE r.run_id = '${runId}' AND r.status = 'open';`
        )
        await sealer.waitFor(/UPDATE 1/)
        sealer.send('COMMIT;')
        await sealer.waitFor(/COMMIT/)

        // The blocked writer now unblocks, re-checks status, sees 'sealed', and refuses.
        await expect(writerPromise).rejects.toThrow(/not "open" -- INSERT/)
      } finally {
        sealer.close()
      }

      const rowCount = await queryScalar(
        conn,
        `SELECT row_count::text FROM smi5879_run WHERE run_id = :'run_id'`,
        { run_id: runId }
      )
      expect(rowCount).toBe('0')
    }, 15_000)
  }
)

describe.skipIf(prePushNoLiveTestPg)(
  'digest determinism under a changed session TimeZone/DateStyle (design doc 8.3.5.2.4)',
  () => {
    it('population_digest is identical regardless of the querying session TimeZone/DateStyle', async () => {
      const runId = `t-digest-tz-${randomUUID()}`
      await createOpenRun(conn, runId)
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at, security_score, quarantine_reason)
       VALUES (:'run_id', 'x', '2026-03-01T12:00:00Z', '1', '2026-03-01T12:00:00Z', 7, 'has a comma, and a ''quote''');`,
        { run_id: runId }
      )
      await sealRun(conn, runId)

      const baseline = await queryScalar(
        conn,
        `SELECT population_digest FROM smi5879_run WHERE run_id = :'run_id'`,
        { run_id: runId }
      )

      const underAltSession = await queryScalar(
        conn,
        `SET TimeZone = 'America/Los_Angeles'; SET DateStyle = 'German, DMY';
       SELECT smi5879_population_digest(:'run_id');`,
        { run_id: runId }
      )

      expect(underAltSession).toBe(baseline)
    })
  }
)
