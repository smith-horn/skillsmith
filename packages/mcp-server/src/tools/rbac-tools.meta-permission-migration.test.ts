/**
 * @fileoverview SMI-6319 — the shipped migration keeps BOTH of its enforcement points.
 * @see supabase/migrations/20260901000000_rbac_meta_permission_not_grantable.sql
 * @see rbac-tools.meta-permission-not-grantable.test.ts — the behavioural half of this suite
 *      (stub service, tool surface, error mapping). Split so neither file exceeds the 500-line
 *      `audit:standards` budget, and because these are a different KIND of test: static
 *      assertions about a shipped SQL artifact rather than assertions about runtime behaviour.
 *
 * WHY ASSERT ON MIGRATION TEXT AT ALL. `set_team_role_permission()` is enforced at two layers —
 * a table CHECK constraint and an in-function guard — and the specific regression this schema is
 * most exposed to silently removes the second one: a future `CREATE OR REPLACE FUNCTION
 * set_team_role_permission(...)` in an unrelated wave, reproducing the body from an older copy,
 * drops every function-level gate with no error, no failing test, and no diff against the table.
 * That function has already been through two rounds of gate rewrites; a third is likely. These
 * assertions are the tripwire for it, and they are the reason the CHECK constraint exists as the
 * primary defence rather than the guard alone.
 *
 * The runtime behaviour these pin is separately proven end-to-end by the migration's own inline
 * smoke block (s1-s8), which runs inside the same transaction as the DDL and rolls the whole
 * migration back on any failure.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { META_PERMISSIONS } from './rbac-tools.types.js'

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../supabase/migrations/20260901000000_rbac_meta_permission_not_grantable.sql'
)

/** git-crypt's magic header: NUL followed by "GITCRYPT". */
const GIT_CRYPT_HEADER = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54])

function readMigration(): string | null {
  let raw: Buffer
  try {
    raw = readFileSync(MIGRATION_PATH)
  } catch {
    return null
  }
  // `supabase/migrations/**` is git-crypt encrypted. In a locked checkout the file on disk is
  // ciphertext, and asserting on it would fail for a reason that has nothing to do with the
  // invariant under test — so skip loudly rather than fail misleadingly.
  if (raw.subarray(0, GIT_CRYPT_HEADER.length).equals(GIT_CRYPT_HEADER)) return null
  return raw.toString('utf8')
}

const migrationSql = readMigration()

if (migrationSql === null) {
  console.warn(
    '[SMI-6319] SKIPPED the migration-text assertions: ' +
      `${MIGRATION_PATH} is unreadable or still git-crypt encrypted. ` +
      'Unlock with `varlock run -- sh -c \'git-crypt unlock "${GIT_CRYPT_KEY_PATH/#\\~/$HOME}"\'`.'
  )
}

/** The gate-4b `IF`, anchored on `AND p_effect` — gate 4's own `IF p_permission IN (...)` wraps
 *  onto a second line (`AND v_caller_role IS DISTINCT FROM 'owner'`), so that is what tells the
 *  two apart. */
const GATE_4B_IF = "IF p_permission IN ('team:manage_rbac', 'team:manage_sso') AND p_effect"

