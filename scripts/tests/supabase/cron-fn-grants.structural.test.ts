/**
 * SMI-7075 -- PG-FREE guard: every public function a `cron.schedule(...)` calls must, by the end of
 * the migration sequence, have EXECUTE revoked from PUBLIC, anon AND authenticated, and no later
 * statement may re-grant any of them. Postgres gives every new function an implicit PUBLIC grant and
 * Supabase adds explicit anon/authenticated ones, so `REVOKE ... FROM anon` alone leaves the function
 * callable over PostgREST. Gate: git-crypt lock state (SMI-5984) -- declared lock skips, undeclared throws.
 *
 * THIS IS A TRIPWIRE, NOT A SECURITY PROOF. It replays migration text in filename order; it cannot see
 * dynamic SQL or the live catalog (the migration's own smoke block checks that). Each predicate is
 * paired with a known-negative so a checker that sees nothing cannot pass silently.
 *
 * @module scripts/tests/supabase/cron-fn-grants.structural
 */

import { describe, it, expect } from 'vitest'
import { allMigrationFiles, readMigrationText } from '../lib/migration-text-guards.ts'
import { splitStatements, stripComments } from '../lib/sql-statement-guards.ts'
import {
  cronCalledFunctions,
  cronFnGrantViolations,
  orderedStatements,
  type MigrationFile,
  UNICODE_ESCAPE_SENTINEL,
} from './cron-fn-grants.test-helpers.ts'

const NEW_MIGRATION = '20261011000000_lockdown_cron_fn_grants.sql'
// SMI-7114: its two cron-called functions are picked up by the extractor; the third (the observer's
// read RPC) is not cron-called, so its revoke is asserted by name, as check_scan_coverage's is.
const REFRESH_MIGRATION = '20261013000000_skills_refresh_metadata_pg_cron.sql'
const REFRESH_CRON_FNS = ['invoke_skills_refresh_metadata', 'check_refresh_observer_heartbeat']
const REFRESH_RPC = 'refresh_metadata_health'

// Measured live from staging cron.job on 2026-10-11.
const MEASURED_CRON_FNS = [
  'cleanup_anon_usage',
  'cleanup_expired_pending_checkouts',
  'cleanup_expired_pending_keys',
  'cleanup_expired_team_invitations',
  'cleanup_old_audit_logs',
  'cleanup_search_metrics',
  'cleanup_trial_usage',
  'cleanup_user_api_usage',
  'cleanup_webhook_dead_letters',
  'compute_status_daily_rollups',
  'expire_stale_sso_members',
  'invoke_indexer_lock_starvation_monitor',
  'invoke_quota_monitor',
  'invoke_registry_audit_volume_monitor',
  'invoke_release_cadence_heartbeat_monitor',
  'invoke_scan_coverage_monitor',
  'invoke_sso_domain_reverify',
  'invoke_status_check',
  'invoke_webhook_heartbeat_monitor',
  'purge_departed_team_members_inventory',
  'purge_status_checks',
]

// The seven staging flagged before this migration (read-only query, 2026-10-11).
const MEASURED_EXPOSED = [
  'compute_status_daily_rollups',
  'invoke_indexer_lock_starvation_monitor',
  'invoke_release_cadence_heartbeat_monitor',
  'invoke_scan_coverage_monitor',
  'invoke_sso_domain_reverify',
  'invoke_status_check',
  'purge_status_checks',
]

const loaded = allMigrationFiles().map((name) => ({ name, sql: readMigrationText(name) }))
const locked = loaded.some((f) => f.sql === null)
const corpus: MigrationFile[] = locked ? [] : loaded.map((f) => ({ name: f.name, sql: f.sql! }))
const without = corpus.filter((f) => f.name !== NEW_MIGRATION)

const fnNames = (files: MigrationFile[]) => cronFnGrantViolations(files).map((v) => v.fn)

