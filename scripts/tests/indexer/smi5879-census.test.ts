/**
 * SMI-5879 Wave 3 item 1: I-1..I-5 partition invariants, CLI arg parsing, and
 * the `purpose` CHECK constraint — against a REAL local Postgres. I-6
 * (SMI-6015 — branch-resolution quality) added below.
 *
 * See smi5879-census.test-helpers.ts's header for the live-Postgres harness
 * this suite requires (env vars, standup command, and the CI-wiring gap this
 * suite is currently NOT covered by).
 *
 * Sibling files (same harness, split to keep each file readable):
 *   smi5879-census.trigger.test.ts   — state-transition matrix, insert-vs-seal
 *                                       race, digest determinism.
 *   smi5879-census.claim-gc.test.ts  — claim/heartbeat/release/GC + parameter
 *                                       validation guards.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  runPsql,
  queryRows,
  queryScalar,
  type PgConnParams,
} from '../../indexer/smi5879-census.pg.ts'
import {
  checkI1Totality,
  checkI2Disjointness,
  checkI3Completeness,
  checkI4SingleInstant,
  checkI5BranchCoverage,
  checkI6BranchResolutionQuality,
  runInvariantChecks,
} from '../../indexer/smi5879-census.invariants.ts'
import { parseArgs, runCensus } from '../../indexer/smi5879-census.ts'
import {
  requireTestConn,
  resetSchema,
  insertSkillFixture,
  createOpenRun,
  sealRun,
  sealAnyOpenGeneration,
  prePushNoLiveTestPg,
} from './smi5879-census.test-helpers.ts'

let conn: PgConnParams

beforeAll(async () => {
  if (prePushNoLiveTestPg) return
  // Own schema (not `resetSchema`'s conflict-prone shared `public`) — this
  // file's `beforeAll` runs concurrently with the sibling `.trigger.test.ts`
  // / `.claim-gc.test.ts` files' own `beforeAll` under vitest's default
  // file-level parallelism. See `resetSchema`'s doc comment.
  conn = await resetSchema(requireTestConn(), 'smi5879_test_census')
}, 60_000)

afterEach(async () => {
  if (prePushNoLiveTestPg) return
  await sealAnyOpenGeneration(conn)
})

/** Original (correct) view definition, for restoring after a deliberately-broken variant. */
const ORIGINAL_VIEW_SQL = `
CREATE OR REPLACE VIEW v_smi5879_census_cohort AS
SELECT
  s.run_id, s.id, s.security_score, s.last_scanned_at, s.quarantined,
  CASE
    WHEN s.quarantined IS TRUE THEN 'C4'
    WHEN s.security_score IS NULL THEN 'C2'
    WHEN s.last_scanned_at IS NULL OR s.last_scanned_at < r.ruleset_epoch THEN 'C3'
    WHEN s.security_score >= 8 THEN 'C1'
    ELSE 'E'
  END AS cohort
FROM smi5879_snapshot_pre s JOIN smi5879_run r ON r.run_id = s.run_id;
`

/** Run `fn` against a temporarily-broken view, then always restore the real one. */
async function withBrokenView(brokenSql: string, fn: () => Promise<void>): Promise<void> {
  await runPsql(conn, brokenSql)
  try {
    await fn()
  } finally {
    await runPsql(conn, ORIGINAL_VIEW_SQL)
  }
}