describe.skipIf(migrationSql === null)('SMI-6319: the shipped migration keeps both layers', () => {
  const sql = migrationSql ?? ''

  it('adds the table-level CHECK constraint covering both meta-permissions', () => {
    expect(sql).toContain('ADD CONSTRAINT team_permission_grants_meta_permission_not_grantable')
    expect(sql).toContain(
      "CHECK (NOT (permission IN ('team:manage_rbac', 'team:manage_sso') AND effect = 'allow'))"
    )
  })

  it("carries gate 4b inside set_team_role_permission's body", () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION set_team_role_permission(')
    expect(sql).toContain(`${GATE_4B_IF} = 'allow' THEN`)
  })

  it('raises gate 4b as a typed 42501, never letting the raw 23514 reach a caller', () => {
    // A 23514 is not a permission denial to `toPermissionDeniedError`, so if the constraint were
    // the only layer the customer would see a raw message naming an internal constraint.
    expect(sql.slice(sql.indexOf(GATE_4B_IF), sql.indexOf(GATE_4B_IF) + 400)).toContain(
      "USING ERRCODE = '42501'"
    )
  })

  it('uses the exact message text PASSTHROUGH_REFUSALS byte-matches', () => {
    // The SQL builds this with a `%` substitution over the gate-1-validated four-value
    // allowlist, so it has exactly the two outputs that allowlist enumerates. If this drifts,
    // the customer silently gets the generic sentence instead of the authored copy.
    expect(sql).toContain('The "%" permission is owner-only and cannot be granted to another role.')
    for (const permission of META_PERMISSIONS) {
      expect(
        `The "${permission}" permission is owner-only and cannot be granted to another role.`
      ).toContain(permission)
    }
  })

  it('places gate 4b BEFORE the INSERT it guards', () => {
    const guardAt = sql.indexOf(GATE_4B_IF)
    const insertAt = sql.indexOf('INSERT INTO team_permission_grants (team_id, role, permission')
    expect(guardAt).toBeGreaterThan(-1)
    expect(insertAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(insertAt)
  })

  it('scopes both enforcement points to allow only, never deny', () => {
    // The deliberate scope boundary, pinned on BOTH layers. A guard or constraint written without
    // the effect predicate would be over-broad: it would also refuse the owner's legal deny rows,
    // passing every negative assertion while silently removing capability. The migration's own
    // smoke s5 asserts the runtime half.
    const guardAt = sql.indexOf(GATE_4B_IF)
    expect(guardAt).toBeGreaterThan(-1)
    expect(sql.slice(guardAt, sql.indexOf('\n', guardAt))).toContain("p_effect = 'allow'")

    const checkAt = sql.indexOf('CHECK (NOT (permission IN')
    expect(sql.slice(checkAt, sql.indexOf('\n', checkAt))).toContain("effect = 'allow'")

    expect(sql).toContain('SMOKE FAIL (s5)')
  })

  it('re-states the REVOKE/GRANT triple after CREATE OR REPLACE', () => {
    // Postgres re-adds an implicit PUBLIC EXECUTE grant on every CREATE OR REPLACE, and
    // Supabase's ALTER DEFAULT PRIVILEGES separately auto-grants anon/authenticated. A bare
    // REVOKE FROM anon, authenticated alone leaves the PUBLIC grant standing.
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION set_team_role_permission(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;'
    )
    expect(sql).toContain(
      'REVOKE EXECUTE ON FUNCTION set_team_role_permission(TEXT, TEXT, TEXT, TEXT) FROM anon, authenticated;'
    )
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION set_team_role_permission(TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;'
    )
  })

  it('purges pre-existing meta-permission allow rows before adding the constraint', () => {
    // Without this the ADD CONSTRAINT aborts on any team that already has one (staging does, from
    // the SMI-6312 repro) — and, more importantly, leaving them in place would "fix" nothing for
    // exactly the teams that were already escalated.
    const purgeAt = sql.indexOf('DELETE FROM team_permission_grants')
    const addAt = sql.indexOf('ADD CONSTRAINT team_permission_grants_meta_permission_not_grantable')
    expect(purgeAt).toBeGreaterThan(-1)
    expect(addAt).toBeGreaterThan(-1)
    expect(purgeAt).toBeLessThan(addAt)
  })

  it('detects a drifted live function body before overwriting it', () => {
    // Section 3 reproduces 20260828000000's body from source, not from the live catalog, so an
    // out-of-band change to the deployed function would be silently reverted. The pre-flight
    // asserts each gate it assumes is present is actually present, and WARNs if not.
    expect(sql).toContain('Pre-flight DRIFT')
    expect(sql).toContain("v_def NOT LIKE '%Only the team owner can change who holds%'")
    expect(sql).toContain("v_def NOT LIKE '%Only owners and admins can widen%'")
  })

  it('keeps a smoke block that runs inside the same transaction as the DDL', () => {
    expect(sql).toContain('SMOKE FAIL (s1)')
    expect(sql).toContain('__smoke_rollback__')
    // The smoke must sit between BEGIN and COMMIT, or a failure cannot roll the DDL back.
    expect(sql.indexOf('$smoke_6319$')).toBeGreaterThan(sql.indexOf('\nBEGIN;'))
    expect(sql.lastIndexOf('$smoke_6319$')).toBeLessThan(sql.indexOf('\nCOMMIT;'))
  })

  it('ships a standalone rollback script alongside the inline ROLLBACK block', () => {
    expect(sql).toContain('-- ROLLBACK:')
    const rollback = readFileSync(
      join(
        dirname(MIGRATION_PATH),
        '../rollbacks/20260901000000_rbac_meta_permission_not_grantable_down.sql'
      ),
      'utf8'
    )
    expect(rollback).toContain(
      'DROP CONSTRAINT IF EXISTS team_permission_grants_meta_permission_not_grantable'
    )
    // The rollback must NOT carry gate 4b — otherwise it does not actually roll anything back.
    expect(rollback).not.toContain('owner-only and cannot be granted')
    // ...and must re-state the grant triple, or it reintroduces the implicit PUBLIC EXECUTE leak.
    expect(rollback).toContain(
      'REVOKE ALL ON FUNCTION set_team_role_permission(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;'
    )
  })
})
