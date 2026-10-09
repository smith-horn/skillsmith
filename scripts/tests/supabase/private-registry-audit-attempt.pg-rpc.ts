/**
 * SMI-6114 — assertion arms for `record_private_registry_audit_attempt()` (live Postgres).
 *
 * Each arm is an exported async function so the revert-then-restore block (`pg-reds.ts`) can run
 * the SAME assertion against a broken build. Every `expect` carries a UNIQUE label: a red-test
 * pins the label it declared before mutating, so "failed" can never mean "failed somewhere else".
 * Expectations come from the declarative tables in the helpers, never from the TypeScript audit
 * module. Registered inside the one top-level describe of `private-registry-audit-attempt.pg.test.ts`
 * (a single file, so vitest never runs two suites against the same database at once).
 *
 * @module scripts/tests/supabase/private-registry-audit-attempt.pg-rpc
 */

import { describe, it, expect } from 'vitest'
import {
  ACCEPTED,
  ALL_OPERATIONS,
  EXPECTED_ARGNAMES,
  EXPECTED_KEYS,
  REFUSED,
  SKILL_A,
  SKILL_B,
  TAKES_SKILL,
  TEAM_A,
  U_LONER,
  U_MEMBER,
  U_OUTSIDER,
  U_PEER,
  attempt,
  byDetail,
  callAs,
  scalar,
  snapshot,
  sqlstate,
  totalRows,
  type Ctx,
  type PsqlSession,
} from './private-registry-audit-attempt.test-helpers.ts'
import {
  BOUNDS,
  assertTextBound,
  assertValueBound,
} from './private-registry-audit-attempt.pg-bounds.ts'

export async function assertCatalogShape(ctl: PsqlSession) {
  const q = (sql: string) => ctl.send(sql)
  const cnt = await q(
    "SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'record_private_registry_audit_attempt';"
  )
  expect(scalar(cnt.stdout), 'exactly one function of that name').toBe('1')
  const names = await q(
    "SELECT array_to_json(proargnames) FROM pg_proc WHERE proname = 'record_private_registry_audit_attempt';"
  )
  expect(JSON.parse(scalar(names.stdout)!), 'proargnames element for element').toEqual([
    ...EXPECTED_ARGNAMES,
  ])
  const flags = await q(
    "SELECT prosecdef, provolatile, proconfig::text, EXISTS (SELECT 1 FROM unnest(proargtypes::oid[]) t WHERE t = 'jsonb'::regtype) FROM pg_proc WHERE proname = 'record_private_registry_audit_attempt';"
  )
  const [secdef, vol, cfg, hasJsonb] = scalar(flags.stdout)!.split('|')
  expect(secdef, 'prosecdef').toBe('t')
  expect(vol, "provolatile = 'v'").toBe('v')
  expect(cfg, 'pinned search_path').toContain('search_path=public, pg_temp')
  expect(hasJsonb, 'no jsonb parameter').toBe('f')
}

