/**
 * SMI-5879 checkpoint/resume follow-up — `--resume` end-to-end coverage
 * against a REAL local Postgres, plus a focused `distinctRepos()` exclusion
 * unit test. See smi5879-census.test-helpers.ts's header for the live-
 * Postgres harness this requires (env vars, standup command, and the
 * CI-coverage gap this suite shares with its siblings).
 *
 * Sibling files (same harness):
 *   smi5879-census.test.ts               — I-1..I-5, CLI arg parsing, the
 *                                           non-resume happy path.
 *   smi5879-census.trigger.test.ts       — state-transition matrix.
 *   smi5879-census.claim-gc.test.ts      — claim/heartbeat/release/GC.
 *   smi5879-census.branches.integration.test.ts — fetching-generation
 *                                           end-to-end, GitHub mocked.
 *
 * Covers exactly the four cases the task's required process calls out:
 *   1. Cold start — `--resume` with no open row to resume: refuses loudly.
 *   2. Identity mismatch — an open row exists but purpose/ruleset-epoch
 *      don't match this invocation: refuses loudly, names both.
 *   3. A run that's actually still alive (fresh heartbeat): refuses to
 *      steal the claim, never silently proceeds.
 *   4. Clean resume — population already loaded (skip populate()) and a
 *      partial smi5879_repo_branch (resolve only the remainder), including
 *      the distinct_repos report-accuracy fix.
 * Plus a fresh-start double-launch UX check and a focused distinctRepos()
 * exclusion unit test.
 *
 * ROUND-2 ADVERSARIAL REVIEW COVERAGE (SMI-5879 checkpoint/resume follow-up,
 * per CLAUDE.md's "a fix for a race condition needs its own confirmation
 * review round" rule): `describeResumeClaimRefusal` (an abandoned/sealed-
 * elsewhere generation must get DIFFERENT advice than a genuinely live
 * claim — the two need opposite operator actions), and resume's interaction
 * with the pre-existing `sweepTransientRepos` (a prior invocation's
 * transient row must be excluded from the RESUMED main pass but still
 * picked up by the sweep).
 *
 * ROUND-3 (CROSS-MODEL REVIEW) COVERAGE — token fencing (High) and its
 * Medium-severity corollary (the seal-attribution ambiguity): direct
 * fencing tests for `populate()`/`seal()` (`smi5879-census.ts`) and
 * `writeOutcomesBatch()`/`updateOutcomesBatch()`
 * (`smi5879-census.branches.writes.ts`) — each proven to (a) succeed
 * normally under the CURRENT token and (b) reject loudly, writing/changing
 * NOTHING, under a STALE one (simulating a claim stolen mid-write). Replaces
 * the round-2 `assertGenerationSealed` tests — that function itself was
 * replaced by `seal()`'s own atomic, self-verifying `RETURNING` check.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { runPsql, queryRows, type PgConnParams } from '../../indexer/smi5879-census.pg.ts'
import { runCensus } from '../../indexer/smi5879-census.ts'
import { populate, seal } from '../../indexer/smi5879-census.lifecycle.ts'
import { distinctRepos } from '../../indexer/smi5879-census.branches.ts'
import {
  writeOutcomesBatch,
  updateOutcomesBatch,
  ClaimFencedWriteError,
} from '../../indexer/smi5879-census.branches.writes.ts'
import { describeResumeClaimRefusal } from '../../indexer/smi5879-census.resume.ts'
import {
  requireTestConn,
  resetSchema,
  insertSkillFixture,
  createOpenRun,
  sealRun,
  sealAnyOpenGeneration,
  backdateHeartbeat,
  prePushNoLiveTestPg,
} from './smi5879-census.test-helpers.ts'
import type { ResolutionOutcome } from '../../indexer/smi5879-census.types.ts'

let conn: PgConnParams
let originalFetch: typeof global.fetch

beforeAll(async () => {
  if (prePushNoLiveTestPg) return
  // Own schema (not resetSchema's conflict-prone shared `public`) — this
  // file's beforeAll runs concurrently with every sibling file's own
  // beforeAll under vitest's default file-level parallelism.
  conn = await resetSchema(requireTestConn(), 'smi5879_test_checkpoint_resume')
}, 60_000)

beforeEach(async () => {
  if (prePushNoLiveTestPg) return
  // Every resume test exercises the real population path (some directly via
  // `skills`, some to prove populate() is/isn't re-run) — clear between
  // tests so later tests don't silently inherit earlier fixture rows.
  await runPsql(conn, 'DELETE FROM skills;')
})

afterEach(async () => {
  global.fetch = originalFetch
  if (prePushNoLiveTestPg) return
  await sealAnyOpenGeneration(conn)
})

function githubRepoUrl(owner: string, repo: string): string {
  return `https://api.github.com/repos/${owner}/${repo}`
}

/** Install a URL-keyed `global.fetch` mock — an unregistered URL throws, so an
 *  already-resolved repo getting re-fetched fails the test loudly. */
