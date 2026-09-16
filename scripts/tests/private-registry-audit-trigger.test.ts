/**
 * SMI-6114: `trg_prs_audit` / `trg_prs_audit_truncate`
 * (supabase/migrations/20260913000000_private_registry_audit_trigger.sql) against a REAL Postgres.
 *
 * Trigger behaviour — which operations write a row, how many, as whom, inside which transaction,
 * and whether a failed audit write can let the mutation commit — cannot be established by reading
 * the migration text. Each case below drives the table the way one real caller does (an
 * authenticated PostgREST publish or deprecate, the review RPC's UPDATE, a service-role job, a
 * direct SQL session) and reads audit_logs back.
 *
 * SKIPS without SMI5879_TEST_PG* env vars, like every live-Postgres suite in this repo (none of
 * them run in CI yet — SMI-5946). The always-on structural assertions live in
 * `private-registry-audit-trigger.pins.test.ts`, `.detectors.test.ts`, and `.scanner.test.ts`
 * (split from the original `.static.test.ts`, SMI-6680 governance retro, PR #2860 gate). Standup:
 * see the helpers file header.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  queryRows,
  queryScalar,
  runPsql,
  testConnParamsFromEnv,
} from '../indexer/smi5879-census.pg.ts'
import {
  auditRowsForTeam,
  noLiveTestPg,
  resetSchema,
  runAs,
  type Caller,
  type PgConnParams,
} from './private-registry-audit-trigger.test-helpers.ts'

if (noLiveTestPg) {
  console.warn(
    '[private-registry-audit-trigger] SKIPPED: no live test Postgres configured ' +
      '(SMI5879_TEST_PGHOST/PORT/USER/PASSWORD/DATABASE unset). See the helpers file header.'
  )
}

const SUBMITTER = '11111111-1111-4111-8111-111111111111'
const REVIEWER = '22222222-2222-4222-8222-222222222222'
const asUser = (sub: string): Caller => ({
  claims: { sub, role: 'authenticated' },
  role: 'authenticated',
})
const SKILL_BODY = '# Secret skill body that must never be copied into audit_logs'

let conn: PgConnParams

beforeAll(async () => {
  if (noLiveTestPg) return
  const base = testConnParamsFromEnv()
  if (!base) throw new Error('unreachable: noLiveTestPg already checked')
  conn = await resetSchema(base, 'smi6114_test_audit_trigger')
}, 60_000)

/** Publish one version as `SUBMITTER` over the authenticated path; returns the team id. */
async function publish(team: string, version = '1.0.0'): Promise<void> {
  await runAs(
    conn,
    asUser(SUBMITTER),
    `INSERT INTO private_registry_skills (team_id, skill_id, version, description, content)
     VALUES (:'team', 'ns/skill', :'version', 'a private description',
             jsonb_build_object('SKILL.md', :'body', 'scripts/run.sh', 'echo hi'));`,
    { team, version, body: SKILL_BODY }
  )
}

/** The review RPC's own UPDATE, run as the definer role with the reviewer's JWT claims. */
async function decide(team: string, decision: 'approved' | 'rejected'): Promise<void> {
  await runAs(
    conn,
    { claims: { sub: REVIEWER, role: 'authenticated' }, role: null },
    `UPDATE private_registry_skills
        SET approval_status = :'decision', approved_by = :'reviewer'::uuid,
            approved_at = NOW(), review_note = 'looks fine to me'
      WHERE team_id = :'team';`,
    { team, decision, reviewer: REVIEWER }
  )
}

