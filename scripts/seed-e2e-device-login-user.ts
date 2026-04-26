/**
 * seed-e2e-device-login-user.ts
 *
 * SMI-4460 — idempotent seed for the staging test user used by the
 * device-login round-trip e2e (`packages/website/tests/e2e/device-login-roundtrip.spec.ts`).
 *
 * Creates (or no-ops) the user `e2e-device-login@skillsmith.test`, ensures the
 * `profiles` row exists with `profile_completed_at` set, and prints the
 * resolved user_id (which the workflow stores as the `E2E_TEST_USER_ID`
 * secret so the spec can assert on it post-claim).
 *
 * Usage:
 *   varlock run -- npx tsx scripts/seed-e2e-device-login-user.ts            # use STAGING_* env
 *   varlock run -- npx tsx scripts/seed-e2e-device-login-user.ts --emit-id  # also write user_id to stdout for capture
 *
 * Required env (staging only — refuses to run against prod):
 *   STAGING_SUPABASE_URL                     (must contain ovhcifugwqnzoebwfuku)
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY        (auth admin + profiles upsert)
 *   E2E_TEST_USER_PASSWORD                   (random 32-char, stored as secret)
 *   E2E_TEST_USER_EMAIL  (optional — defaults to e2e-device-login@skillsmith.test)
 *
 * Idempotent: re-running is a no-op if the user + profile already exist.
 */

import { createClient } from '@supabase/supabase-js'

const STAGING_REF = 'ovhcifugwqnzoebwfuku'
const PROD_REF = 'vrcnzpmndtroqxxoqkzy' // SMI-4460-allow-prod-ref
const DEFAULT_EMAIL = 'e2e-device-login@skillsmith.test'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`[SMI-4460 seed] Missing required env var: ${name}`)
    process.exit(2)
  }
  return v
}

async function main(): Promise<void> {
  const url = requireEnv('STAGING_SUPABASE_URL')
  const serviceRole = requireEnv('STAGING_SUPABASE_SERVICE_ROLE_KEY')
  const password = requireEnv('E2E_TEST_USER_PASSWORD')
  const email = process.env['E2E_TEST_USER_EMAIL'] ?? DEFAULT_EMAIL

  if (url.includes(PROD_REF)) {
    console.error(
      `[SMI-4460 seed] Refusing to run: STAGING_SUPABASE_URL contains the prod ref (${PROD_REF}). ` +
        `This script mutates auth.users + profiles and MUST run against staging only.`
    )
    process.exit(2)
  }
  if (!url.includes(STAGING_REF)) {
    console.error(
      `[SMI-4460 seed] STAGING_SUPABASE_URL does not contain expected staging ref (${STAGING_REF}).`
    )
    process.exit(2)
  }

  const admin = createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // 1. Find existing user by email (paginated; staging has few users).
  let userId: string | null = null
  let page = 1
  const perPage = 1000
  // Bounded loop in case staging grows large — break after we cover ≥ 100 pages.
  for (let i = 0; i < 100 && !userId; i++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage })
    if (error) {
      console.error(`[SMI-4460 seed] listUsers failed: ${error.message}`)
      process.exit(1)
    }
    const found = data.users.find((u) => u.email === email)
    if (found) {
      userId = found.id
      break
    }
    if (data.users.length < perPage) break // last page
    page++
  }

  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (error) {
      console.error(`[SMI-4460 seed] createUser failed: ${error.message}`)
      process.exit(1)
    }
    userId = data.user!.id
    console.error(`[SMI-4460 seed] Created auth user ${email} (id=${userId})`)
  } else {
    console.error(`[SMI-4460 seed] Auth user ${email} already exists (id=${userId})`)
  }

  // 2. Upsert profile with profile_completed_at set so approve_device_code
  //    (migration 081 Tx 3) does not gate the test user with profile_incomplete.
  const { error: profileErr } = await admin.from('profiles').upsert(
    {
      id: userId,
      email,
      profile_completed_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  )
  if (profileErr) {
    console.error(`[SMI-4460 seed] profiles upsert failed: ${profileErr.message}`)
    process.exit(1)
  }
  console.error(`[SMI-4460 seed] profiles row OK for user ${userId}`)

  // 3. Emit the user_id to stdout (one line) so the workflow can capture it.
  // Stderr above is ignored by `tee`/capture; stdout is the machine surface.
  if (process.argv.includes('--emit-id')) {
    process.stdout.write(`${userId}\n`)
  } else {
    console.error(`[SMI-4460 seed] user_id=${userId}`)
  }
}

main().catch((err: unknown) => {
  console.error(`[SMI-4460 seed] unexpected error: ${String(err)}`)
  process.exit(1)
})
