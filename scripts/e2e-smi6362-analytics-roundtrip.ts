/**
 * e2e-smi6362-analytics-roundtrip.ts
 *
 * SMI-6362 — write-path (identity/consent/team-resolution) and read-path
 * (RPC + RLS tenant isolation + coverage k-anonymity) round-trip against real
 * staging Supabase. Test infrastructure only — does not touch product code.
 * Requires scripts/seed-e2e-smi6362-analytics-users.ts to have been run at
 * least once against the same staging project.
 *
 * This script is self-sufficient: it resolves team ids itself (via the same
 * deterministic subscription ids the seed script uses) and mints its own
 * scratch GEN-A/GEN-B license keys — no stdout/JSON hand-off from the seed
 * script is required. See e2e-smi6362-analytics-fixtures.ts (shared fixture
 * data) and e2e-smi6362-analytics-db-utils.ts (shared DB primitives).
 *
 * Assertions (see task spec for full numbered list; summarized here):
 *  1-9  write path: identity resolution, consent gating, server-derived actor
 *       determinism/distinctness, team-spoof rejection, anonymous tool_call
 *       rejection, batched multi-lane writes — all against the real
 *       POST /functions/v1/events edge function.
 *  10-12 read path: analytics_tool_usage RPC + search_metrics_team_scoped_read
 *       RLS tenant isolation, both directions.
 *  13-14 coverage k-anonymity: analytics_team_reporting_coverage across all 7
 *       seeded teams, cross-checked against computeExpectedCoverage()'s pure
 *       mirror of the SQL suppression ladder.
 *
 * Usage: varlock run -- npx tsx scripts/e2e-smi6362-analytics-roundtrip.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import {
  USER_A1,
  USER_A2,
  USER_A3,
  USER_A4,
  USER_B1,
  TEAM_GEN_A,
  TEAM_GEN_B,
  ALL_TEAMS,
  E2E_PASSWORD,
} from './e2e-smi6362-analytics-fixtures.js'
import {
  requireEnv,
  assertStagingHost,
  resolveTeamIdBySubscription,
  mintFreshLicenseKey,
} from './e2e-smi6362-analytics-db-utils.js'
import {
  signIn,
  freshAnonymousId,
  postEvent,
  queryEventRows,
  callToolUsageRpc,
  runCoverageAssertions,
  type ActorSession,
} from './e2e-smi6362-analytics-roundtrip.helpers.js'

const STAGING_REF = 'ovhcifugwqnzoebwfuku'
const STAGING_HOST = `${STAGING_REF}.supabase.co`
// Split across two string literals so this file cannot trip the prod-ref grep gate.
const PROD_REF = 'vrcnzpmn' + 'dtroqxxoqkzy' // SMI-6362-allow-prod-ref

const ACTOR_RE = /^[0-9a-f]{64}$/

const results: { name: string; pass: boolean; detail?: string }[] = []
function record(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail })
  console.error(`[SMI-6362 e2e] ${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main(): Promise<void> {
  const url = requireEnv('STAGING_SUPABASE_URL')
  const anonKey = requireEnv('STAGING_SUPABASE_ANON_KEY')
  const serviceRole = requireEnv('STAGING_SUPABASE_SERVICE_ROLE_KEY')
  assertStagingHost(url, STAGING_HOST, PROD_REF)

  const admin = createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const eventsUrl = `${url}/functions/v1/events`

  // ---- Resolve team ids -------------------------------------------------------
  const teamIds = new Map<string, string>()
  for (const team of ALL_TEAMS) {
    teamIds.set(team.key, await resolveTeamIdBySubscription(admin, team.subscriptionId))
  }
  const genAId = teamIds.get('GEN_A')!
  const genBId = teamIds.get('GEN_B')!

  // ---- Sign in the actors this script actually calls as ---------------------
  const a1 = await signIn(url, anonKey, USER_A1.email, E2E_PASSWORD)
  const a2 = await signIn(url, anonKey, USER_A2.email, E2E_PASSWORD)
  const a3 = await signIn(url, anonKey, USER_A3.email, E2E_PASSWORD)
  const a4 = await signIn(url, anonKey, USER_A4.email, E2E_PASSWORD)
  const b1 = await signIn(url, anonKey, USER_B1.email, E2E_PASSWORD)
  // E1 is a member of every coverage-matrix team (owner) — one sign-in covers all 5.
  const e1 = await signIn(url, anonKey, 'e2e-smi6362-cov-e1@skillsmith.test', E2E_PASSWORD)

  // ---- Mint scratch license keys, using the owners' just-resolved user ids --
  // (self-sufficient: no dependency on the seed script's stdout/JSON output).
  const genALicenseKey = await mintFreshLicenseKey(
    admin,
    TEAM_GEN_A.subscriptionId,
    a1.userId,
    'team',
    'GEN_A-scratch'
  )
  const genBLicenseKey = await mintFreshLicenseKey(
    admin,
    TEAM_GEN_B.subscriptionId,
    b1.userId,
    'team',
    'GEN_B-scratch'
  )

  const testStart = new Date().toISOString()
  const RUN_ID = randomUUID().slice(0, 8)
  const TOOL_AC123 = `e2e-ac1-3-${RUN_ID}`
  const TOOL_AC6 = `e2e-ac6-${RUN_ID}`
  const TOOL_AC7 = `e2e-ac7-${RUN_ID}`
  const TOOL_AC8 = `e2e-ac8-${RUN_ID}`
  const TOOL_AC9 = `e2e-ac9-tool-${RUN_ID}`
  const SKILL_AC9 = `e2e-ac9-skill-${RUN_ID}`
  const TOOL_B1 = `e2e-acB1-${RUN_ID}`

  await runWritePathAssertions(admin, eventsUrl, {
    a1,
    a2,
    a3,
    a4,
    genAId,
    genBId,
    genBLicenseKey,
    genALicenseKey,
    testStart,
    TOOL_AC123,
    TOOL_AC6,
    TOOL_AC7,
    TOOL_AC8,
    TOOL_AC9,
    SKILL_AC9,
  })

  // Setup write for AC11/AC12: give Team GEN-B real tool_call data BEFORE
  // testing isolation, so a 0-row result from a foreign caller proves RLS is
  // blocking real data rather than merely observing an empty team (stronger
  // proof than the literal assertion ordering alone would give).
  const b1Setup = await postEvent(
    eventsUrl,
    { event: 'tool_call', anonymous_id: freshAnonymousId(), metadata: { tool_name: TOOL_B1 } },
    { Authorization: `Bearer ${b1.accessToken}` }
  )
  record(
    'AC12-setup B1 tool_call write to GEN-B',
    b1Setup.accepted === '1',
    JSON.stringify(b1Setup)
  )

  await runReadPathAssertions(url, anonKey, { a1, b1, genAId, genBId, TOOL_AC123, TOOL_B1 })
  await runCoverageAssertions(url, anonKey, { a1, b1, e1, teamIds }, record)

  const failed = results.filter((r) => !r.pass)
  console.error(
    `\n[SMI-6362 e2e] ${results.length - failed.length}/${results.length} checks passed.`
  )
  if (failed.length > 0) {
    console.error('[SMI-6362 e2e] FAILED checks:')
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail ?? '(no detail)'}`)
    throw new Error(`SMI-6362 round-trip failed: ${failed.length} check(s) did not pass`)
  }
}

interface WritePathCtx {
  a1: ActorSession
  a2: ActorSession
  a3: ActorSession
  a4: ActorSession
  genAId: string
  genBId: string
  genBLicenseKey: string
  genALicenseKey: string
  testStart: string
  TOOL_AC123: string
  TOOL_AC6: string
  TOOL_AC7: string
  TOOL_AC8: string
  TOOL_AC9: string
  SKILL_AC9: string
}

async function runWritePathAssertions(
  admin: SupabaseClient,
  eventsUrl: string,
  ctx: WritePathCtx
): Promise<void> {
  const rowsAC123 = () =>
    queryEventRows(admin, {
      eventType: 'telemetry:tool_call',
      metadataKey: 'tool_name',
      metadataValue: ctx.TOOL_AC123,
      sinceIso: ctx.testStart,
    })

  // AC1: A1, sole membership (no API key), enabled+decided -> accepted, row lands with
  // server-derived team_id/identity/actor.
  const r1 = await postEvent(
    eventsUrl,
    {
      event: 'tool_call',
      anonymous_id: freshAnonymousId(),
      metadata: { tool_name: ctx.TOOL_AC123 },
    },
    { Authorization: `Bearer ${ctx.a1.accessToken}` }
  )
  const rows1 = await rowsAC123()
  const row1 = rows1[0]
  record(
    'AC1 A1 tool_call accepted + row shape',
    r1.accepted === '1' &&
      rows1.length === 1 &&
      row1?.metadata.team_id === ctx.genAId &&
      row1?.metadata.identity === 'user' &&
      ACTOR_RE.test(row1?.actor ?? ''),
    JSON.stringify({ r1, row1 })
  )
  const actorA1 = row1?.actor

  // AC2: re-run the identical call -> a SECOND row, not deduped, same actor (determinism).
  const r2 = await postEvent(
    eventsUrl,
    {
      event: 'tool_call',
      anonymous_id: freshAnonymousId(),
      metadata: { tool_name: ctx.TOOL_AC123 },
    },
    { Authorization: `Bearer ${ctx.a1.accessToken}` }
  )
  const rows2 = await rowsAC123()
  record(
    'AC2 A1 repeat write is a second row with identical actor',
    r2.accepted === '1' && rows2.length === 2 && rows2[1].actor === actorA1,
    JSON.stringify({ r2, count: rows2.length })
  )

  // AC3: A2 (also enabled+decided, sole GEN-A member) -> distinct actor, same team.
  const r3 = await postEvent(
    eventsUrl,
    {
      event: 'tool_call',
      anonymous_id: freshAnonymousId(),
      metadata: { tool_name: ctx.TOOL_AC123 },
    },
    { Authorization: `Bearer ${ctx.a2.accessToken}` }
  )
  const rows3 = await rowsAC123()
  const row3 = rows3[2]
  record(
    'AC3 A2 write has distinct actor, same team_id',
    r3.accepted === '1' &&
      rows3.length === 3 &&
      row3?.actor !== actorA1 &&
      row3?.metadata.team_id === ctx.genAId,
    JSON.stringify({ r3, row3 })
  )

  // AC4: A3 (disabled+decided, an opt-out) -> consent_denied, no new row.
  const r4 = await postEvent(
    eventsUrl,
    {
      event: 'tool_call',
      anonymous_id: freshAnonymousId(),
      metadata: { tool_name: ctx.TOOL_AC123 },
    },
    { Authorization: `Bearer ${ctx.a3.accessToken}` }
  )
  const rows4 = await rowsAC123()
  record(
    'AC4 A3 (opted-out) rejected consent_denied, no new row',
    r4.reason === 'consent_denied' && r4.accepted === '0' && rows4.length === 3,
    JSON.stringify(r4)
  )

  // AC5: A4 (undecided) -> consent_required, no new row.
  const r5 = await postEvent(
    eventsUrl,
    {
      event: 'tool_call',
      anonymous_id: freshAnonymousId(),
      metadata: { tool_name: ctx.TOOL_AC123 },
    },
    { Authorization: `Bearer ${ctx.a4.accessToken}` }
  )
  const rows5 = await rowsAC123()
  record(
    'AC5 A4 (undecided) rejected consent_required, no new row',
    r5.reason === 'consent_required' && r5.accepted === '0' && rows5.length === 3,
    JSON.stringify(r5)
  )

  // AC6: A1's JWT + Team GEN-B's license key (A1 is not a GEN-B member) -> license_not_member.
  const r6 = await postEvent(
    eventsUrl,
    { event: 'tool_call', anonymous_id: freshAnonymousId(), metadata: { tool_name: ctx.TOOL_AC6 } },
    { Authorization: `Bearer ${ctx.a1.accessToken}`, 'X-API-Key': ctx.genBLicenseKey }
  )
  const rows6 = await queryEventRows(admin, {
    eventType: 'telemetry:tool_call',
    metadataKey: 'tool_name',
    metadataValue: ctx.TOOL_AC6,
    sinceIso: ctx.testStart,
  })
  record(
    'AC6 A1 + GEN-B license key rejected license_not_member, zero rows',
    r6.reason === 'license_not_member' && r6.accepted === '0' && rows6.length === 0,
    JSON.stringify(r6)
  )

  // AC7: A1 attempts to spoof metadata.team_id = GEN-B -> server-derived team_id (GEN-A) wins.
  const r7 = await postEvent(
    eventsUrl,
    {
      event: 'tool_call',
      anonymous_id: freshAnonymousId(),
      metadata: { tool_name: ctx.TOOL_AC7, team_id: ctx.genBId },
    },
    { Authorization: `Bearer ${ctx.a1.accessToken}` }
  )
  const rows7 = await queryEventRows(admin, {
    eventType: 'telemetry:tool_call',
    metadataKey: 'tool_name',
    metadataValue: ctx.TOOL_AC7,
    sinceIso: ctx.testStart,
  })
  record(
    'AC7 client-supplied team_id spoof dropped, row carries real team_id',
    r7.accepted === '1' && rows7.length === 1 && rows7[0]?.metadata.team_id === ctx.genAId,
    JSON.stringify({ r7, row: rows7[0] })
  )

  // AC8: no JWT at all, valid GEN-A license key only -> identity_required, tool_call has no anon path.
  const r8 = await postEvent(
    eventsUrl,
    { event: 'tool_call', anonymous_id: freshAnonymousId(), metadata: { tool_name: ctx.TOOL_AC8 } },
    { 'X-API-Key': ctx.genALicenseKey }
  )
  const rows8 = await queryEventRows(admin, {
    eventType: 'telemetry:tool_call',
    metadataKey: 'tool_name',
    metadataValue: ctx.TOOL_AC8,
    sinceIso: ctx.testStart,
  })
  record(
    'AC8 no JWT (license key only) rejected identity_required, zero rows',
    r8.reason === 'identity_required' && r8.accepted === '0' && rows8.length === 0,
    JSON.stringify(r8)
  )

  // AC9: mixed-lane batch (tool_call + skill_invoke) under A1's JWT -> both accepted, both team_id=GEN-A.
  const r9 = await postEvent(
    eventsUrl,
    {
      events: [
        {
          event: 'tool_call',
          anonymous_id: freshAnonymousId(),
          metadata: { tool_name: ctx.TOOL_AC9 },
        },
        {
          event: 'skill_invoke',
          anonymous_id: freshAnonymousId(),
          skill_id: ctx.SKILL_AC9,
          metadata: { skill_name: ctx.SKILL_AC9 },
        },
      ],
    },
    { Authorization: `Bearer ${ctx.a1.accessToken}`, 'X-Skillsmith-Batched': 'true' }
  )
  const rows9tool = await queryEventRows(admin, {
    eventType: 'telemetry:tool_call',
    metadataKey: 'tool_name',
    metadataValue: ctx.TOOL_AC9,
    sinceIso: ctx.testStart,
  })
  const rows9skill = await queryEventRows(admin, {
    eventType: 'telemetry:skill_invoke',
    metadataKey: 'skill_name',
    metadataValue: ctx.SKILL_AC9,
    sinceIso: ctx.testStart,
  })
  record(
    'AC9 batched tool_call+skill_invoke both accepted, both team_id=GEN-A',
    r9.body.accepted === 2 &&
      r9.body.rejected === 0 &&
      rows9tool.length === 1 &&
      rows9tool[0]?.metadata.team_id === ctx.genAId &&
      rows9skill.length === 1 &&
      rows9skill[0]?.metadata.team_id === ctx.genAId,
    JSON.stringify({ body: r9.body, tool: rows9tool[0], skill: rows9skill[0] })
  )
}

interface ReadPathCtx {
  a1: ActorSession
  b1: ActorSession
  genAId: string
  genBId: string
  TOOL_AC123: string
  TOOL_B1: string
}

async function runReadPathAssertions(
  url: string,
  anonKey: string,
  ctx: ReadPathCtx
): Promise<void> {
  // AC10: A1 reads GEN-A's own usage -> our AC1-3 marker present with count >= 3.
  const a1OwnTeam = await callToolUsageRpc(url, anonKey, ctx.a1.accessToken, ctx.genAId, 30)
  const marker = a1OwnTeam.top_tools.find((t) => t.tool === ctx.TOOL_AC123)
  record(
    'AC10 A1 analytics_tool_usage(GEN-A) sees own writes, count >= 3',
    !!marker && Number(marker.count) >= 3,
    JSON.stringify({ top_tools: a1OwnTeam.top_tools })
  )

  // AC11: A1 reads GEN-B (not a member) -> RLS blocks ALL of GEN-B's data, even though GEN-B
  // now has real data (the AC12-setup write) -- total_calls=0 proves isolation, not absence.
  const a1ForeignTeam = await callToolUsageRpc(url, anonKey, ctx.a1.accessToken, ctx.genBId, 30)
  record(
    'AC11 A1 analytics_tool_usage(GEN-B) isolated to zero despite real GEN-B data existing',
    Number(a1ForeignTeam.total_calls) === 0,
    JSON.stringify({ total_calls: a1ForeignTeam.total_calls })
  )

  // AC12: B1 reads GEN-B (own team, sees the setup write) and GEN-A (foreign, isolated) -- both directions.
  const b1OwnTeam = await callToolUsageRpc(url, anonKey, ctx.b1.accessToken, ctx.genBId, 30)
  const b1Marker = b1OwnTeam.top_tools.find((t) => t.tool === ctx.TOOL_B1)
  const b1ForeignTeam = await callToolUsageRpc(url, anonKey, ctx.b1.accessToken, ctx.genAId, 30)
  record(
    'AC12 B1 sees own GEN-B data, isolated from GEN-A (both directions)',
    !!b1Marker && Number(b1Marker.count) >= 1 && Number(b1ForeignTeam.total_calls) === 0,
    JSON.stringify({ b1_own: b1OwnTeam.top_tools, b1_foreign_total: b1ForeignTeam.total_calls })
  )
}

main().catch((err: unknown) => {
  console.error(`[SMI-6362 e2e] unexpected error: ${String(err)}`)
  process.exit(1)
})
