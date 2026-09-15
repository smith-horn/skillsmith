/**
 * SMI-6114: who can READ the audit rows `trg_prs_audit` writes, through the real
 * `audit_logs_team_scoped_read` policy, compared with who can read the skill versions they describe
 * through the real `private_registry_skills_member_read` policy and the real
 * `get_private_registry_submissions()` RPC.
 *
 * Invariant under test: audit visibility never exceeds data visibility. A pending publish, a reject,
 * and any update/delete touching a pending or rejected version carry no `metadata.team_id`, so no
 * authenticated reader sees them; only BYPASSRLS roles do. The submitter and reviewer can see those
 * versions' metadata through the RPC but NOT their audit rows through RLS — strictly less, never
 * more.
 *
 * One scenario, built once, read from five seats. Skips without SMI5879_TEST_PG* (see
 * private-registry-audit-trigger.test-helpers.ts for standup).
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { queryRows, runPsql, testConnParamsFromEnv } from '../indexer/smi5879-census.pg.ts'
import {
  noLiveTestPg,
  resetSchema,
  runAs,
  type Caller,
  type PgConnParams,
} from './private-registry-audit-trigger.test-helpers.ts'
import { realVisibilitySql } from './private-registry-audit-visibility.test-helpers.ts'

const SCHEMA = 'smi6114_test_audit_visibility'
const TEAM = `team-${randomUUID()}`
const SUBMITTER = '33333333-3333-4333-8333-333333333333'
const REVIEWER = '44444444-4444-4444-8444-444444444444' // team admin: registry:approve by default
const MEMBER = '55555555-5555-4555-8555-555555555555' // plain member, never submits or reviews
const OUTSIDER = '66666666-6666-4666-8666-666666666666' // not in the team
const asUser = (sub: string): Caller => ({
  claims: { sub, role: 'authenticated' },
  role: 'authenticated',
})
const SERVICE: Caller = { claims: { role: 'service_role' }, role: 'service_role' }

/** "<event>@<version>" for every audit row the seat can read through RLS. */
type Seen = string[]
let conn: PgConnParams
const auditSeen: Record<string, Seen> = {}
const dataSeen: Record<string, Set<string>> = {}
let serviceRows: { event: string; tagged: boolean; hasTeamIdKey: boolean }[] = []

async function readAsUser(sub: string, sql: string): Promise<string[][]> {
  // SET LOCAL, not set_config(): a SELECT would print its own row into the parsed output.
  return queryRows(
    conn,
    `BEGIN;
     SET LOCAL request.jwt.claims = :'claims';
     SET LOCAL request.jwt.claim.sub = :'sub';
     SET LOCAL request.jwt.claim.role = 'authenticated';
     SET LOCAL ROLE authenticated;
     ${sql}
     COMMIT;`,
    { claims: JSON.stringify({ sub, role: 'authenticated' }), sub, team: TEAM }
  )
}

const AUDIT_SQL = `SELECT action || '@' || (metadata->>'version') FROM audit_logs
  WHERE resource LIKE 'private_registry_skills/' || :'team' || '/%' ORDER BY 1;`
const DATA_SQL = `SELECT version FROM private_registry_skills WHERE team_id = :'team'
  UNION SELECT version FROM get_private_registry_submissions(:'team', NULL);`

const SEATS = { MEMBER, SUBMITTER, REVIEWER, OUTSIDER } as const

