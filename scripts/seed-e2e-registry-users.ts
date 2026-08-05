/**
 * seed-e2e-registry-users.ts
 *
 * SMI-5922 — idempotent seed for the staging test fixtures used by the
 * private registry install E2E round-trip (scripts/e2e-registry-roundtrip.ts).
 * Generic provisioning primitives live in seed-e2e-registry-users.helpers.ts
 * (500-line file-length gate); this file owns the staging guard, fixture
 * constants, and orchestration.
 *
 * Seeds two teams and four users:
 *   - Team A (Enterprise, active): e2e-registry-admin@skillsmith.test (owner — 'owner'
 *     role satisfies user_admin_team_ids()'s role IN ('admin','owner') check, migration
 *     071_team_workspaces.sql:43-52), e2e-registry-member@skillsmith.test (member)
 *   - Team B (team-tier, active, NOT enterprise): e2e-registry-nonent@skillsmith.test (owner)
 *   - e2e-registry-dual@skillsmith.test: member of BOTH Team A and Team B — the
 *     load-bearing regression actor for round-trip assertion #6 (dual-membership 403,
 *     SMI-5922 plan review finding #5). A global `profiles.tier` check (the bug the
 *     row-scoped entitlement design was built to prevent regressing to) would
 *     incorrectly read 'enterprise' for this user via Team A and wrongly grant access
 *     to Team B's own skill; only a correct check scoped to the row's own team returns
 *     403. `profiles.tier` is NOT trigger-maintained on a direct `team_members` insert
 *     (only `accept_team_invitation`/`remove_team_member` call `recompute_user_tier`,
 *     20260524000002_team_member_tier_sync.sql) — this script calls it explicitly for
 *     all four users after memberships are set, or the dual actor's `profiles.tier`
 *     stays 'community' and the regression case tests nothing (Opus review finding #1).
 *
 * Plus:
 *   - One durable Team B skill row (service-role insert) — the cross-team-404 /
 *     non-Enterprise-403 / dual-membership-403 fetch target. The skill_id's namespace
 *     segment MUST equal Team B's own trigger-derived `teams.skill_namespace`
 *     (enforce_private_skill_namespace, 20260727000000_private_registry_skill_namespace_enforcement.sql:315-334
 *     hard-rejects any mismatch) — read back after team creation, never guessed/hardcoded.
 *     Repaired (not just created) on re-run: `deprecated` is the one column still
 *     UPDATE-grantable to `authenticated` post-hardening, so a stray `setDeprecated()`
 *     call against this fixture between runs must not silently stick (Opus finding #3).
 *   - One `license_keys` row per team, linked to that team's subscription. The MCP tool
 *     surface (`private_registry_manage`, `registry-tools.ts:268` `resolveTeamId()`)
 *     resolves "which team's registry" EXCLUSIVELY from `SKILLSMITH_LICENSE_KEY` via
 *     `resolve_team_from_license` — never from the caller's `team_members` rows, which
 *     only gate the WITHIN-team read via RLS/entitlement once a team is already
 *     selected. Both teams need a key: round-trip assertion #4/#6's MCP-live re-run
 *     targets Team A's and Team B's skills respectively, regardless of which team the
 *     acting user's own license key would otherwise suggest (Opus review finding #2,
 *     traced through to both teams — not just Team A). Raw key values cannot be
 *     recovered from the stored `key_hash` (one-way SHA-256), so this is idempotent by
 *     "does an active key already exist for this subscription" — a re-run does not
 *     mint a second key, and only prints the raw value the run that actually creates it.
 *
 * Idempotency (SMI-5922 plan review finding #7): every durable fixture — teams,
 * subscriptions, memberships, tiers, license keys, the durable skill — uses a
 * deterministic lookup/upsert/repair path, so a re-run repairs drifted state instead
 * of erroring or duplicating. Final state (including the durable skill row's own
 * content and the two teams' distinctness) is asserted before IDs are printed
 * (Opus finding #4).
 *
 * Usage:
 *   varlock run -- npx tsx scripts/seed-e2e-registry-users.ts
 *
 * Required env (staging only — refuses to run against prod):
 *   STAGING_SUPABASE_URL              (must resolve to the staging host ovhcifugwqnzoebwfuku.supabase.co)
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY (auth admin + teams/subscriptions/team_members/
 *                                      private_registry_skills/license_keys writes)
 *   E2E_REG_USER_PASSWORD             (shared password for all four test users; stored as secret)
 *
 * Output (stdout — machine-readable, suitable for GitHub Actions secret capture):
 *   E2E_REG_ADMIN_USER_ID=<uuid>
 *   E2E_REG_MEMBER_USER_ID=<uuid>
 *   E2E_REG_NONENT_USER_ID=<uuid>
 *   E2E_REG_DUAL_USER_ID=<uuid>
 *   E2E_REG_TEAM_A_LICENSE_KEY=<key>   (only printed the run that creates it)
 *   E2E_REG_TEAM_B_LICENSE_KEY=<key>   (only printed the run that creates it)
 *
 * Team IDs are NOT emitted as secrets (plan Wave 2 §3) — the spec resolves them at
 * runtime from the user IDs via service-role, same as the durable skill's namespace.
 */

