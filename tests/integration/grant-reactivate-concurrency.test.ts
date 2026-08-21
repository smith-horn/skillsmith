/**
 * SMI-6093: true-concurrency regression test for
 * grant_or_reactivate_complimentary_subscription()'s pg_advisory_xact_lock
 * serialization. Fires two GENUINELY simultaneous RPC calls (each an
 * independent HTTP request through PostgREST, each its own backend Postgres
 * connection) for the same user and asserts the lock prevents a fork --
 * exactly one subscriptions row, one teams row, both calls succeed.
 *
 * Requires a live local Supabase instance (`supabase start`). Skipped by
 * default -- opt in with SKILLSMITH_GRANT_CONCURRENCY_LIVE_DB=true, never
 * runs against staging/prod (SUPABASE_URL always defaults to localhost).
 */

import { afterAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'

const LIVE_DB = process.env.SKILLSMITH_GRANT_CONCURRENCY_LIVE_DB === 'true'
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321'
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

describe.skipIf(!LIVE_DB)(
  'SMI-6093: grant_or_reactivate_complimentary_subscription concurrency',
  () => {
    // NOTE: describe.skipIf still EXECUTES this callback body to register the
    // suite -- it only skips running the it() blocks. Any env-dependent setup
    // here must not throw/construct eagerly when LIVE_DB is false, or the
    // whole file fails outright instead of skipping cleanly.
    if (LIVE_DB && !SERVICE_ROLE_KEY) {
      throw new Error(
        'SKILLSMITH_GRANT_CONCURRENCY_LIVE_DB=true requires SUPABASE_SERVICE_ROLE_KEY ' +
          '(no fallback -- this test must never silently hit the wrong project)'
      )
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
      // team_members/teams -> subscriptions, profiles/auth.users last.
      await adminClient.from('license_keys').delete().eq('user_id', scratchUserId)
      const { data: subs } = await adminClient
        .from('subscriptions')
        .select('id')
        .eq('user_id', scratchUserId)
      const subIds = (subs || []).map((s) => s.id)
      if (subIds.length > 0) {
        await adminClient
          .from('team_members')
          .delete()
          .in(
            'team_id',
            (await adminClient.from('teams').select('id').in('subscription_id', subIds)).data?.map(
              (t) => t.id
            ) || []
          )
        await adminClient.from('teams').delete().in('subscription_id', subIds)
        await adminClient.from('subscriptions').delete().in('id', subIds)
      }
      await adminClient.from('profiles').delete().eq('id', scratchUserId)
      await adminClient.auth.admin.deleteUser(scratchUserId)
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