beforeAll(async () => {
  if (noLiveTestPg) return
  const base = testConnParamsFromEnv()
  if (!base) throw new Error('unreachable: noLiveTestPg already checked')
  conn = await resetSchema(base, SCHEMA)
  await runPsql(conn, realVisibilitySql(SCHEMA))
  await runPsql(
    conn,
    `INSERT INTO team_members (team_id, user_id, role) VALUES
       (:'team', :'submitter'::uuid, 'member'),
       (:'team', :'reviewer'::uuid, 'admin'),
       (:'team', :'member'::uuid, 'member');`,
    { team: TEAM, submitter: SUBMITTER, reviewer: REVIEWER, member: MEMBER }
  )

  // 1.0.0 stays pending; 2.0.0 is rejected; 3.0.0 approved then deprecated; 4.0.0 approved.
  for (const version of ['1.0.0', '2.0.0', '3.0.0', '4.0.0']) {
    await runAs(
      conn,
      asUser(SUBMITTER),
      `INSERT INTO private_registry_skills (team_id, skill_id, version, content)
       VALUES (:'team', 'ns/skill', :'version', '{"SKILL.md":"body"}');`,
      { team: TEAM, version }
    )
  }
  const decide = (version: string, decision: string) =>
    runAs(
      conn,
      { claims: { sub: REVIEWER, role: 'authenticated' }, role: null }, // the RPC's definer UPDATE
      `UPDATE private_registry_skills
          SET approval_status = :'decision', approved_by = :'reviewer'::uuid, approved_at = NOW()
        WHERE team_id = :'team' AND version = :'version';`,
      { team: TEAM, version, decision, reviewer: REVIEWER }
    )
  await decide('2.0.0', 'rejected')
  await decide('3.0.0', 'approved')
  await decide('4.0.0', 'approved')
  // Through the real private_registry_skills_admin_update policy, as the admin.
  await runAs(
    conn,
    asUser(REVIEWER),
    `UPDATE private_registry_skills SET deprecated = TRUE
      WHERE team_id = :'team' AND version = '3.0.0';`,
    { team: TEAM }
  )
  for (const version of ['1.0.0', '3.0.0']) {
    await runAs(
      conn,
      SERVICE,
      `UPDATE private_registry_skills SET description = 'ops edit'
        WHERE team_id = :'team' AND version = :'version';`,
      { team: TEAM, version }
    )
  }

  // Data visibility is snapshotted BEFORE the deletes, while every version still exists.
  for (const [seat, sub] of Object.entries(SEATS)) {
    dataSeen[seat] = new Set((await readAsUser(sub, DATA_SQL)).map(([v]) => v))
  }
  await runAs(
    conn,
    SERVICE,
    `DELETE FROM private_registry_skills WHERE team_id = :'team' AND version IN ('1.0.0', '4.0.0');`,
    { team: TEAM }
  )

  for (const [seat, sub] of Object.entries(SEATS)) {
    auditSeen[seat] = (await readAsUser(sub, AUDIT_SQL)).map(([x]) => x)
  }
  serviceRows = (
    await queryRows(
      conn,
      `BEGIN; SET LOCAL ROLE service_role;
       SELECT action || '@' || (metadata->>'version'), metadata->>'member_visible', (metadata ? 'team_id')::text
         FROM audit_logs WHERE metadata->>'registry_team_id' = :'team' ORDER BY 1;
       COMMIT;`,
      { team: TEAM }
    )
  ).map(([event, tagged, hasKey]) => ({
    event,
    tagged: tagged === 'true',
    hasTeamIdKey: hasKey === 'true',
  }))
}, 120_000)

/** The five member-visible events in this scenario. */
const TAGGED = ['approve@3.0.0', 'approve@4.0.0', 'delete@4.0.0', 'deprecate@3.0.0', 'update@3.0.0']

describe.skipIf(noLiveTestPg)('private-registry audit visibility (SMI-6114)', () => {
  it('a plain member cannot read the audit row of a pending publish', () => {
    expect(auditSeen.MEMBER).not.toContain('publish@1.0.0')
    expect(auditSeen.MEMBER.filter((e) => e.startsWith('publish@'))).toEqual([])
  })

  it('a plain member can read the approve row', () => {
    expect(auditSeen.MEMBER).toContain('approve@3.0.0')
  })

  it('a plain member cannot read the reject row', () => {
    expect(auditSeen.MEMBER).not.toContain('reject@2.0.0')
  })

  it('every team member reads exactly the member-visible events, whatever their role', () => {
    expect(auditSeen.MEMBER).toEqual(TAGGED)
    expect(auditSeen.SUBMITTER).toEqual(TAGGED) // not their own pending/rejected rows
    expect(auditSeen.REVIEWER).toEqual(TAGGED) // not the reject they wrote
  })

  it('a non-member reads nothing', () => {
    expect(auditSeen.OUTSIDER).toEqual([])
  })

  it('service_role (BYPASSRLS) reads every row; team_id is present exactly on the tagged ones', () => {
    expect(serviceRows).toHaveLength(12)
    expect(serviceRows.filter((r) => r.tagged).map((r) => r.event)).toEqual(TAGGED)
    expect(serviceRows.every((r) => r.tagged === r.hasTeamIdKey)).toBe(true)
  })

  it('audit visibility never exceeds data visibility, for any reader', () => {
    // Sanity on the denominator: the RPC gives the submitter and reviewer the hidden versions.
    expect([...dataSeen.MEMBER].sort()).toEqual(['3.0.0', '4.0.0'])
    expect([...dataSeen.SUBMITTER].sort()).toEqual(['1.0.0', '2.0.0', '3.0.0', '4.0.0'])
    expect([...dataSeen.REVIEWER].sort()).toEqual(['1.0.0', '2.0.0', '3.0.0', '4.0.0'])
    expect(dataSeen.OUTSIDER.size).toBe(0)
    for (const seat of Object.keys(SEATS)) {
      const leaked = auditSeen[seat].filter((e) => !dataSeen[seat].has(e.split('@')[1]))
      expect({ seat, leaked }).toEqual({ seat, leaked: [] })
    }
  })
})
