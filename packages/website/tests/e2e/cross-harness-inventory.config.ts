/**
 * cross-harness-inventory.config.ts
 *
 * SMI-5395 — config wiring for the cross-harness skill inventory e2e.
 *
 * Centralises env-var reads for the spec + helpers so a missing var fails
 * loudly at boot instead of as a confusing runtime null. Also enforces the
 * staging-only invariant via positive AND negative ref matches — the
 * non-negotiable guard documented in the SMI-5395 plan §"Prod-Ref Grep Gate"
 * (workflow YAML provides the second backstop via grep at preflight time).
 *
 * Per CLAUDE.md project-ref table: staging ref `ovhcifugwqnzoebwfuku`. The
 * prod ref is the literal in PROD_REF below; the workflow's grep gate
 * allowlists this line via the marker comment.
 * This test MUST run against staging only.
 *
 * Note: cliPath / runHintExecution are intentionally absent (M4 — option-b
 * driver never builds or spawns the CLI, so requireEnv('CLI_PATH') would
 * throw at boot and is not needed here).
 */

const STAGING_REF = 'ovhcifugwqnzoebwfuku'
const PROD_REF = 'vrcnzpmndtroqxxoqkzy' // SMI-5395-allow-prod-ref

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v || v.length === 0) {
    throw new Error(
      `[SMI-5395] Required env var ${name} is missing. ` +
        `See .github/workflows/cross-harness-inventory-e2e.yml for the secret list.`
    )
  }
  return v
}

function assertStagingUrl(url: string): string {
  if (url.includes(PROD_REF)) {
    throw new Error(
      `[SMI-5395] Refusing to run: STAGING_SUPABASE_URL contains the prod project ref ` +
        `(${PROD_REF}). This test mutates user_devices + device_skills and MUST run ` +
        `against staging (${STAGING_REF}) only. See plan §"Prod-Ref Grep Gate".`
    )
  }
  if (!url.includes(STAGING_REF)) {
    throw new Error(
      `[SMI-5395] Refusing to run: STAGING_SUPABASE_URL does not contain the ` +
        `staging project ref (${STAGING_REF}). Expected URL like ` +
        `https://${STAGING_REF}.supabase.co. Got: ${url.replace(/(https?:\/\/[^/]+).*/, '$1')}.`
    )
  }
  return url
}

export interface InventoryE2EConfig {
  supabaseUrl: string
  supabaseAnonKey: string
  supabaseServiceRoleKey: string
  consentOnUserId: string
  consentOffUserId: string
  consentOnUserEmail: string
  consentOffUserEmail: string
  invUserPassword: string
  websiteBaseUrl: string
}

let cached: InventoryE2EConfig | null = null

export function getConfig(): InventoryE2EConfig {
  if (cached) return cached
  const supabaseUrl = assertStagingUrl(requireEnv('STAGING_SUPABASE_URL'))
  cached = {
    supabaseUrl,
    supabaseAnonKey: requireEnv('STAGING_SUPABASE_ANON_KEY'),
    supabaseServiceRoleKey: requireEnv('STAGING_SUPABASE_SERVICE_ROLE_KEY'),
    consentOnUserId: requireEnv('E2E_INV_CONSENT_ON_USER_ID'),
    consentOffUserId: requireEnv('E2E_INV_CONSENT_OFF_USER_ID'),
    invUserPassword: requireEnv('E2E_INV_USER_PASSWORD'),
    consentOnUserEmail:
      process.env['E2E_INV_CONSENT_ON_EMAIL'] ?? 'e2e-inventory-consent-on@skillsmith.test',
    consentOffUserEmail:
      process.env['E2E_INV_CONSENT_OFF_EMAIL'] ?? 'e2e-inventory-consent-off@skillsmith.test',
    websiteBaseUrl: process.env['WEBSITE_BASE_URL'] ?? 'http://127.0.0.1:4321',
  }
  return cached
}
