/**
 * SMI-6114 / SMI-6669 -- the PG-FREE half of the attempt-RPC suite. It reads migration text only,
 * carries no Postgres gate and runs everywhere. Its one gate is `migrationTextLocked()` (SMI-5984):
 * on a declared git-crypt-locked checkout the migration is ciphertext and the suite skips; an
 * UNDECLARED lock throws, so a real unlock failure cannot hide inside a skip.
 *
 * THIS IS A TRIPWIRE, NOT A SECURITY PROOF. Text checks are lexical stand-ins for properties only
 * the live-Postgres half (.pg.test.ts) proves. What this half adds that the live half cannot: it
 * runs where there is no database, and it proves every revert anchor in
 * `private-registry-audit-attempt.test-reverts.ts` still matches the shipped text exactly once --
 * a drifted anchor would otherwise surface only when someone has a database to hand.
 *
 * @module scripts/tests/supabase/private-registry-audit-attempt.structural
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ACCEPTED,
  NEW_MIGRATION,
  REFUSED,
  migrationSql,
  migrationTextLocked,
} from './private-registry-audit-attempt.test-helpers.ts'
import {
  brokenMigrationSql,
  type RevertVariant,
} from './private-registry-audit-attempt.test-reverts.ts'
import { extractFunction } from './pg-session.ts'
import { stripComments } from '../lib/sql-statement-guards.ts'

const RPC = 'public.record_private_registry_audit_attempt'
const MON = 'public.registry_audit_volume_over_threshold'

const VARIANTS: RevertVariant[] = [
  'audit-source-clause-dropped',
  'upper-bound-le-now',
  'null-operation-admitted',
  'null-result-admitted',
  'anon-revoke-removed',
  'anon-revoke-removed-smoke-blind',
  'namespace-equality-dropped',
  'non-member-attributed',
  'mutation-success-refusal-removed',
  'team-id-key-added',
  'octet-length-bound',
  'service-role-revoke-removed',
  'having-ge',
  'content-read-refusal-removed',
  'actor-parameter-added',
  'utc-pin-removed',
]

const rpcBody = (sql: string) =>
  stripComments(
    sql.slice(
      sql.indexOf(`FUNCTION ${RPC}(`),
      sql.indexOf('registry_audit_volume_over_threshold(\n  p_threshold')
    )
  )

describe.skipIf(migrationTextLocked())('SMI-6114 -- attempt RPC (PG-free)', () => {
  it('the declarative table is 28 accepted + 8 refused = 36, all distinct', () => {
    const accepted = ACCEPTED.flatMap(({ op, results }) => results.map((r) => `${op}/${r}`))
    const refused = REFUSED.map(([op, r]) => `${op}/${r}`)
    expect(accepted.length, 'accepted pairings').toBe(28)
    expect(refused.length, 'refused pairings').toBe(8)
    expect(new Set([...accepted, ...refused]).size, 'no pairing is both, none repeated').toBe(36)
  })

  it('every revert anchor still matches the shipped text exactly once and changes it', () => {
    const real = migrationSql()
    for (const v of VARIANTS)
      expect(brokenMigrationSql(v), `${v} must differ from the real text`).not.toBe(real)
  })

  it('the shipped RPC never writes a team_id key, never member-visible, actor from auth.uid() only', () => {
    const body = rpcBody(migrationSql())
    expect(body, 'positive control: the slice really is the RPC').toContain(
      'record_private_registry_audit_attempt'
    )
    expect(body).not.toMatch(/'team_id'/)
    expect(body).toMatch(/'member_visible', false/)
    expect(body).not.toMatch(/'member_visible', true/)
    expect(body).toMatch(/'user:' \|\| v_uid::text/)
    expect(body).not.toMatch(/p_actor/)
    const handler = /\bEXCEPTION\s+WHEN\b/i
    expect(
      handler.test(`${body}\nEXCEPTION WHEN OTHERS THEN NULL;`),
      'known-positive control: the handler regex matches an injected handler'
    ).toBe(true)
    expect(
      handler.test(`${body}\nexception when others then null;`),
      'known-positive control: case-insensitive'
    ).toBe(true)
    expect(body).not.toMatch(handler)
  })

  it('known-negative: the team_id-key mutation DOES trip the same text check', () => {
    expect(rpcBody(brokenMigrationSql('team-id-key-added'))).toMatch(/'team_id'/)
  })

  it('NULL operation/result are refused with the NULL-first idiom, not the precedent NULL-admitting one', () => {
    const body = rpcBody(migrationSql())
    expect(body).toMatch(
      /IF p_operation IS NULL OR char_length\(p_operation\) > 32 OR p_operation NOT IN/
    )
    expect(body).toMatch(/IF p_result IS NULL OR char_length\(p_result\) > 32 OR p_result NOT IN/)
    expect(rpcBody(brokenMigrationSql('null-operation-admitted'))).toMatch(
      /IF p_operation IS NOT NULL AND/
    )
  })

  it('grants: authenticated only on the RPC (anon and PUBLIC revoked); service_role only on the monitor', () => {
    const sql = stripComments(migrationSql())
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.record_private_registry_audit_attempt\(\s*TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT\) FROM PUBLIC;/
    )
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.record_private_registry_audit_attempt\(\s*TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT\) FROM anon;/
    )
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.record_private_registry_audit_attempt\([^)]*\)\s+TO authenticated;/
    )
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.registry_audit_volume_over_threshold\(INTEGER, TIMESTAMPTZ\)\s+FROM PUBLIC, anon, authenticated;/
    )
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.registry_audit_volume_over_threshold\(INTEGER, TIMESTAMPTZ\)\s+TO service_role;/
    )
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.registry_audit_volume_over_threshold[^;]*authenticated/
    )
    expect(stripComments(brokenMigrationSql('anon-revoke-removed'))).not.toMatch(/FROM anon;/)
  })

  it('the monitor reads only client_reported rows in the two CLOSED UTC buckets', () => {
    const fn = stripComments(extractFunction(NEW_MIGRATION, MON))
    expect(fn).toMatch(/al\.metadata->>'audit_source' = 'client_reported'/)
    expect(fn).toMatch(/al\.created_at >= v_closed_before - interval '2 hours'/)
    expect(fn).toMatch(/al\.created_at < {2}v_closed_before/)
    expect(fn).not.toMatch(/<=\s*p_now/)
    expect(fn).toMatch(/date_trunc\('hour', p_now AT TIME ZONE 'UTC'\) AT TIME ZONE 'UTC'/)
    expect(stripComments(extractFunction(NEW_MIGRATION, MON))).not.toBe('')
  })

  it('the paired rollback drops both functions; the schema_version DELETE stays commented out', () => {
    const p = join(
      process.cwd(),
      'supabase/rollbacks/20261008000000_private_registry_audit_attempt_rpc_down.sql'
    )
    expect(existsSync(p), 'rollback file exists').toBe(true)
    const raw = readFileSync(p, 'utf8')
    const sql = stripComments(raw)
    expect(sql).toMatch(
      /DROP FUNCTION IF EXISTS public\.registry_audit_volume_over_threshold\(INTEGER, TIMESTAMPTZ\)/
    )
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.record_private_registry_audit_attempt\(/)
    // The schema_version DELETE is commented out by default (warning 4): it must NOT be executable,
    // and it must still be present as a comment for the operator to uncomment.
    expect(sql, 'the DELETE is not executable').not.toMatch(/DELETE FROM schema_version/)
    expect(raw, 'the DELETE survives as a comment').toMatch(
      /^-- DELETE FROM schema_version WHERE version = 120;/m
    )
  })
})
