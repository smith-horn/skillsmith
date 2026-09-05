/**
 * e2e-smi6362-analytics-db-utils.ts
 *
 * SMI-6362 — shared staging-DB provisioning/lookup primitives used by BOTH
 * scripts/seed-e2e-smi6362-analytics-users.ts (writes) and
 * scripts/e2e-smi6362-analytics-roundtrip.ts (reads + one self-service license
 * key mint). Pattern mirrors scripts/seed-e2e-registry-users.helpers.ts
 * (ensureUser/ensureSubscriptionAndTeam/ensureMembership/ensureLicenseKey) —
 * generalized here so the round-trip script doesn't need any stdout/JSON
 * hand-off from the seed script: it resolves team ids and mints its own
 * scratch license key directly against staging via the same service-role
 * client.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { randomBytes, createHash } from 'node:crypto'
import type { ConsentState } from './e2e-smi6362-analytics-fixtures.js'

const LOG_PREFIX = '[SMI-6362 e2e]'
const LICENSE_KEY_PREFIX = 'sk_live_'

export function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`${LOG_PREFIX} Missing required env var: ${name}`)
    process.exit(2)
  }
  return v
}

/**
 * Fail-closed, host-based (not substring) staging-only guard — same pattern
 * as scripts/seed-e2e-registry-users.ts (a substring check on
 * PROD_REF/STAGING_REF is bypassable via e.g. https://evil.example/?r=<ref>,
 * which would still send real staging credentials to an attacker-controlled
 * host). Exits the process on any violation; never returns false.
 */
export function assertStagingHost(url: string, stagingHost: string, prodRef: string): void {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    console.error(`${LOG_PREFIX} URL is not a valid URL: ${url}`)
    process.exit(2)
  }
  if (hostname.includes(prodRef)) {
    console.error(
      `${LOG_PREFIX} Refusing to run: the URL's host contains the prod ref. This script mutates ` +
        `staging auth/teams/subscriptions/team_members/license_keys/user_telemetry_preferences ` +
        `and search_metrics test rows and MUST only run against staging.`
    )
    process.exit(2)
  }
  if (hostname !== stagingHost) {
    console.error(
      `${LOG_PREFIX} URL's host ('${hostname}') does not exactly match the expected staging host (${stagingHost}).`
    )
    process.exit(2)
  }
}

/**
 * Finds an existing auth user by email via paginated listUsers, or creates
 * one. Resyncs the password on every run (matches seed-e2e-registry-users.ts's
 * "a re-run repairs drift" contract).
 */
export async function ensureUser(
  admin: SupabaseClient,
  email: string,
  password: string
): Promise<string> {
  let userId: string | null = null
  let page = 1
  const perPage = 1000

  for (let i = 0; i < 100 && !userId; i++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage })
    if (error) {
      console.error(`${LOG_PREFIX} listUsers failed: ${error.message}`)
      process.exit(1)
    }
    const found = data.users.find((u) => u.email === email)
    if (found) {
      userId = found.id
      break
    }
    if (data.users.length < perPage) break
    page++
  }

  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (error) {
      console.error(`${LOG_PREFIX} createUser failed for ${email}: ${error.message}`)
      process.exit(1)
    }
    userId = data.user!.id
    console.error(`${LOG_PREFIX} Created auth user ${email} (id=${userId})`)
  } else {
    const { error: pwErr } = await admin.auth.admin.updateUserById(userId, { password })
    if (pwErr) {
      console.error(`${LOG_PREFIX} password resync failed for ${email}: ${pwErr.message}`)
      process.exit(1)
    }
    console.error(
      `${LOG_PREFIX} Auth user ${email} already exists (id=${userId}), password resynced`
    )
  }

  return userId
}

/**
 * Idempotently ensures a subscription + its RPC-provisioned team exist, with
 * the subscription's owner as the team's 'owner'. Returns the team_id.
 * ensure_team_for_subscription() (073_ensure_team_for_subscription.sql)
 * requires tier IN ('team','enterprise') — both this fixture's teams use
 * 'team'.
 */
export async function ensureSubscriptionAndTeam(
  admin: SupabaseClient,
  subscriptionId: string,
  ownerUserId: string,
  tier: 'team' | 'enterprise',
  seatCount: number
): Promise<string> {
  const now = new Date()
  const oneYearOut = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)

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
      `${LOG_PREFIX} subscriptions upsert failed for ${subscriptionId}: ${subErr.message}`
    )
    process.exit(1)
  }

  const { data: teamId, error: rpcErr } = await admin.rpc('ensure_team_for_subscription', {
    p_subscription_id: subscriptionId,
  })
  if (rpcErr || !teamId) {
    console.error(
      `${LOG_PREFIX} ensure_team_for_subscription failed for ${subscriptionId}: ${
        rpcErr?.message ?? 'no team_id returned'
      }`
    )
    process.exit(1)
  }
  return teamId as string
}