function installGithubFetchMock(): (owner: string, repo: string, responses: Response[]) => void {
  originalFetch = global.fetch
  const handlers = new Map<string, Response[]>()
  const mock = vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : String(input)
    const queue = handlers.get(url)
    if (!queue || queue.length === 0) {
      throw new Error(
        `SMI-5879 checkpoint-resume test: unexpected fetch to unregistered URL: ${url}`
      )
    }
    return queue.length > 1 ? (queue.shift() as Response) : queue[0]
  })
  global.fetch = mock as unknown as typeof global.fetch
  return (owner, repo, responses) => handlers.set(githubRepoUrl(owner, repo), responses)
}

function branchResponse(defaultBranch: string): Response {
  return new Response(JSON.stringify({ default_branch: defaultBranch }), { status: 200 })
}

/**
 * Directly insert smi5879_snapshot_pre row(s) matching `skills` fixture
 * id(s) — bypasses the real populate(). ALL rows go in ONE INSERT statement
 * (one psql invocation, one transaction) so `now()` — and therefore
 * `snapshot_taken_at` — is IDENTICAL across every row, same as the real
 * populate()'s single-transaction REPEATABLE READ load. Two separate
 * `runPsql` calls would each be a separate transaction with a distinct
 * `now()`, tripping I-4 (single-instant snapshot) on a multi-row population.
 */
async function insertPopulationRows(
  conn: PgConnParams,
  runId: string,
  rows: readonly { id: string; repoUrl?: string }[]
): Promise<void> {
  const values = rows
    .map((_, i) => `(:'run_id', :'id${i}', now(), '100', now(), NULLIF(:'repo_url${i}', ''))`)
    .join(',\n       ')
  const vars: Record<string, string> = { run_id: runId }
  rows.forEach((r, i) => {
    vars[`id${i}`] = r.id
    vars[`repo_url${i}`] = r.repoUrl ?? ''
  })
  await runPsql(
    conn,
    `INSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, snapshot_taken_at, repo_url)
     VALUES ${values};`,
    vars
  )
}