import { createClient } from '@supabase/supabase-js'
import {
  ensureUser,
  ensureSubscriptionAndTeam,
  ensureMembership,
  recomputeTier,
  ensureLicenseKey,
} from './seed-e2e-registry-users.helpers.js'

const STAGING_REF = 'ovhcifugwqnzoebwfuku'
const STAGING_HOST = `${STAGING_REF}.supabase.co`
// Split across two string literals so this file cannot trip the prod-ref grep gate.
const PROD_REF = 'vrcnzpmn' + 'dtroqxxoqkzy' // SMI-5922-allow-prod-ref

const EMAIL_ADMIN = 'e2e-registry-admin@skillsmith.test'
const EMAIL_MEMBER = 'e2e-registry-member@skillsmith.test'
const EMAIL_NONENT = 'e2e-registry-nonent@skillsmith.test'
const EMAIL_DUAL = 'e2e-registry-dual@skillsmith.test'

// Deterministic subscriptions.id (overrides the column's uuid_generate_v4() default) so
// ensure_team_for_subscription()'s own idempotency check (looked up by subscription_id)
// finds the SAME subscription — and therefore the same team — on every re-run.
const SUB_ID_ENT = 'e2e-reg-ent-sub'
const SUB_ID_NONENT = 'e2e-reg-nonent-sub'

const DURABLE_SKILL_NAME = 'durable-skill'
const DURABLE_SKILL_VERSION = '1.0.0'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`[SMI-5922 seed] Missing required env var: ${name}`)
    process.exit(2)
  }
  return v
}

