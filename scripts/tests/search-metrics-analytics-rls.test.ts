/**
 * @fileoverview SMI-6362 — RLS, grant, k-anonymity-coverage and retention-boundary
 * assertions for the cloud usage-analytics surface.
 *
 * Sibling of `scripts/tests/private-registry-rls.test.ts` (the convention this file
 * follows) and named by the plan's own Test-coverage-plan rows:
 * `docs/internal/implementation/smi-6362-cloud-usage-analytics.md` § Test coverage plan,
 * rows "Migration text / RLS / grants" and "Retention boundary (Q-4)".
 *
 * TWO HALVES, WITH DIFFERENT STRENGTHS — stated up front so a green run is never
 * over-cited:
 *
 *  1. STATIC (always runs, no database). T-RLS-1..4/6/7, T-GRANT-1/2, T-PROV-1's static
 *     half, and the k-constant coupling check assert against the shipped migration and
 *     TypeScript text. These prove the DECLARATIONS are right — that no RPC was flipped
 *     to SECURITY DEFINER, that the policy predicate is unchanged, that the grants say
 *     what they must. They cannot prove enforcement.
 *
 *  2. LIVE POSTGRES — lives in the sibling `search-metrics-analytics-rls.pg.test.ts`,
 *     following this repo's existing `*.pg.test.ts` convention for env-gated suites that
 *     need a real database (`scripts/tests/supabase/purge-departed-toctou.pg.test.ts`,
 *     `inventory-device-lock.pg.test.ts`). T-RLS-5, T-COVERAGE-1..11 and T-RET-1's
 *     boundary half execute the SHIPPED function bodies and the SHIPPED RLS policy there.
 *     Split out of this file rather than inlined because the two halves have genuinely
 *     different run conditions (CI runs this one and skips that one) and because the
 *     combined file exceeded the 500-line gate. Read them as one suite.
 *
 * DELIBERATELY NOT DUPLICATED HERE (each already covered, better, where it lives):
 *  - The 64-lowercase-hex actor format that makes the `actor = auth.uid()::TEXT` branch
 *    inert — `supabase/functions/_shared/telemetry-actor.test.ts` ("is 64 lowercase hex
 *    characters"). T-RLS-7 below asserts the other half of that pairing: that the branch
 *    itself is still present and unchanged in the policy.
 *  - The renderer half of AC-9 (a `qualitative` note contains no digits; no
 *    suppression_reason enum value ever reaches rendered output; 4/0 and 4/1 render
 *    identically because both collapse to the same all-NULL `qualitative` row) —
 *    `packages/mcp-server/src/tools/analytics.supabase.service.test.ts` § buildCoverageNote.
 *    This file asserts the RPC-side input to that renderer instead.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { computeExpectedCoverage } from '../e2e-smi6362-analytics-fixtures.js'
import {
  AC9_MATRIX,
  ANALYTICS_RPCS,
  K_ANONYMITY_FLOOR,
  POLICY_PREDICATE_PARENT,
  RESOLVE_IDENTITY_SIG,
  TEAM_HELPERS_MIGRATION,
  functionHeader,
  grantFactsFor,
  loadMigrations,
  migrationsRedefiningUserTeamIds,
} from './search-metrics-analytics-rls.helpers.ts'

const MIGRATIONS = loadMigrations()

// ============================================================================
// T-RLS-1..4 — policy shape, security mode, search_path form
// ============================================================================

describe('T-RLS-1..4 — search_metrics RLS + analytics RPC security declarations', () => {
  it('locates every migration this suite asserts against', () => {
    // Filenames stay plaintext under git-crypt, so this holds in both lock states.
    expect(MIGRATIONS).toBeDefined()
  })

  if (MIGRATIONS.locked) return // post-merge-verify.yml, by design (SMI-4221/SMI-5984)
  const { wiring, parentTable, partitionRls } = MIGRATIONS

  it('T-RLS-1: the parent table enables RLS and carries search_metrics_team_scoped_read', () => {
    expect(parentTable.flat).toContain('ALTER TABLE search_metrics ENABLE ROW LEVEL SECURITY')
    expect(parentTable.flat).toContain(
      'CREATE POLICY search_metrics_team_scoped_read ON search_metrics FOR SELECT TO authenticated'
    )
  })

  it('T-RLS-2: the parent policy predicate is exactly the D-2 two-branch USING clause', () => {
    // Both branches, verbatim. A future edit that drops the team branch, widens it to
    // USING (true), or replaces the SECURITY DEFINER helper fails here at PR time.
    expect(parentTable.flat).toContain(POLICY_PREDICATE_PARENT)
    expect(parentTable.flat).not.toContain('FOR SELECT TO authenticated USING (true)')
  })

  it('T-RLS-3: partitions get the SAME policy — pg_policies is per-table, not inherited', () => {
    // SMI-5202: PostgreSQL propagates neither rowsecurity nor policies to children, so
    // every partition needs its own copy. Both the backfill loop and the ongoing
    // cleanup_search_metrics() creator must build the identical predicate.
    const perPartition =
      "'CREATE POLICY search_metrics_team_scoped_read ON %I ' " +
      "'FOR SELECT TO authenticated ' " +
      "'USING (actor = auth.uid()::TEXT OR metadata->>%L IN (SELECT public.user_team_ids()))'"
    const occurrences = partitionRls.flat.split(perPartition).length - 1
    expect(
      occurrences,
      'expected the per-partition policy DDL twice: once in the existing-partition backfill ' +
        'loop, once inside cleanup_search_metrics() for partitions the cron creates later'
    ).toBe(2)
    expect(partitionRls.flat).toContain('ENABLE ROW LEVEL SECURITY')
  })

  it.each(ANALYTICS_RPCS)(
    'T-RLS-4: $name is declared SECURITY $security with SET search_path in the `=` form',
    ({ name, security }) => {
      const header = functionHeader(wiring.raw, name)
      expect(header, `${name} header`).toContain(`SECURITY ${security}`)
      const forbidden = security === 'INVOKER' ? 'SECURITY DEFINER' : 'SECURITY INVOKER'
      expect(header, `${name} must not be ${forbidden}`).not.toContain(forbidden)
      // `SET search_path TO public` is silently dropped from pg_proc.proconfig by
      // Supabase's linter contract — the `=` form is the one that populates it.
      expect(header).toMatch(/SET search_path = public/)
      expect(header).not.toMatch(/SET search_path TO /)
    }
  )

  it('T-RLS-4b: resolve_telemetry_identity is SECURITY DEFINER with the `=` search_path form', () => {
    const header = functionHeader(wiring.raw, 'public.resolve_telemetry_identity')
    expect(header).toContain('SECURITY DEFINER')
    expect(header).toMatch(/SET search_path = public, pg_temp/)
  })

  it('T-RLS-4c: exactly two functions in this migration are SECURITY DEFINER by design', () => {
    // D-2c: everything else must stay INVOKER so search_metrics_team_scoped_read remains
    // the authorization boundary rather than p_team_id. get_team_usage_for_period is the
    // pre-existing DEFINER sibling this migration repoints (item 8), not a new one.
    const definerFns = [...wiring.raw.matchAll(/CREATE OR REPLACE FUNCTION\s+([\w.]+)\s*\(/g)]
      .map((m) => m[1])
      .filter((fn) => functionHeader(wiring.raw, fn).includes('SECURITY DEFINER'))
    expect(new Set(definerFns)).toEqual(
      new Set([
        'public.analytics_team_reporting_coverage',
        'public.resolve_telemetry_identity',
        'get_team_usage_for_period',
      ])
    )
  })

  it('T-RLS-4d: the UUID-typed p_team_id overloads are explicitly DROPped before recreation', () => {
    // A parameter-type change creates a NEW overload; without these drops PostgREST
    // returns 300 Multiple Choices on every call.
    for (const drop of [
      'DROP FUNCTION IF EXISTS public.analytics_skill_top(UUID, INT);',
      'DROP FUNCTION IF EXISTS public.analytics_skill_stale(UUID, INT, INT);',
      'DROP FUNCTION IF EXISTS public.analytics_skill_cooccurrence(UUID, INT);',
    ]) {
      expect(wiring.flat).toContain(drop)
    }
  })
})

// ============================================================================
// T-RLS-6 — cleanup_search_metrics() keeps creating RLS + policy on new partitions
// ============================================================================

describe('T-RLS-6 — cleanup_search_metrics() still hardens the partitions it creates', () => {
  if (MIGRATIONS.locked) return
  const { partitionRls, wiring } = MIGRATIONS

  it('the shipped body enables RLS and creates the policy on the next-month partition', () => {
    const body = partitionRls.flat
    expect(body).toContain('CREATE OR REPLACE FUNCTION cleanup_search_metrics()')
    expect(body).toContain(
      "EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_next_name)"
    )
    expect(body).toContain("policyname = 'search_metrics_team_scoped_read'")
  })

  it('SMI-6362 deliberately left cleanup_search_metrics() unchanged (D-2d / W1-V4)', () => {
    // Rev 1 claimed the new indexes had to be added here too; that was retracted after
    // catalog verification showed PostgreSQL propagates partitioned-index children
    // automatically. If a future author re-adds index DDL here, this fails and they have
    // to re-read D-2d rather than re-litigating it silently.
    expect(wiring.raw).not.toMatch(/CREATE OR REPLACE FUNCTION\s+cleanup_search_metrics/)
    expect(wiring.flat).toContain('cleanup_search_metrics() -- NOT changed')
  })
})

// ============================================================================
// T-RLS-7 — the actor = auth.uid()::TEXT branch is present, unchanged, and inert
// ============================================================================

describe('T-RLS-7 — the self-read branch is unchanged and documented-inert (D-2b consequence 1)', () => {
  if (MIGRATIONS.locked) return
  const { parentTable } = MIGRATIONS

  it('the branch is still literally present in the policy predicate', () => {
    // Inertness is a PAIR of facts, and this file owns only the first:
    //   (a) the policy still compares `actor` to the raw account uuid — asserted here;
    //   (b) `actor` is always a 64-lowercase-hex HMAC digest, which can never equal a
    //       hyphenated UUID — asserted in supabase/functions/_shared/telemetry-actor.test.ts
    //       ("is 64 lowercase hex characters"), NOT duplicated here.
    // Deleting (a) would silently change the policy's shape; breaking (b) would put raw
    // account identifiers in a table team admins read. Each test guards its own half.
    expect(parentTable.flat).toContain('actor = auth.uid()::TEXT')
  })

  it("user_team_ids() — the branch's team resolver — is still defined by 071 and nothing later", () => {
    // The live half (T-RLS-5) pins its user_team_ids() extraction to 071 because
    // `extractLatestFunction` does not mask SQL comments, and 074's documented,
    // NOT-auto-applied rollback block contains the literal phrase
    // `-- CREATE OR REPLACE FUNCTION user_team_ids(uid UUID)`. This guard makes the pin
    // self-invalidating: if a later migration ever genuinely redefines the function, this
    // fails and the pin has to be revisited rather than silently testing a stale body.
    expect(migrationsRedefiningUserTeamIds()).toEqual([
      '070_webhook_dead_letters.sql', // superseded UUID overload, DROPped by 074
      TEAM_HELPERS_MIGRATION, // 071 — the shipped no-args form
    ])
  })

  it('the policy comment records that all writes go via service_role (no write policies)', () => {
    // Asserted as two fragments because the COMMENT is built from concatenated SQL string
    // literals, so the sentence is interrupted by a `' '` boundary in the file text.
    expect(parentTable.flat).toContain('All writes go via service_role (BYPASSRLS); no ')
    expect(parentTable.flat).toContain('INSERT/UPDATE/DELETE policies exist.')
    // The read policy is the ONLY policy: a write policy here would let an authenticated
    // client forge telemetry rows that the read policy then serves back as team data.
    expect(parentTable.raw).not.toMatch(
      /CREATE POLICY[^;]*ON search_metrics[^;]*FOR\s+(INSERT|UPDATE|DELETE|ALL)\b/i
    )
  })
})

// ============================================================================
// T-GRANT-1 / T-GRANT-2
// ============================================================================

describe('T-GRANT-1 — the five analytics RPCs are authenticated-only', () => {
  if (MIGRATIONS.locked) return
  const { wiring } = MIGRATIONS

  it.each(ANALYTICS_RPCS)(
    '$sig: EXECUTE to authenticated, revoked from PUBLIC and anon',
    ({ sig }) => {
      const { revokedFrom, grantedTo } = grantFactsFor(wiring.raw, sig)
      expect(revokedFrom, `${sig} REVOKE`).toEqual(expect.arrayContaining(['public', 'anon']))
      expect(grantedTo, `${sig} GRANT`).toEqual(['authenticated'])
      expect(grantedTo).not.toContain('anon')
      expect(grantedTo).not.toContain('public')
    }
  )
})

describe('T-GRANT-2 — resolve_telemetry_identity is UNREACHABLE from PostgREST', () => {
  if (MIGRATIONS.locked) return
  const { wiring } = MIGRATIONS

  // SCOPE OF THIS TEST, STATED IN ITS OWN NAME AND BODY (plan AC-6, round-2 required
  // change #1). It proves REACHABILITY: no PostgREST role can invoke the function. It
  // proves NOTHING about `p_user_id` PROVENANCE — a service_role caller passing an
  // arbitrary user id passes this test unchanged, and would receive that user's team
  // membership and consent state. Provenance is a call-site invariant (D-2f rules 1-5)
  // proved behaviourally by N-7 in supabase/functions/events. A green run here must
  // never be cited as covering the confused-deputy case.
  it('proves REACHABILITY ONLY (service_role-only; NOT p_user_id provenance — see N-7)', () => {
    const { revokedFrom, grantedTo } = grantFactsFor(wiring.raw, RESOLVE_IDENTITY_SIG)
    expect(revokedFrom).toEqual(expect.arrayContaining(['public', 'anon', 'authenticated']))
    expect(grantedTo).toEqual(['service_role'])
    for (const role of ['authenticated', 'anon', 'public']) {
      expect(
        grantedTo,
        `resolve_telemetry_identity must not be EXECUTE-able by ${role}; this assertion is ` +
          'about reachability from PostgREST, not about which p_user_id a service_role ' +
          'caller may pass (D-2f, proved by N-7)'
      ).not.toContain(role)
    }
  })

  it('the shipped SQL header states the function self-authorizes nothing', () => {
    expect(wiring.flat).toContain('THIS FUNCTION SELF-AUTHORIZES NOTHING')
  })
})

// ============================================================================
// T-PROV-1 (static half) — single call site + user_id absent from the allowlist
// ============================================================================

describe('T-PROV-1 static half — p_user_id provenance preconditions (D-2f rules 1 & 4)', () => {
  const IDENTITY_MODULE = 'supabase/functions/_shared/telemetry-identity.ts'
  const ROW_BUILDER = 'supabase/functions/events/row-builder.ts'

  it('resolve_telemetry_identity has exactly ONE non-test RPC call site', () => {
    // DISCREPANCY WITH THE PLAN TEXT, resolved here rather than deferred. AC-6 writes this
    // rule as the literal shell command
    //   grep -rn "resolve_telemetry_identity" supabase/functions/ --include="*.ts" | grep -v _tests_
    // and asserts it "returns exactly one line". That command cannot ever return one line
    // against the shipped tree: it returns 11, because (a) telemetry-identity.ts documents
    // the invariant in five prose comments naming the function, and (b) `grep -v _tests_`
    // does not exclude co-located `*.test.ts` files (telemetry-identity.test.ts,
    // events/index.test.ts), which live beside their source rather than in a `_tests_`
    // directory. The INTENT — "a second caller fails the build rather than passing review"
    // — is what is asserted: exactly one non-test site that actually INVOKES the RPC.
    const call = /\.rpc\(\s*['"]resolve_telemetry_identity['"]/g
    const files = grepFiles('supabase/functions', /\.ts$/).filter(
      (f) => !/\.test\.ts$/.test(f) && !f.includes('/_tests_/')
    )
    const sites = files.flatMap((f) => {
      const hits = readFileSync(f, 'utf8').match(call) ?? []
      return hits.map(() => f)
    })
    expect(
      sites,
      'D-2f rule 4: a second service-role caller inherits the provenance invariant and must ' +
        'prove it, or needs its own function with its own argument discipline'
    ).toEqual([IDENTITY_MODULE])
  })

  it("`user_id` is absent from sanitizeMetadata's allowlist (D-2f consequence 1)", () => {
    // Adding it — for any reason, including a plausible "let the client tell us who it is
    // for debugging" — converts D-2f rule 2 from structurally-true to merely-currently-true.
    const src = readFileSync(ROW_BUILDER, 'utf8')
    const start = src.indexOf('const allowed')
    expect(start, `no 'const allowed' allowlist found in ${ROW_BUILDER}`).toBeGreaterThan(-1)
    const allowlist = src.slice(start, src.indexOf(']', start))
    expect(allowlist).not.toMatch(/['"]user_id['"]/)
    expect(allowlist).not.toMatch(/['"]team_id['"]/) // D-2a: server-stamped, never client-sent
    expect(allowlist).toMatch(/['"]tool_name['"]/) // the one key SMI-6362 legitimately added
  })
})

// ============================================================================
// k-anonymity coupling — SQL constant, TS mirror, and the rendered sentence agree
// ============================================================================

describe('k-anonymity coupling — raising k cannot leave the copy or the mirror lying', () => {
  const NOTE_HELPERS = 'packages/mcp-server/src/tools/analytics.supabase.service.helpers.ts'
  const NUMBER_WORDS: Record<number, string> = { 4: 'four', 5: 'five', 6: 'six', 7: 'seven' }

  it('the SQL body declares v_k = the expected floor', () => {
    if (MIGRATIONS.locked) return
    expect(MIGRATIONS.wiring.flat).toContain(`v_k CONSTANT INT := ${K_ANONYMITY_FLOOR};`)
  })

  it("buildCoverageNote's qualitative sentence spells the SAME threshold in words", () => {
    // The sentence must stay digit-free (a literal "5" would defeat the "no digits at a
    // qualitative level" assertion in analytics.supabase.service.test.ts), so the coupling
    // has to be checked against the word form.
    const word = NUMBER_WORDS[K_ANONYMITY_FLOOR]
    const src = readFileSync(NOTE_HELPERS, 'utf8')
    expect(src).toContain(
      `Coverage is shown only when at least ${word} seats are reporting and at least ${word} are not.`
    )
  })

  it("the staging harness's computeExpectedCoverage mirror agrees with the SQL ladder on all 11 AC-9 rows", () => {
    // scripts/e2e-smi6362-analytics-roundtrip.ts cross-checks the LIVE RPC against this
    // pure TS mirror. Nothing else pins the mirror itself, so a drift in it would silently
    // weaken that harness into agreeing with whatever the RPC returned.
    for (const c of AC9_MATRIX) {
      const members = [
        ...Array.from({ length: c.reporting }, () => 'enabled_decided' as const),
        ...Array.from({ length: c.optedOut }, () => 'disabled_decided' as const),
        ...Array.from({ length: c.undecided }, () => 'undecided' as const),
      ].map((consent, i) => ({ key: `m${i}`, email: `m${i}@test`, consent }))
      expect(members).toHaveLength(c.totalSeats)
      expect(computeExpectedCoverage(members).level, c.id).toBe(c.expectedLevel)
    }
  })
})

// ============================================================================
// T-RET-1 (static half) — the shipped retention comparison is unchanged
// ============================================================================

describe('T-RET-1 (static) — cleanup_search_metrics() still compares v_part_end <= v_cutoff', () => {
  it('the shipped comparison is still `v_part_end <= v_cutoff` against a 90-day cutoff', () => {
    if (MIGRATIONS.locked) return
    const body = MIGRATIONS.partitionRls.flat
    expect(body).toContain("v_cutoff := (NOW() - INTERVAL '90 days')::date;")
    expect(body).toContain(
      "v_part_end DATE := (to_date(v_suffix, 'YYYYMM') + INTERVAL '1 month')::date;"
    )
    expect(body).toContain('IF v_part_end <= v_cutoff THEN')
    // A `<` here, or a v_part_START comparison, would drop a partition still holding
    // in-window rows. Both are the mistake this boundary test exists to catch.
    expect(body).not.toContain('IF v_part_start <= v_cutoff THEN')
  })

  it('the SMI-5202 rewrite kept the boundary byte-identical to the original (20260519000004)', () => {
    if (MIGRATIONS.locked) return
    // cleanup_search_metrics() is defined twice: 20260519000004 introduced it, and
    // 20260526000001 CREATE OR REPLACEs it to add per-partition RLS. That rewrite was
    // supposed to touch only the RLS half. Comparing the retention expressions across
    // both definitions proves it did — a retention semantics change smuggled into an RLS
    // migration is exactly the kind of edit no reviewer of either diff would catch alone.
    for (const expr of [
      "v_cutoff := (NOW() - INTERVAL '90 days')::date;",
      "v_part_end DATE := (to_date(v_suffix, 'YYYYMM') + INTERVAL '1 month')::date;",
      'IF v_part_end <= v_cutoff THEN',
    ]) {
      expect(MIGRATIONS.retention.flat, `original definition: ${expr}`).toContain(expr)
      expect(MIGRATIONS.partitionRls.flat, `SMI-5202 rewrite: ${expr}`).toContain(expr)
    }
  })
})

// ============================================================================
// Local helper
// ============================================================================

/** Recursively list files under `dir` whose basename matches `match`. */
function grepFiles(dir: string, match: RegExp): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...grepFiles(p, match))
    else if (match.test(e.name)) out.push(p)
  }
  return out
}