describe.skipIf(prePushNoLiveTestPg)('--resume (SMI-5879 checkpoint/resume follow-up)', () => {
  it('1. cold start: refuses loudly when no open generation exists to resume', async () => {
    await expect(
      runCensus(conn, {
        purpose: 'window',
        rulesetEpoch: '2026-01-01T00:00:00Z',
        apply: true,
        reportPath: 'unused.json',
        resume: true,
      })
    ).rejects.toThrow(/no 'open' generation exists to resume/)
  })

  it('2a. identity mismatch: refuses when the open generation has a DIFFERENT purpose', async () => {
    const runId = `t-resume-purpose-mismatch-${randomUUID()}`
    await createOpenRun(conn, runId, 'decision', '2026-01-01T00:00:00Z')

    await expect(
      runCensus(conn, {
        purpose: 'rehearsal',
        rulesetEpoch: '2026-01-01T00:00:00Z',
        apply: true,
        reportPath: 'unused.json',
        resume: true,
      })
    ).rejects.toThrow(/does not match this invocation/)
  })

  it('2b. identity mismatch: refuses when the open generation has a DIFFERENT ruleset_epoch', async () => {
    const runId = `t-resume-epoch-mismatch-${randomUUID()}`
    await createOpenRun(conn, runId, 'decision', '2026-01-01T00:00:00Z')

    await expect(
      runCensus(conn, {
        purpose: 'decision',
        rulesetEpoch: '2026-02-02T00:00:00Z',
        apply: true,
        reportPath: 'unused.json',
        resume: true,
      })
    ).rejects.toThrow(/does not match this invocation/)
  })

  it('3. refuses to steal a claim that is still genuinely alive (fresh heartbeat)', async () => {
    const runId = `t-resume-live-claim-${randomUUID()}`
    await createOpenRun(conn, runId, 'window', '2026-01-01T00:00:00Z')
    // Simulate a currently-running process holding the claim — heartbeat is
    // fresh (just claimed, milliseconds ago), NOT stale.
    await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-live');`, {
      run_id: runId,
      token: randomUUID(),
    })

    await expect(
      runCensus(conn, {
        purpose: 'window',
        rulesetEpoch: '2026-01-01T00:00:00Z',
        apply: true,
        reportPath: 'unused.json',
        resume: true,
      })
    ).rejects.toThrow(/another process .*appears to hold an active claim/)

    // The generation must be untouched — still open, still held by the live claim.
    const status = await queryRows(
      conn,
      `SELECT status FROM smi5879_run WHERE run_id = :'run_id'`,
      {
        run_id: runId,
      }
    )
    expect(status[0]?.[0]).toBe('open')
  })

  it('4a. clean resume skips population load when already fully loaded (window purpose, no branch I/O)', async () => {
    const runId = `t-resume-population-skip-${randomUUID()}`
    const id1 = await insertSkillFixture(conn, { security_score: 9 })
    const id2 = await insertSkillFixture(conn, { security_score: null })

    await createOpenRun(conn, runId, 'window', '2026-01-01T00:00:00Z')
    // Simulate a prior (crashed) attempt that already finished the population
    // load — direct INSERT into smi5879_snapshot_pre for BOTH fixtures. If
    // the resume path's isPopulated() skip is broken and populate() re-runs
    // its INSERT ... SELECT * FROM skills, this SAME (run_id, id) pair would
    // violate the table's PK — the test would then fail on a rejected
    // promise instead of the assertions below, which is the point: a
    // regression here fails loudly, not silently.
    await insertPopulationRows(conn, runId, [{ id: id1 }, { id: id2 }])
    // Simulate the prior process dying: claim, then backdate the heartbeat
    // past the default 30-minute takeover threshold.
    const staleToken = randomUUID()
    await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-dead');`, {
      run_id: runId,
      token: staleToken,
    })
    await backdateHeartbeat(conn, runId, 61)

    const report = await runCensus(conn, {
      purpose: 'window',
      rulesetEpoch: '2026-01-01T00:00:00Z',
      apply: true,
      reportPath: 'unused.json',
      resume: true,
    })

    expect(report.resumed).toBe(true)
    expect(report.status).toBe('sealed')
    expect(report.row_count).toBe(2)
    expect(report.invariants.every((i) => i.passed)).toBe(true)

    // SMI-5879 checkpoint/resume round-2 review finding: the resume event is
    // recorded on the registry row itself (smi5879_run.notes), not just
    // forensically reconstructible from smi5879_repo_branch.resolved_at.
    const notes = await queryRows(conn, `SELECT notes FROM smi5879_run WHERE run_id = :'run_id'`, {
      run_id: runId,
    })
    expect(notes[0]?.[0]).toContain('resumed at')
  })

  it('4b. clean resume resolves only the remainder — distinct_repos in the report reflects the TRUE total, not just the remainder', async () => {
    const setHandler = installGithubFetchMock()
    const runId = `t-resume-branch-remainder-${randomUUID()}`
    const id1 = await insertSkillFixture(conn, { repo_url: 'https://github.com/acme/already-done' })
    const id2 = await insertSkillFixture(conn, {
      repo_url: 'https://github.com/acme/still-pending',
    })

    await createOpenRun(conn, runId, 'decision', '2026-01-01T00:00:00Z')
    await insertPopulationRows(conn, runId, [
      { id: id1, repoUrl: 'https://github.com/acme/already-done' },
      { id: id2, repoUrl: 'https://github.com/acme/still-pending' },
    ])
    // Simulate the prior (crashed) attempt's partial branch-resolution
    // progress: acme/already-done is already recorded resolved. Only
    // acme/still-pending gets a fetch mock registered below — if
    // distinctRepos() fails to exclude the already-resolved repo, the pool
    // would attempt to fetch acme/already-done too and the unregistered-URL
    // guard in installGithubFetchMock throws, failing this test loudly.
    await runPsql(
      conn,
      `INSERT INTO smi5879_repo_branch (run_id, owner, repo, default_branch, resolution, http_status)
       VALUES (:'run_id', 'acme', 'already-done', 'main', 'resolved', 200);`,
      { run_id: runId }
    )
    setHandler('acme', 'still-pending', [branchResponse('develop')])

    const staleToken = randomUUID()
    await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-dead');`, {
      run_id: runId,
      token: staleToken,
    })
    await backdateHeartbeat(conn, runId, 61)

    const report = await runCensus(conn, {
      purpose: 'decision',
      rulesetEpoch: '2026-01-01T00:00:00Z',
      apply: true,
      reportPath: 'unused.json',
      resume: true,
    })

    expect(report.resumed).toBe(true)
    expect(report.status).toBe('sealed')
    expect(report.branch_resolution).not.toBeNull()
    // The report-accuracy fix: distinct_repos must be the TRUE total (2),
    // not just the 1 repo this resumed invocation itself resolved.
    expect(report.branch_resolution?.distinct_repos).toBe(2)
    expect(report.branch_resolution?.resolved).toBe(2)
    expect(report.branch_resolution?.transient).toBe(0)
    expect(report.invariants.find((i) => i.id === 'I-6')?.passed).toBe(true)

    const rows = await queryRows(
      conn,
      `SELECT owner, repo, default_branch FROM smi5879_repo_branch WHERE run_id = :'run_id' ORDER BY repo`,
      { run_id: runId }
    )
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r[1] === 'already-done')?.[2]).toBe('main')
    expect(rows.find((r) => r[1] === 'still-pending')?.[2]).toBe('develop')
  })

  it('4c. resume: a prior transient smi5879_repo_branch row is excluded from the resumed MAIN pass but still picked up by sweepTransientRepos', async () => {
    const setHandler = installGithubFetchMock()
    const runId = `t-resume-sweep-transient-${randomUUID()}`
    const id1 = await insertSkillFixture(conn, {
      repo_url: 'https://github.com/acme/flaky-then-fixed',
    })

    await createOpenRun(conn, runId, 'decision', '2026-01-01T00:00:00Z')
    await insertPopulationRows(conn, runId, [
      { id: id1, repoUrl: 'https://github.com/acme/flaky-then-fixed' },
    ])
    // Simulate the prior (crashed) attempt's main-pass outcome: retries
    // exhausted, recorded transient.
    await runPsql(
      conn,
      `INSERT INTO smi5879_repo_branch (run_id, owner, repo, default_branch, resolution, http_status)
       VALUES (:'run_id', 'acme', 'flaky-then-fixed', NULL, 'transient', 503);`,
      { run_id: runId }
    )
    // Only ONE queued response — if distinctRepos() failed to exclude this
    // repo from the RESUMED main pass, the pool would consume this response
    // there instead (leaving the sweep's own fresh resolveOne call with an
    // empty queue, which installGithubFetchMock's unregistered-URL guard
    // then throws on) — proves the response was consumed by the sweep, not
    // the main pass.
    setHandler('acme', 'flaky-then-fixed', [branchResponse('main')])

    const staleToken = randomUUID()
    await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-dead');`, {
      run_id: runId,
      token: staleToken,
    })
    await backdateHeartbeat(conn, runId, 61)

    const report = await runCensus(conn, {
      purpose: 'decision',
      rulesetEpoch: '2026-01-01T00:00:00Z',
      apply: true,
      reportPath: 'unused.json',
      resume: true,
    })

    expect(report.status).toBe('sealed')
    expect(report.branch_resolution?.reresolution_sweep).not.toBeNull()
    expect(report.branch_resolution?.reresolution_sweep?.repos_reattempted).toBe(1)
    expect(report.branch_resolution?.resolved).toBe(1)
    expect(report.branch_resolution?.transient).toBe(0)
    expect(report.invariants.find((i) => i.id === 'I-6')?.passed).toBe(true)
  })

  it('5. fresh start (no --resume) refuses with an actionable message when an open generation already exists', async () => {
    const runId = `t-fresh-blocked-by-open-${randomUUID()}`
    await createOpenRun(conn, runId, 'rehearsal', '2026-01-01T00:00:00Z')

    await expect(
      runCensus(conn, {
        purpose: 'decision',
        rulesetEpoch: '2026-03-03T00:00:00Z',
        apply: true,
        reportPath: 'unused.json',
        resume: false,
      })
    ).rejects.toThrow(/already 'open'.*--resume/s)
  })
})