describe.skipIf(noLiveTestPg)('trg_prs_audit (SMI-6114)', () => {
  it('an authenticated publish writes exactly one attributed row, with no content text', async () => {
    const team = `team-${randomUUID()}`
    await publish(team)

    const rows = await auditRowsForTeam(conn, team)
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row.eventType).toBe('private_registry:publish')
    expect(row.action).toBe('publish')
    expect(row.result).toBe('success')
    expect(row.actor).toBe(`user:${SUBMITTER}`)
    expect(row.resource).toBe(`private_registry_skills/${team}/ns/skill@1.0.0`)
    // A pending version is invisible to ordinary members, so its publish row carries no `team_id`
    // (the key audit_logs_team_scoped_read reads); the team is under `registry_team_id` instead.
    expect(row.metadata.team_id).toBeUndefined()
    expect(row.metadata).toMatchObject({
      registry_team_id: team,
      member_visible: false,
      skill_id: 'ns/skill',
      version: '1.0.0',
      auth_path: 'user_jwt',
      actor_user_id: SUBMITTER,
      transport: 'database_trigger',
      trigger_op: 'INSERT',
      db_role: 'authenticated',
      approval_status: 'pending',
      published_by: SUBMITTER,
      published_by_available: true,
      file_count: 2,
    })
    const serialized = JSON.stringify(row)
    expect(serialized).not.toContain(SKILL_BODY)
    expect(serialized).not.toContain('a private description')
    expect(serialized).not.toContain('echo hi')
  })

  it.each([
    ['approved', 'private_registry:approve'],
    ['rejected', 'private_registry:reject'],
  ] as const)('a %s review decision writes one decision row as the reviewer', async (d, event) => {
    const team = `team-${randomUUID()}`
    await publish(team)
    await decide(team, d)

    const rows = await auditRowsForTeam(conn, team)
    expect(rows.map((r) => r.eventType)).toEqual(['private_registry:publish', event])
    const decision = rows[1]
    expect(decision.actor).toBe(`user:${REVIEWER}`)
    expect(decision.metadata).toMatchObject({
      previous_approval_status: 'pending',
      approval_status: d,
      approved_by: REVIEWER,
      review_note_present: true,
      member_visible: d === 'approved',
    })
    // Approve exposes a version members can now read anyway; reject does not.
    expect(decision.metadata.team_id).toBe(d === 'approved' ? team : undefined)
    expect(rows[0].metadata.team_id).toBeUndefined()
    // The approver columns are part of the decision, not a separate "update".
    expect(JSON.stringify(decision)).not.toContain('looks fine to me')
  })

  it('a version leaving approved state is untagged from that event on (tagging is time-of-event)', async () => {
    const team = `team-${randomUUID()}`
    await publish(team, '1.0.0')
    await publish(team, '2.0.0')
    await decide(team, 'approved')
    const direct: Caller = { claims: null, role: null }
    await runAs(
      conn,
      direct,
      `UPDATE private_registry_skills SET approval_status = 'rejected'
        WHERE team_id = :'team' AND version = '1.0.0';`,
      { team }
    )
    await runAs(
      conn,
      direct,
      `UPDATE private_registry_skills SET approval_status = 'pending', description = 'x'
        WHERE team_id = :'team' AND version = '2.0.0';`,
      { team }
    )

    const tags = (await auditRowsForTeam(conn, team))
      .map((r) => `${r.eventType.split(':')[1]}@${r.metadata.version}=${r.metadata.team_id ?? '-'}`)
      .sort()
    expect(tags).toEqual(
      [
        'approve@1.0.0=' + team, // approved at the time: stays readable to members
        'approve@2.0.0=' + team,
        'publish@1.0.0=-',
        'publish@2.0.0=-',
        'reject@1.0.0=-', // approved before, not after
        'update@2.0.0=-', // approved before, pending after
      ].sort()
    )
  })

  it('deprecate and undeprecate each write one row; a no-op update writes none', async () => {
    const team = `team-${randomUUID()}`
    await publish(team)
    await decide(team, 'approved')
    const flip = (value: string) =>
      runAs(
        conn,
        asUser(REVIEWER),
        `UPDATE private_registry_skills SET deprecated = :'value'::boolean WHERE team_id = :'team';`,
        { team, value }
      )

    await flip('true')
    await flip('true') // already deprecated: nothing changes, nothing is recorded
    await flip('false')

    const rows = await auditRowsForTeam(conn, team)
    expect(rows.map((r) => r.eventType)).toEqual([
      'private_registry:publish',
      'private_registry:approve',
      'private_registry:deprecate',
      'private_registry:undeprecate',
    ])
    expect(rows[2].actor).toBe(`user:${REVIEWER}`)
    expect(rows[2].metadata).toMatchObject({ previous_deprecated: false, deprecated: true })
    // Approved before and after: member-visible, so tagged.
    expect(rows.slice(2).map((r) => r.metadata.team_id)).toEqual([team, team])
  })

  it('a multi-row deprecate writes one row per version that actually changed', async () => {
    const team = `team-${randomUUID()}`
    await publish(team, '1.0.0')
    await publish(team, '1.1.0')
    await publish(team, '1.2.0')
    await runAs(
      conn,
      asUser(REVIEWER),
      `UPDATE private_registry_skills SET deprecated = TRUE
        WHERE team_id = :'team' AND version = '1.1.0';`,
      { team }
    )
    await runAs(
      conn,
      asUser(REVIEWER),
      `UPDATE private_registry_skills SET deprecated = TRUE WHERE team_id = :'team';`,
      { team }
    )

    const deprecations = (await auditRowsForTeam(conn, team)).filter(
      (r) => r.eventType === 'private_registry:deprecate'
    )
    expect(deprecations.map((r) => r.metadata.version).sort()).toEqual(['1.0.0', '1.1.0', '1.2.0'])
    // These versions are still pending, so the deprecations are untagged.
    expect(deprecations.every((r) => r.metadata.team_id === undefined)).toBe(true)
  })

  it('privileged writes are recorded as updates and attributed to the role, not a user', async () => {
    const team = `team-${randomUUID()}`
    await publish(team)
    await runAs(
      conn,
      { claims: { role: 'service_role' }, role: 'service_role' },
      `UPDATE private_registry_skills SET content = '{"SKILL.md":"rewritten"}'::jsonb
        WHERE team_id = :'team';`,
      { team }
    )
    await runAs(
      conn,
      { claims: null, role: null },
      `UPDATE private_registry_skills SET description = 'changed by hand' WHERE team_id = :'team';`,
      { team }
    )

    const [, viaServiceRole, viaDirectSql] = await auditRowsForTeam(conn, team)
    expect(viaServiceRole.eventType).toBe('private_registry:update')
    expect(viaServiceRole.actor).toBe('jwt_role:service_role')
    expect(viaServiceRole.metadata).toMatchObject({
      auth_path: 'service_role',
      changed_columns: ['content'],
    })
    expect(viaDirectSql.eventType).toBe('private_registry:update')
    expect(viaDirectSql.actor).toBe(`db_session:${conn.user}`)
    expect(viaDirectSql.metadata).toMatchObject({
      auth_path: 'direct_sql',
      changed_columns: ['description'],
    })
    expect(JSON.stringify(viaDirectSql)).not.toContain('changed by hand')
    // Updates to a pending version stay untagged.
    expect([viaServiceRole, viaDirectSql].map((r) => r.metadata.member_visible)).toEqual([
      false,
      false,
    ])
  })

  it('delete writes a delete row; truncate writes a statement-level truncate row', async () => {
    const team = `team-${randomUUID()}`
    await publish(team)
    await runAs(
      conn,
      { claims: null, role: null },
      `DELETE FROM private_registry_skills WHERE team_id = :'team';`,
      { team }
    )
    const rows = await auditRowsForTeam(conn, team)
    expect(rows.map((r) => r.eventType)).toEqual([
      'private_registry:publish',
      'private_registry:delete',
    ])
    expect(rows[1].metadata.team_id).toBeUndefined() // the deleted version was pending

    // Rolled back so the shared table survives for the other cases; the count is read inside the
    // same transaction, before the rollback.
    const truncates = await queryScalar(
      conn,
      `BEGIN;
       TRUNCATE private_registry_skills;
       SELECT count(*) FROM audit_logs WHERE event_type = 'private_registry:truncate';
       ROLLBACK;`
    )
    expect(truncates).toBe('1')
  })

  it('an INSERT that fails, or a transaction that rolls back, leaves no audit row', async () => {
    const team = `team-${randomUUID()}`
    await publish(team)
    await expect(publish(team)).rejects.toThrow(/duplicate key|unique/i)
    await runPsql(
      conn,
      `BEGIN;
       INSERT INTO private_registry_skills (team_id, skill_id, version, content, published_by)
       VALUES (:'team', 'ns/skill', '9.9.9', '{"SKILL.md":"x"}', :'sub'::uuid);
       ROLLBACK;`,
      { team, sub: SUBMITTER }
    )

    const rows = await auditRowsForTeam(conn, team)
    expect(rows.map((r) => r.eventType)).toEqual(['private_registry:publish'])
  })

  it('fails closed: when the audit row cannot be written, the mutation does not commit', async () => {
    const team = `team-${randomUUID()}`
    // The CHECK exists only inside this transaction; it makes every private_registry audit
    // INSERT fail, standing in for any audit-write failure.
    await expect(
      runAs(
        conn,
        { claims: { sub: SUBMITTER, role: 'authenticated' }, role: null },
        `ALTER TABLE audit_logs ADD CONSTRAINT smi6114_block_registry_audit
           CHECK (event_type NOT LIKE 'private\\_registry:%') NOT VALID;
         INSERT INTO private_registry_skills (team_id, skill_id, version, content)
         VALUES (:'team', 'ns/skill', '1.0.0', '{"SKILL.md":"x"}');`,
        { team }
      )
    ).rejects.toThrow(/smi6114_block_registry_audit/)

    const persisted = await queryScalar(
      conn,
      `SELECT count(*) FROM private_registry_skills WHERE team_id = :'team';`,
      { team }
    )
    expect(persisted).toBe('0')
  })

  it('is SECURITY DEFINER with a pinned search_path, and not executable by anon/authenticated', async () => {
    const rows = await queryRows(
      conn,
      `SELECT p.prosecdef, array_to_string(p.proconfig, ','),
              has_function_privilege('anon', p.oid, 'EXECUTE'),
              has_function_privilege('authenticated', p.oid, 'EXECUTE')
         FROM pg_proc p
        WHERE p.oid = 'audit_private_registry_skills_change()'::regprocedure;`
    )
    expect(rows).toEqual([['t', 'search_path=smi6114_test_audit_trigger, pg_temp', 'f', 'f']])
  })
})