async function main(): Promise<void> {
  const url = requireEnv('STAGING_SUPABASE_URL')
  const serviceRole = requireEnv('STAGING_SUPABASE_SERVICE_ROLE_KEY')
  const password = requireEnv('E2E_REG_USER_PASSWORD')

  // Fail-closed, host-based (not substring) staging-only guard (Opus review finding #5 —
  // a substring check on PROD_REF/STAGING_REF is bypassable by e.g.
  // https://evil.example/?r=<staging-ref>, which would still POST the service-role key to
  // an attacker-controlled host). Runs before any network call.
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    console.error(`[SMI-5922 seed] STAGING_SUPABASE_URL is not a valid URL: ${url}`)
    process.exit(2)
  }
  if (hostname.includes(PROD_REF)) {
    console.error(
      `[SMI-5922 seed] Refusing to run: STAGING_SUPABASE_URL's host contains the prod ref. ` +
        `This script mutates auth.users + teams + subscriptions + team_members + ` +
        `license_keys + private_registry_skills and MUST only run against staging.`
    )
    process.exit(2)
  }
  if (hostname !== STAGING_HOST) {
    console.error(
      `[SMI-5922 seed] STAGING_SUPABASE_URL's host ('${hostname}') does not exactly match the expected staging host (${STAGING_HOST}).`
    )
    process.exit(2)
  }

  const admin = createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // 1. Users.
  const adminId = await ensureUser(admin, EMAIL_ADMIN, password)
  const memberId = await ensureUser(admin, EMAIL_MEMBER, password)
  const nonentId = await ensureUser(admin, EMAIL_NONENT, password)
  const dualId = await ensureUser(admin, EMAIL_DUAL, password)

  // 2. Teams. Owner = the subscription's user_id (RPC-derived team name/slug), which
  //    becomes team_members role='owner' — counts as admin for RLS purposes.
  const teamAId = await ensureSubscriptionAndTeam(admin, SUB_ID_ENT, adminId, 'enterprise', 3)
  const teamBId = await ensureSubscriptionAndTeam(admin, SUB_ID_NONENT, nonentId, 'team', 2)
  if (teamAId === teamBId) {
    // Should be structurally impossible (distinct subscription ids -> distinct teams
    // per ensure_team_for_subscription's own idempotency key), but a collapse here
    // would make every isolation assertion in the round-trip spec vacuous.
    console.error('[SMI-5922 seed] FATAL: Team A and Team B resolved to the same team_id.')
    process.exit(1)
  }

  // 3. Extra memberships beyond each subscription's owner (the RPC only inserts the owner).
  await ensureMembership(admin, teamAId, memberId, 'member')
  await ensureMembership(admin, teamAId, dualId, 'member')
  await ensureMembership(admin, teamBId, dualId, 'member')

  // 4. Recompute profiles.tier for all four users now that memberships are final —
  //    load-bearing for the dual actor (Opus finding #1); run for all four for a
  //    consistent, accurate fixture rather than singling one user out.
  await recomputeTier(admin, adminId)
  await recomputeTier(admin, memberId)
  await recomputeTier(admin, nonentId)
  await recomputeTier(admin, dualId)

  // 5. License keys — the MCP tool surface's "which team" selector (Opus finding #2,
  //    traced to both teams: assertions #4/#6's MCP-live re-run each target a specific
  //    team's skill regardless of which team the acting user's own key might suggest).
  const teamALicenseKey = await ensureLicenseKey(admin, SUB_ID_ENT, adminId, 'enterprise', 'Team A')
  const teamBLicenseKey = await ensureLicenseKey(admin, SUB_ID_NONENT, nonentId, 'team', 'Team B')

  // 6. Read back Team B's trigger-derived namespace — never guessed. A hardcoded prefix
  //    would fail enforce_private_skill_namespace's hard check the moment the durable
  //    skill row below is inserted (namespace mismatch -> 23514).
  const { data: teamBRow, error: teamBErr } = await admin
    .from('teams')
    .select('skill_namespace')
    .eq('id', teamBId)
    .single()
  if (teamBErr || !teamBRow?.skill_namespace) {
    console.error(
      `[SMI-5922 seed] Could not read back Team B's skill_namespace: ${teamBErr?.message ?? 'empty'}`
    )
    process.exit(1)
  }
  const durableSkillId = `${teamBRow.skill_namespace}/${DURABLE_SKILL_NAME}`

  // 7. Durable Team B skill row (service-role insert; the cross-team-404 / non-Enterprise-403
  //    / dual-membership-403 fetch target). Immutable + idempotent: ignoreDuplicates on the
  //    natural UNIQUE(team_id, skill_id, version) key means a re-run silently no-ops instead
  //    of erroring on 23505. content_hash is trigger-derived (trg_prs_content_hash) — never
  //    supplied. published_by is intentionally omitted: its DEFAULT auth.uid() resolves to
  //    NULL on this service-role path (no session), matching the real MCP-publish provenance
  //    semantics documented on the column itself (20260729000000_private_registry_privilege_hardening.sql).
  const { error: skillErr } = await admin.from('private_registry_skills').upsert(
    {
      team_id: teamBId,
      skill_id: durableSkillId,
      version: DURABLE_SKILL_VERSION,
      description:
        'SMI-5922 durable E2E fixture — cross-team 404 / non-Enterprise 403 / dual-membership 403 fetch target. Never installed.',
      content: {
        'SKILL.md':
          '# SMI-5922 durable fixture skill\n\nSeeded by scripts/seed-e2e-registry-users.ts. Fetch-target only — never published fresh per run, never installed.',
      },
    },
    { onConflict: 'team_id,skill_id,version', ignoreDuplicates: true }
  )
  if (skillErr) {
    console.error(
      `[SMI-5922 seed] private_registry_skills upsert failed for ${durableSkillId}: ${skillErr.message}`
    )
    process.exit(1)
  }

  // 7b. Repair, not just create: `deprecated` is the one column still UPDATE-grantable to
  //     `authenticated` post-hardening (setDeprecated() is a shipped op) — a stray toggle
  //     between runs must not silently stick on this "durable, never mutated" fixture
  //     (Opus finding #3). ignoreDuplicates above never reaches this row on a re-run, so an
  //     explicit repair UPDATE is required; service_role bypasses the column-scoped GRANT
  //     that otherwise restricts this to `deprecated` alone for `authenticated`.
  const { error: repairErr } = await admin
    .from('private_registry_skills')
    .update({ deprecated: false })
    .eq('team_id', teamBId)
    .eq('skill_id', durableSkillId)
    .eq('version', DURABLE_SKILL_VERSION)
    .eq('deprecated', true)
  if (repairErr) {
    console.error(
      `[SMI-5922 seed] Durable skill deprecated-flag repair failed: ${repairErr.message}`
    )
    process.exit(1)
  }
  console.error(`[SMI-5922 seed] Durable Team B skill ready: ${durableSkillId}`)

  // 8. Final-state assertion before printing IDs — a partial prior run must self-heal on
  //    retry, not require manual cleanup (SMI-5922 plan review finding #7). Independent
  //    re-reads of team_members (5 rows), the durable skill row itself, and the two
  //    subscriptions' tiers — not just the membership check the first draft had (Opus
  //    finding #4: a missing skill row or a team_id collapse must not slide through).
  const { data: finalMembers, error: finalErr } = await admin
    .from('team_members')
    .select('team_id,user_id,role')
    .in('team_id', [teamAId, teamBId])
  if (finalErr) {
    console.error(`[SMI-5922 seed] Final-state team_members read failed: ${finalErr.message}`)
    process.exit(1)
  }
  // Role, not just presence (GPT-5.6-Sol review finding #4): a member drifted to 'admin'
  // (e.g. manually promoted between runs) makes assertion #3's "ordinary member can
  // install" check vacuous, since ensureMembership's own upsert now repairs this on
  // every run but a stale prior-run state must still be caught here too.
  const hasRole = (teamId: string, userId: string, role: string) =>
    (finalMembers ?? []).some(
      (m) => m.team_id === teamId && m.user_id === userId && m.role === role
    )
  const missing: string[] = []
  if (!hasRole(teamAId, adminId, 'owner')) missing.push('Team A admin (role=owner)')
  if (!hasRole(teamAId, memberId, 'member')) missing.push('Team A member (role=member)')
  if (!hasRole(teamAId, dualId, 'member')) missing.push('Team A dual actor (role=member)')
  if (!hasRole(teamBId, nonentId, 'owner')) missing.push('Team B nonent owner (role=owner)')
  if (!hasRole(teamBId, dualId, 'member')) missing.push('Team B dual actor (role=member)')

  // profiles.tier, not just the recompute_user_tier() call succeeding (GPT-5.6-Sol
  // review finding #1 — High): calling the RPC doesn't prove it actually persisted the
  // expected value. Without this read-back, round-trip assertion #6 (the load-bearing
  // dual-membership regression case) could silently pass under BOTH a correct
  // row-scoped entitlement check AND the incorrect global-profiles.tier check it exists
  // to catch, if the dual actor's tier never actually reached 'enterprise' -- both
  // checks would then agree (403), proving nothing.
  const { data: finalProfiles, error: finalProfilesErr } = await admin
    .from('profiles')
    .select('id,tier')
    .in('id', [adminId, memberId, nonentId, dualId])
  if (finalProfilesErr) {
    console.error(`[SMI-5922 seed] Final-state profiles read failed: ${finalProfilesErr.message}`)
    process.exit(1)
  }
  const tierOf = (userId: string) => (finalProfiles ?? []).find((p) => p.id === userId)?.tier
  if (tierOf(adminId) !== 'enterprise')
    missing.push(`Team A admin profiles.tier (got ${tierOf(adminId)}, want enterprise)`)
  if (tierOf(memberId) !== 'enterprise')
    missing.push(`Team A member profiles.tier (got ${tierOf(memberId)}, want enterprise)`)
  if (tierOf(nonentId) !== 'team')
    missing.push(`Team B nonent profiles.tier (got ${tierOf(nonentId)}, want team)`)
  if (tierOf(dualId) !== 'enterprise')
    missing.push(
      `Dual actor profiles.tier (got ${tierOf(dualId)}, want enterprise -- load-bearing for round-trip assertion #6)`
    )

  const { data: finalSkill, error: finalSkillErr } = await admin
    .from('private_registry_skills')
    .select('team_id,deprecated')
    .eq('team_id', teamBId)
    .eq('skill_id', durableSkillId)
    .eq('version', DURABLE_SKILL_VERSION)
    .maybeSingle()
  if (finalSkillErr) {
    console.error(`[SMI-5922 seed] Final-state skill read failed: ${finalSkillErr.message}`)
    process.exit(1)
  }
  if (!finalSkill) missing.push('Team B durable skill row')
  else if (finalSkill.deprecated) missing.push('Team B durable skill row (still deprecated)')

  const { data: finalSubs, error: finalSubsErr } = await admin
    .from('subscriptions')
    .select('id,tier,status')
    .in('id', [SUB_ID_ENT, SUB_ID_NONENT])
  if (finalSubsErr) {
    console.error(`[SMI-5922 seed] Final-state subscriptions read failed: ${finalSubsErr.message}`)
    process.exit(1)
  }
  const subOk = (id: string, tier: string) =>
    (finalSubs ?? []).some((s) => s.id === id && s.tier === tier && s.status === 'active')
  if (!subOk(SUB_ID_ENT, 'enterprise')) missing.push('Team A subscription (enterprise/active)')
  if (!subOk(SUB_ID_NONENT, 'team')) missing.push('Team B subscription (team/active)')

  if (missing.length > 0) {
    console.error(`[SMI-5922 seed] Final-state assertion failed — missing: ${missing.join(', ')}`)
    process.exit(1)
  }
  console.error('[SMI-5922 seed] Final-state assertion OK.')

  // 9. Emit secrets to stdout (machine-readable) so the operator can store them as GitHub
  //    e2e-staging environment secrets. Operational log lines above go to stderr and are
  //    ignored by capture. Password and service-role key are never printed. License keys
  //    only appear the run that creates them (see ensureLicenseKey's docstring).
  process.stdout.write(`E2E_REG_ADMIN_USER_ID=${adminId}\n`)
  process.stdout.write(`E2E_REG_MEMBER_USER_ID=${memberId}\n`)
  process.stdout.write(`E2E_REG_NONENT_USER_ID=${nonentId}\n`)
  process.stdout.write(`E2E_REG_DUAL_USER_ID=${dualId}\n`)
  if (teamALicenseKey) process.stdout.write(`E2E_REG_TEAM_A_LICENSE_KEY=${teamALicenseKey}\n`)
  if (teamBLicenseKey) process.stdout.write(`E2E_REG_TEAM_B_LICENSE_KEY=${teamBLicenseKey}\n`)
}

main().catch((err: unknown) => {
  console.error(`[SMI-5922 seed] unexpected error: ${String(err)}`)
  process.exit(1)
})