describe('--resume requires --apply (parseArgs)', () => {
  it('rejects --resume without --apply', async () => {
    const { parseArgs } = await import('../../indexer/smi5879-census.ts')
    expect(() =>
      parseArgs(['--purpose=decision', '--ruleset-epoch=2026-01-01T00:00:00Z', '--resume'])
    ).toThrow(/--resume requires --apply/)
  })

  it('accepts --apply --resume together', async () => {
    const { parseArgs } = await import('../../indexer/smi5879-census.ts')
    const args = parseArgs([
      '--purpose=decision',
      '--ruleset-epoch=2026-01-01T00:00:00Z',
      '--apply',
      '--resume',
    ])
    expect(args.apply).toBe(true)
    expect(args.resume).toBe(true)
  })
})

describe.skipIf(prePushNoLiveTestPg)(
  'distinctRepos() exclusion (SMI-5879 checkpoint/resume)',
  () => {
    it('excludes an (owner, repo) pair that already has a smi5879_repo_branch row for this run_id', async () => {
      const runId = `t-distinctrepos-exclude-${randomUUID()}`
      const id1 = await insertSkillFixture(conn, { repo_url: 'https://github.com/acme/repo-x' })
      const id2 = await insertSkillFixture(conn, { repo_url: 'https://github.com/acme/repo-y' })
      await createOpenRun(conn, runId, 'decision', '2026-01-01T00:00:00Z')
      await insertPopulationRows(conn, runId, [
        { id: id1, repoUrl: 'https://github.com/acme/repo-x' },
        { id: id2, repoUrl: 'https://github.com/acme/repo-y' },
      ])
      // repo-x already has a row (any resolution — even 'transient' counts,
      // per distinctRepos' own doc comment: re-attempting it via the main
      // pass's INSERT would still violate the PK; a transient repo's
      // re-attempt is sweepTransientRepos' job, not distinctRepos').
      await runPsql(
        conn,
        `INSERT INTO smi5879_repo_branch (run_id, owner, repo, default_branch, resolution, http_status)
       VALUES (:'run_id', 'acme', 'repo-x', NULL, 'transient', 503);`,
        { run_id: runId }
      )

      const { repos } = await distinctRepos(conn, runId)
      expect(repos).toEqual([{ owner: 'acme', repo: 'repo-y' }])
    })

    it('excludes nothing on a fresh generation (smi5879_repo_branch starts empty)', async () => {
      const runId = `t-distinctrepos-fresh-${randomUUID()}`
      const id1 = await insertSkillFixture(conn, { repo_url: 'https://github.com/acme/repo-fresh' })
      await createOpenRun(conn, runId, 'decision', '2026-01-01T00:00:00Z')
      await insertPopulationRows(conn, runId, [
        { id: id1, repoUrl: 'https://github.com/acme/repo-fresh' },
      ])

      const { repos } = await distinctRepos(conn, runId)
      expect(repos).toEqual([{ owner: 'acme', repo: 'repo-fresh' }])
    })
  }
)