describe.skipIf(prePushNoLiveTestPg)(
  'I-1..I-5 partition invariants (design doc 8.3.1.4 / 8.3.5.2.6)',
  () => {
    it('I-1..I-4 all pass against a healthy generation', async () => {
      const runId = `t-i1i4-healthy-${randomUUID()}`
      await createOpenRun(conn, runId, 'window')
      const id1 = await insertSkillFixture(conn)
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at, quarantined, security_score)
       VALUES (:'run_id', :'id', now(), '100', now(), false, 9);`,
        { run_id: runId, id: id1 }
      )
      await sealRun(conn, runId)

      const results = await runInvariantChecks(conn, runId, false)
      expect(results.map((r) => r.id)).toEqual(['I-1', 'I-2', 'I-3', 'I-4'])
      for (const r of results) expect(r.passed, `${r.id}: ${r.detail}`).toBe(true)
    })

    it('I-1 totality fails on a row with a NULL cohort (view ELSE branch removed)', async () => {
      const runId = `t-i1-null-${randomUUID()}`
      await createOpenRun(conn, runId, 'window')
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at, quarantined, security_score, last_scanned_at)
       VALUES (:'run_id', 'skill-mid', now(), '100', now(), false, 5, now());`,
        { run_id: runId }
      )
      await sealRun(conn, runId)

      const brokenSql = `
      CREATE OR REPLACE VIEW v_smi5879_census_cohort AS
      SELECT s.run_id, s.id, s.security_score, s.last_scanned_at, s.quarantined,
        CASE
          WHEN s.quarantined IS TRUE THEN 'C4'
          WHEN s.security_score IS NULL THEN 'C2'
          WHEN s.last_scanned_at IS NULL OR s.last_scanned_at < r.ruleset_epoch THEN 'C3'
          WHEN s.security_score >= 8 THEN 'C1'
        END AS cohort
      FROM smi5879_snapshot_pre s JOIN smi5879_run r ON r.run_id = s.run_id;
    `
      await withBrokenView(brokenSql, async () => {
        const result = await checkI1Totality(conn, runId)
        expect(result.passed).toBe(false)
        expect(result.detail).toContain('NULL cohort')
      })
    })

    it('I-2 disjointness fails on a row appearing in two cohorts (UNION-shaped view)', async () => {
      const runId = `t-i2-dup-${randomUUID()}`
      await createOpenRun(conn, runId, 'window')
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at, quarantined, security_score)
       VALUES (:'run_id', 'skill-dup', now(), '100', now(), true, 9);`,
        { run_id: runId }
      )
      await sealRun(conn, runId)

      // Deliberately overlapping predicates: a quarantined, high-score row matches BOTH arms.
      const brokenSql = `
      CREATE OR REPLACE VIEW v_smi5879_census_cohort AS
      SELECT s.run_id, s.id, s.security_score, s.last_scanned_at, s.quarantined, 'C4' AS cohort
      FROM smi5879_snapshot_pre s WHERE s.quarantined IS TRUE
      UNION ALL
      SELECT s.run_id, s.id, s.security_score, s.last_scanned_at, s.quarantined, 'C1' AS cohort
      FROM smi5879_snapshot_pre s WHERE s.security_score >= 8;
    `
      await withBrokenView(brokenSql, async () => {
        const result = await checkI2Disjointness(conn, runId)
        expect(result.passed).toBe(false)
        expect(result.detail).toContain('more than one cohort')
      })
    })

    it('I-3 completeness fails on a row-count mismatch (view filters out a row)', async () => {
      const runId = `t-i3-mismatch-${randomUUID()}`
      await createOpenRun(conn, runId, 'window')
      const id1 = await insertSkillFixture(conn)
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at, quarantined, security_score)
       VALUES (:'run_id', :'id', now(), '100', now(), false, NULL);`,
        { run_id: runId, id: id1 }
      )
      await sealRun(conn, runId)

      // View silently drops unscored rows — the exact shape I-3 exists to catch.
      const brokenSql = `
      CREATE OR REPLACE VIEW v_smi5879_census_cohort AS
      SELECT s.run_id, s.id, s.security_score, s.last_scanned_at, s.quarantined, 'C4' AS cohort
      FROM smi5879_snapshot_pre s JOIN smi5879_run r ON r.run_id = s.run_id
      WHERE s.security_score IS NOT NULL;
    `
      await withBrokenView(brokenSql, async () => {
        const result = await checkI3Completeness(conn, runId)
        expect(result.passed).toBe(false)
        expect(result.detail).toContain('different population')
      })
    })

    it('I-4 single-instant fails on a multi-`snapshot_taken_at` population', async () => {
      const runId = `t-i4-multi-instant-${randomUUID()}`
      await createOpenRun(conn, runId, 'window')
      const id1 = await insertSkillFixture(conn)
      const id2 = await insertSkillFixture(conn)
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at)
       VALUES (:'run_id', :'id1', now(), '100', '2026-01-01T00:00:00Z'),
              (:'run_id', :'id2', now(), '101', '2026-01-02T00:00:00Z');`,
        { run_id: runId, id1, id2 }
      )
      await sealRun(conn, runId)

      const result = await checkI4SingleInstant(conn, runId)
      expect(result.passed).toBe(false)
      expect(result.detail).toContain('lost its REPEATABLE READ framing')
    })

    it('I-5 branch coverage fails on a distinct repo with no smi5879_repo_branch row', async () => {
      const runId = `t-i5-missing-branch-${randomUUID()}`
      await createOpenRun(conn, runId, 'decision')
      const id1 = await insertSkillFixture(conn, {
        repo_url: 'https://github.com/acme/uncovered-repo',
      })
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at, repo_url)
       VALUES (:'run_id', :'id', now(), '100', now(), 'https://github.com/acme/uncovered-repo');`,
        { run_id: runId, id: id1 }
      )
      await sealRun(conn, runId)
      // Deliberately: no smi5879_repo_branch row written for acme/uncovered-repo.

      const result = await checkI5BranchCoverage(conn, runId)
      expect(result.passed).toBe(false)
      expect(result.detail).toContain('acme/uncovered-repo')
      expect(result.detail).toContain('fall back')
    })

    it('I-5 passes when the distinct repo is covered', async () => {
      const runId = `t-i5-covered-${randomUUID()}`
      await createOpenRun(conn, runId, 'decision')
      const id1 = await insertSkillFixture(conn, {
        repo_url: 'https://github.com/acme/covered-repo',
      })
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at, repo_url)
       VALUES (:'run_id', :'id', now(), '100', now(), 'https://github.com/acme/covered-repo');
       INSERT INTO smi5879_repo_branch (run_id, owner, repo, default_branch, resolution, http_status)
       VALUES (:'run_id', 'acme', 'covered-repo', 'main', 'resolved', 200);`,
        { run_id: runId, id: id1 }
      )
      await sealRun(conn, runId)

      const result = await checkI5BranchCoverage(conn, runId)
      expect(result.passed).toBe(true)
    })

    it('I-6 branch-resolution quality fails on a transient smi5879_repo_branch row (SMI-6015)', async () => {
      const runId = `t-i6-transient-${randomUUID()}`
      await createOpenRun(conn, runId, 'decision')
      const id1 = await insertSkillFixture(conn, {
        repo_url: 'https://github.com/acme/flaky-repo',
      })
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at, repo_url)
       VALUES (:'run_id', :'id', now(), '100', now(), 'https://github.com/acme/flaky-repo');
       INSERT INTO smi5879_repo_branch (run_id, owner, repo, default_branch, resolution, http_status)
       VALUES (:'run_id', 'acme', 'flaky-repo', NULL, 'transient', 503);`,
        { run_id: runId, id: id1 }
      )
      await sealRun(conn, runId)

      const result = await checkI6BranchResolutionQuality(conn, runId)
      expect(result.passed).toBe(false)
      expect(result.detail).toContain('1 smi5879_repo_branch row')
      expect(result.detail).toContain("resolution='transient'")
    })

    it('I-6 passes when zero rows are transient (mix of resolved/not-found is fine)', async () => {
      const runId = `t-i6-clean-${randomUUID()}`
      await createOpenRun(conn, runId, 'decision')
      const id1 = await insertSkillFixture(conn, {
        repo_url: 'https://github.com/acme/covered-repo-2',
      })
      const id2 = await insertSkillFixture(conn, {
        repo_url: 'https://github.com/acme/gone-repo',
      })
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at, repo_url)
       VALUES
         (:'run_id', :'id1', now(), '100', now(), 'https://github.com/acme/covered-repo-2'),
         (:'run_id', :'id2', now(), '101', now(), 'https://github.com/acme/gone-repo');
       INSERT INTO smi5879_repo_branch (run_id, owner, repo, default_branch, resolution, http_status)
       VALUES
         (:'run_id', 'acme', 'covered-repo-2', 'main', 'resolved', 200),
         (:'run_id', 'acme', 'gone-repo', NULL, 'not-found', 404);`,
        { run_id: runId, id1, id2 }
      )
      await sealRun(conn, runId)

      const result = await checkI6BranchResolutionQuality(conn, runId)
      expect(result.passed).toBe(true)
      expect(result.detail).toContain('zero transient')
    })

    it('runInvariantChecks includes I-6 (after I-5) for a fetching generation and fails closed on a transient row', async () => {
      const runId = `t-i6-runInvariantChecks-${randomUUID()}`
      await createOpenRun(conn, runId, 'decision')
      const id1 = await insertSkillFixture(conn, {
        repo_url: 'https://github.com/acme/still-flaky',
      })
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at, repo_url)
       VALUES (:'run_id', :'id', now(), '100', now(), 'https://github.com/acme/still-flaky');
       INSERT INTO smi5879_repo_branch (run_id, owner, repo, default_branch, resolution, http_status)
       VALUES (:'run_id', 'acme', 'still-flaky', NULL, 'transient', 500);`,
        { run_id: runId, id: id1 }
      )
      await sealRun(conn, runId)

      const results = await runInvariantChecks(conn, runId, true)
      expect(results.map((r) => r.id)).toEqual(['I-1', 'I-2', 'I-3', 'I-4', 'I-5', 'I-6'])
      const i6 = results.find((r) => r.id === 'I-6')
      expect(i6?.passed).toBe(false)
      // I-6 failing must not mask an otherwise-healthy I-1..I-5 (I-5 passes here — the
      // repo DOES have a smi5879_repo_branch row, just a transient-outcome one).
      expect(results.find((r) => r.id === 'I-5')?.passed).toBe(true)
    })

    it('a window generation skips I-5 AND I-6 entirely (no GitHub I/O by design)', async () => {
      const runId = `t-window-no-i5-${randomUUID()}`
      await createOpenRun(conn, runId, 'window')
      const id1 = await insertSkillFixture(conn, {
        repo_url: 'https://github.com/acme/never-resolved',
      })
      await runPsql(
        conn,
        `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at, repo_url)
       VALUES (:'run_id', :'id', now(), '100', now(), 'https://github.com/acme/never-resolved');`,
        { run_id: runId, id: id1 }
      )
      await sealRun(conn, runId)

      const results = await runInvariantChecks(conn, runId, false)
      expect(results.find((r) => r.id === 'I-5')).toBeUndefined()
      expect(results.find((r) => r.id === 'I-6')).toBeUndefined()
      expect(results.every((r) => r.passed)).toBe(true)
    })
  }
)