/** One cron function `foo`, created in 001, then `extra` statements in 002. */
function synthetic(
  extra: string,
  create = 'CREATE FUNCTION public.foo() RETURNS void AS $$ SELECT 1 $$ LANGUAGE sql;'
) {
  return [
    {
      name: '001.sql',
      sql: `${create}\nSELECT cron.schedule('j', '* * * * *', $$SELECT public.foo()$$);`,
    },
    { name: '002.sql', sql: extra },
  ]
}
const ALL3 = 'REVOKE EXECUTE ON FUNCTION public.foo() FROM PUBLIC, anon, authenticated;'

describe.skipIf(locked)('SMI-7075 -- cron-called functions are locked to non-API roles', () => {
  it('presence: the extractor finds the 21 cron-called functions measured on staging', () => {
    expect(corpus.length, 'migrations were actually read').toBeGreaterThan(100)
    const found = cronCalledFunctions(orderedStatements(corpus))
    const missing = MEASURED_CRON_FNS.filter((f) => !found.has(f))
    expect(missing, 'measured cron functions the extractor missed').toEqual([])
  })

  it('full corpus: no cron-called function is executable by PUBLIC, anon or authenticated', () => {
    expect(cronFnGrantViolations(corpus)).toEqual([])
  })

  it('known-negative: without the SMI-7075 migration, exactly the seven measured-exposed functions fail', () => {
    expect(
      corpus.some((f) => f.name === NEW_MIGRATION),
      'new migration present'
    ).toBe(true)
    expect(fnNames(without)).toEqual(MEASURED_EXPOSED)
  })

  it('check_scan_coverage (not cron-called) is revoked from all three roles by the new migration', () => {
    const revokes = (files: MigrationFile[]) =>
      files
        .flatMap((f) => splitStatements(stripComments(f.sql)))
        .filter((s) =>
          /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.check_scan_coverage\s*\(\s*INT\s*\)\s+FROM\s+PUBLIC\s*,\s*anon\s*,\s*authenticated\b/i.test(
            s
          )
        )
    const mine = corpus.filter((f) => f.name === NEW_MIGRATION)
    expect(revokes(mine)).toHaveLength(1)
    expect(revokes(without), 'known-negative: earlier migrations never did').toHaveLength(0)
  })
})

describe.skipIf(locked)('SMI-7114 -- the refresh functions are covered by the grants guard', () => {
  const mine = () => corpus.filter((f) => f.name === REFRESH_MIGRATION)
  const without7114 = () => corpus.filter((f) => f.name !== REFRESH_MIGRATION)

  it('presence: the extractor finds both new cron-called functions, and neither is a violation', () => {
    expect(mine(), 'refresh migration present').toHaveLength(1)
    const found = cronCalledFunctions(orderedStatements(corpus))
    for (const fn of REFRESH_CRON_FNS) expect(found.has(fn), `${fn} extracted`).toBe(true)
    expect(fnNames(corpus).filter((f) => REFRESH_CRON_FNS.includes(f))).toEqual([])
  })

  it('known-negative: with the migration present but its revokes removed, both are flagged', () => {
    const stripped = mine().map((f) => ({
      ...f,
      sql: f.sql.replace(/REVOKE EXECUTE ON FUNCTION public\.[^;]*;/g, ''),
    }))
    const flagged = fnNames([...without7114(), ...stripped])
    for (const fn of REFRESH_CRON_FNS) expect(flagged, `${fn} flagged`).toContain(fn)
  })

  it('refresh_metadata_health (not cron-called) is revoked from all three roles exactly once', () => {
    const re = new RegExp(
      `REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${REFRESH_RPC}\\s*\\(\\s*interval\\s*\\)\\s+FROM\\s+PUBLIC\\s*,\\s*anon\\s*,\\s*authenticated\\b`,
      'i'
    )
    const revokes = (files: MigrationFile[]) =>
      files.flatMap((f) => splitStatements(stripComments(f.sql))).filter((s) => re.test(s))
    expect(revokes(mine())).toHaveLength(1)
    expect(revokes(without7114()), 'known-negative: no other migration does').toHaveLength(0)
  })
})