/** Member call for one accepted pairing; list/namespace pass NULL skill. */
export async function assertAcceptedCase(ctl: PsqlSession, op: string, result: string) {
  const id = `acc-${op}-${result}`
  const takes = TAKES_SKILL(op)
  const res = await attempt(ctl, U_MEMBER, {
    operation: op,
    result,
    skillId: takes ? 'nsa6114/skill-x' : null,
    version: takes ? '1.2.3' : null,
    detail: id,
    fileCount: 3,
    contentHash: takes ? 'hash-abc' : null,
    teamId: TEAM_A,
    fingerprint: 'abcdef012345',
    authRole: 'admin',
  })
  expect(res.stderr, `${id}: accepted call must not error`).not.toMatch(/ERROR/)
  const s = await snapshot(ctl, byDetail(id))
  expect(s, `${id}: a row must exist`).not.toBeNull()
  const r = s!
  expect(r.n, `${id}: count = 1`).toBe(1)
  // Paired presence FIRST, so the absence assertion below cannot pass on an empty/unrelated row.
  expect(r.hasAuditSource, `${id}: paired presence of audit_source`).toBe(true)
  expect(r.md.audit_source, `${id}: audit_source is client_reported`).toBe('client_reported')
  expect(r.hasRequestedTeamId, `${id}: paired presence of requested_team_id`).toBe(true)
  expect(r.md.requested_team_id, `${id}: requested_team_id`).toBe(TEAM_A)
  expect(r.md.registry_team_id, `${id}: registry_team_id equals the verified team`).toBe(TEAM_A)
  expect(r.noTeamIdKey, `${id}: NOT (metadata ? 'team_id')`).toBe(true)
  expect(r.md.member_visible, `${id}: member_visible is false`).toBe(false)
  expect(r.md.audit_writer, `${id}: audit_writer is attempt_rpc`).toBe('attempt_rpc')
  expect(r.eventType, `${id}: event_type`).toBe(`private_registry:${op}`)
  expect(r.action, `${id}: action`).toBe(op)
  expect(r.result, `${id}: result`).toBe(result)
  expect(r.actor, `${id}: actor shape`).toBe(`user:${U_MEMBER}`)
  expect(r.keys, `${id}: exact metadata key set`).toEqual([...EXPECTED_KEYS])
  expect(r.md.skill_id, `${id}: attributed skill_id`).toBe(takes ? 'nsa6114/skill-x' : null)
  expect(r.md.version, `${id}: attributed version`).toBe(takes ? '1.2.3' : null)
  expect(r.md.content_hash, `${id}: attributed content_hash`).toBe(takes ? 'hash-abc' : null)
  expect(r.md.auth_role, `${id}: auth_role`).toBe('admin')
  expect(r.md.file_count, `${id}: file_count`).toBe(3)
  expect(r.md.license_key_fingerprint, `${id}: fingerprint`).toBe('abcdef012345')
  expect(r.md.actor_user_id, `${id}: actor_user_id`).toBe(U_MEMBER)
  expect(r.md.auth_path, `${id}: auth_path`).toBe('user_jwt')
  expect(r.md.transport, `${id}: transport`).toBe('mcp_server')
  const expectedResource = takes
    ? `private_registry_skills/${TEAM_A}/nsa6114/skill-x@1.2.3`
    : op === 'namespace'
      ? `teams/${TEAM_A}`
      : `private_registry_skills/${TEAM_A}`
  expect(r.resource, `${id}: resource`).toBe(expectedResource)
}

export async function assertRefusedCase(ctl: PsqlSession, op: string, result: string) {
  const id = `ref-${op}-${result}`
  const before = await totalRows(ctl)
  const res = await attempt(ctl, U_MEMBER, { operation: op, result, detail: id, teamId: TEAM_A })
  expect(sqlstate(res), `${id}: refusal raises 22023 (stderr: ${res.stderr})`).toBe('22023')
  expect(await totalRows(ctl), `${id}: no row written`).toBe(before)
}

const EXPECTED_UNVERIFIED = (op: string) =>
  op === 'namespace' ? 'teams/unverified' : 'private_registry_skills/unverified'

/** Non-member with a realistic fixture: real team with other members, caller in a different team,
 *  slash-form skill of the requested team's real namespace. */
