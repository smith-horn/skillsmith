/**
 * seed-e2e-registry-users.helpers.ts
 *
 * SMI-5922 — companion helpers for seed-e2e-registry-users.ts, split out to stay
 * under the 500-line file-length gate (audit:standards). Generic, reusable
 * provisioning primitives; the main script owns the staging-guard, fixture
 * constants, and orchestration (main()).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { randomBytes, createHash } from 'node:crypto'

// Mirrors supabase/functions/_shared/license.ts's generateLicenseKey()/hashLicenseKey()
// (Deno Web Crypto there; node:crypto here — same 32-random-bytes -> base64url body,
// sha256-hex hash scheme, same 'sk_live_' prefix so the format-validity check
// `key.startsWith(LICENSE_KEY_PREFIX) && key.length >= 40` still holds).
const LICENSE_KEY_PREFIX = 'sk_live_'

/**
 * Finds an existing auth user by email via paginated listUsers, or creates one.
 * Returns the resolved user_id. Never errors silently — exits on any API failure.
 */
export async function ensureUser(
  admin: SupabaseClient,
  email: string,
  password: string
): Promise<string> {
  let userId: string | null = null
  let page = 1
  const perPage = 1000

  // Bounded loop — staging has few users; cap at 100 pages to avoid a runaway.
  for (let i = 0; i < 100 && !userId; i++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage })
    if (error) {
      console.error(`[SMI-5922 seed] listUsers failed: ${error.message}`)
      process.exit(1)
    }
    const found = data.users.find((u) => u.email === email)
    if (found) {
      userId = found.id
      break
    }
    if (data.users.length < perPage) break // last page reached
    page++
  }

  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (error) {
      console.error(`[SMI-5922 seed] createUser failed for ${email}: ${error.message}`)
      process.exit(1)
    }
    userId = data.user!.id
    console.error(`[SMI-5922 seed] Created auth user ${email} (id=${userId})`)
  } else {
    // GPT-5.6-Sol review finding #4: an existing user's password was never resynced,
    // so re-running the seed after rotating E2E_REG_USER_PASSWORD wouldn't restore
    // sign-in -- repair it unconditionally on every run, matching this script's
    // "a re-run repairs drift" contract for every other fixture.
    const { error: pwErr } = await admin.auth.admin.updateUserById(userId, { password })
    if (pwErr) {
      console.error(`[SMI-5922 seed] password resync failed for ${email}: ${pwErr.message}`)
      process.exit(1)
    }
    console.error(
      `[SMI-5922 seed] Auth user ${email} already exists (id=${userId}), password resynced`
    )
  }

  return userId
}

/**
 * Idempotently ensures a subscription + its RPC-provisioned team exist, with the
 * subscription's owner as the team's 'owner' (admin-equivalent). Returns the team_id.
 */
export async function ensureSubscriptionAndTeam(
  admin: SupabaseClient,
  subscriptionId: string,
  ownerUserId: string,
  tier: 'enterprise' | 'team',
  seatCount: number
): Promise<string> {
  const now = new Date()
  const oneYearOut = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)

  // subscriptions.current_period_start/end are NOT NULL with no default — must be
  // supplied explicitly (011_users_subscriptions.sql:39-40). seat_count is explicit
  // (not left at DEFAULT 1) so the fixture accurately represents a multi-member team,
  // even though it's unenforced on a direct insert today (Opus finding #6).
  const { error: subErr } = await admin.from('subscriptions').upsert(
    {
      id: subscriptionId,
      user_id: ownerUserId,
      tier,
      status: 'active',
      billing_period: 'monthly',
      seat_count: seatCount,
      current_period_start: now.toISOString(),
      current_period_end: oneYearOut.toISOString(),
    },
    { onConflict: 'id' }
  )
  if (subErr) {
    console.error(
      `[SMI-5922 seed] subscriptions upsert failed for ${subscriptionId}: ${subErr.message}`
    )
    process.exit(1)
  }

  // service_role-only RPC (073_ensure_team_for_subscription.sql). Idempotent: returns the
  // existing team_id (looked up by subscription_id) on re-run, and self-heals a missing
  // owner team_members row on partial-failure recovery.
  const { data: teamId, error: rpcErr } = await admin.rpc('ensure_team_for_subscription', {
    p_subscription_id: subscriptionId,
  })
  if (rpcErr || !teamId) {
    console.error(
      `[SMI-5922 seed] ensure_team_for_subscription failed for ${subscriptionId}: ${
        rpcErr?.message ?? 'no team_id returned'
      }`
    )
    process.exit(1)
  }
  console.error(
    `[SMI-5922 seed] Team ready for subscription ${subscriptionId} (tier=${tier}, team_id=${teamId})`
  )
  return teamId as string
}

