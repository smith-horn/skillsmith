/**
 * SMI-6114: the REAL read-side visibility rules, installed on top of the audit-trigger fixture, so
 * `private-registry-audit-visibility.test.ts` can prove audit visibility never exceeds data
 * visibility.
 *
 * Nothing here is a hand-written approximation of a policy or helper. Each object is copied out of
 * the migration that currently defines it, at test time, so a later change to any of them changes
 * what this suite checks:
 *
 * | Object                                   | Live definition (first occurrence in the file) |
 * |------------------------------------------|------------------------------------------------|
 * | user_team_ids(), user_member_team_ids()  | 071_team_workspaces.sql                        |
 * | default_role_permission(TEXT, TEXT)      | 20260902010000_workspace_member_permissions    |
 * | team_ids_with_permission(TEXT)           | 20260828000001_team_sso_settings               |
 * | get_private_registry_submissions(...)    | 20260827000001_rbac_seam_widening              |
 * | audit_logs_team_scoped_read              | 20260420020000_audit_logs_team_rls             |
 * | private_registry_skills_member_read      | 20260809000000_private_registry_approval_gate  |
 * | private_registry_skills_member_insert    | 20260724000000_private_registry_skills         |
 * | private_registry_skills_admin_update     | 20260827000001_rbac_seam_widening              |
 *
 * `20260827000001` also carries rollback copies of two of these inside a block comment, after the
 * live ones. Taking the first occurrence is what selects the live definitions; the extractor also
 * refuses a match that is not at the start of a line.
 *
 * The tables those helpers read (team_members, team_permission_grants, team_sso_settings) are
 * minimal fixtures carrying only the columns the helper bodies reference.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(process.cwd(), 'supabase/migrations')

interface Extract {
  file: string
  /** Literal text the statement starts with, at the start of a line. */
  start: string
  kind: 'function' | 'policy'
}

const EXTRACTS: Extract[] = [
  {
    file: '071_team_workspaces.sql',
    start: 'CREATE OR REPLACE FUNCTION user_team_ids()',
    kind: 'function',
  },
  {
    file: '071_team_workspaces.sql',
    start: 'CREATE OR REPLACE FUNCTION user_member_team_ids()',
    kind: 'function',
  },
  {
    file: '20260902010000_workspace_member_permissions.sql',
    start: 'CREATE OR REPLACE FUNCTION default_role_permission(',
    kind: 'function',
  },
  {
    file: '20260828000001_team_sso_settings.sql',
    start: 'CREATE OR REPLACE FUNCTION team_ids_with_permission(',
    kind: 'function',
  },
  {
    file: '20260827000001_rbac_seam_widening.sql',
    start: 'CREATE OR REPLACE FUNCTION get_private_registry_submissions(',
    kind: 'function',
  },
  {
    file: '20260420020000_audit_logs_team_rls.sql',
    start: 'CREATE POLICY audit_logs_team_scoped_read',
    kind: 'policy',
  },
  {
    file: '20260809000000_private_registry_approval_gate.sql',
    start: 'CREATE POLICY private_registry_skills_member_read',
    kind: 'policy',
  },
  {
    file: '20260724000000_private_registry_skills.sql',
    start: 'CREATE POLICY private_registry_skills_member_insert',
    kind: 'policy',
  },
  {
    file: '20260827000001_rbac_seam_widening.sql',
    start: 'CREATE POLICY private_registry_skills_admin_update',
    kind: 'policy',
  },
]

/** The first line-anchored occurrence of `start` in `file`, through its terminating `;`. */
export function extractStatement({ file, start, kind }: Extract): string {
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
  const idx = sql.split('\n').findIndex((line) => line.startsWith(start))
  if (idx < 0) throw new Error(`SMI-6114 fixture: "${start}" not found at a line start in ${file}`)
  const rest = sql.split('\n').slice(idx).join('\n')
  const end =
    kind === 'function'
      ? rest.indexOf('$$;', rest.indexOf('AS $$') + 'AS $$'.length) + '$$;'.length
      : rest.indexOf(';') + 1
  if (end <= 0) throw new Error(`SMI-6114 fixture: no terminator for "${start}" in ${file}`)
  return rest.slice(0, end)
}

/**
 * Replace the permissive fixture policies with the real ones and add the helper objects. Returns
 * SQL meant to run AFTER `resetSchema()` (which already applied the trigger migration), in the same
 * schema; `public` is rewritten to that schema, the same substitution the migration itself gets.
 */
export function realVisibilitySql(schema: string): string {
  const real = EXTRACTS.map(extractStatement).join('\n\n')
  return `
CREATE TABLE team_members (
  team_id         TEXT NOT NULL,
  user_id         UUID NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  provisioned_via TEXT,
  sso_verified_at TIMESTAMPTZ,
  PRIMARY KEY (team_id, user_id)
);
CREATE TABLE team_permission_grants (
  team_id    TEXT NOT NULL,
  role       TEXT NOT NULL,
  permission TEXT NOT NULL,
  effect     TEXT NOT NULL,
  UNIQUE (team_id, role, permission)
);
CREATE TABLE team_sso_settings (team_id TEXT PRIMARY KEY, reverify_days INT);

DROP POLICY audit_logs_fixture_read ON audit_logs;
DROP POLICY prs_fixture_authenticated ON private_registry_skills;

${real}

GRANT EXECUTE ON FUNCTION get_private_registry_submissions(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION user_team_ids(), user_member_team_ids(), team_ids_with_permission(TEXT)
  TO authenticated;
`.replace(/\bpublic\b/g, schema)
}