export async function assertNonMemberCase(ctl: PsqlSession, op: string) {
  const id = `nm-${op}`
  const takes = TAKES_SKILL(op)
  const res = await attempt(ctl, U_OUTSIDER, {
    operation: op,
    result: 'error',
    skillId: takes ? SKILL_A : null,
    version: takes ? '1.0.0' : null,
    contentHash: takes ? 'hash-a' : null,
    detail: id,
    teamId: TEAM_A,
  })
  expect(res.stderr, `${id}: non-membership is a success, not a refusal`).not.toMatch(/ERROR/)
  const s = await snapshot(ctl, byDetail(id))
  expect(s, `${id}: a row must exist`).not.toBeNull()
  const r = s!
  expect(r.n, `${id}: count = 1`).toBe(1)
  expect(r.hasRequestedSkillId, `${id}: paired presence of requested_skill_id`).toBe(true)
  expect(r.md.requested_skill_id, `${id}: requested_skill_id equals input`).toBe(
    takes ? SKILL_A : null
  )
  expect(r.jsonNullSkillId, `${id}: non-member skill_id is JSON null`).toBe(true)
  expect(r.jsonNullVersion, `${id}: non-member version is JSON null`).toBe(true)
  expect(r.jsonNullContentHash, `${id}: non-member content_hash is JSON null`).toBe(true)
  expect(r.md.requested_version, `${id}: requested_version equals input`).toBe(
    takes ? '1.0.0' : null
  )
  expect(r.md.requested_content_hash, `${id}: requested_content_hash`).toBe(takes ? 'hash-a' : null)
  expect(r.md.requested_team_id, `${id}: requested_team_id equals input`).toBe(TEAM_A)
  expect(
    'registry_team_id' in r.md && r.md.registry_team_id === null,
    `${id}: registry_team_id JSON null`
  ).toBe(true)
  expect(r.resource, `${id}: resource is exactly the /unverified form`).toBe(
    EXPECTED_UNVERIFIED(op)
  )
  expect(r.noTeamIdKey, `${id}: NOT (metadata ? 'team_id')`).toBe(true)
}

/** Verified member naming ANOTHER team's real namespace. */
export async function assertMemberOtherNamespace(ctl: PsqlSession, op: string) {
  const id = `mo-${op}`
  const res = await attempt(ctl, U_MEMBER, {
    operation: op,
    result: 'error',
    skillId: SKILL_B,
    version: '1.0.0',
    contentHash: 'hash-b',
    detail: id,
    teamId: TEAM_A,
  })
  expect(res.stderr, `${id}: call must not error`).not.toMatch(/ERROR/)
  const s = await snapshot(ctl, byDetail(id))
  expect(s, `${id}: a row must exist`).not.toBeNull()
  const r = s!
  expect(r.n, `${id}: count = 1`).toBe(1)
  expect(r.hasRequestedSkillId, `${id}: paired presence of requested_skill_id`).toBe(true)
  expect(r.md.requested_skill_id, `${id}: requested_skill_id is set`).toBe(SKILL_B)
  expect(r.jsonNullSkillId, `${id}: other-namespace skill_id is JSON null`).toBe(true)
  expect(r.jsonNullVersion, `${id}: other-namespace version is JSON null`).toBe(true)
  expect(r.jsonNullContentHash, `${id}: other-namespace content_hash is JSON null`).toBe(true)
  expect(r.md.registry_team_id, `${id}: registry_team_id is the verified team`).toBe(TEAM_A)
  expect(r.resource, `${id}: resource names only the verified team`).toBe(
    op === 'namespace' ? `teams/${TEAM_A}` : `private_registry_skills/${TEAM_A}`
  )
}

/** p_skill_id is never refused; a malformed one writes one row with JSON-null plain keys. */
export async function assertMalformedSkill(ctl: PsqlSession, tag: string, value: string | null) {
  const id = `ms-${tag}`
  const res = await attempt(ctl, U_MEMBER, {
    operation: 'get',
    result: 'error',
    skillId: value,
    version: '9.9.9',
    detail: id,
    teamId: TEAM_A,
  })
  expect(res.stderr, `${id}: p_skill_id is never refused`).not.toMatch(/ERROR/)
  const s = await snapshot(ctl, byDetail(id))
  expect(s, `${id}: a row must exist`).not.toBeNull()
  const r = s!
  expect(r.n, `${id}: count = 1`).toBe(1)
  expect(r.hasRequestedSkillId, `${id}: paired presence of requested_skill_id`).toBe(true)
  expect(r.md.requested_skill_id, `${id}: requested_skill_id equals the supplied value`).toBe(value)
  expect(r.jsonNullSkillId, `${id}: skill_id is JSON null`).toBe(true)
  expect(r.jsonNullVersion, `${id}: version is JSON null`).toBe(true)
  expect(r.resource, `${id}: resource carries no skill segment`).toBe(
    `private_registry_skills/${TEAM_A}`
  )
}

