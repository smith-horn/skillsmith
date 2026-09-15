/**
 * SMI-6651 (plan D14, ADR-162 §1) — `release_private_registry_skill_content()`, the SECURITY
 * DEFINER RPC that is now the ONLY path back to `private_registry_skills.content` for
 * `authenticated`. Harness, env vars, real-vs-stub inventory: ./private-registry-content-
 * release.test-helpers.ts.
 *
 * Every `it()` asserts VALUES, never just "did not throw" (CLAUDE.md's SMI-6598 rule). The
 * "revert-then-restore" describe block at the bottom breaks each of 11 guards (a-e, g-l — f
 * reuses d's break against a different scenario; (i) is an explicitly-labeled STRUCTURAL check,
 * not a behavioral one -- see its own comment), confirms the targeted assertion FAILS, then
 * restores the real migration and confirms it passes again.
 *
 * SMI-6114 untag rule (round 3, after the SMI-6651 branch rebased onto PR #2850): audit rows now
 * carry `metadata.registry_team_id` + `metadata.member_visible` always, and the `team_id` KEY
 * (not merely its value) only on a `success` row, mirroring `audit_private_registry_skills_
 * change()` (20260913000000) and `isMemberVisible()` (registry-tools.live.audit.ts). T3/T4/T5/T6
 * assert this directly; V-visibility proves it through the REAL `audit_logs_team_scoped_read`
 * RLS policy rather than by construction alone.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  PsqlSession,
  requireTestConn,
  noLiveTestPg,
  baseSchemaSql,
  migrationSql,
  fixtureSql,
  asUid,
  rows,
  scalar,
  MEMBER,
  MEMBER2,
  ADMIN,
  TEAM_ENT,
  TEAM_LAPSED,
  TEAM_OTHER,
  BODY_V1,
  BODY_V2,
  BODY_FALLBACK_V1,
  type TestConn,
} from './private-registry-content-release.test-helpers.ts'
import { brokenMigrationSql } from './private-registry-content-release.test-reverts.ts'

const NULL_SENTINEL = '<null>'

/** Extracts the step-4 content re-read's own `SELECT ... ;` verbatim out of a migration text, for
 *  Finding-5(a)'s STRUCTURAL predicate assertions -- see that test's own comment for why a static
 *  text check, not a live two-session interleaving, is what this guard's own timing constraints
 *  leave available. */
function extractReReadSelect(sql: string): string {
  const start = sql.indexOf('SELECT prs.content INTO v_content')
  if (start === -1) throw new Error('extractReReadSelect: anchor not found')
  const end = sql.indexOf(';', start)
  if (end === -1) throw new Error('extractReReadSelect: unterminated statement')
  return sql.slice(start, end + 1)
}

let conn: TestConn
let ctl: PsqlSession