describe.skipIf(prePushNoLiveTestPg)(
  'describeResumeClaimRefusal (SMI-5879 checkpoint/resume round-2 review)',
  () => {
    it('an ABANDONED generation gets "waiting will not help" advice, never the live-claim message', async () => {
      const runId = `t-describe-refusal-abandoned-${randomUUID()}`
      await createOpenRun(conn, runId, 'decision', '2026-01-01T00:00:00Z')
      const token = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-dead');`, {
        run_id: runId,
        token,
      })
      await backdateHeartbeat(conn, runId, 180) // > 2h default GC p_stale_after
      await runPsql(
        conn,
        `SELECT * FROM smi5879_gc_force_abandon(:'run_id', :'token', 'test-abandon');`,
        {
          run_id: runId,
          token,
        }
      )

      const message = await describeResumeClaimRefusal(conn, runId)
      expect(message).toContain('abandoned')
      expect(message).toContain('Waiting will NOT help')
      expect(message).not.toContain('Refusing to steal a live claim')
    })

    it('a LIVE claim gets the "refusing to steal" advice, naming the holder', async () => {
      const runId = `t-describe-refusal-live-${randomUUID()}`
      await createOpenRun(conn, runId, 'decision', '2026-01-01T00:00:00Z')
      await runPsql(
        conn,
        `SELECT * FROM smi5879_claim_run(:'run_id', gen_random_uuid(), 'holder-alive');`,
        { run_id: runId }
      )

      const message = await describeResumeClaimRefusal(conn, runId)
      expect(message).toContain('Refusing to steal a live claim')
      expect(message).toContain('holder-alive')
      expect(message).not.toContain('Waiting will NOT help')
    })
  }
)