/** Closed-set / NULL arguments: 22023, never 23502, and no row. */
export async function assertClosedSet(
  ctl: PsqlSession,
  tag: string,
  operation: string | null,
  result: string | null
) {
  const before = await totalRows(ctl)
  const res = await attempt(ctl, U_MEMBER, {
    operation,
    result,
    detail: `cs-${tag}`,
    teamId: TEAM_A,
  })
  expect(sqlstate(res), `${tag}: SQLSTATE is 22023 (stderr: ${res.stderr})`).toBe('22023')
  expect(sqlstate(res), `${tag}: SQLSTATE is not 23502`).not.toBe('23502')
  expect(await totalRows(ctl), `${tag}: no row written`).toBe(before)
}

export async function assertNonMemberNeverPopulatesSkill(ctl: PsqlSession) {
  await assertNonMemberCase(ctl, 'get')
}

export async function assertAnonNoExecute(ctl: PsqlSession) {
  const fn =
    "'public.record_private_registry_audit_attempt(text,text,text,text,text,integer,text,text,text,text)'::regprocedure"
  const has = await ctl.send(`SELECT has_function_privilege('anon', ${fn}, 'EXECUTE');`)
  expect(scalar(has.stdout), "has_function_privilege('anon', rpc, 'EXECUTE') is false").toBe('f')
}

export async function assertServiceRoleNoExecute(ctl: PsqlSession) {
  const fn =
    "'public.record_private_registry_audit_attempt(text,text,text,text,text,integer,text,text,text,text)'::regprocedure"
  const has = await ctl.send(`SELECT has_function_privilege('service_role', ${fn}, 'EXECUTE');`)
  expect(
    scalar(has.stdout),
    "has_function_privilege('service_role', rpc, 'EXECUTE') is false"
  ).toBe('f')
}

/** The design's central property, through the REAL audit_logs_team_scoped_read policy: rows the RPC
 *  writes for a verified member are invisible to team members, while a team_id-tagged control row
 *  IS visible (so the policy is live) and a superuser sees every written row (paired presence). */
export async function assertRowsInvisibleToMembers(ctl: PsqlSession) {
  const pairs: Array<[string, string]> = [
    ['get', 'error'],
    ['deprecate', 'denied'],
    ['list', 'success'],
    ['namespace', 'not_found'],
  ]
  for (const [i, [op, result]] of pairs.entries()) {
    const res = await attempt(ctl, U_MEMBER, {
      operation: op,
      result,
      detail: `vis-w${i}`,
      teamId: TEAM_A,
    })
    expect(res.stderr, `vis-w${i}: write must succeed`).not.toMatch(/ERROR/)
  }
  await ctl.send(
    `INSERT INTO audit_logs (event_type, actor, resource, action, result, metadata)
     VALUES ('private_registry:get', 'user:ctl', 'r', 'get', 'success',
             '{"detail":"vis-ctl","team_id":"${TEAM_A}"}'::jsonb);`
  )
  const count = async (uid: string | null, role: 'authenticated' | null, like: string) => {
    const sql = `SELECT count(*) FROM audit_logs WHERE metadata->>'detail' LIKE '${like}';`
    const r = role ? await callAs(ctl, role, uid, sql) : await ctl.send(sql)
    expect(r.stderr, `count query for ${like}`).not.toMatch(/ERROR/)
    return scalar(r.stdout)
  }
  expect(
    await count(null, null, 'vis-w%'),
    'paired presence: superuser sees every written row'
  ).toBe('4')
  for (const uid of [U_MEMBER, U_PEER])
    expect(
      await count(uid, 'authenticated', 'vis-ctl'),
      'control: a member CAN see a team_id-tagged row'
    ).toBe('1')
  for (const uid of [U_MEMBER, U_PEER])
    expect(await count(uid, 'authenticated', 'vis-w%'), 'members see ZERO rows the RPC wrote').toBe(
      '0'
    )
}