describe.skipIf(prePushNoLiveTestPg)('`purpose` CHECK constraint (design doc 8.3.5.2.1)', () => {
  it('accepts rehearsal | decision | window', async () => {
    for (const purpose of ['rehearsal', 'decision', 'window'] as const) {
      const runId = `t-purpose-ok-${purpose}-${randomUUID()}`
      await createOpenRun(conn, runId, purpose)
      await sealRun(conn, runId)
      const stored = await queryScalar(
        conn,
        `SELECT purpose FROM smi5879_run WHERE run_id = :'run_id'`,
        {
          run_id: runId,
        }
      )
      expect(stored).toBe(purpose)
    }
  })

  it('rejects any other value', async () => {
    const runId = `t-purpose-bad-${randomUUID()}`
    await expect(
      runPsql(
        conn,
        `INSERT INTO smi5879_run (run_id, purpose, ruleset_epoch) VALUES (:'run_id', 'bogus', '2026-07-29T23:41:09Z');`,
        { run_id: runId }
      )
    ).rejects.toThrow(/check constraint|smi5879_run_purpose_check/i)
  })

  it('a `rehearsal` generation is distinguishable from `decision`/`window` by a binding check (item 4 precursor)', async () => {
    // item 4 (gate-check.ts) isn't built by this item — this proves the DATA MODEL
    // supports the distinction it will need: purpose = 'decision' evaluates false
    // for a rehearsal row, so a future gate binding on purpose cannot be satisfied by one.
    const runId = `t-purpose-rehearsal-cannot-satisfy-${randomUUID()}`
    await createOpenRun(conn, runId, 'rehearsal')
    await sealRun(conn, runId)
    const decisionCheck = await queryScalar(
      conn,
      `SELECT (purpose = 'decision') FROM smi5879_run WHERE run_id = :'run_id'`,
      { run_id: runId }
    )
    const windowCheck = await queryScalar(
      conn,
      `SELECT (purpose = 'window') FROM smi5879_run WHERE run_id = :'run_id'`,
      { run_id: runId }
    )
    expect(decisionCheck).toBe('f')
    expect(windowCheck).toBe('f')
  })
})