describe.skipIf(prePushNoLiveTestPg)(
  'seal() token fencing + self-verification (SMI-5879 cross-model review, High + Medium)',
  () => {
    it('succeeds with the CURRENT token against an open generation, flipping status to sealed', async () => {
      const runId = `t-seal-fence-ok-${randomUUID()}`
      await createOpenRun(conn, runId, 'decision', '2026-01-01T00:00:00Z')
      const token = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token,
      })
      await expect(seal(conn, runId, token)).resolves.toBeUndefined()
      const status = await queryRows(
        conn,
        `SELECT status FROM smi5879_run WHERE run_id = :'run_id'`,
        { run_id: runId }
      )
      expect(status[0]?.[0]).toBe('sealed')
    })

    it('throws on a STALE token even though status is still open (the High-finding zombie-writer scenario)', async () => {
      const runId = `t-seal-fence-stale-${randomUUID()}`
      await createOpenRun(conn, runId, 'decision', '2026-01-01T00:00:00Z')
      const staleToken = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token: staleToken,
      })
      // Simulate a takeover: another process claims with a NEW token — this
      // process's own `staleToken` is no longer current, but status is
      // STILL 'open' (the resumer hasn't sealed anything yet).
      await backdateHeartbeat(conn, runId, 61)
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-b');`, {
        run_id: runId,
        token: randomUUID(),
      })

      await expect(seal(conn, runId, staleToken)).rejects.toThrow(
        /did not seal generation .* \(0 row\(s\) updated, expected 1\)/
      )
      const status = await queryRows(
        conn,
        `SELECT status FROM smi5879_run WHERE run_id = :'run_id'`,
        { run_id: runId }
      )
      expect(status[0]?.[0]).toBe('open')
    })

    it('throws when the generation was already sealed by someone else (the Medium-finding seal-attribution ambiguity)', async () => {
      const runId = `t-seal-fence-already-sealed-${randomUUID()}`
      await createOpenRun(conn, runId, 'decision', '2026-01-01T00:00:00Z')
      // Process X seals and releases.
      await sealRun(conn, runId)
      // Process R (a resumer) legitimately re-claims the now-sealed,
      // never-abandoned row — smi5879_claim_run accepts status IN
      // ('open','sealed') with a NULL token, so this succeeds and R holds a
      // REAL, currently-valid token.
      const resumerToken = randomUUID()
      const claimed = await queryRows(
        conn,
        `SELECT run_id FROM smi5879_claim_run(:'run_id', :'token', 'holder-resumer');`,
        { run_id: runId, token: resumerToken }
      )
      expect(claimed).toHaveLength(1) // confirm the re-claim genuinely succeeded

      // R's own seal() must still refuse — status isn't 'open', regardless
      // of R's token being perfectly valid. This is the exact case a
      // SEPARATE later status-read (the old assertGenerationSealed) could
      // not distinguish from "I sealed it myself."
      await expect(seal(conn, runId, resumerToken)).rejects.toThrow(
        /did not seal generation .* \(0 row\(s\) updated, expected 1\)/
      )
    })

    it('SMI-5879 cross-model review round-5 finding (HIGH): the restored pre-check genuinely serializes seal() against a concurrent writer — row_count and population_digest are NOT undercounted', async () => {
      // Round 4 empirically reproduced the exact regression this test
      // guards against: round 3's fencing fix folded seal()'s registry-row
      // lock into the UPDATE's own WHERE clause and dropped the standalone
      // pre-check SELECT ... FOR UPDATE that used to run as an EARLIER,
      // separate statement — reopening the "insert-vs-seal" race design doc
      // SECTION 4 exists to close (a writer mid-commit when seal()'s
      // count(*) subquery evaluates, but finishing commit before the
      // UPDATE's own lock is granted, is silently uncounted). Round 4's own
      // live reproduction caught it; round 5 found this exact regression
      // has ZERO test coverage — the three OTHER seal() tests above only
      // exercise the token/status WHERE clause, never lock ordering, so a
      // future "simplify the SQL" refactor could reintroduce it with every
      // test in this file staying green. This test closes that gap by
      // reproducing the same race directly against a real Postgres.
      const { spawn } = await import('node:child_process')
      const runId = `t-seal-lockorder-${randomUUID()}`
      const id1 = await insertSkillFixture(conn, {})
      await createOpenRun(conn, runId, 'window', '2026-01-01T00:00:00Z')
      const token = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token,
      })
      await insertPopulationRows(conn, runId, [{ id: id1 }])

      // A writer (the migration's own sanctioned "operator repair BEFORE
      // sealing" allowance, SECTION 4) holds the guard-trigger's row lock
      // via an open, uncommitted transaction inserting a SECOND row, and
      // commits partway through seal()'s own blocked wait.
      const testConn = requireTestConn()
      const writer = spawn('psql', ['--no-psqlrc', '-X', '-q'], {
        env: {
          ...process.env,
          PGHOST: testConn.host,
          PGPORT: String(testConn.port),
          PGUSER: testConn.user,
          PGPASSWORD: testConn.password,
          PGDATABASE: testConn.database,
          PGOPTIONS: `-c search_path=${conn.searchPath}`,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      writer.stdin.write(
        `BEGIN;\nINSERT INTO smi5879_snapshot_pre (run_id, id, updated_at, row_xmin, ` +
          `snapshot_taken_at) VALUES ('${runId}', 'race-row-2', now(), '999', now());\n`
      )
      await new Promise((r) => setTimeout(r, 500)) // let the writer's INSERT (and its guard-trigger lock) land first

      const sealStart = Date.now()
      const sealPromise = seal(conn, runId, token)
      await new Promise((r) => setTimeout(r, 2500)) // seal() should be BLOCKED for this whole window
      writer.stdin.write('COMMIT;\n\\q\n')

      await expect(sealPromise).resolves.toBeUndefined()
      // seal() must have genuinely BLOCKED on the writer's lock, not raced past it.
      expect(Date.now() - sealStart).toBeGreaterThan(2000)

      const result = await queryRows(
        conn,
        `SELECT row_count, population_digest,
                (SELECT count(*) FROM smi5879_snapshot_pre WHERE run_id = r.run_id) AS actual_rows,
                smi5879_population_digest(r.run_id) AS current_digest
           FROM smi5879_run r WHERE run_id = :'run_id'`,
        { run_id: runId }
      )
      const [rowCount, populationDigest, actualRows, currentDigest] = result[0] ?? []
      expect(rowCount).toBe('2')
      expect(actualRows).toBe('2')
      // The sealed row_count must match the true row count (no undercount)...
      expect(rowCount).toBe(actualRows)
      // ...and the sealed digest must match what the (now-complete) population
      // actually hashes to — an undercounted seal computes BOTH from a stale
      // snapshot, so this is the same bug caught two independent ways.
      expect(populationDigest).toBe(currentDigest)
    })
  }
)

