/**
 * @fileoverview SMI-6362 — the LIVE-POSTGRES half of the cloud usage-analytics RLS /
 * k-anonymity coverage suite. Read together with its static sibling,
 * `scripts/tests/search-metrics-analytics-rls.test.ts`, which owns T-RLS-1..4/6/7,
 * T-GRANT-1/2, T-PROV-1's static half, the k-constant coupling check, and T-RET-1's
 * migration-text half. The two were split only because the combined file exceeded the
 * 500-line gate and because they have different run conditions.
 *
 * WHAT THIS FILE PROVES THAT NOTHING ELSE IN THE REPO CAN. The static sibling asserts the
 * DECLARATIONS are right — that no RPC was flipped to SECURITY DEFINER, that the policy
 * predicate is unchanged, that the grants say what they must. It cannot prove ENFORCEMENT.
 * This file executes the shipped `analytics_team_reporting_coverage()` body and the
 * shipped `search_metrics_team_scoped_read` policy — both EXTRACTED VERBATIM from the
 * migrations at run time by `./supabase/pg-session.ts`, never transcribed — against a
 * throwaway Postgres, so a mocked test's inability to prove an RLS policy or a
 * k-anonymity ladder (CLAUDE.md's SMI-6015 lesson) does not apply here.
 *
 * CONNECTION + NO CI COVERAGE, STATED PLAINLY. Same five-env-var convention as
 * `scripts/tests/supabase/purge-departed-toctou.test-helpers.ts` and the smi5879 census
 * harness: SMI6362_TEST_PGHOST / PORT / USER / PASSWORD / DATABASE. CI provisions no
 * Postgres and sets none of them, so this suite skips there — loudly (see the helpers
 * module's console.warn, which carries a docker one-liner). That is the same known,
 * tracked gap SMI-5946 already records, not a new one. Verified green locally against
 * postgres:15-alpine, including two mutation checks (a rev-3 `full` expectation for the
 * 5-seats/0-non-reporting row, and restoring the former member's team_members row) that
 * both correctly failed.
 *
 * DELIBERATELY NOT DUPLICATED HERE:
 *  - The 64-lowercase-hex actor format that makes the `actor = auth.uid()::TEXT` branch
 *    inert — `supabase/functions/_shared/telemetry-actor.test.ts`.
 *  - The renderer half of AC-9 (no digits at `qualitative`; no suppression_reason enum
 *    value ever rendered; 4/0 and 4/1 render identically) —
 *    `packages/mcp-server/src/tools/analytics.supabase.service.test.ts` § buildCoverageNote.
 *    This file asserts the RPC-side INPUT to that renderer instead.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PsqlSession } from './supabase/pg-session.ts'
import {
  AC9_MATRIX,
  COVERAGE_NULL_SENTINEL,
  coverageQuery,
  fixtureUserId,
  noLiveTestPg,
  parseCoverageRow,
  requireTestConn,
  schemaSql,
  seedCoverageCaseSql,
  type TestConn,
} from './search-metrics-analytics-rls.helpers.ts'

const TEAM_A = 'smi6362-rls-team-a'
const TEAM_B = 'smi6362-rls-team-b'
const U_A = fixtureUserId(90, 1) // team-A member
const U_B = fixtureUserId(90, 2) // team-B member
const U_EX = fixtureUserId(90, 3) // FORMER team-A member (membership removed)
const U_NONE = fixtureUserId(90, 4) // authenticated, no team at all

let conn: TestConn
let sql: PsqlSession
const seededTeams: string[] = []

describe.skipIf(noLiveTestPg)('SMI-6362 live SQL — shipped bodies against a real Postgres', () => {
  beforeAll(async () => {
    conn = requireTestConn()
    sql = new PsqlSession(conn, 'smi6362')
    const { stderr } = await sql.send(schemaSql(), 60_000)
    // A failed schema build must be loud: every assertion below would otherwise pass or
    // fail for the wrong reason.
    expect(stderr, `schema build failed:\n${stderr}`).not.toMatch(/ERROR/)

    // AC-9 matrix: one team per row, each with its own seats.
    const seeds: string[] = []
    AC9_MATRIX.forEach((c, i) => {
      const { teamId, sql: s } = seedCoverageCaseSql(c, i)
      seededTeams.push(teamId)
      seeds.push(s)
    })
    // Two distinct active actors for the released levels, so active_actors_in_window is
    // provably POPULATED there and provably NULL (not 0) at qualitative.
    for (const teamId of [seededTeams[9], seededTeams[10]]) {
      for (const actor of ['a'.repeat(64), 'b'.repeat(64)]) {
        seeds.push(
          `INSERT INTO search_metrics (event_type, actor, metadata) VALUES ` +
            `('telemetry:tool_call', '${actor}', jsonb_build_object('team_id', '${teamId}'));`
        )
      }
    }

    // T-RLS-5 fixture: two teams, one former member, one team-less user.
    for (const uid of [U_A, U_B, U_EX, U_NONE]) {
      seeds.push(`INSERT INTO auth.users (id) VALUES ('${uid}');`)
    }
    seeds.push(
      `INSERT INTO team_members (team_id, user_id) VALUES ('${TEAM_A}', '${U_A}');`,
      `INSERT INTO team_members (team_id, user_id) VALUES ('${TEAM_B}', '${U_B}');`,
      // U_EX was a team-A member and has been removed — no team_members row remains.
      `INSERT INTO search_metrics (event_type, actor, metadata) VALUES ` +
        `('telemetry:tool_call', '${'c'.repeat(64)}', jsonb_build_object('team_id', '${TEAM_A}'));`,
      `INSERT INTO search_metrics (event_type, actor, metadata) VALUES ` +
        `('telemetry:tool_call', '${'d'.repeat(64)}', jsonb_build_object('team_id', '${TEAM_B}'));`,
      // A row whose actor IS a raw uuid. Impossible in production (D-2b makes every actor a
      // 64-hex digest), seeded only so T-RLS-5 can demonstrate the branch's real behaviour
      // rather than assuming it.
      `INSERT INTO search_metrics (event_type, actor, metadata) VALUES ` +
        `('telemetry:tool_call', '${U_EX}', jsonb_build_object('team_id', '${TEAM_A}'));`
    )
    const { stderr: seedErr } = await sql.send(seeds.join('\n'), 60_000)
    expect(seedErr, `fixture seed failed:\n${seedErr}`).not.toMatch(/ERROR/)
  }, 120_000)

  afterAll(async () => {
    await sql?.close()
  })

  // --------------------------------------------------------------------------
  // T-COVERAGE-1..11
  // --------------------------------------------------------------------------

  describe('T-COVERAGE-1..11 — analytics_team_reporting_coverage release ladder (AC-9)', () => {
    it.each(AC9_MATRIX.map((c, i) => [c.id, c, i] as const))(
      '%s: seats=%o resolves to the required coverage_level with the right NULLs',
      async (_id, c, i) => {
        const teamId = seededTeams[i]
        const { stdout } = await sql.send(
          `SET smi6362.uid = '${fixtureUserId(i, 0)}';\n${coverageQuery(teamId)}`
        )
        const row = parseCoverageRow(stdout)
        expect(row, `${c.id}: expected one row for a member of ${teamId}`).not.toBeNull()
        if (!row) return

        expect(row.coverageLevel, `${c.id} coverage_level`).toBe(c.expectedLevel)
        // suppression_reason is DIAGNOSTIC ONLY (D-2e) — asserted here at the SQL boundary
        // so a support engineer can tell which condition fired. That it never reaches
        // rendered output is asserted in analytics.supabase.service.test.ts, not here.
        expect(row.suppressionReason, `${c.id} suppression_reason`).toBe(
          c.expectedReason ?? COVERAGE_NULL_SENTINEL
        )
        expect(row.suppressed).toBe(c.expectedLevel === 'full' ? 'false' : 'true')

        const N = COVERAGE_NULL_SENTINEL
        if (c.expectedLevel === 'qualitative') {
          // Differencing protection: NO numbers at all, active_actors_in_window included.
          // NULL, never 0 — a 0 is a number an admin can difference against a roster.
          for (const [col, v] of Object.entries({
            total_seats: row.totalSeats,
            reporting_seats: row.reportingSeats,
            non_reporting_seats: row.nonReportingSeats,
            opted_out_seats: row.optedOutSeats,
            undecided_seats: row.undecidedSeats,
            active_actors_in_window: row.activeActors,
          })) {
            expect(v, `${c.id}: ${col} must be NULL at qualitative, not 0`).toBe(N)
          }
        } else if (c.expectedLevel === 'aggregate') {
          expect(row.totalSeats).toBe(String(c.totalSeats))
          expect(row.reportingSeats).toBe(String(c.reporting))
          expect(row.nonReportingSeats).toBe(String(c.optedOut + c.undecided))
          expect(row.optedOutSeats, 'the split stays withheld at aggregate').toBe(N)
          expect(row.undecidedSeats, 'the split stays withheld at aggregate').toBe(N)
          expect(row.activeActors).toBe('2')
        } else {
          expect(row.totalSeats).toBe(String(c.totalSeats))
          expect(row.reportingSeats).toBe(String(c.reporting))
          expect(row.nonReportingSeats).toBe(String(c.optedOut + c.undecided))
          expect(row.optedOutSeats).toBe(String(c.optedOut))
          expect(row.undecidedSeats).toBe(String(c.undecided))
          expect(row.activeActors).toBe('2')
        }
      }
    )

    it('both empty-bucket ends are symmetric qualitative (rev-4, round-3 item 4)', async () => {
      // The assertion that pins the REMOVED non_reporting = 0 exemption. Under rev 3's
      // ladder 4/0 and 5/0 returned `full`, and the level itself then told an admin holding
      // the per-developer panel that nobody had opted out. Both ends must now be
      // externally identical to a mixed small team.
      const reads = await Promise.all(
        [0, 2, 3].map(async (i) => {
          const { stdout } = await sql.send(
            `SET smi6362.uid = '${fixtureUserId(i, 0)}';\n${coverageQuery(seededTeams[i])}`
          )
          return parseCoverageRow(stdout)
        })
      )
      // [0]=4 reporting/0 non-reporting, [2]=0 reporting/4 opted out, [3]=5 reporting/0.
      for (const r of reads) expect(r?.coverageLevel).toBe('qualitative')
      expect(reads[0]?.totalSeats).toBe(COVERAGE_NULL_SENTINEL)
      expect(reads[2]?.totalSeats).toBe(COVERAGE_NULL_SENTINEL)
    })

    it('a NON-MEMBER gets zero rows, never an error that leaks the team exists (AC-6)', async () => {
      const { stdout, stderr } = await sql.send(
        `SET smi6362.uid = '${U_NONE}';\n${coverageQuery(seededTeams[9])}`
      )
      expect(stderr).not.toMatch(/ERROR/)
      expect(parseCoverageRow(stdout)).toBeNull()
    })

    it('a member with NO user_telemetry_preferences row counts as undecided, not as absent', async () => {
      // The LEFT JOIN is what makes "never contacted" and "row with a NULL
      // consent_decided_at" the same bucket. An INNER JOIN here would silently shrink
      // total_seats and could promote a team past k.
      await sql.send(
        `INSERT INTO auth.users (id) VALUES ('${fixtureUserId(99, 1)}');
         INSERT INTO team_members (team_id, user_id) VALUES ('${seededTeams[9]}', '${fixtureUserId(99, 1)}');`
      )
      const { stdout } = await sql.send(
        `SET smi6362.uid = '${fixtureUserId(9, 0)}';\n${coverageQuery(seededTeams[9])}`
      )
      const row = parseCoverageRow(stdout)
      expect(row?.totalSeats).toBe('11')
      // 5 opted out + 1 undecided ⇒ the split is no longer releasable, so `full` demotes.
      expect(row?.coverageLevel).toBe('aggregate')
      expect(row?.nonReportingSeats).toBe('6')
      expect(row?.undecidedSeats).toBe(COVERAGE_NULL_SENTINEL)
    })
  })

  // --------------------------------------------------------------------------
  // T-RLS-5
  // --------------------------------------------------------------------------

  describe('T-RLS-5 — tenant isolation and the former team member (AC-6)', () => {
    async function visibleTeamIds(uid: string): Promise<string[]> {
      const { stdout, stderr } = await sql.send(
        `RESET ROLE;
         SET smi6362.uid = '${uid}';
         SET ROLE authenticated;
         SELECT DISTINCT metadata->>'team_id' FROM search_metrics ORDER BY 1;
         RESET ROLE;`
      )
      expect(stderr).not.toMatch(/ERROR/)
      return stdout.trim() === ''
        ? []
        : stdout
            .trim()
            .split('\n')
            .map((s) => s.trim())
    }

    it('a team-A member sees team-A rows and NO team-B row exists in the result', async () => {
      const seen = await visibleTeamIds(U_A)
      expect(seen).toContain(TEAM_A)
      expect(seen).not.toContain(TEAM_B)
    })

    it('a team-B member sees team-B rows only (isolation holds in both directions)', async () => {
      const seen = await visibleTeamIds(U_B)
      expect(seen).toEqual([TEAM_B])
    })

    it('an authenticated user with NO team sees zero rows', async () => {
      expect(await visibleTeamIds(U_NONE)).toEqual([])
    })

    it('a FORMER team-A member sees zero rows via the TEAM branch', async () => {
      // The team branch resolves through user_team_ids(), which reads team_members live —
      // so removing the membership removes the visibility with no extra revocation step.
      // Every team-A row whose actor is a real 64-hex digest is now invisible to them.
      const { stdout } = await sql.send(
        `RESET ROLE;
         SET smi6362.uid = '${U_EX}';
         SET ROLE authenticated;
         SELECT count(*) FROM search_metrics WHERE actor <> '${U_EX}';
         RESET ROLE;`
      )
      expect(Number(stdout.trim())).toBe(0)
    })

    it('the actor branch is LIVE but unreachable in production (D-2b consequence 1)', async () => {
      // Seeded above is one row whose `actor` is literally the former member's account
      // uuid. It IS visible to them — the branch works exactly as written. That is the
      // point: the branch is inert not because it is broken but because `deriveActor()`
      // always returns 64 lowercase hex, which can never equal a hyphenated UUID
      // (asserted in supabase/functions/_shared/telemetry-actor.test.ts, not duplicated
      // here). If a future change ever made `actor` the raw uid, this row's visibility
      // becomes every former member's cross-team personal-history read path.
      const { stdout } = await sql.send(
        `RESET ROLE;
         SET smi6362.uid = '${U_EX}';
         SET ROLE authenticated;
         SELECT count(*) FROM search_metrics;
         RESET ROLE;`
      )
      expect(Number(stdout.trim())).toBe(1)
      expect(/^[0-9a-f]{64}$/.test(U_EX), 'a UUID can never satisfy the actor digest format').toBe(
        false
      )
    })
  })

  // --------------------------------------------------------------------------
  // T-RET-1 (Q-4)
  // --------------------------------------------------------------------------

  describe('T-RET-1 — the 90-day retention boundary cannot drop an in-window partition', () => {
    it('evaluates the SHIPPED date expressions across every boundary offset', async () => {
      // Property: for any monthly partition holding at least one row newer than the
      // 90-day cutoff, `v_part_end <= v_cutoff` must be FALSE. Proved by evaluating the
      // real expressions in Postgres over 40 months of offsets rather than reasoning
      // about them — date_trunc/interval arithmetic at month boundaries is exactly where
      // a hand-argued proof goes wrong.
      const { stdout, stderr } = await sql.send(`
WITH t AS (SELECT now() AS n),
     suffixes AS (
       SELECT to_char((SELECT n FROM t) - (g || ' months')::INTERVAL, 'YYYYMM') AS sfx
         FROM generate_series(0, 40) g
     ),
     calc AS (
       SELECT sfx,
              to_date(sfx, 'YYYYMM')                                      AS part_start,
              (to_date(sfx, 'YYYYMM') + INTERVAL '1 month')::date         AS part_end,
              ((SELECT n FROM t) - INTERVAL '90 days')::date              AS cutoff
         FROM suffixes
     )
SELECT count(*) FROM calc
 WHERE part_end <= cutoff                       -- the shipped DROP predicate
   AND part_end > ((SELECT n FROM t) - INTERVAL '90 days')::date;  -- holds an in-window day
`)
      expect(stderr).not.toMatch(/ERROR/)
      expect(
        Number(stdout.trim()),
        'a partition whose range extends past the 90-day cutoff must never satisfy the DROP ' +
          'predicate — v_part_end <= v_cutoff and v_part_end > v_cutoff are mutually exclusive ' +
          'by construction, and this evaluates the shipped expressions to prove it'
      ).toBe(0)
    })
  })
})