/**
 * Idempotently ensures a team_members row exists WITH the expected role — repairs role
 * drift on re-run (GPT-5.6-Sol review finding #4: a plain ignoreDuplicates upsert left a
 * previously-promoted member stuck at 'admin', silently making round-trip assertion #3's
 * "ordinary member can install" check vacuous, since an accidentally-admin member proves
 * nothing about the member-level gate). Only ever called for non-owner memberships
 * (ensureSubscriptionAndTeam's RPC owns the owner row) — a real DO UPDATE here is safe.
 */
export async function ensureMembership(
  admin: SupabaseClient,
  teamId: string,
  userId: string,
  role: 'admin' | 'member'
): Promise<void> {
  const { error } = await admin
    .from('team_members')
    .upsert(
      { team_id: teamId, user_id: userId, role, joined_at: new Date().toISOString() },
      { onConflict: 'team_id,user_id' }
    )
  if (error) {
    console.error(
      `[SMI-5922 seed] team_members upsert failed (team=${teamId}, user=${userId}): ${error.message}`
    )
    process.exit(1)
  }
}

/**
 * Recomputes + persists profiles.tier for a user via the shared RPC
 * (20260524000002_team_member_tier_sync.sql) — MAX(tier_rank) across the user's own
 * active subscriptions and every team subscription they belong to. Must run AFTER all
 * of that user's team_members rows exist (it queries current state, not incremental) —
 * this is what makes the dual-membership actor's profiles.tier actually read
 * 'enterprise' (via Team A), which is the precondition for round-trip assertion #6 to
 * distinguish a correct row-scoped entitlement check from an incorrect global-tier one
 * (Opus review finding #1 — without this call, both checks return 403 identically and
 * the assertion proves nothing).
 */
export async function recomputeTier(admin: SupabaseClient, userId: string): Promise<void> {
  const { error } = await admin.rpc('recompute_user_tier', { p_user_id: userId })
  if (error) {
    console.error(`[SMI-5922 seed] recompute_user_tier failed for ${userId}: ${error.message}`)
    process.exit(1)
  }
}

/**
 * Mirrors supabase/functions/_shared/license.ts's generateLicenseKey()/hashLicenseKey(),
 * reimplemented with node:crypto (same scheme: 32 random bytes, base64url body,
 * sha256-hex hash, 'sk_live_' prefix).
 */
function generateLicenseKey(): { key: string; keyHash: string; keyPrefix: string } {
  const key = `${LICENSE_KEY_PREFIX}${randomBytes(32).toString('base64url')}`
  const keyPrefix = `${key.substring(0, 16)}...`
  const keyHash = createHash('sha256').update(key).digest('hex')
  return { key, keyHash, keyPrefix }
}

/**
 * Idempotently ensures an active license_keys row exists for the given subscription,
 * linked to `ownerUserId`. The raw key value is a one-way hash in the DB (key_hash) —
 * it cannot be recovered on a later run, so this only mints (and returns) a fresh key
 * the FIRST time it's called for a given subscription; subsequent runs detect the
 * existing active key and return null (nothing new to print — the operator already has
 * the value from the run that created it, captured as a GitHub Actions secret).
 *
 * Known gap (GPT-5.6-Sol review finding #3): if the process crashes or the operator
 * loses the captured stdout AFTER this function inserts the row but BEFORE the value
 * reaches a GitHub Actions secret, the raw key is unrecoverable — a re-run sees the
 * active row and returns null, not a fresh key. Recovery in that case is manual:
 * `DELETE FROM license_keys WHERE subscription_id = '<SUB_ID_ENT|SUB_ID_NONENT>' AND status = 'active'`
 * via `./scripts/pooler-psql.sh` against staging, then re-run the seed script.
 */
export async function ensureLicenseKey(
  admin: SupabaseClient,
  subscriptionId: string,
  ownerUserId: string,
  tier: 'enterprise' | 'team',
  label: string
): Promise<string | null> {
  const { data: existing, error: selErr } = await admin
    .from('license_keys')
    .select('id')
    .eq('subscription_id', subscriptionId)
    .eq('status', 'active')
    .limit(1)
  if (selErr) {
    console.error(`[SMI-5922 seed] license_keys lookup failed for ${label}: ${selErr.message}`)
    process.exit(1)
  }
  if (existing && existing.length > 0) {
    console.error(`[SMI-5922 seed] License key already active for ${label} — not reprinted.`)
    return null
  }

  const { key, keyHash, keyPrefix } = generateLicenseKey()
  const { error: insErr } = await admin.from('license_keys').insert({
    user_id: ownerUserId,
    subscription_id: subscriptionId,
    key_hash: keyHash,
    key_prefix: keyPrefix,
    name: `SMI-5922 E2E — ${label}`,
    tier,
    status: 'active',
  })
  if (insErr) {
    console.error(`[SMI-5922 seed] license_keys insert failed for ${label}: ${insErr.message}`)
    process.exit(1)
  }
  console.error(`[SMI-5922 seed] Created license key for ${label} (prefix=${keyPrefix})`)
  return key
}