describe.skipIf(prePushNoLiveTestPg)(
  'populate() token fencing (SMI-5879 cross-model review, High)',
  () => {
    it('succeeds with the CURRENT token, population lands', async () => {
      const runId = `t-populate-fence-ok-${randomUUID()}`
      await insertSkillFixture(conn, {})
      await createOpenRun(conn, runId, 'window', '2026-01-01T00:00:00Z')
      const token = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token,
      })
      await expect(populate(conn, runId, token)).resolves.toBeUndefined()
      const rows = await queryRows(
        conn,
        `SELECT count(*) FROM smi5879_snapshot_pre WHERE run_id = :'run_id'`,
        { run_id: runId }
      )
      expect(Number(rows[0]?.[0])).toBeGreaterThan(0)
    })

    it('throws on a STALE token — claim already taken over — and inserts ZERO rows', async () => {
      const runId = `t-populate-fence-stale-${randomUUID()}`
      await insertSkillFixture(conn, {})
      await createOpenRun(conn, runId, 'window', '2026-01-01T00:00:00Z')
      const staleToken = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token: staleToken,
      })
      await backdateHeartbeat(conn, runId, 61)
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-b');`, {
        run_id: runId,
        token: randomUUID(),
      })

      await expect(populate(conn, runId, staleToken)).rejects.toThrow(
        /loaded 0 row\(s\) but skills has 1.*same repeatable read snapshot/is
      )
      const rows = await queryRows(
        conn,
        `SELECT count(*) FROM smi5879_snapshot_pre WHERE run_id = :'run_id'`,
        { run_id: runId }
      )
      expect(rows[0]?.[0]).toBe('0')
    })

    it('a genuinely empty `skills` table under the CURRENT token is NOT reported as a claim loss (loaded=0 matches source=0)', async () => {
      // Round-4/5 finding: the loaded-vs-source comparison must not
      // false-positive on a legitimately empty population — 0 loaded rows
      // against a genuinely empty skills table (source=0) is a MATCH, not a
      // mismatch.
      const runId = `t-populate-fence-empty-skills-${randomUUID()}`
      await createOpenRun(conn, runId, 'window', '2026-01-01T00:00:00Z')
      const token = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token,
      })
      // beforeEach already clears `skills` — no fixture inserted here.
      await expect(populate(conn, runId, token)).resolves.toBeUndefined()
      const rows = await queryRows(
        conn,
        `SELECT count(*) FROM smi5879_snapshot_pre WHERE run_id = :'run_id'`,
        { run_id: runId }
      )
      expect(rows[0]?.[0]).toBe('0')
    })

    it('SMI-5879 cross-model review round-4 finding (Medium): a REAL takeover racing the fence-lock wait raises the same claim-lost error, not a raw SQLSTATE 40001 message', async () => {
      // Reproduces the exact race the round-4 review found live: populate()'s
      // REPEATABLE READ pre-check blocks on a registry-row lock a concurrent
      // "resumer" holds (simulated here via an explicit, uncommitted
      // smi5879_claim_run-shaped UPDATE); once that commits mid-wait, the
      // transaction's own snapshot is stale relative to the just-committed
      // token, and Postgres raises SQLSTATE 40001 rather than the ordinary
      // "0 rows, no error" shape every OTHER (READ COMMITTED) fenced write
      // produces — verified this DOES reach `populate()`'s dedicated catch
      // and gets re-thrown as the same claim-lost signal, not a raw psql
      // exit-3 message.
      const { spawn } = await import('node:child_process')
      const runId = `t-populate-fence-race-${randomUUID()}`
      await insertSkillFixture(conn, {})
      await createOpenRun(conn, runId, 'window', '2026-01-01T00:00:00Z')
      const staleToken = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token: staleToken,
      })

      const testConn = requireTestConn()
      const holder = spawn('psql', ['--no-psqlrc', '-X', '-q'], {
        env: {
          ...process.env,
          PGHOST: testConn.host,
          PGPORT: String(testConn.port),
          PGUSER: testConn.user,
          PGPASSWORD: testConn.password,
          PGDATABASE: testConn.database,
          PGOPTIONS: `-c search_path=${conn.searchPath}`,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const newToken = randomUUID()
      holder.stdin.write(
        `BEGIN;\nUPDATE smi5879_run SET runner_token = '${newToken}', runner_heartbeat_at = now() ` +
          `WHERE run_id = '${runId}';\n`
      )
      await new Promise((r) => setTimeout(r, 500)) // let the holder's UPDATE (and its row lock) land first

      const populatePromise = populate(conn, runId, staleToken)
      await new Promise((r) => setTimeout(r, 1000))
      holder.stdin.write('COMMIT;\n\\q\n')

      await expect(populatePromise).rejects.toThrow(
        /aborted with a serialization failure.*no longer holds a live claim/s
      )
      const rows = await queryRows(
        conn,
        `SELECT count(*) FROM smi5879_snapshot_pre WHERE run_id = :'run_id'`,
        { run_id: runId }
      )
      expect(rows[0]?.[0]).toBe('0')
    }, 15_000)
  }
)

