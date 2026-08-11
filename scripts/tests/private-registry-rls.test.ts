/**
 * @fileoverview RLS-policy assertions for the private_registry_skills table (ADR-129).
 * @see SMI-5816: Private skill registry — real implementation.
 *
 * This repo has no live-Postgres (role-switching) test harness — no PGlite / pg-mem /
 * testcontainers dependency — so true RLS *enforcement* is validated at the staging E2E
 * gate (Wave 6, plan `private-skill-registry-and-update-notifications.md`), exactly as
 * get_user_inventory()'s tenant isolation is (see 20260626000001_user_inventory.sql, which
 * notes staging e2e SMI-5395). The executable equivalent here is a *structural* assertion
 * that the migration ships the four ADR-129 policies with the correct SECURITY DEFINER
 * helper predicates — i.e. the RLS is written such that:
 *   - a team-A authenticated user's auth.uid() resolves only to team-A ids (member_read /
 *     member_insert scoped to user_team_ids()/user_member_team_ids()), so team-B rows are
 *     never SELECT-able or INSERT-able → cross-team isolation;
 *   - deprecation (an UPDATE) is gated to user_admin_team_ids(), so a non-admin team member
 *     cannot deprecate a skill.
 * A drift in any of these predicates (e.g. someone loosening member_read to USING (true))
 * fails this test at PR time, before it can reach staging.
 *
 * SMI-5984: `post-merge-verify.yml` intentionally has no git-crypt unlock step (SMI-4221 —
 * a workflow holding `issues: write` shouldn't also hold a decrypt key), and
 * `supabase/migrations/**` is git-crypt encrypted (`.gitattributes`). On that locked
 * checkout the migration file below is ciphertext, so the content assertions can't run —
 * only the unlocked PR-matrix CI remains the authoritative RLS-*content* check. This test
 * detects lock state directly on the migration file itself (not the unrelated CORS-sentinel
 * `gitCryptLocked()` helper in `vitest.config.root-tests.ts`, which only answers whether
 * `supabase/functions/**` is locked — a different path that could in principle diverge) and
 * falls back to an existence-only check, the same filename-survives-encryption pattern
 * `backfill-migration-headers.test.ts` relies on (filenames stay plaintext under git-crypt;
 * only file contents don't). A genuinely missing or unreadable migration is NOT treated as
 * "locked" — it still throws and fails the test, same as before this change.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MIGRATIONS_DIR = 'supabase/migrations'

// git-crypt magic header — same 9-byte signature vitest.config.root-tests.ts's
// gitCryptLocked() checks, applied here to this specific migration file instead of the
// CORS sentinel. Buffer.equals() avoids a binary->string round-trip for the comparison.
const GIT_CRYPT_MAGIC = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54]) // "\x00GITCRYPT"

type LoadedMigration = { locked: true; path: string } | { locked: false; path: string; sql: string }

/**
 * Locate the migration that creates private_registry_skills (by filename, which stays
 * plaintext under git-crypt regardless of lock state) and either return its normalized SQL
 * content, or — on a git-crypt-locked checkout — flag it as locked without reading content
 * (existence/header verification only; this does NOT establish migration content integrity,
 * which is the unlocked PR-matrix CI run's job). Throws (does not swallow) when no matching
 * file exists, or when an unlocked file's content doesn't actually CREATE the table — both
 * are genuine failures, not lock-related.
 *
 * `dir` defaults to the real migrations directory; overridable for tests below.
 */
function loadPrivateRegistryMigration(dir: string = MIGRATIONS_DIR): LoadedMigration {
  const files = readdirSync(dir).filter(
    (f) => f.endsWith('.sql') && f.includes('private_registry_skills')
  )
  if (files.length === 0) {
    throw new Error('No migration found that CREATEs private_registry_skills')
  }
  const path = join(dir, files[0])
  const raw = readFileSync(path)

  if (raw.subarray(0, GIT_CRYPT_MAGIC.length).equals(GIT_CRYPT_MAGIC)) {
    return { locked: true, path }
  }

  const content = raw.toString('utf8')
  if (!/CREATE TABLE[^;]*private_registry_skills/i.test(content)) {
    throw new Error('No migration found that CREATEs private_registry_skills')
  }
  return { locked: false, path, sql: content.replace(/\s+/g, ' ') }
}

