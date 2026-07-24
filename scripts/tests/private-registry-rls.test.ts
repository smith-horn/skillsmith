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
 */

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = 'supabase/migrations'

/** Locate the migration that creates private_registry_skills and normalize its whitespace. */
function loadPrivateRegistryMigration(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
  for (const f of files) {
    const content = readFileSync(join(MIGRATIONS_DIR, f), 'utf8')
    if (/CREATE TABLE[^;]*private_registry_skills/i.test(content)) {
      return content.replace(/\s+/g, ' ')
    }
  }
  throw new Error('No migration found that CREATEs private_registry_skills')
}

describe('private_registry_skills RLS + constraints (ADR-129 / SMI-5816)', () => {
  const sql = loadPrivateRegistryMigration()

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