describe('SMI-7075 -- checker mutation cases (synthetic corpora)', () => {
  const flagged = (files: MigrationFile[]) => fnNames(files)

  it('anon-only revoke is flagged', () => {
    expect(flagged(synthetic('REVOKE EXECUTE ON FUNCTION public.foo() FROM anon;'))).toEqual([
      'foo',
    ])
  })
  it('PUBLIC + anon without authenticated is flagged, and says which role', () => {
    const v = cronFnGrantViolations(
      synthetic('REVOKE EXECUTE ON FUNCTION public.foo() FROM PUBLIC, anon;')
    )
    expect(v).toHaveLength(1)
    expect(v[0].reason).toMatch(/not revoked from authenticated\b/)
  })
  it('all three revoked is clean (control)', () => {
    expect(flagged(synthetic(ALL3))).toEqual([])
  })
  it('a later GRANT to anon re-opens it', () => {
    const v = cronFnGrantViolations(
      synthetic(`${ALL3}\nGRANT EXECUTE ON FUNCTION public.foo() TO anon;`)
    )
    expect(v.map((x) => x.fn)).toEqual(['foo'])
    expect(v[0].reason).toMatch(/re-granted to anon/)
  })
  it('DROP then CREATE resets the ACL: flagged', () => {
    const redo =
      'DROP FUNCTION public.foo();\nCREATE FUNCTION public.foo() RETURNS void AS $$ SELECT 1 $$ LANGUAGE sql;'
    expect(flagged(synthetic(`${ALL3}\n${redo}`))).toEqual(['foo'])
  })
  it('CREATE OR REPLACE keeps the ACL: not flagged', () => {
    const replace =
      'CREATE OR REPLACE FUNCTION public.foo() RETURNS void AS $$ SELECT 2 $$ LANGUAGE sql;'
    expect(flagged(synthetic(`${ALL3}\n${replace}`))).toEqual([])
  })
  it('a revoke placed BEFORE the CREATE is flagged', () => {
    const files = [
      { name: '001.sql', sql: ALL3 },
      ...synthetic(
        '',
        'CREATE FUNCTION public.foo() RETURNS void AS $$ SELECT 1 $$ LANGUAGE sql;'
      ).map((f, i) => ({ ...f, name: `00${i + 2}.sql` })),
    ]
    expect(flagged(files)).toEqual(['foo'])
  })
  it('a cron-called function with no CREATE anywhere is reported, not skipped', () => {
    const v = cronFnGrantViolations([
      { name: '001.sql', sql: "SELECT cron.schedule('j','* * * * *',$$SELECT public.ghost()$$);" },
    ])
    expect(v).toEqual([{ fn: 'ghost', reason: expect.stringMatching(/no CREATE FUNCTION/) }])
  })
  it('a function whose last event is a DROP no longer exists: excluded', () => {
    expect(flagged(synthetic('DROP FUNCTION public.foo();'))).toEqual([])
  })
  it('a cron.schedule inside a -- comment contributes nothing', () => {
    const sql =
      "-- SELECT cron.schedule('j','* * * * *',$$SELECT public.foo()$$);\nCREATE FUNCTION public.foo() RETURNS void AS $$ SELECT 1 $$ LANGUAGE sql;"
    expect(cronCalledFunctions(orderedStatements([{ name: '001.sql', sql }])).size).toBe(0)
  })
  it('PERFORM cron.schedule in a DO block with a single-quoted command is extracted', () => {
    const sql = "DO $do$ BEGIN PERFORM cron.schedule('j', '0 * * * *', 'SELECT foo()'); END $do$;"
    expect([...cronCalledFunctions(orderedStatements([{ name: '001.sql', sql }]))]).toEqual(['foo'])
  })
  // Postgres identifier rules, measured on staging 2026-10-11: unquoted folds case, quoted is exact.
  it('unquoted uppercase and quoted lowercase grantees count', () => {
    expect(
      flagged(
        synthetic('REVOKE EXECUTE ON FUNCTION public.foo() FROM "public", ANON, "authenticated";')
      )
    ).toEqual([])
  })
  it('quoted "PUBLIC" and "Anon" are other roles, not PUBLIC/anon: flagged', () => {
    for (const bad of ['"PUBLIC", anon, authenticated', 'PUBLIC, "Anon", authenticated']) {
      expect(flagged(synthetic(`REVOKE EXECUTE ON FUNCTION public.foo() FROM ${bad};`))).toEqual([
        'foo',
      ])
    }
  })
  it('REVOKE ... ON ALL FUNCTIONS IN SCHEMA public covers it, and a later schema-wide GRANT re-opens it', () => {
    const all = 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;'
    expect(flagged(synthetic(all))).toEqual([])
    expect(
      flagged(
        synthetic(`${all}\nGRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;`)
      )
    ).toEqual(['foo'])
  })
  // SMI-7075 cross-family review, finding 1: GRANT OPTION FOR leaves EXECUTE in place.
  it('REVOKE GRANT OPTION FOR (function or schema-wide) is not a revoke: flagged', () => {
    for (const stmt of [
      'REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION public.foo() FROM PUBLIC, anon, authenticated;',
      'REVOKE GRANT OPTION FOR ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;',
    ]) {
      expect(flagged(synthetic(stmt))).toEqual(['foo'])
    }
  })
  // Finding 2: the replay keeps one ACL per name, so an overloaded name fails closed.
  it('an overloaded cron-called name fails closed even when one overload is revoked', () => {
    const v = cronFnGrantViolations(
      synthetic(
        'CREATE FUNCTION public.foo(integer) RETURNS void AS $$ SELECT 1 $$ LANGUAGE sql;\n' +
          'REVOKE EXECUTE ON FUNCTION public.foo(integer) FROM PUBLIC, anon, authenticated;'
      )
    )
    expect(v).toEqual([{ fn: 'foo', reason: expect.stringMatching(/^overloaded/) }])
  })
  // Finding 3: a quoted name is exact. A quoted lower-case name is the same function; any other
  // quoted name cannot be verified by this guard and fails closed.
  it('a quoted lower-case cron call is the same function and is verified normally', () => {
    const files = synthetic(ALL3).map((f, i) =>
      i === 0
        ? { ...f, sql: f.sql.replace('$$SELECT public.foo()$$', '$$SELECT "public"."foo"()$$') }
        : f
    )
    expect(cronCalledFunctions(orderedStatements(files))).toEqual(new Set(['foo']))
    expect(flagged(files)).toEqual([])
  })
  it('a quoted mixed-case cron call fails closed', () => {
    const v = cronFnGrantViolations([
      {
        name: '001.sql',
        sql: `CREATE FUNCTION public."Foo"() RETURNS void AS $$ SELECT 1 $$ LANGUAGE sql;\nSELECT cron.schedule('Foo', '* * * * *', $$SELECT public."Foo"()$$);`,
      },
    ])
    expect(v).toEqual([
      { fn: 'Foo', reason: expect.stringMatching(/not a case-folded identifier/) },
    ])
  })
  // Round 2: a Unicode-escaped identifier can spell any name or schema; it fails closed.
  it('a U&"..." identifier in a cron command fails closed, as the name or as the schema', () => {
    for (const call of ['public.U&"\\0046oo"()', 'U&"\\0070ublic".foo()']) {
      const files = synthetic(ALL3).map((f, i) =>
        i === 0 ? { ...f, sql: f.sql.replace('$$SELECT public.foo()$$', `$$SELECT ${call}$$`) } : f
      )
      expect(fnNames(files)).toEqual([UNICODE_ESCAPE_SENTINEL])
    }
  })
  it('a revoke naming a different function does not cover foo', () => {
    expect(
      flagged(
        synthetic('REVOKE EXECUTE ON FUNCTION public.foobar() FROM PUBLIC, anon, authenticated;')
      )
    ).toEqual(['foo'])
  })
})