describe.skipIf(prePushNoLiveTestPg)('CLI arg parsing (parseArgs)', () => {
  it('parses valid --purpose and --ruleset-epoch, defaulting --dry-run and a report path', () => {
    const args = parseArgs(['--purpose=rehearsal', '--ruleset-epoch=2026-07-29T23:41:09Z'])
    expect(args.purpose).toBe('rehearsal')
    expect(args.rulesetEpoch).toBe('2026-07-29T23:41:09Z')
    expect(args.apply).toBe(false)
    expect(args.reportPath).toMatch(/smi5879-census-report-\d+\.json/)
  })

  it('honors --apply and --report-path', () => {
    const args = parseArgs([
      '--purpose=decision',
      '--ruleset-epoch=2026-07-29T23:41:09Z',
      '--apply',
      '--report-path=/tmp/custom-report.json',
    ])
    expect(args.apply).toBe(true)
    expect(args.reportPath).toBe('/tmp/custom-report.json')
  })

  it('rejects a missing or invalid --purpose', () => {
    expect(() => parseArgs(['--ruleset-epoch=2026-07-29T23:41:09Z'])).toThrow(/--purpose/)
    expect(() => parseArgs(['--purpose=bogus', '--ruleset-epoch=2026-07-29T23:41:09Z'])).toThrow(
      /--purpose/
    )
  })

  it('rejects a missing or unparseable --ruleset-epoch', () => {
    expect(() => parseArgs(['--purpose=rehearsal'])).toThrow(/--ruleset-epoch/)
    expect(() => parseArgs(['--purpose=rehearsal', '--ruleset-epoch=not-a-date'])).toThrow(
      /--ruleset-epoch/
    )
  })
})