describe('loadPrivateRegistryMigration (SMI-5984 git-crypt lock detection)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'private-registry-migration-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns locked:true and skips content when the file starts with the git-crypt header', () => {
    const path = join(dir, '20260724000000_private_registry_skills.sql')
    writeFileSync(path, Buffer.concat([GIT_CRYPT_MAGIC, Buffer.from('rest of encrypted payload')]))

    const result = loadPrivateRegistryMigration(dir)

    expect(result.locked).toBe(true)
    expect(result.path).toBe(path)
    expect('sql' in result).toBe(false)
  })

  it('returns locked:false with normalized SQL for an unlocked, valid migration', () => {
    writeFileSync(
      join(dir, '20260724000000_private_registry_skills.sql'),
      'CREATE TABLE private_registry_skills (\n  id UUID\n);'
    )

    const result = loadPrivateRegistryMigration(dir)

    expect(result.locked).toBe(false)
    if (!result.locked) {
      expect(result.sql).toContain('CREATE TABLE private_registry_skills')
    }
  })

  it('throws when no matching migration file exists (not treated as locked)', () => {
    writeFileSync(join(dir, 'unrelated_migration.sql'), 'CREATE TABLE unrelated ();')

    expect(() => loadPrivateRegistryMigration(dir)).toThrow(
      'No migration found that CREATEs private_registry_skills'
    )
  })

  it('throws when the file is unlocked but does not actually CREATE the table (not treated as locked)', () => {
    writeFileSync(
      join(dir, '20260724000000_private_registry_skills.sql'),
      'DROP TABLE private_registry_skills;'
    )

    expect(() => loadPrivateRegistryMigration(dir)).toThrow(
      'No migration found that CREATEs private_registry_skills'
    )
  })

  it('does not misclassify a truncated/partial git-crypt-like header as locked', () => {
    // Starts with SOME of the magic bytes but not the full 9-byte signature — a real
    // truncated/corrupted file, not a genuinely locked one. Must fall through to content
    // parsing (and fail there, on missing CREATE TABLE) rather than being silently
    // treated as "locked" and skipped.
    writeFileSync(
      join(dir, '20260724000000_private_registry_skills.sql'),
      Buffer.from([0x00, 0x47, 0x49])
    )

    expect(() => loadPrivateRegistryMigration(dir)).toThrow(
      'No migration found that CREATEs private_registry_skills'
    )
  })
})

describe('private_registry_skills RLS + constraints (ADR-129 / SMI-5816)', () => {
  const migration = loadPrivateRegistryMigration()

  it('locates the migration that creates private_registry_skills', () => {
    expect(migration.path).toMatch(/private_registry_skills\.sql$/)
  })

  if (migration.locked) {
    // Checkout is git-crypt-locked (post-merge-verify.yml, by design — SMI-4221). Content
    // assertions below need plaintext SQL, which isn't available here; the unlocked
    // PR-matrix CI run is the authoritative check for RLS *content*. Existence (above) is
    // all that can be verified on this run.
    return
  }

  const { sql } = migration

  it('enables row level security on the table', () => {
    expect(sql).toContain('private_registry_skills ENABLE ROW LEVEL SECURITY')
  })

  it('member_read: any team member can SELECT their own team (user_team_ids)', () => {
    expect(sql).toContain(
      'CREATE POLICY private_registry_skills_member_read ON private_registry_skills FOR SELECT TO authenticated USING (team_id IN (SELECT user_team_ids()))'
    )
    // Negative: the authenticated read policy must NOT be open — that would leak every team.
    expect(sql).not.toContain('FOR SELECT TO authenticated USING (true)')
  })

  it('member_insert: publishing gated to team members (user_member_team_ids)', () => {
    expect(sql).toContain(
      'CREATE POLICY private_registry_skills_member_insert ON private_registry_skills FOR INSERT TO authenticated WITH CHECK (team_id IN (SELECT user_member_team_ids()))'
    )
  })

  it('admin_update: deprecation (UPDATE) gated to admins in BOTH USING and WITH CHECK', () => {
    // A non-admin member falls out of user_admin_team_ids(), so this policy blocks their
    // deprecate/undeprecate on the authenticated path.
    expect(sql).toContain(
      'CREATE POLICY private_registry_skills_admin_update ON private_registry_skills FOR UPDATE TO authenticated USING (team_id IN (SELECT user_admin_team_ids())) WITH CHECK (team_id IN (SELECT user_admin_team_ids()))'
    )
  })

  it('service_all: service_role bypass for the MCP/edge service-client path', () => {
    expect(sql).toContain(
      'CREATE POLICY private_registry_skills_service_all ON private_registry_skills FOR ALL TO service_role USING (true) WITH CHECK (true)'
    )
  })

  it('enforces version immutability via UNIQUE(team_id, skill_id, version)', () => {
    expect(sql).toContain('UNIQUE (team_id, skill_id, version)')
  })

  it('caps content JSONB at 2 MB via a pg_column_size CHECK', () => {
    expect(sql).toContain('CHECK (pg_column_size(content) <= 2097152)')
  })
})
