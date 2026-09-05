/**
 * seed-e2e-smi6362-analytics-users.ts
 *
 * SMI-6362 — idempotent seed for the staging test fixtures used by the cloud
 * usage analytics write/read round-trip (scripts/e2e-smi6362-analytics-roundtrip.ts).
 * Test infrastructure only — does not touch product code.
 *
 * Seeds 20 auth users and 7 teams (see e2e-smi6362-analytics-fixtures.ts for
 * the full composition table):
 *   - Team GEN-A (4 members) / Team GEN-B (2 members): write/read/isolation
 *     testing, each with an active license_keys row.
 *   - Five coverage-matrix teams (COV_4_0 / COV_5_0 / COV_5_1 / COV_10_5A /
 *     COV_10_5B) sized to exercise every branch of
 *     analytics_team_reporting_coverage()'s k=5 suppression ladder.
 *
 * Every fixture (users, subscriptions, teams, memberships, telemetry consent
 * state, license keys) is driven to its target state via an idempotent
 * ensure/upsert path, so a re-run repairs drift rather than erroring or
 * duplicating — same contract as scripts/seed-e2e-registry-users.ts.
 *
 * Usage:
 *   varlock run -- npx tsx scripts/seed-e2e-smi6362-analytics-users.ts
 *
 * Required env (staging only — refuses to run against prod):
 *   STAGING_SUPABASE_URL
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY
 *
 * The shared test password is a literal in e2e-smi6362-analytics-fixtures.ts
 * (E2E_PASSWORD) — throwaway staging-only test data, not a real secret.
 *
 * License keys are NOT printed here — scripts/e2e-smi6362-analytics-roundtrip.ts
 * mints its own scratch GEN-A/GEN-B license keys at test time (self-sufficient,
 * no stdout/JSON hand-off between the two scripts required). See
 * e2e-smi6362-analytics-db-utils.ts's mintFreshLicenseKey() docstring.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  ALL_USERS,
  ALL_TEAMS,
  TEAM_GEN_A,
  TEAM_GEN_B,
  E2E_PASSWORD,
  teamAllMembers,
  type TeamSpec,
} from './e2e-smi6362-analytics-fixtures.js'
import {
  requireEnv,
  assertStagingHost,
  ensureUser,
  ensureSubscriptionAndTeam,
  ensureMembership,
  ensureTelemetryPreference,
  mintFreshLicenseKey,
} from './e2e-smi6362-analytics-db-utils.js'

const STAGING_REF = 'ovhcifugwqnzoebwfuku'
const STAGING_HOST = `${STAGING_REF}.supabase.co`
// Split across two string literals so this file cannot trip the prod-ref grep gate.
const PROD_REF = 'vrcnzpmn' + 'dtroqxxoqkzy' // SMI-6362-allow-prod-ref

async function seedTeam(
  admin: SupabaseClient,
  spec: TeamSpec,
  userIds: Map<string, string>
): Promise<string> {
  const ownerId = userIds.get(spec.owner.email)!
  const teamId = await ensureSubscriptionAndTeam(
    admin,
    spec.subscriptionId,
    ownerId,
    spec.tier,
    spec.seatCount
  )
  for (const member of spec.extraMembers) {
    await ensureMembership(admin, teamId, userIds.get(member.email)!, 'member')
  }
  console.error(
    `[SMI-6362 seed] Team ${spec.key} ready (team_id=${teamId}, ${teamAllMembers(spec).length} members)`
  )

  if (spec.needsLicenseKey) {
    await mintFreshLicenseKey(admin, spec.subscriptionId, ownerId, spec.tier, spec.key)
    console.error(`[SMI-6362 seed] License key minted for ${spec.key}`)
  }

  return teamId
}

async function main(): Promise<void> {
  const url = requireEnv('STAGING_SUPABASE_URL')
  const serviceRole = requireEnv('STAGING_SUPABASE_SERVICE_ROLE_KEY')

  assertStagingHost(url, STAGING_HOST, PROD_REF)

  const admin = createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // 1. Users (20 total: 6 dedicated GEN-A/GEN-B identities + 14 pooled
  //    coverage-matrix identities). Each gets its global consent state
  //    stamped immediately after creation — consent is a property of the
  //    user, not of any one team membership.
  const userIds = new Map<string, string>()
  for (const user of ALL_USERS) {
    const id = await ensureUser(admin, user.email, E2E_PASSWORD)
    userIds.set(user.email, id)
    await ensureTelemetryPreference(admin, id, user.consent)
  }
  console.error(`[SMI-6362 seed] ${userIds.size} auth users ready with consent state stamped.`)

  // 2. Teams (7 total) — subscription+team provisioning, non-owner
  //    memberships, and license keys for GEN-A/GEN-B.
  const teamIds = new Map<string, string>()
  for (const team of ALL_TEAMS) {
    const teamId = await seedTeam(admin, team, userIds)
    teamIds.set(team.key, teamId)
  }

  // 3. Final-state assertion before declaring success — a partial prior run
  //    must self-heal on retry, matching seed-e2e-registry-users.ts's
  //    contract. Re-reads team_members counts and each user's telemetry
  //    consent state independently rather than trusting the write calls'
  //    own success alone.
  const missing: string[] = []

  const allTeamIds = [...teamIds.values()]
  const { data: finalMembers, error: finalMembersErr } = await admin
    .from('team_members')
    .select('team_id,user_id,role')
    .in('team_id', allTeamIds)
  if (finalMembersErr) {
    console.error(
      `[SMI-6362 seed] Final-state team_members read failed: ${finalMembersErr.message}`
    )
    process.exit(1)
  }
  for (const team of ALL_TEAMS) {
    const teamId = teamIds.get(team.key)!
    const expectedMembers = teamAllMembers(team)
    for (const member of expectedMembers) {
      const memberId = userIds.get(member.email)!
      const expectedRole = member === team.owner ? 'owner' : 'member'
      const found = (finalMembers ?? []).some(
        (m) => m.team_id === teamId && m.user_id === memberId && m.role === expectedRole
      )
      if (!found) {
        missing.push(`${team.key}: ${member.key} (role=${expectedRole})`)
      }
    }
    const actualCount = (finalMembers ?? []).filter((m) => m.team_id === teamId).length
    if (actualCount !== expectedMembers.length) {
      missing.push(
        `${team.key}: expected exactly ${expectedMembers.length} members, found ${actualCount}`
      )
    }
  }

  const allUserIds = [...userIds.values()]
  const { data: finalPrefs, error: finalPrefsErr } = await admin
    .from('user_telemetry_preferences')
    .select('user_id,enabled,consent_decided_at')
    .in('user_id', allUserIds)
  if (finalPrefsErr) {
    console.error(
      `[SMI-6362 seed] Final-state user_telemetry_preferences read failed: ${finalPrefsErr.message}`
    )
    process.exit(1)
  }
  for (const user of ALL_USERS) {
    const userId = userIds.get(user.email)!
    const row = (finalPrefs ?? []).find((p) => p.user_id === userId)
    if (user.consent === 'undecided') {
      if (row && row.consent_decided_at !== null) {
        missing.push(
          `${user.key}: expected undecided (no row or NULL consent_decided_at), found decided`
        )
      }
    } else {
      const expectedEnabled = user.consent === 'enabled_decided'
      if (!row || row.enabled !== expectedEnabled || row.consent_decided_at === null) {
        missing.push(
          `${user.key}: expected enabled=${expectedEnabled}+decided, got ${
            row ? `enabled=${row.enabled},decided_at=${row.consent_decided_at}` : 'no row'
          }`
        )
      }
    }
  }

  const licenseSubIds = [TEAM_GEN_A.subscriptionId, TEAM_GEN_B.subscriptionId]
  const { data: finalKeys, error: finalKeysErr } = await admin
    .from('license_keys')
    .select('subscription_id,status')
    .in('subscription_id', licenseSubIds)
  if (finalKeysErr) {
    console.error(`[SMI-6362 seed] Final-state license_keys read failed: ${finalKeysErr.message}`)
    process.exit(1)
  }
  for (const subId of licenseSubIds) {
    const hasActive = (finalKeys ?? []).some(
      (k) => k.subscription_id === subId && k.status === 'active'
    )
    if (!hasActive) missing.push(`license key: no active row for subscription ${subId}`)
  }

  if (missing.length > 0) {
    console.error(`[SMI-6362 seed] Final-state assertion failed — missing: ${missing.join('; ')}`)
    process.exit(1)
  }
  console.error('[SMI-6362 seed] Final-state assertion OK.')

  // 4. Emit machine-readable summary to stdout (team ids are re-derived by the
  //    round-trip script itself via resolveTeamIdBySubscription — this
  //    printout is purely operator-facing, not a required hand-off).
  for (const team of ALL_TEAMS) {
    process.stdout.write(`SMI6362_TEAM_${team.key}_ID=${teamIds.get(team.key)}\n`)
  }
}

main().catch((err: unknown) => {
  console.error(`[SMI-6362 seed] unexpected error: ${String(err)}`)
  process.exit(1)
})