/** Idempotently ensures a non-owner team_members row with the expected role, repairing role drift. */
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
      `${LOG_PREFIX} team_members upsert failed (team=${teamId}, user=${userId}): ${error.message}`
    )
    process.exit(1)
  }
}

/**
 * Idempotently drives user_telemetry_preferences to the given global consent
 * state (service-role bypasses the user_telemetry_self_rw RLS policy, so this
 * can set any user's row directly):
 *  - 'enabled_decided'  -> enabled=true,  consent_decided_at=now() (a real
 *    dashboard-style opt-in — consent_decided MUST be true, not just enabled).
 *  - 'disabled_decided' -> enabled=false, consent_decided_at=now() (a real
 *    opt-out).
 *  - 'undecided'        -> row deleted entirely (resolve_telemetry_identity
 *    treats "no row" and "consent_decided_at IS NULL" identically — deleting
 *    is the simplest idempotent way to guarantee the undecided state on a
 *    re-run, even if a prior run left a decided row behind).
 */
export async function ensureTelemetryPreference(
  admin: SupabaseClient,
  userId: string,
  consent: ConsentState
): Promise<void> {
  if (consent === 'undecided') {
    const { error } = await admin.from('user_telemetry_preferences').delete().eq('user_id', userId)
    if (error) {
      console.error(
        `${LOG_PREFIX} user_telemetry_preferences delete (undecided repair) failed for ${userId}: ${error.message}`
      )
      process.exit(1)
    }
    return
  }

  const now = new Date().toISOString()
  const { error } = await admin.from('user_telemetry_preferences').upsert(
    {
      user_id: userId,
      enabled: consent === 'enabled_decided',
      consent_decided_at: now,
      updated_at: now,
    },
    { onConflict: 'user_id' }
  )
  if (error) {
    console.error(
      `${LOG_PREFIX} user_telemetry_preferences upsert failed for ${userId}: ${error.message}`
    )
    process.exit(1)
  }
}

/** Resolves a team's id from its deterministic subscription id — never guessed. */
export async function resolveTeamIdBySubscription(
  admin: SupabaseClient,
  subscriptionId: string
): Promise<string> {
  const { data, error } = await admin
    .from('teams')
    .select('id')
    .eq('subscription_id', subscriptionId)
    .single()
  if (error || !data?.id) {
    console.error(
      `${LOG_PREFIX} Could not resolve team id for subscription ${subscriptionId}: ${
        error?.message ?? 'no row'
      }`
    )
    process.exit(1)
  }
  return data.id as string
}

function generateLicenseKeyValue(): { key: string; keyHash: string; keyPrefix: string } {
  const key = `${LICENSE_KEY_PREFIX}${randomBytes(32).toString('base64url')}`
  const keyPrefix = `${key.substring(0, 16)}...`
  const keyHash = createHash('sha256').update(key).digest('hex')
  return { key, keyHash, keyPrefix }
}

/**
 * Revokes every existing active license_keys row for `subscriptionId` and
 * mints a fresh one, returning the plaintext value EVERY call (deliberate
 * departure from scripts/seed-e2e-registry-users.helpers.ts's
 * "only print once" convention: key_hash is a one-way SHA-256, and this
 * fixture's keys are throwaway, single-purpose test credentials scoped to one
 * seed+round-trip run, not a long-lived shared CI secret — always minting
 * fresh trades a harmless rotation for guaranteed self-sufficiency, so the
 * round-trip script never depends on capturing the seed script's stdout).
 */
export async function mintFreshLicenseKey(
  admin: SupabaseClient,
  subscriptionId: string,
  ownerUserId: string,
  tier: 'team' | 'enterprise',
  label: string
): Promise<string> {
  const { error: revokeErr } = await admin
    .from('license_keys')
    .update({ status: 'revoked', revoked_at: new Date().toISOString() })
    .eq('subscription_id', subscriptionId)
    .eq('status', 'active')
  if (revokeErr) {
    console.error(`${LOG_PREFIX} license_keys revoke failed for ${label}: ${revokeErr.message}`)
    process.exit(1)
  }

  const { key, keyHash, keyPrefix } = generateLicenseKeyValue()
  const { error: insErr } = await admin.from('license_keys').insert({
    user_id: ownerUserId,
    subscription_id: subscriptionId,
    key_hash: keyHash,
    key_prefix: keyPrefix,
    name: `SMI-6362 E2E — ${label}`,
    tier,
    status: 'active',
  })
  if (insErr) {
    console.error(`${LOG_PREFIX} license_keys insert failed for ${label}: ${insErr.message}`)
    process.exit(1)
  }
  return key
}
