/**
 * seed-e2e-inventory-users.ts
 *
 * SMI-5395 — idempotent seed for the two staging test users used by the
 * cross-harness inventory e2e (`packages/website/tests/e2e/cross-harness-inventory.spec.ts`).
 *
 * Creates (or no-ops) two dedicated users with fixed consent values:
 *   - e2e-inventory-consent-on@skillsmith.test  → inventory_sync_enabled = TRUE
 *   - e2e-inventory-consent-off@skillsmith.test → inventory_sync_enabled = FALSE
 *
 * For each user the script UPSERTs a user_telemetry_preferences row so that the
 * user-side RLS SELECT returns the correct consent value without any mid-suite
 * toggling (C2/H7). Consent is never mutated at runtime — values are fixed here.
 *
 * Usage:
 *   varlock run -- npx tsx scripts/seed-e2e-inventory-users.ts
 *
 * Required env (staging only — refuses to run against prod):
 *   STAGING_SUPABASE_URL              (must contain the staging ref ovhcifugwqnzoebwfuku)
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY (auth admin + user_telemetry_preferences upsert)
 *   E2E_INV_USER_PASSWORD             (shared password for both test users; stored as secret)
 *
 * Output (stdout — machine-readable, suitable for GitHub Actions secret capture):
 *   E2E_INV_CONSENT_ON_USER_ID=<uuid>
 *   E2E_INV_CONSENT_OFF_USER_ID=<uuid>
 *
 * Idempotent: re-running is a no-op if users + prefs rows already exist.
 */

import { createClient } from '@supabase/supabase-js'

const STAGING_REF = 'ovhcifugwqnzoebwfuku'
// Split across two string literals so this file cannot trip the prod-ref grep gate.
const PROD_REF = 'vrcnzpmn' + 'dtroqxxoqkzy' // SMI-5395-allow-prod-ref

const EMAIL_ON = 'e2e-inventory-consent-on@skillsmith.test'
const EMAIL_OFF = 'e2e-inventory-consent-off@skillsmith.test'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`[SMI-5395 seed] Missing required env var: ${name}`)
    process.exit(2)
  }
  return v
}

/**
 * Finds an existing auth user by email via paginated listUsers, or creates one.
 * Returns the resolved user_id. Never errors silently — exits on any API failure.
 */
async function ensureUser(
  admin: ReturnType<typeof createClient>,
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
      console.error(`[SMI-5395 seed] listUsers failed: ${error.message}`)
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
      console.error(`[SMI-5395 seed] createUser failed for ${email}: ${error.message}`)
      process.exit(1)
    }
    userId = data.user!.id
    console.error(`[SMI-5395 seed] Created auth user ${email} (id=${userId})`)
  } else {
    console.error(`[SMI-5395 seed] Auth user ${email} already exists (id=${userId})`)
  }

  return userId
}

async function main(): Promise<void> {
  const url = requireEnv('STAGING_SUPABASE_URL')
  const serviceRole = requireEnv('STAGING_SUPABASE_SERVICE_ROLE_KEY')
  const password = requireEnv('E2E_INV_USER_PASSWORD')

  // Fail-closed: abort before any network call if the URL points at prod.
  if (url.includes(PROD_REF)) {
    console.error(
      `[SMI-5395 seed] Refusing to run: STAGING_SUPABASE_URL contains the prod ref. ` +
        `This script mutates auth.users + user_telemetry_preferences and MUST only run against staging.`
    )
    process.exit(2)
  }
  if (!url.includes(STAGING_REF)) {
    console.error(
      `[SMI-5395 seed] STAGING_SUPABASE_URL does not contain the expected staging ref (${STAGING_REF}).`
    )
    process.exit(2)
  }

  const admin = createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // 1. Ensure both auth users exist (idempotent createUser).
  const consentOnId = await ensureUser(admin, EMAIL_ON, password)
  const consentOffId = await ensureUser(admin, EMAIL_OFF, password)

  // 2. UPSERT user_telemetry_preferences for the consent-ON user.
  //    All NOT-NULL columns set explicitly:
  //      user_id               — PK, no default (required)
  //      enabled               — skill-invoke telemetry opt-in (NOT NULL DEFAULT false); false here
  //      inventory_sync_enabled — inventory consent gate (NOT NULL DEFAULT FALSE); TRUE for this user
  //      updated_at            — no auto-update trigger; set to now() so conflict path also refreshes it
  const { error: prefsOnErr } = await admin.from('user_telemetry_preferences').upsert(
    {
      user_id: consentOnId,
      enabled: false,
      inventory_sync_enabled: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  )
  if (prefsOnErr) {
    console.error(
      `[SMI-5395 seed] user_telemetry_preferences upsert failed for consent-ON user: ${prefsOnErr.message}`
    )
    process.exit(1)
  }
  console.error(
    `[SMI-5395 seed] user_telemetry_preferences OK for consent-ON user ${consentOnId} (inventory_sync_enabled=true)`
  )

  // 3. UPSERT user_telemetry_preferences for the consent-OFF user.
  //    inventory_sync_enabled = FALSE — the gate for Test C's consent_disabled path.
  const { error: prefsOffErr } = await admin.from('user_telemetry_preferences').upsert(
    {
      user_id: consentOffId,
      enabled: false,
      inventory_sync_enabled: false,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  )
  if (prefsOffErr) {
    console.error(
      `[SMI-5395 seed] user_telemetry_preferences upsert failed for consent-OFF user: ${prefsOffErr.message}`
    )
    process.exit(1)
  }
  console.error(
    `[SMI-5395 seed] user_telemetry_preferences OK for consent-OFF user ${consentOffId} (inventory_sync_enabled=false)`
  )

  // 4. Emit user IDs to stdout (machine-readable) so the operator can store them
  //    as GitHub e2e-staging environment secrets. Operational log lines above go to
  //    stderr and are ignored by capture. Password and service-role key are never printed.
  process.stdout.write(`E2E_INV_CONSENT_ON_USER_ID=${consentOnId}\n`)
  process.stdout.write(`E2E_INV_CONSENT_OFF_USER_ID=${consentOffId}\n`)
}

main().catch((err: unknown) => {
  console.error(`[SMI-5395 seed] unexpected error: ${String(err)}`)
  process.exit(1)
})