describe.skipIf(prePushNoLiveTestPg)(
  'writeOutcomesBatch/updateOutcomesBatch token fencing (SMI-5879 cross-model review, High)',
  () => {
    const outcome: ResolutionOutcome = {
      repo: { owner: 'acme', repo: 'fenced-repo' },
      resolution: 'resolved',
      defaultBranch: 'main',
      httpStatus: 200,
      attempts: 1,
    }

    it('writeOutcomesBatch: succeeds with the CURRENT token', async () => {
      const runId = `t-write-fence-ok-${randomUUID()}`
      await createOpenRun(conn, runId, 'decision', '2026-01-01T00:00:00Z')
      const token = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token,
      })
      await expect(writeOutcomesBatch(conn, runId, token, [outcome])).resolves.toBeUndefined()
      const rows = await queryRows(
        conn,
        `SELECT owner FROM smi5879_repo_branch WHERE run_id = :'run_id'`,
        { run_id: runId }
      )
      expect(rows).toHaveLength(1)
    })

    it('writeOutcomesBatch: throws ClaimFencedWriteError on a STALE token, writes NOTHING', async () => {
      const runId = `t-write-fence-stale-${randomUUID()}`
      await createOpenRun(conn, runId, 'decision', '2026-01-01T00:00:00Z')
      const staleToken = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token: staleToken,
      })
      await backdateHeartbeat(conn, runId, 61)
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-b');`, {
        run_id: runId,
        token: randomUUID(),
      })

      await expect(writeOutcomesBatch(conn, runId, staleToken, [outcome])).rejects.toThrow(
        ClaimFencedWriteError
      )
      const rows = await queryRows(
        conn,
        `SELECT owner FROM smi5879_repo_branch WHERE run_id = :'run_id'`,
        { run_id: runId }
      )
      expect(rows).toHaveLength(0)
    })

    it('updateOutcomesBatch: succeeds with the CURRENT token', async () => {
      const runId = `t-update-fence-ok-${randomUUID()}`
      await createOpenRun(conn, runId, 'decision', '2026-01-01T00:00:00Z')
      const token = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token,
      })
      await runPsql(
        conn,
        `INSERT INTO smi5879_repo_branch (run_id, owner, repo, default_branch, resolution, http_status)
         VALUES (:'run_id', 'acme', 'fenced-repo', NULL, 'transient', 503);`,
        { run_id: runId }
      )
      await expect(updateOutcomesBatch(conn, runId, token, [outcome])).resolves.toBeUndefined()
      const rows = await queryRows(
        conn,
        `SELECT resolution FROM smi5879_repo_branch WHERE run_id = :'run_id'`,
        { run_id: runId }
      )
      expect(rows[0]?.[0]).toBe('resolved')
    })

    it('updateOutcomesBatch: throws ClaimFencedWriteError on a STALE token, row stays UNCHANGED', async () => {
      const runId = `t-update-fence-stale-${randomUUID()}`
      await createOpenRun(conn, runId, 'decision', '2026-01-01T00:00:00Z')
      const staleToken = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token: staleToken,
      })
      await runPsql(
        conn,
        `INSERT INTO smi5879_repo_branch (run_id, owner, repo, default_branch, resolution, http_status)
         VALUES (:'run_id', 'acme', 'fenced-repo', NULL, 'transient', 503);`,
        { run_id: runId }
      )
      await backdateHeartbeat(conn, runId, 61)
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-b');`, {
        run_id: runId,
        token: randomUUID(),
      })

      await expect(updateOutcomesBatch(conn, runId, staleToken, [outcome])).rejects.toThrow(
        ClaimFencedWriteError
      )
      const rows = await queryRows(
        conn,
        `SELECT resolution FROM smi5879_repo_branch WHERE run_id = :'run_id'`,
        { run_id: runId }
      )
      expect(rows[0]?.[0]).toBe('transient')
    })
  }
)

describe.skipIf(prePushNoLiveTestPg)(
  'resolveDefaultBranches: a fenced-out write propagates as a normal rejection (SMI-5879 cross-model review round-4, Medium)',
  () => {
    it('a STALE token throws ClaimFencedWriteError from resolveDefaultBranches itself — not an unhandled rejection, not a hang', async () => {
      // Round-4 finding: `flush()` previously pushed writeOutcomesBatch(...)
      // into `pendingFlushes` with no `.catch()`, invisible to the pool's
      // own abort machinery until `Promise.all(pendingFlushes)` — this test
      // proves the fix's `writeError` capture (renamed from `fencedOutError`
      // in round 5, since it can carry ANY writeOutcomesBatch rejection, not
      // only a fencing one) + explicit post-pool `throw writeError` actually
      // surfaces the error as a normal, awaitable rejection from
      // `resolveDefaultBranches` (this test method itself proves it: a real
      // unhandled rejection would crash the WHOLE vitest worker process, not
      // just fail this one assertion).
      const { resolveDefaultBranches } = await import('../../indexer/smi5879-census.branches.ts')
      const { newRateLimitTelemetry } = await import('../../indexer/_shared/rate-limit.ts')
      const setHandler = installGithubFetchMock()
      const runId = `t-resolve-fence-propagate-${randomUUID()}`
      const id1 = await insertSkillFixture(conn, {
        repo_url: 'https://github.com/acme/fence-propagate-repo',
      })
      await createOpenRun(conn, runId, 'decision', '2026-01-01T00:00:00Z')
      await insertPopulationRows(conn, runId, [
        { id: id1, repoUrl: 'https://github.com/acme/fence-propagate-repo' },
      ])
      setHandler('acme', 'fence-propagate-repo', [branchResponse('main')])

      const staleToken = randomUUID()
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-a');`, {
        run_id: runId,
        token: staleToken,
      })
      await backdateHeartbeat(conn, runId, 61)
      await runPsql(conn, `SELECT * FROM smi5879_claim_run(:'run_id', :'token', 'holder-b');`, {
        run_id: runId,
        token: randomUUID(),
      })

      await expect(
        resolveDefaultBranches(conn, runId, staleToken, async () => ({}), newRateLimitTelemetry())
      ).rejects.toThrow(ClaimFencedWriteError)

      const rows = await queryRows(
        conn,
        `SELECT owner FROM smi5879_repo_branch WHERE run_id = :'run_id'`,
        { run_id: runId }
      )
      expect(rows).toHaveLength(0)
    })
  }
)
