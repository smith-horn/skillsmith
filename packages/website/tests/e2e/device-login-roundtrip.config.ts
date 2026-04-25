/**
 * device-login-roundtrip.config.ts
 *
 * SMI-4460 — config wiring for the prod-parity device-login round-trip e2e.
 *
 * Centralises env-var reads for the spec + helpers so a missing var fails
 * loudly at boot instead of as a confusing runtime null. Also enforces the
 * staging-only invariant via positive AND negative ref matches — the
 * non-negotiable guard documented in the SMI-4460 plan §"Prod-Ref Grep Gate"
 * (workflow YAML provides the second backstop via grep at preflight time).
 *
 * Per CLAUDE.md memory `project_supabase_prod_vs_staging.md`: staging ref
 * `ovhcifugwqnzoebwfuku`. The prod ref is the literal in PROD_REF below;
 * the workflow's grep gate allowlists this line via the marker comment.
 * This test MUST run against staging only.
 */

const STAGING_REF = 'ovhcifugwqnzoebwfuku'
const PROD_REF = 'vrcnzpmndtroqxxoqkzy' // SMI-4460-allow-prod-ref

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v || v.length === 0) {
    throw new Error(
      `[SMI-4460] Required env var ${name} is missing. ` +
        `See .github/workflows/device-login-roundtrip.yml for the secret list.`
    )
  }
  return v
}

function assertStagingUrl(url: string): string {
  if (url.includes(PROD_REF)) {
    throw new Error(
      `[SMI-4460] Refusing to run: STAGING_SUPABASE_URL contains the prod project ref ` +
        `(${PROD_REF}). This test mutates device_codes + audit_logs and MUST run ` +
        `against staging (${STAGING_REF}) only. See plan §"Prod-Ref Grep Gate".`
    )
  }
  if (!url.includes(STAGING_REF)) {
    throw new Error(
      `[SMI-4460] Refusing to run: STAGING_SUPABASE_URL does not contain the ` +
        `staging project ref (${STAGING_REF}). Expected URL like ` +
        `https://${STAGING_REF}.supabase.co. Got: ${url.replace(/(https?:\/\/[^/]+).*/, '$1')}.`
    )
  }
  return url
}

export interface RoundtripConfig {
  supabaseUrl: string
  supabaseAnonKey: string
  supabaseServiceRoleKey: string
  testUserEmail: string
  testUserPassword: string
  testUserId: string
  websiteBaseUrl: string
  cliPath: string
  /** When true, Wave 2 step 9 runs the post-login hint command for layer-2 B3 protection (Phase 4a). */
  runHintExecution: boolean
}

let cached: RoundtripConfig | null = null

export function getConfig(): RoundtripConfig {
  if (cached) return cached
  const supabaseUrl = assertStagingUrl(requireEnv('STAGING_SUPABASE_URL'))
  cached = {
    supabaseUrl,
    supabaseAnonKey: requireEnv('STAGING_SUPABASE_ANON_KEY'),
    supabaseServiceRoleKey: requireEnv('STAGING_SUPABASE_SERVICE_ROLE_KEY'),
    testUserEmail: process.env['E2E_TEST_USER_EMAIL'] ?? 'e2e-device-login@skillsmith.test',
    testUserPassword: requireEnv('E2E_TEST_USER_PASSWORD'),
    testUserId: requireEnv('E2E_TEST_USER_ID'),
    websiteBaseUrl: process.env['WEBSITE_BASE_URL'] ?? 'http://localhost:4321',
    cliPath: requireEnv('CLI_PATH'),
    runHintExecution: process.env['RUN_HINT_EXECUTION'] === 'true',
  }
  return cached
}