export function registerRpcTests(ctx: Ctx) {
  const ctl = () => ctx.ctl()

  describe('catalog, privileges, authentication', () => {
    it('exactly one function, argument names element for element, SECURITY DEFINER, pinned search_path, VOLATILE, no jsonb', async () => {
      await assertCatalogShape(ctl())
    })

    it('monitor function is service_role-only and STABLE', async () => {
      const fn = "'public.registry_audit_volume_over_threshold(integer,timestamptz)'::regprocedure"
      const r = await ctl().send(
        `SELECT has_function_privilege('service_role', ${fn}, 'EXECUTE'), has_function_privilege('authenticated', ${fn}, 'EXECUTE'), has_function_privilege('anon', ${fn}, 'EXECUTE'), (SELECT provolatile FROM pg_proc WHERE oid = ${fn}), (SELECT prosecdef FROM pg_proc WHERE oid = ${fn});`
      )
      expect(scalar(r.stdout)).toBe('t|f|f|s|t')
    })

    it('unauthenticated (authenticated role, no sub claim): 42501 AND not_authenticated', async () => {
      const before = await totalRows(ctl())
      const res = await attempt(ctl(), null, { operation: 'get', result: 'error', teamId: TEAM_A })
      expect(sqlstate(res), 'no sub claim raises 42501').toBe('42501')
      expect(res.stderr, 'message is not_authenticated').toContain('not_authenticated')
      expect(await totalRows(ctl()), 'no row written').toBe(before)
    })

    it('service_role has no EXECUTE (catalog) and its call fails 42501', async () => {
      await assertServiceRoleNoExecute(ctl())
      const res = await callAs(
        ctl(),
        'service_role',
        null,
        "SELECT public.record_private_registry_audit_attempt(p_operation => 'get', p_result => 'error');"
      )
      expect(sqlstate(res), 'service_role call is permission denied').toBe('42501')
      expect(res.stderr, 'refused by the ACL, not by the body').toMatch(
        /permission denied for function/
      )
      expect(res.stderr, 'never reaches the not_authenticated check').not.toContain(
        'not_authenticated'
      )
    })

    it('rows the RPC writes are invisible to team members through the real RLS policy', async () => {
      await assertRowsInvisibleToMembers(ctl())
    })

    it('anon has no EXECUTE (catalog) and cannot call it', async () => {
      await assertAnonNoExecute(ctl())
      const res = await callAs(
        ctl(),
        'anon',
        U_MEMBER,
        "SELECT public.record_private_registry_audit_attempt(p_operation => 'get', p_result => 'error');"
      )
      expect(sqlstate(res), 'anon call is permission denied').toBe('42501')
    })
  })

  describe('28 accepted + 8 refused pairings (declarative table)', () => {
    for (const { op, results } of ACCEPTED)
      for (const result of results)
        it(`accepted ${op}/${result}: one untagged client_reported row`, async () => {
          await assertAcceptedCase(ctl(), op, result)
        })
    for (const [op, result] of REFUSED)
      it(`refused ${op}/${result}: 22023`, async () => {
        await assertRefusedCase(ctl(), op, result)
      })
  })

  describe('closed set and NULL arguments', () => {
    it('unknown operation / unknown result / NULL operation / NULL result: 22023, never 23502', async () => {
      await assertClosedSet(ctl(), 'unknown-operation', 'frobnicate', 'error')
      await assertClosedSet(ctl(), 'unknown-result', 'get', 'maybe')
      await assertClosedSet(ctl(), 'null-operation', null, 'error')
      await assertClosedSet(ctl(), 'null-result', 'get', null)
    })
  })

  describe('attribution', () => {
    for (const op of ALL_OPERATIONS)
      it(`non-member ${op}: success row, /unverified resource, JSON-null plain keys`, async () => {
        await assertNonMemberCase(ctl(), op)
      })
    for (const op of ALL_OPERATIONS)
      it(`member naming another team's namespace (${op}): JSON-null plain keys, verified-team resource`, async () => {
        await assertMemberOtherNamespace(ctl(), op)
      })
    const MALFORMED: Array<[string, string | null]> = [
      ['null', null],
      ['no-slash', 'noslash'],
      ['two-slashes', 'nsa6114/x/y'],
      ['empty', ''],
      ['leading-slash', '/x'],
      ['trailing-slash', 'x/'],
      ['ns-trailing-slash', 'nsa6114/'],
    ]
    for (const [tag, value] of MALFORMED)
      it(`p_skill_id ${tag} is never refused`, async () => {
        await assertMalformedSkill(ctl(), tag, value)
      })
    for (const [tag, teamId] of [
      ['null', null],
      ['blank', ''],
    ] as const)
      it(`${tag} p_team_id is a success row with the /unverified resource`, async () => {
        const id = `nt-${tag}`
        const res = await attempt(ctl(), U_MEMBER, {
          operation: 'get',
          result: 'error',
          skillId: SKILL_A,
          version: '1.0.0',
          detail: id,
          teamId,
        })
        expect(res.stderr, `${id}: not a refusal`).not.toMatch(/ERROR/)
        const r = (await snapshot(ctl(), byDetail(id)))!
        expect(r.n, `${id}: count = 1`).toBe(1)
        expect(r.hasRequestedTeamId, `${id}: paired presence of requested_team_id`).toBe(true)
        expect(r.md.requested_team_id, `${id}: requested_team_id equals input`).toBe(teamId)
        expect(r.md.registry_team_id, `${id}: registry_team_id is null`).toBeNull()
        expect(r.jsonNullSkillId, `${id}: skill_id JSON null`).toBe(true)
        expect(r.resource, `${id}: /unverified resource`).toBe('private_registry_skills/unverified')
        expect(r.noTeamIdKey, `${id}: no team_id key`).toBe(true)
      })
    it('a caller in no team at all is still a success row', async () => {
      const res = await attempt(ctl(), U_LONER, {
        operation: 'list',
        result: 'success',
        teamId: TEAM_A,
        detail: 'loner',
      })
      expect(res.stderr).not.toMatch(/ERROR/)
      expect((await snapshot(ctl(), byDetail('loner')))!.resource).toBe(
        'private_registry_skills/unverified'
      )
    })
  })

  describe('actor and bounds', () => {
    it('actor is user:<fixture uuid literal>; the fixture uuid is non-null', async () => {
      expect(U_MEMBER, 'fixture uuid literal').toMatch(/^[0-9a-f-]{36}$/)
      await attempt(ctl(), U_MEMBER, {
        operation: 'get',
        result: 'error',
        detail: 'actor',
        teamId: TEAM_A,
      })
      const r = await ctl().send(
        `SELECT al.actor IS NOT DISTINCT FROM 'user:' || '${U_MEMBER}', '${U_MEMBER}'::uuid IS NOT NULL FROM audit_logs al WHERE ${byDetail('actor')};`
      )
      expect(scalar(r.stdout), 'actor matches and the literal is non-null').toBe('t|t')
    })
    for (const b of BOUNDS)
      it(`${b.arg}: ${b.limit} multibyte chars accepted, ${b.limit + 1} refused`, async () => {
        await assertTextBound(ctl(), b)
      })
    it('p_auth_role, p_file_count and p_license_key_fingerprint bounds', async () => {
      for (const v of ['admin', 'member', null])
        await assertValueBound(ctl(), `role-${v}`, { authRole: v }, true)
      for (const v of ['owner', '', 'ADMIN'])
        await assertValueBound(ctl(), `role-bad-${v}`, { authRole: v }, false)
      for (const v of [0, 100000]) await assertValueBound(ctl(), `fc-${v}`, { fileCount: v }, true)
      for (const v of [-1, 100001])
        await assertValueBound(ctl(), `fc-bad-${v}`, { fileCount: v }, false)
      await assertValueBound(ctl(), 'fp-ok', { fingerprint: 'abcdef012345' }, true)
      for (const v of ['abcdef01234', 'ABCDEF012345', 'zzzzzzzzzzzz', 'abcdef0123456'])
        await assertValueBound(ctl(), `fp-bad-${v}`, { fingerprint: v }, false)
    })
  })
}
