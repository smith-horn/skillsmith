/**
 * SMI-6093: true-concurrency regression test for
 * grant_or_reactivate_complimentary_subscription()'s pg_advisory_xact_lock
 * serialization. Fires two GENUINELY simultaneous RPC calls (each an
 * independent HTTP request through PostgREST, each its own backend Postgres
 * connection) for the same user and asserts the lock prevents a fork --
 * exactly one subscriptions row, one teams row, both calls succeed.
 *
 * Requires a live local Supabase instance (`supabase start`). Skipped by
 * default -- opt in with SKILLSMITH_GRANT_CONCURRENCY_TEST=1 (guards-and-
 * opt-outs.md registered name/value convention). Runtime-enforced,
 * independent of any CI/env configuration: SUPABASE_URL is caller-supplied
 * and could theoretically point anywhere, and cleanup below performs real
 * deletes with a service-role key -- this file hard-fails unless the host
 * resolves to loopback, never trusting "it's gated in CI" alone (plan-review
 * finding, 2026-08-21).
 */

import { afterAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'

const LIVE_DB = process.env.SKILLSMITH_GRANT_CONCURRENCY_TEST === '1'
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321'
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function assertLoopbackUrl(url: string): void {
  const hostname = new URL(url).hostname
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      `SKILLSMITH_GRANT_CONCURRENCY_TEST=1 refuses to run against a non-loopback SUPABASE_URL ` +
        `host "${hostname}" -- this test performs real deletes with a service-role key and must ` +
        `only ever target a local ephemeral instance, never staging/prod, regardless of how it ` +
        `was invoked.`
    )
  }
}

describe.skipIf(!LIVE_DB)(
  'SMI-6093: grant_or_reactivate_complimentary_subscription concurrency',
  () => {
    // NOTE: describe.skipIf still EXECUTES this callback body to register the
    // suite -- it only skips running the it() blocks. Any env-dependent setup
    // here must not throw/construct eagerly when LIVE_DB is false, or the
    // whole file fails outright instead of skipping cleanly.
    if (LIVE_DB && !SERVICE_ROLE_KEY) {
      throw new Error(
        'SKILLSMITH_GRANT_CONCURRENCY_TEST=1 requires SUPABASE_SERVICE_ROLE_KEY ' +
          '(no fallback -- this test must never silently hit the wrong project)'
      )
    }
    if (LIVE_DB) {
      assertLoopbackUrl(SUPABASE_URL)
    }

    const adminClient = LIVE_DB
      ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY as string, {
          auth: { autoRefreshToken: false, persistSession: false },
        })
      : (null as unknown as ReturnType<typeof createClient>)

    const scratchSuffix = crypto.randomUUID()
    const scratchEmail = `smi6093-concurrency-${scratchSuffix}@example.test`
    let scratchUserId: string | null = null

    afterAll(async () => {
      if (!scratchUserId) return
      // Cleanup order respects FK dependents: license_keys -> subscriptions,
      // team_members/teams -> subscriptions, profiles/auth.users last. Errors
      // are collected and logged (not thrown, so a partial cleanup failure
      // never masks the test's own pass/fail result) rather than silently
      // swallowed (plan-review finding, 2026-08-21).
      const cleanupErrors: string[] = []
      const track = (label: string, error: { message: string } | null) => {
        if (error) cleanupErrors.push(`${label}: ${error.message}`)
      }

      track(
        'license_keys',
        (await adminClient.from('license_keys').delete().eq('user_id', scratchUserId)).error
      )
      const { data: subs } = await adminClient
        .from('subscriptions')
        .select('id')
        .eq('user_id', scratchUserId)
      const subIds = (subs || []).map((s) => s.id)
      if (subIds.length > 0) {
        const { data: teamRows } = await adminClient
          .from('teams')
          .select('id')
          .in('subscription_id', subIds)
        const teamIds = (teamRows || []).map((t) => t.id)
        if (teamIds.length > 0) {
          track(
            'team_members',
            (await adminClient.from('team_members').delete().in('team_id', teamIds)).error
          )
        }
        track(
          'teams',
          (await adminClient.from('teams').delete().in('subscription_id', subIds)).error
        )
        track(
          'subscriptions',
          (await adminClient.from('subscriptions').delete().in('id', subIds)).error
        )
      }
      track('profiles', (await adminClient.from('profiles').delete().eq('id', scratchUserId)).error)
      const { error: deleteUserError } = await adminClient.auth.admin.deleteUser(scratchUserId)
      if (deleteUserError) cleanupErrors.push(`auth.users: ${deleteUserError.message}`)

      if (cleanupErrors.length > 0) {
        console.error(
          `SMI-6093 concurrency test: scratch cleanup for user ${scratchUserId} had ${cleanupErrors.length} error(s):`,
          cleanupErrors
        )
      }
    })

    it('serializes two concurrent grants for the same user into exactly one subscription and one team', async () => {
      const { data: created, error: createError } = await adminClient.auth.admin.createUser({
        email: scratchEmail,
        email_confirm: true,
      })
      expect(createError).toBeNull()
      expect(created?.user?.id).toBeTruthy()
      scratchUserId = created!.user!.id

      await adminClient.from('profiles').upsert({
        id: scratchUserId,
        email: scratchEmail,
        tier: 'community',
      })

      const grantArgs = {
        p_user_id: scratchUserId,
        p_tier: 'team',
        p_months: 1,
        p_reason: 'SMI-6093 concurrency test',
        p_granted_by: 'smi6093-concurrency-test',
        p_allow_downgrade: false,
      }

      // Two genuinely simultaneous calls -- each Promise starts an independent
      // HTTP request immediately (no await between them), each PostgREST
      // request gets its own backend connection/transaction, so the
      // pg_advisory_xact_lock contention happens server-side in Postgres.
      const [resultA, resultB] = await Promise.all([
        adminClient.rpc('grant_or_reactivate_complimentary_subscription', grantArgs),
        adminClient.rpc('grant_or_reactivate_complimentary_subscription', grantArgs),
      ])

      expect(resultA.error, `call A failed: ${resultA.error?.message}`).toBeNull()
      expect(resultB.error, `call B failed: ${resultB.error?.message}`).toBeNull()

      // Never trust either RPC response for the fork check -- re-read
      // persisted state fresh, the same discipline QuarantineService's
      // concurrency test uses.
      const { data: subs, error: subsError } = await adminClient
        .from('subscriptions')
        .select('id, tier, status')
        .eq('user_id', scratchUserId)
        .filter('metadata->>grant_type', 'eq', 'complimentary')

      expect(subsError).toBeNull()
      expect(subs).toHaveLength(1)
      expect(subs![0].tier).toBe('team')
      expect(subs![0].status).toBe('active')

      const { data: teams, error: teamsError } = await adminClient
        .from('teams')
        .select('id, subscription_id')
        .eq('subscription_id', subs![0].id)

      expect(teamsError).toBeNull()
      expect(teams).toHaveLength(1)
    })
  }
)