function lit(v: string | null): string {
  return v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`
}

function rpcCall(
  skillId: string,
  version: string | null,
  teamId: string | null,
  transport: string | null,
  requestId: string | null
): string {
  return `SELECT public.release_private_registry_skill_content(${lit(skillId)}, ${lit(version)}, ${lit(teamId)}, ${lit(transport)}, ${lit(requestId)});`
}

/** `{"detail": "...", "status": "denied"}` — jsonb_build_object's canonical text form sorts keys
 *  alphabetically, so `detail` always precedes `status`. */
function deniedJson(detail: string): string {
  return `{"detail": "${detail}", "status": "denied"}`
}

/** One SET ROLE / set_config / query / RESET ROLE cycle, as four separate sends so the query's
 *  own stdout is never mixed with a command-completion tag from the role/GUC setup. */
async function callAs(
  role: 'authenticated' | 'anon',
  uid: string | null,
  sql: string
): Promise<{ stdout: string; stderr: string }> {
  await ctl.send(`SET ROLE ${role};`)
  try {
    await ctl.send(asUid(uid))
    return await ctl.send(sql)
  } finally {
    await ctl.send('RESET ROLE;')
  }
}

/** Call the RPC as MEMBER and expect `expected`. */
async function expectAsMember(
  skillId: string,
  version: string | null,
  teamId: string | null,
  requestId: string,
  expected: string
): Promise<void> {
  const call = await callAs(
    'authenticated',
    MEMBER,
    rpcCall(skillId, version, teamId, null, requestId)
  )
  expect(call.stderr, `unexpected error for ${requestId}:\n${call.stderr}`).not.toMatch(/ERROR/)
  expect(call.stdout).toBe(expected)
}

const AUDIT_FIELDS = [
  'eventType',
  'actor',
  'action',
  'result',
  'resource',
  'teamId',
  'hasTeamIdKey',
  'registryTeamId',
  'requestedTeamId',
  'memberVisible',
  'skillId',
  'version',
  'authPath',
  'actorUserId',
  'transport',
  'requestId',
  'detail',
  'fileCount',
  'contentHash',
  'auditWriter',
  'noBodyLeak',
] as const
type AuditRow = Record<(typeof AUDIT_FIELDS)[number], string>

/** `teamId` is `metadata->>'team_id'`, coalesced (so an ABSENT key and an actual NULL both read
 *  as the sentinel — `hasTeamIdKey`, from `metadata ? 'team_id'`, is what distinguishes them,
 *  per the SMI-6114 rule's own "truly absent, not a JSON null" requirement). */
function auditQuery(requestId: string): string {
  const c = (expr: string) => `coalesce(${expr}, '${NULL_SENTINEL}')`
  return `SELECT al.event_type, al.actor, al.action, al.result, al.resource,
    ${c("al.metadata->>'team_id'")}, (al.metadata ? 'team_id'),
    ${c("al.metadata->>'registry_team_id'")}, ${c("al.metadata->>'requested_team_id'")},
    ${c("al.metadata->>'member_visible'")},
    ${c("al.metadata->>'skill_id'")},
    ${c("al.metadata->>'version'")}, ${c("al.metadata->>'auth_path'")},
    ${c("al.metadata->>'actor_user_id'")}, ${c("al.metadata->>'transport'")},
    ${c("al.metadata->>'request_id'")}, ${c("al.metadata->>'detail'")},
    ${c("al.metadata->>'file_count'")}, ${c("al.metadata->>'content_hash'")},
    ${c("al.metadata->>'audit_writer'")}, (al::text NOT LIKE '%SENTINEL%')
  FROM audit_logs al WHERE al.metadata->>'request_id' = '${requestId}' ORDER BY al.created_at;`
}

function parseAuditRow(f: string[]): AuditRow {
  return Object.fromEntries(AUDIT_FIELDS.map((k, i) => [k, f[i]])) as AuditRow
}

async function auditRowsFor(requestId: string): Promise<AuditRow[]> {
  const res = await ctl.send(auditQuery(requestId))
  expect(res.stderr).not.toMatch(/ERROR/)
  return rows(res.stdout).map(parseAuditRow)
}

async function auditCountFor(requestId: string): Promise<string | null> {
  const res = await ctl.send(
    `SELECT count(*) FROM audit_logs WHERE metadata->>'request_id' = '${requestId}';`
  )
  return scalar(res.stdout)
}

/** Rebuild schema (base + given migration text) then reload fixtures. */
async function rebuildWith(
  migrationText: string,
  opts: { expectSelfSmokeFailure?: boolean } = {}
): Promise<void> {
  const res = await ctl.send(baseSchemaSql() + '\n' + migrationText)
  if (opts.expectSelfSmokeFailure) {
    expect(res.stderr, 'expected the migration to trip its own smoke block').toMatch(/SMOKE FAIL/)
  } else {
    expect(res.stderr, `schema+migration build failed:\n${res.stderr}`).not.toMatch(/ERROR/)
  }
  const fx = await ctl.send(fixtureSql())
  expect(fx.stderr, `fixture load failed:\n${fx.stderr}`).not.toMatch(/ERROR/)
}

/** Install (or remove) a BEFORE INSERT trigger on audit_logs that always raises — test 7's and
 *  revert (b)'s fail-closed probe. */
async function installAuditBoom(): Promise<void> {
  await ctl.send(`
    CREATE OR REPLACE FUNCTION smi6651_boom() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'forced audit failure' USING ERRCODE = 'XX000'; END $$;
    DROP TRIGGER IF EXISTS smi6651_boom_trg ON audit_logs;
    CREATE TRIGGER smi6651_boom_trg BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION smi6651_boom();
  `)
}
async function removeAuditBoom(): Promise<void> {
  await ctl.send(
    'DROP TRIGGER IF EXISTS smi6651_boom_trg ON audit_logs; DROP FUNCTION IF EXISTS smi6651_boom();'
  )
}

describe.skipIf(noLiveTestPg)('SMI-6651 — release_private_registry_skill_content()', () => {
  beforeAll(async () => {
    conn = requireTestConn()
    ctl = new PsqlSession(conn, 'ctl')
    await ctl.send('\\set VERBOSITY verbose')
    await rebuildWith(migrationSql())
  }, 90_000)

  afterAll(async () => {
    await ctl?.close()
  })

  beforeEach(async () => {
    await ctl.send('RESET ROLE;')
    const fx = await ctl.send(fixtureSql())
    expect(fx.stderr).not.toMatch(/ERROR/)
  })

  it('T1: authenticated content=42501, metadata/count(*) OK, admin UPDATE+RETURNING id OK, RETURNING * =42501', async () => {
    const content = await callAs(
      'authenticated',
      MEMBER,
      "SELECT content FROM private_registry_skills WHERE skill_id = 'smi6651/happy' LIMIT 1;"
    )
    expect(content.stderr).toMatch(/42501/)

    const idRead = await callAs(
      'authenticated',
      MEMBER,
      "SELECT id FROM private_registry_skills WHERE skill_id = 'smi6651/happy' LIMIT 1;"
    )
    expect(idRead.stderr).not.toMatch(/ERROR/)
    expect(scalar(idRead.stdout)).not.toBeNull()

    const count = await callAs(
      'authenticated',
      MEMBER,
      'SELECT count(*) FROM private_registry_skills;'
    )
    // RLS-visible (approval_status='approved') to MEMBER: happy v1/v2, lapsed-skill, deprecated-
    // skill, versioned v1.5/v2.0, fallback v1.0/v2.0, malformed-skill (Finding 1 fixture) (9) +
    // the 4 ENTITLEMENT_TEAMS rows (tier/no-sub/trialing/pastdue-skill) + dangling-skill (5) = 14.
    // RLS never enforces `deprecated`, and MEMBER is a team member of every one of these fixture
    // teams.
    expect(scalar(count.stdout)).toBe('14')

    const upd = await callAs(
      'authenticated',
      ADMIN,
      `UPDATE private_registry_skills SET deprecated = deprecated WHERE skill_id = 'smi6651/happy' AND version = '1.0.0' RETURNING id;`
    )
    expect(upd.stderr).not.toMatch(/ERROR/)
    expect(scalar(upd.stdout)).not.toBeNull()

    const updStar = await callAs(
      'authenticated',
      ADMIN,
      `UPDATE private_registry_skills SET deprecated = deprecated WHERE skill_id = 'smi6651/happy' AND version = '1.0.0' RETURNING *;`
    )
    expect(updStar.stderr).toMatch(/42501/)
  })

  it('T2: privilege catalog — column split, table-level denial, function ACL, no PUBLIC EXECUTE', async () => {
    const colPriv = await ctl.send(`
      SELECT a.attname,
             (has_column_privilege('authenticated','public.private_registry_skills',a.attname,'SELECT') = (a.attname <> 'content'))
        FROM pg_attribute a
       WHERE a.attrelid = 'public.private_registry_skills'::regclass AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attname;`)
    for (const [col, ok] of rows(colPriv.stdout))
      expect(ok, `column ${col} privilege mismatch`).toBe('t')

    const tableAndFn = await ctl.send(`
      SELECT
        (NOT has_table_privilege('authenticated','public.private_registry_skills','SELECT')),
        (NOT has_table_privilege('anon','public.private_registry_skills','SELECT')),
        (NOT has_column_privilege('anon','public.private_registry_skills','content','SELECT')),
        coalesce((SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure('public.release_private_registry_skill_content(text,text,text,text,text)')), FALSE),
        coalesce((SELECT has_function_privilege('authenticated', to_regprocedure('public.release_private_registry_skill_content(text,text,text,text,text)'), 'EXECUTE')), FALSE),
        (NOT coalesce((SELECT has_function_privilege('anon', to_regprocedure('public.release_private_registry_skill_content(text,text,text,text,text)'), 'EXECUTE')), FALSE)),
        (NOT coalesce((SELECT EXISTS(SELECT 1 FROM pg_proc p, unnest(COALESCE(p.proacl, acldefault('f',p.proowner))) acl WHERE p.oid = to_regprocedure('public.release_private_registry_skill_content(text,text,text,text,text)') AND acl::text LIKE '=%')), TRUE));
    `)
    const [
      authNoTableSelect,
      anonNoTableSelect,
      anonNoContentSelect,
      isSecdef,
      authCanExec,
      anonCannotExec,
      noPublicExec,
    ] = rows(tableAndFn.stdout)[0]
    expect(authNoTableSelect).toBe('t')
    expect(anonNoTableSelect).toBe('t')
    expect(anonNoContentSelect).toBe('t')
    expect(isSecdef).toBe('t')
    expect(authCanExec).toBe('t')
    expect(anonCannotExec).toBe('t')
    expect(noPublicExec).toBe('t')

    const sv = await ctl.send('SELECT count(*) FROM schema_version WHERE version = 117;')
    expect(scalar(sv.stdout)).toBe('1')
  })

  it('T3: entitled member -> released with content, exactly one success audit row, no body leak', async () => {
    const call = await callAs(
      'authenticated',
      MEMBER,
      rpcCall('smi6651/happy', '2.0.0', null, 'edge_function', 't3')
    )
    expect(call.stderr).not.toMatch(/ERROR/)
    expect(call.stdout).toContain('"status": "released"')
    expect(call.stdout).toContain(BODY_V2)

    expect(await auditCountFor('t3')).toBe('1')
    const [row] = await auditRowsFor('t3')
    expect(row.result).toBe('success')
    // SMI-6114 untag rule: `team_id` is PRESENT (the key, not just a non-null value) only here.
    expect(row.hasTeamIdKey).toBe('t')
    expect(row.teamId).toBe(TEAM_ENT)
    expect(row.registryTeamId).toBe(TEAM_ENT)
    // requested_team_id (round 5): p_team_id was omitted (NULL) on this call -- the raw request,
    // recorded as-is, distinct from the verified team_id/registry_team_id above.
    expect(row.requestedTeamId).toBe(NULL_SENTINEL)
    expect(row.memberVisible).toBe('true')
    expect(row.fileCount).toBe('2')
    expect(row.contentHash).toBe('smi6651-hash-v2')
    expect(row.noBodyLeak).toBe('t')
  })

  it('T4/E2: member of a lapsed team -> denied/team_subscription_inactive, no content key, one audit row', async () => {
    await expectAsMember(
      'smi6651/lapsed-skill',
      null,
      null,
      't4',
      deniedJson('team_subscription_inactive')
    )
    expect(await auditCountFor('t4')).toBe('1')
    const [row] = await auditRowsFor('t4')
    expect(row.result).toBe('denied')
    // SMI-6114 untag rule: a denial never gets the `team_id` key, even though the row's team is
    // fully known — only registry_team_id (BYPASSRLS-readable) carries it.
    expect(row.hasTeamIdKey).toBe('f')
    expect(row.registryTeamId).toBe(TEAM_LAPSED)
    expect(row.requestedTeamId).toBe(NULL_SENTINEL)
    expect(row.memberVisible).toBe('false')
  })

  it('T5: not_found is byte-identical across other-team / nonexistent / pending / deprecated / wrong-team-filter', async () => {
    const cases: Array<[string, string | null, string]> = [
      ['smi6651/other-team-skill', null, 't5-a'],
      ['smi6651/does-not-exist', null, 't5-b'],
      ['smi6651/pending-skill', null, 't5-c'],
      ['smi6651/deprecated-skill', null, 't5-d'],
      ['smi6651/happy', TEAM_OTHER, 't5-e'],
    ]
    const returns: string[] = []
    const norm: string[] = []
    for (const [skillId, teamId, reqId] of cases) {
      const call = await callAs(
        'authenticated',
        MEMBER,
        rpcCall(skillId, null, teamId, null, reqId)
      )
      expect(call.stderr).not.toMatch(/ERROR/)
      returns.push(call.stdout)
      const [row] = await auditRowsFor(reqId)
      // No `team_id` key on ANY not_found row (SMI-6114 untag rule) — asserted directly per case,
      // not folded into `norm`, so a single mistagged case names itself instead of just breaking
      // set-size-1.
      expect(row.hasTeamIdKey, `case ${reqId} has a team_id key`).toBe('f')
      // Identical except id/timestamp (not selected) and metadata.skill_id/request_id (excluded
      // here). `resource` is likewise excluded: it embeds skill_id by construction, so it is
      // expected to vary the same way — a documented reading of the byte-identity clause.
      norm.push(
        [
          row.eventType,
          row.actor,
          row.action,
          row.result,
          row.registryTeamId,
          row.memberVisible,
          row.version,
          row.authPath,
          row.actorUserId,
          row.transport,
          row.detail,
          row.fileCount,
          row.contentHash,
          row.auditWriter,
        ].join('|')
      )
    }
    expect(new Set(returns).size).toBe(1)
    expect(returns[0]).toBe('{"status": "not_found"}')
    expect(new Set(norm).size).toBe(1)
    expect(norm[0]).toContain(`|${NULL_SENTINEL}|false|`)

    // requested_team_id (round 5), asserted separately from `norm`: it legitimately VARIES across
    // these cases with p_team_id, so it cannot join the byte-identity set above. t5-e is the one
    // case that supplied a (caller-unverified) p_team_id -- recorded as-is, contrasting with
    // registryTeamId, which stayed NULL for that same case since TEAM_OTHER is not a team the
    // caller is in.
    const [t5eRow] = await auditRowsFor('t5-e')
    expect(t5eRow.requestedTeamId).toBe(TEAM_OTHER)
    expect(t5eRow.registryTeamId).toBe(NULL_SENTINEL)
  })

  it('T6: registry_team_id names p_team_id only when the caller is actually a member; team_id key is absent either way', async () => {
    await callAs('authenticated', MEMBER, rpcCall('smi6651/nope-1', null, TEAM_ENT, null, 't6-in'))
    const [inRow] = await auditRowsFor('t6-in')
    expect(inRow.registryTeamId).toBe(TEAM_ENT)
    expect(inRow.hasTeamIdKey).toBe('f')
    // requested_team_id (round 5): equals the raw p_team_id EITHER way, verified or not --
    // contrast with registryTeamId above/below, which is NULL unless the caller is a member.
    expect(inRow.requestedTeamId).toBe(TEAM_ENT)
    await callAs(
      'authenticated',
      MEMBER,
      rpcCall('smi6651/nope-2', null, TEAM_OTHER, null, 't6-out')
    )
    const [outRow] = await auditRowsFor('t6-out')
    expect(outRow.registryTeamId).toBe(NULL_SENTINEL)
    expect(outRow.requestedTeamId).toBe(TEAM_OTHER)
    expect(outRow.hasTeamIdKey).toBe('f')
  })

  it('V-visibility: a fellow team member sees the success row via real RLS, not denied/not_found/malformed', async () => {
    await callAs(
      'authenticated',
      MEMBER,
      rpcCall('smi6651/happy', '2.0.0', null, null, 'v-success')
    )
    await callAs(
      'authenticated',
      MEMBER,
      rpcCall('smi6651/lapsed-skill', null, null, null, 'v-denied')
    )
    await callAs(
      'authenticated',
      MEMBER,
      rpcCall('smi6651/does-not-exist-vis', null, null, null, 'v-notfound')
    )
    // The fourth audit row in the untag matrix (round 5 review): content_missing_or_malformed,
    // using the existing round-4 fixture ({"SKILL.md":"ok","x":123} under TEAM_ENT). Asserted
    // untagged the same way as the other two non-success rows before the cross-role check below.
    await callAs(
      'authenticated',
      MEMBER,
      rpcCall('smi6651/malformed-skill', null, null, null, 'v-malformed')
    )
    const [malformedRow] = await auditRowsFor('v-malformed')
    expect(malformedRow.result).toBe('not_found')
    expect(malformedRow.detail).toBe('content_missing_or_malformed')
    expect(malformedRow.hasTeamIdKey).toBe('f')
    expect(malformedRow.registryTeamId).toBe(TEAM_ENT)
    expect(malformedRow.memberVisible).toBe('false')

    // MEMBER2 is a fellow member of BOTH TEAM_ENT (the success and malformed rows' team) and
    // TEAM_LAPSED (the denied row's team) — so a failure to see denied/not_found/malformed could
    // only be the SMI-6114 untag rule doing its job, never plain non-membership.
    const seen = await callAs(
      'authenticated',
      MEMBER2,
      `SELECT metadata->>'request_id' FROM audit_logs
        WHERE metadata->>'request_id' IN ('v-success','v-denied','v-notfound','v-malformed')
        ORDER BY 1;`
    )
    expect(seen.stderr).not.toMatch(/ERROR/)
    expect(rows(seen.stdout).map((r) => r[0])).toEqual(['v-success'])
  })

  it('V-visibility (actor): the caller sees only their own success row, via the team branch, not their own denied/not_found/malformed rows', async () => {
    // Same four calls as the fellow-member test above, under fresh request ids so the two tests
    // don't share rows.
    await callAs(
      'authenticated',
      MEMBER,
      rpcCall('smi6651/happy', '2.0.0', null, null, 'va-success')
    )
    await callAs(
      'authenticated',
      MEMBER,
      rpcCall('smi6651/lapsed-skill', null, null, null, 'va-denied')
    )
    await callAs(
      'authenticated',
      MEMBER,
      rpcCall('smi6651/does-not-exist-vis', null, null, null, 'va-notfound')
    )
    await callAs(
      'authenticated',
      MEMBER,
      rpcCall('smi6651/malformed-skill', null, null, null, 'va-malformed')
    )
    // This assertion's truth comes from the FIXTURE (MEMBER is a member of TEAM_ENT, the success
    // row's own team), not from the policy alone -- audit_logs_team_scoped_read's team branch
    // would show the success row to ANY fellow team member, actor included, only because the
    // fixture happens to make them one. It does NOT cover: a non-member actor (whose own success
    // row would be invisible to them too, same as everyone else without BYPASSRLS), or a
    // BYPASSRLS/service-role caller (RLS does not apply at all, so every row is visible).
    const seenByActor = await callAs(
      'authenticated',
      MEMBER,
      `SELECT metadata->>'request_id' FROM audit_logs
        WHERE metadata->>'request_id' IN ('va-success','va-denied','va-notfound','va-malformed')
        ORDER BY 1;`
    )
    expect(seenByActor.stderr).not.toMatch(/ERROR/)
    expect(rows(seenByActor.stdout).map((r) => r[0])).toEqual(['va-success'])

    // Actor prefix, asserted directly (round 5): the row's actor is `'user:' || <uuid>`, which is
    // NOT equal to a bare `auth.uid()::text` -- the exact mismatch that keeps the caller from
    // reading their own denied/not_found/malformed rows via audit_logs_team_scoped_read's first
    // branch, and the reason the success row above is visible only via the team branch.
    const actorCheck = await callAs(
      'authenticated',
      MEMBER,
      `SELECT al.actor, (al.actor = 'user:' || '${MEMBER}'::uuid::text),
              (al.actor = '${MEMBER}'::uuid::text)
         FROM audit_logs al WHERE al.metadata->>'request_id' = 'va-success';`
    )
    expect(actorCheck.stderr).not.toMatch(/ERROR/)
    const [[actorValue, matchesPrefixed, matchesBare]] = rows(actorCheck.stdout)
    expect(actorValue).toBe(`user:${MEMBER}`)
    expect(matchesPrefixed).toBe('t')
    expect(matchesBare).toBe('f')
  })

  it('T7: a failing audit insert makes the call raise and persists nothing', async () => {
    await installAuditBoom()
    const before = await ctl.send('SELECT count(*) FROM audit_logs;')
    const call = await callAs(
      'authenticated',
      MEMBER,
      rpcCall('smi6651/happy', '2.0.0', null, null, 't7')
    )
    expect(call.stderr).toMatch(/forced audit failure/)
    expect(call.stdout).toBe('')
    const after = await ctl.send('SELECT count(*) FROM audit_logs;')
    expect(scalar(after.stdout)).toBe(scalar(before.stdout))
    await removeAuditBoom()
  })

  it('V1: omitted version picks the most recently PUBLISHED row, not the highest semver', async () => {
    const call = await callAs(
      'authenticated',
      MEMBER,
      rpcCall('smi6651/versioned', null, null, null, 'v1')
    )
    expect(call.stdout).toContain('"version": "1.5.0"')
  })

  it('V2: latest-published version deprecated -> falls back to the previous non-deprecated one', async () => {
    const call = await callAs(
      'authenticated',
      MEMBER,
      rpcCall('smi6651/fallback', null, null, null, 'v2')
    )
    expect(call.stdout).toContain('"version": "1.0.0"')
    expect(call.stdout).toContain(BODY_FALLBACK_V1)
  })

  it('V3: an explicit pin on a deprecated version is not_found — no bypass by pinning', async () => {
    await expectAsMember('smi6651/fallback', '2.0.0', null, 'v3', '{"status": "not_found"}')
  })

  it('V4: an explicit pin on a non-latest approved version returns that version', async () => {
    const call = await callAs(
      'authenticated',
      MEMBER,
      rpcCall('smi6651/happy', '1.0.0', null, null, 'v4')
    )
    expect(call.stdout).toContain('"version": "1.0.0"')
    expect(call.stdout).toContain(BODY_V1)
  })

  it('T9: auth.uid() NULL raises 42501; invalid p_transport raises 22023', async () => {
    const noAuth = await callAs(
      'authenticated',
      null,
      rpcCall('smi6651/happy', null, null, null, 't9-noauth')
    )
    expect(noAuth.stderr).toMatch(/42501/)
    expect(noAuth.stderr).toMatch(/not_authenticated/)
    const badTransport = await callAs(
      'authenticated',
      MEMBER,
      rpcCall('smi6651/happy', null, null, 'carrier-pigeon', 't9-badtransport')
    )
    expect(badTransport.stderr).toMatch(/22023/)
  })

  it('T10: anon cannot EXECUTE the function', async () => {
    const call = await callAs('anon', null, rpcCall('smi6651/happy', null, null, null, 't10'))
    expect(call.stderr).toMatch(/42501/)
    expect(call.stderr).toMatch(/permission denied for function/)
  })

  it('E1/E6: row team tier=team -> denied/team_tier_not_enterprise, even though the caller is ALSO entitled via TEAM_ENT', async () => {
    // E1 (denial reason) and E6 (no cross-team leak: MEMBER's OWN enterprise entitlement via
    // TEAM_ENT must not leak into TEAM_TIER's entitlement check) are the SAME call from two
    // angles — entitlement is keyed to `v_row.team_id`, never to any team the caller belongs to.
    await expectAsMember(
      'smi6651/tier-skill',
      null,
      null,
      'e1e6',
      deniedJson('team_tier_not_enterprise')
    )
  })

  it.each([
    ['smi6651/no-sub-skill', 'team_has_no_subscription', 'e3'],
    ['smi6651/dangling-skill', 'subscription_not_found', 'e4'],
  ])('E3/E4: %s -> denied/%s', async (skillId, detail, reqId) => {
    await expectAsMember(skillId, null, null, reqId, deniedJson(detail))
  })

  it.each([
    ['active', 'smi6651/happy', TEAM_ENT],
    ['trialing', 'smi6651/trialing-skill', 'smi6651-team-trialing'],
    ['past_due', 'smi6651/pastdue-skill', 'smi6651-team-pastdue'],
  ])('E5: subscription status %s -> released', async (_status, skillId, teamId) => {
    const call = await callAs(
      'authenticated',
      MEMBER,
      rpcCall(skillId, null, null, null, `e5-${skillId}`)
    )
    expect(call.stderr).not.toMatch(/ERROR/)
    expect(call.stdout).toContain('"status": "released"')
    expect(call.stdout).toContain(`"team_id": "${teamId}"`)
  })

  it('Finding 1: object content with a non-string value -> not_found/content_missing_or_malformed, no content leaked', async () => {
    const call = await callAs(
      'authenticated',
      MEMBER,
      rpcCall('smi6651/malformed-skill', null, null, null, 'finding1')
    )
    expect(call.stderr).not.toMatch(/ERROR/)
    expect(call.stdout).toBe('{"status": "not_found"}')
    expect(call.stdout).not.toContain('"x"')
    expect(call.stdout).not.toContain('123')

    expect(await auditCountFor('finding1')).toBe('1')
    const [row] = await auditRowsFor('finding1')
    expect(row.result).toBe('not_found')
    expect(row.detail).toBe('content_missing_or_malformed')
    expect(row.hasTeamIdKey).toBe('f')
    expect(row.requestedTeamId).toBe(NULL_SENTINEL)
    expect(row.noBodyLeak).toBe('t')
  })

  it('Finding 5(a) STRUCTURAL: the step-4 re-read re-applies team/approval/deprecated predicates against v_row -- not a behavioral (interleaving) proof, see comment', async () => {
    // Genuine two-session interleaving would need to land a concurrent UPDATE strictly between
    // this function's own step-2 SELECT and step-4 SELECT -- a window that is unlocked, on
    // purpose (ADR-159 §3), and only microseconds wide with no externally-observable pause point
    // inside a single atomic RPC call. PsqlSession supports running two independent sessions
    // (confirmed: it is a plain spawn()-backed psql child process, nothing ties one instance to
    // another), but there is nothing in this specific gap for a second session to synchronize on
    // without instrumenting a sleep into the function body -- which would mean testing a modified
    // copy, not the shipped one. So this check is an EXPLICIT, clearly-labeled STATIC/STRUCTURAL
    // assertion against the real migration text instead, per the fallback the round-4 review
    // explicitly allows for exactly this shape of guard. It is deliberately paired with the
    // BEHAVIORAL revert-then-restore tests below (a, d/f, i) that DO exercise these same three
    // predicates' real effect on step 2's lookup / step 4's re-read outcome, just not via live
    // concurrency landing inside the gap between the two reads.
    const block = extractReReadSelect(migrationSql())
    expect(block).toContain('AND prs.team_id = v_row.team_id')
    expect(block).toContain("AND prs.approval_status = 'approved'")
    expect(block).toContain('AND prs.deprecated = false')
  })

  it.each([
    ['p_skill_id blank', rpcCall('', null, null, null, 'b1'), /22023/],
    ['p_skill_id over 256 chars', rpcCall('x'.repeat(257), null, null, null, 'b2'), /22023/],
    [
      'p_version over 64 chars',
      rpcCall('smi6651/happy', 'v'.repeat(65), null, null, 'b3'),
      /22023/,
    ],
    [
      'p_team_id over 128 chars',
      rpcCall('smi6651/happy', null, 't'.repeat(129), null, 'b4'),
      /22023/,
    ],
    [
      'p_request_id over 128 chars',
      rpcCall('smi6651/happy', null, null, null, 'r'.repeat(129)),
      /22023/,
    ],
  ])('Finding 5(b) boundary: %s raises 22023', async (_label, sql, expected) => {
    const call = await callAs('authenticated', MEMBER, sql)
    expect(call.stderr).toMatch(expected)
  })

  describe('revert-then-restore (SMI-6598)', () => {
    it('(a) removing the team-membership filter breaks not_found byte-identity for an other-team skill', async () => {
      await rebuildWith(brokenMigrationSql('a'))
      const broken = await callAs(
        'authenticated',
        MEMBER,
        rpcCall('smi6651/other-team-skill', null, null, null, 'revert-a')
      )
      expect(broken.stdout).not.toBe('{"status": "not_found"}')
      expect(broken.stdout).toContain('"status": "denied"')

      await rebuildWith(migrationSql())
      const fixed = await callAs(
        'authenticated',
        MEMBER,
        rpcCall('smi6651/other-team-skill', null, null, null, 'revert-a-restored')
      )
      expect(fixed.stdout).toBe('{"status": "not_found"}')
    })

    it('(b) swallowing the success-audit failure breaks fail-closed', async () => {
      await rebuildWith(brokenMigrationSql('b'))
      await installAuditBoom()
      const before = await ctl.send('SELECT count(*) FROM audit_logs;')
      const broken = await callAs(
        'authenticated',
        MEMBER,
        rpcCall('smi6651/happy', '2.0.0', null, null, 'revert-b')
      )
      expect(broken.stderr).not.toMatch(/forced audit failure/)
      expect(broken.stdout).toContain('"status": "released"')
      expect(scalar((await ctl.send('SELECT count(*) FROM audit_logs;')).stdout)).toBe(
        scalar(before.stdout)
      )
      await removeAuditBoom()

      await rebuildWith(migrationSql())
      await installAuditBoom()
      const fixed = await callAs(
        'authenticated',
        MEMBER,
        rpcCall('smi6651/happy', '2.0.0', null, null, 'revert-b-restored')
      )
      expect(fixed.stderr).toMatch(/forced audit failure/)
      expect(fixed.stdout).toBe('')
      await removeAuditBoom()
    })

    it('(c) unconditional team tagging breaks the membership guard', async () => {
      await rebuildWith(brokenMigrationSql('c'))
      await callAs(
        'authenticated',
        MEMBER,
        rpcCall('smi6651/nope-c', null, TEAM_OTHER, null, 'revert-c')
      )
      // T6's own assertion, restated here against the broken build: registry_team_id is tagged
      // with a team the caller is NOT in.
      expect((await auditRowsFor('revert-c'))[0].registryTeamId).toBe(TEAM_OTHER)

      await rebuildWith(migrationSql())
      await callAs(
        'authenticated',
        MEMBER,
        rpcCall('smi6651/nope-c2', null, TEAM_OTHER, null, 'revert-c-restored')
      )
      expect((await auditRowsFor('revert-c-restored'))[0].registryTeamId).toBe(NULL_SENTINEL)
    })

    it('(h) tagging the denied row with team_id breaks V-visibility (and T4)', async () => {
      await rebuildWith(brokenMigrationSql('h'))
      await callAs(
        'authenticated',
        MEMBER,
        rpcCall('smi6651/lapsed-skill', null, null, null, 'revert-h')
      )
      const [broken] = await auditRowsFor('revert-h')
      expect(broken.hasTeamIdKey).toBe('t')
      expect(broken.teamId).toBe(TEAM_LAPSED)
      // V-visibility, restated: MEMBER2 (a fellow TEAM_LAPSED member) can now read a denied row.
      const brokenSeen = await callAs(
        'authenticated',
        MEMBER2,
        "SELECT metadata->>'request_id' FROM audit_logs WHERE metadata->>'request_id' = 'revert-h';"
      )
      expect(rows(brokenSeen.stdout).map((r) => r[0])).toEqual(['revert-h'])

      await rebuildWith(migrationSql())
      await callAs(
        'authenticated',
        MEMBER,
        rpcCall('smi6651/lapsed-skill', null, null, null, 'revert-h-restored')
      )
      const [fixed] = await auditRowsFor('revert-h-restored')
      expect(fixed.hasTeamIdKey).toBe('f')
      const fixedSeen = await callAs(
        'authenticated',
        MEMBER2,
        "SELECT metadata->>'request_id' FROM audit_logs WHERE metadata->>'request_id' = 'revert-h-restored';"
      )
      expect(rows(fixedSeen.stdout).map((r) => r[0])).toEqual([])
    })

    it('(d/f) dropping the step-2 deprecated predicate changes the not_found shape and breaks V2 fallback', async () => {
      await rebuildWith(brokenMigrationSql('d'))
      // (d) original probe: an already-fully-deprecated row is still blocked (step 4's own
      // re-check saves it), but the audit shape changes — the tell that step 2's guard broke.
      await callAs(
        'authenticated',
        MEMBER,
        rpcCall('smi6651/deprecated-skill', null, null, null, 'revert-d')
      )
      const [broken] = await auditRowsFor('revert-d')
      expect(broken.detail).toBe('content_missing_or_malformed')
      expect(broken.resource).toContain(TEAM_ENT)
      // (f) V2 probe: with the deprecated=false gone from step 2, ORDER BY published_at DESC now
      // picks the deprecated 2.0.0 row at step 2; step 4 then re-blocks it — so the omitted-
      // version call 404s instead of falling back to 1.0.0.
      const v2broken = await callAs(
        'authenticated',
        MEMBER,
        rpcCall('smi6651/fallback', null, null, null, 'revert-f')
      )
      expect(v2broken.stdout).toBe('{"status": "not_found"}')

      await rebuildWith(migrationSql())
      await callAs(
        'authenticated',
        MEMBER,
        rpcCall('smi6651/deprecated-skill', null, null, null, 'revert-d-restored')
      )
      const [fixed] = await auditRowsFor('revert-d-restored')
      expect(fixed.detail).toBe('no_visible_row')
      expect(fixed.resource).not.toContain(TEAM_ENT)
      const v2fixed = await callAs(
        'authenticated',
        MEMBER,
        rpcCall('smi6651/fallback', null, null, null, 'revert-f-restored')
      )
      expect(v2fixed.stdout).toContain('"version": "1.0.0"')
    })

    it('(e) a column-only REVOKE is ineffective while the table-wide GRANT survives', async () => {
      await rebuildWith(brokenMigrationSql('e'), { expectSelfSmokeFailure: true })
      const brokenPriv = await ctl.send(
        "SELECT has_column_privilege('authenticated','public.private_registry_skills','content','SELECT');"
      )
      expect(scalar(brokenPriv.stdout)).toBe('t')
      const brokenRead = await callAs(
        'authenticated',
        MEMBER,
        "SELECT content FROM private_registry_skills WHERE skill_id = 'smi6651/happy' LIMIT 1;"
      )
      expect(brokenRead.stderr).not.toMatch(/42501/)

      await rebuildWith(migrationSql())
      const fixedPriv = await ctl.send(
        "SELECT has_column_privilege('authenticated','public.private_registry_skills','content','SELECT');"
      )
      expect(scalar(fixedPriv.stdout)).toBe('f')
      const fixedRead = await callAs(
        'authenticated',
        MEMBER,
        "SELECT content FROM private_registry_skills WHERE skill_id = 'smi6651/happy' LIMIT 1;"
      )
      expect(fixedRead.stderr).toMatch(/42501/)
    })

    it('(g) entitlement checked against a caller team instead of the row team breaks E6', async () => {
      await rebuildWith(brokenMigrationSql('g'))
      const broken = await callAs(
        'authenticated',
        MEMBER,
        rpcCall('smi6651/tier-skill', null, null, null, 'revert-g')
      )
      expect(broken.stdout).toContain('"status": "released"')

      await rebuildWith(migrationSql())
      await expectAsMember(
        'smi6651/tier-skill',
        null,
        null,
        'revert-g-restored',
        deniedJson('team_tier_not_enterprise')
      )
    })

    it('(i) STRUCTURAL: removing the team_id re-pin drops it from the shipped step-4 re-read text (see Finding 5(a) comment for why this is structural, not a live-interleaving proof)', async () => {
      const brokenSql = brokenMigrationSql('i')
      expect(extractReReadSelect(brokenSql)).not.toContain('AND prs.team_id = v_row.team_id')
      // The broken build still applies cleanly and behaves identically to the fixed one for
      // every scenario this suite's fixtures can express without genuine cross-call concurrency
      // (id already pins exactly one row with exactly one current team_id absent a race) --
      // confirmed live rather than assumed, so this revert does not silently mislabel "no
      // reachable difference in this harness" as "the guard does nothing".
      await rebuildWith(brokenSql)
      const broken = await callAs(
        'authenticated',
        MEMBER,
        rpcCall('smi6651/happy', '2.0.0', null, null, 'revert-i')
      )
      expect(broken.stdout).toContain('"status": "released"')

      await rebuildWith(migrationSql())
      expect(extractReReadSelect(migrationSql())).toContain('AND prs.team_id = v_row.team_id')
      const fixed = await callAs(
        'authenticated',
        MEMBER,
        rpcCall('smi6651/happy', '2.0.0', null, null, 'revert-i-restored')
      )
      expect(fixed.stdout).toContain('"status": "released"')
    })

    it('(j) removing the string-value guard lets malformed content leak through', async () => {
      await rebuildWith(brokenMigrationSql('j'))
      const broken = await callAs(
        'authenticated',
        MEMBER,
        rpcCall('smi6651/malformed-skill', null, null, null, 'revert-j')
      )
      expect(broken.stdout).toContain('"status": "released"')
      expect(broken.stdout).toContain('"x": 123')
      const [brokenRow] = await auditRowsFor('revert-j')
      expect(brokenRow.result).toBe('success')

      await rebuildWith(migrationSql())
      const fixed = await callAs(
        'authenticated',
        MEMBER,
        rpcCall('smi6651/malformed-skill', null, null, null, 'revert-j-restored')
      )
      expect(fixed.stdout).toBe('{"status": "not_found"}')
      const [fixedRow] = await auditRowsFor('revert-j-restored')
      expect(fixedRow.detail).toBe('content_missing_or_malformed')
    })

    it('(k) dropping requested_team_id from no_visible_row loses the requested (unverified) team', async () => {
      await rebuildWith(brokenMigrationSql('k'))
      await callAs(
        'authenticated',
        MEMBER,
        rpcCall('smi6651/nope-k', null, TEAM_OTHER, null, 'revert-k')
      )
      const [broken] = await auditRowsFor('revert-k')
      expect(broken.requestedTeamId).toBe(NULL_SENTINEL)
      // registry_team_id is untouched by this revert -- still correctly NULL, since TEAM_OTHER is
      // unverified -- the requested-vs-verified distinction itself is the property this variant
      // breaks, not the verified key.
      expect(broken.registryTeamId).toBe(NULL_SENTINEL)

      await rebuildWith(migrationSql())
      await callAs(
        'authenticated',
        MEMBER,
        rpcCall('smi6651/nope-k2', null, TEAM_OTHER, null, 'revert-k-restored')
      )
      const [fixed] = await auditRowsFor('revert-k-restored')
      expect(fixed.requestedTeamId).toBe(TEAM_OTHER)
    })

    it('(l) a bare-uuid actor lets the caller read their own denied/not_found rows', async () => {
      await rebuildWith(brokenMigrationSql('l'))
      await callAs(
        'authenticated',
        MEMBER,
        rpcCall('smi6651/lapsed-skill', null, null, null, 'revert-l')
      )
      const brokenSeen = await callAs(
        'authenticated',
        MEMBER,
        "SELECT metadata->>'request_id' FROM audit_logs WHERE metadata->>'request_id' = 'revert-l';"
      )
      expect(rows(brokenSeen.stdout).map((r) => r[0])).toEqual(['revert-l'])
      const [brokenRow] = await auditRowsFor('revert-l')
      expect(brokenRow.actor).toBe(MEMBER)

      await rebuildWith(migrationSql())
      await callAs(
        'authenticated',
        MEMBER,
        rpcCall('smi6651/lapsed-skill', null, null, null, 'revert-l-restored')
      )
      const fixedSeen = await callAs(
        'authenticated',
        MEMBER,
        "SELECT metadata->>'request_id' FROM audit_logs WHERE metadata->>'request_id' = 'revert-l-restored';"
      )
      expect(rows(fixedSeen.stdout).map((r) => r[0])).toEqual([])
      const [fixedRow] = await auditRowsFor('revert-l-restored')
      expect(fixedRow.actor).toBe(`user:${MEMBER}`)
    })
  })
})