describe.skipIf(prePushNoLiveTestPg)(
  'end-to-end runCensus() lifecycle (window purpose — no GitHub I/O)',
  () => {
    it('creates, populates, seals a generation and reports correct cohort counts', async () => {
      await insertSkillFixture(conn, {
        security_score: 9,
        last_scanned_at: new Date().toISOString(),
      }) // C1
      await insertSkillFixture(conn, { security_score: null }) // C2
      await insertSkillFixture(conn, { quarantined: true, security_score: 5 }) // C4

      const report = await runCensus(conn, {
        purpose: 'window',
        rulesetEpoch: '2026-07-29T23:41:09Z',
        apply: true,
        reportPath: 'unused-in-test.json',
        resume: false,
      })

      expect(report.status).toBe('sealed')
      expect(report.resumed).toBe(false)
      expect(report.row_count).toBeGreaterThanOrEqual(3)
      expect(report.population_digest).toMatch(/^smi5879-v1:sha256:[0-9a-f]{64}$/)
      expect(report.branch_digest).toBe(
        'smi5879-v1:sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      )
      expect(report.cohorts.C1).toBeGreaterThanOrEqual(1)
      expect(report.cohorts.C2).toBeGreaterThanOrEqual(1)
      expect(report.cohorts.C4).toBeGreaterThanOrEqual(1)
      expect(report.excluded_cohort_e_count).toBe(report.cohorts.E)
      expect(report.ruleset_epoch_provenance).toContain('scanner_ruleset_version')
      expect(report.branch_resolution).toBeNull()
      expect(report.invariants.every((i) => i.passed)).toBe(true)

      const rows = await queryRows(
        conn,
        `SELECT status FROM smi5879_run WHERE run_id = :'run_id'`,
        {
          run_id: report.run_id,
        }
      )
      expect(rows[0][0]).toBe('sealed')
    })
  }
)
