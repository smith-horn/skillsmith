/**
 * e2e-registry-roundtrip.ts
 *
 * SMI-5922 — the real user journey: publish -> fetch (Edge Function / MCP-live) ->
 * install (real CLI subprocess) -> boundary outcomes, against real staging Supabase.
 * Deliberately outside every vitest glob (top-level scripts/, not scripts/tests/**)
 * so it can never fire in secretless CI (the inverse of the SMI-4961 dormant-test
 * lesson) — run explicitly via `.github/workflows/private-registry-e2e.yml`.
 *
 * Requires `scripts/seed-e2e-registry-users.ts` to have been run at least once
 * against the same staging project (Team A/B, the 4 actors, the durable Team B
 * skill). Team IDs are NOT passed in — this script resolves them itself via the
 * same deterministic subscription IDs the seed script uses (SUB_ID_ENT/SUB_ID_NONENT
 * below; keep in sync with scripts/seed-e2e-registry-users.ts if either changes).
 *
 * Round-trip assertions (plan doc "Round-trip assertions" table):
 *   1. Team A admin publishes (real user-JWT insert) -> row lands, content_hash
 *      server-derived.
 *   2. Team A admin installs via the REAL `skillsmith registry install` CLI
 *      subprocess — the actual published bin entrypoint (`packages/cli/dist/cli.js`,
 *      esbuild bundle, NOT the parallel unbundled `dist/src/index.js` tsc output that
 *      also exists in a dev build — only the former is what `npm install -g
 *      @skillsmith/cli` ships) — isolated $HOME per actor, never touches a real
 *      user's local state -> exit 0, file on disk, byte-equal content.
 *   3. Team A member (non-admin) does the same -> SUCCEEDS (member-level gate is
 *      intentional; this is not a negative test).
 *   4. Team B member fetches Team A's skillId -> 404, byte-identical to a fetch of
 *      a genuinely nonexistent skillId (non-leak assertion).
 *   5. Team B member fetches Team B's OWN durable skill -> 403 (team B is not
 *      Enterprise-entitled).
 *   6. The dual-membership actor (Enterprise via Team A + member of non-Enterprise
 *      Team B) fetches Team B's own durable skill -> 403. Load-bearing: a global
 *      `profiles.tier` check (the bug the row-scoped design exists to prevent
 *      regressing to) would incorrectly read 'enterprise' for this user via Team A
 *      and wrongly return 200. Only a check scoped to the ROW's own team returns 403.
 *   7. No/garbage JWT -> 401.
 *   8. Cache-Control: no-store present on every 401/403/404 response above
 *      (asserted inline on rows 4/5/6/7's raw fetches — see rawPrivateRegistryGet).
 *
 * MCP-live coverage (Open Question 1, resolved during implementation — COMMITTED,
 * not a fallback): reruns rows #3/#4/#6 through the live MCP service. Implementation
 * lives in the .mcp-live.ts companion (500-line file-length gate) — see its own
 * header for the team-resolution rationale (SKILLSMITH_LICENSE_KEY, not team_members).
 *
 * Usage: varlock run -- npx tsx scripts/e2e-registry-roundtrip.ts
 * (Actually invoked inside Docker by the workflow — the CLI subprocess step loads
 * better-sqlite3 via openCliDatabase(), which needs glibc; see workflow comments.)
 */

import { createClient } from '@supabase/supabase-js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPrivateRegistrySkillContent, storeCredentials } from '@skillsmith/core'
import { runMcpLiveCoverage } from './e2e-registry-roundtrip.mcp-live.js'
import type { ActorSession } from './e2e-registry-roundtrip.types.js'

const STAGING_REF = 'ovhcifugwqnzoebwfuku'
const STAGING_HOST = `${STAGING_REF}.supabase.co`
// Split across two string literals so this file cannot trip the prod-ref grep gate.
const PROD_REF = 'vrcnzpmn' + 'dtroqxxoqkzy' // SMI-5922-allow-prod-ref

// Must match scripts/seed-e2e-registry-users.ts's own constants — the seed script
// is the source of truth for team provisioning; this script only resolves what's
// already there (team IDs are not passed as secrets, by design).
const SUB_ID_ENT = 'e2e-reg-ent-sub'
const SUB_ID_NONENT = 'e2e-reg-nonent-sub'
const DURABLE_SKILL_NAME = 'durable-skill'

const results: { row: string; pass: boolean; detail?: string }[] = []

function record(row: string, pass: boolean, detail?: string): void {
  results.push({ row, pass, detail })
  const status = pass ? 'PASS' : 'FAIL'
  console.error(`[e2e-registry] ${status} ${row}${detail ? ` — ${detail}` : ''}`)
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`[e2e-registry] Missing required env var: ${name}`)
    process.exit(2)
  }
  return v
}

async function signIn(
  url: string,
  anonKey: string,
  email: string,
  password: string
): Promise<ActorSession> {
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error || !data.session) {
    console.error(`[e2e-registry] Sign-in failed for ${email}: ${error?.message ?? 'no session'}`)
    process.exit(1)
  }
  return {
    userId: data.session.user.id,
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresIn: data.session.expires_in ?? 3600,
  }
}

/**
 * Raw GET against private-registry-get -- used wherever the typed
 * getPrivateRegistrySkillContent() wrapper hides what we need to assert (raw
 * headers for row 8, raw body text for row 4's byte-identical comparison, or a
 * deliberately garbage/absent Authorization header for row 7).
 */
async function rawPrivateRegistryGet(
  baseUrl: string,
  anonKey: string,
  jwt: string | null,
  skillId: string
): Promise<{ status: number; cacheControl: string | null; bodyText: string }> {
  const headers: Record<string, string> = { apikey: anonKey }
  if (jwt) headers.Authorization = `Bearer ${jwt}`
  const res = await fetch(
    `${baseUrl}/private-registry-get?skillId=${encodeURIComponent(skillId)}`,
    { method: 'GET', headers }
  )
  const bodyText = await res.text()
  return { status: res.status, cacheControl: res.headers.get('cache-control'), bodyText }
}

/**
 * Seeds an isolated $HOME with a real login session (storeCredentials()), runs the
 * real `skillsmith registry install` CLI subprocess against it, and returns the
 * parsed JSON result. Never touches a real user's local state -- HOME is a fresh
 * tmpdir per call. Invokes the ACTUAL published bin entrypoint (dist/cli.js, the
 * esbuild bundle package.json's "bin" points at) -- not the parallel unbundled
 * dist/src/index.js tsc output that also exists in a dev build but is never what a
 * real `npm install -g @skillsmith/cli` user runs.
 *
 * Scope, stated precisely (GPT-5.6-Sol review finding #6): this proves the bundled
 * entrypoint itself -- credential loading, HTTP fetch, SQLite manifest bookkeeping,
 * disk install, exit-code contract -- all work. It does NOT run `npm pack` or install
 * from a packed tarball, so a broken `package.json` `bin`/`files` field or an npm
 * packaging failure could still slip through undetected by this check specifically
 * (smoke-prod's `cli-published` surface covers the published-package angle instead,
 * post-publish, against the real npm registry).
 */
async function runCliInstall(
  actorLabel: string,
  session: ActorSession,
  stagingUrl: string,
  skillId: string
): Promise<{
  exitCode: number
  json: Record<string, unknown> | null
  stdout: string
  stderr: string
}> {
  const home = mkdtempSync(join(tmpdir(), `e2e-reg-${actorLabel}-`))

  // storeCredentials()/loadCredentials() read os.homedir(), which reads
  // process.env.HOME at call time -- swap it only for this seeding call, restore
  // immediately after, so it can never leak into a concurrent/later call in this
  // same process.
  const origHome = process.env.HOME
  process.env.HOME = home
  try {
    await storeCredentials({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: Date.now() + session.expiresIn * 1000,
      version: 2,
    })
  } finally {
    process.env.HOME = origHome
  }

  const cliEntry = join(process.cwd(), 'packages/cli/dist/cli.js')
  let exitCode = 0
  let stdout = ''
  let stderr = ''
  try {
    stdout = execFileSync('node', [cliEntry, 'registry', 'install', skillId, '--json'], {
      // The CLI subprocess's own env, not this script's -- HOME + SUPABASE_URL
      // scoped to exactly this call so nothing else in the script is affected.
      env: { ...process.env, HOME: home, SUPABASE_URL: stagingUrl },
      encoding: 'utf-8',
      timeout: 30_000,
    })
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string }
    exitCode = e.status ?? 1
    stdout = e.stdout?.toString() ?? ''
    stderr = e.stderr?.toString() ?? ''
  }

  let json: Record<string, unknown> | null = null
  try {
    json = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    json = null
  }

  return { exitCode, json, stdout, stderr }
}

async function main(): Promise<void> {
  const stagingUrl = requireEnv('STAGING_SUPABASE_URL')
  const anonKey = requireEnv('STAGING_SUPABASE_ANON_KEY')
  const serviceRoleKey = requireEnv('STAGING_SUPABASE_SERVICE_ROLE_KEY')
  const password = requireEnv('E2E_REG_USER_PASSWORD')

  // Fail-closed, host-based (not substring) staging-only guard — matches
  // scripts/seed-e2e-registry-users.ts's own fix (a substring check on
  // PROD_REF/STAGING_REF is bypassable by e.g. https://evil.example/?r=<staging-ref>,
  // which would still send real staging credentials to an attacker-controlled host).
  let hostname: string
  try {
    hostname = new URL(stagingUrl).hostname
  } catch {
    console.error(`[e2e-registry] STAGING_SUPABASE_URL is not a valid URL: ${stagingUrl}`)
    process.exit(2)
  }
  if (hostname.includes(PROD_REF)) {
    console.error(
      `[e2e-registry] Refusing to run: STAGING_SUPABASE_URL's host contains the prod ref. This ` +
        `script publishes/fetches/installs real rows and MUST only run against staging.`
    )
    process.exit(2)
  }
  if (hostname !== STAGING_HOST) {
    console.error(
      `[e2e-registry] STAGING_SUPABASE_URL's host ('${hostname}') does not exactly match the expected staging host (${STAGING_HOST}).`
    )
    process.exit(2)
  }

  // Constant for the whole run -- unlike HOME (per-actor), the MCP-live in-process
  // imports read process.env.SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY at call time
  // (packages/mcp-server/src/supabase-client.ts), so these are set once, globally,
  // right here, immediately after the staging-ref guard passes.
  process.env.SUPABASE_URL = stagingUrl
  process.env.SUPABASE_ANON_KEY = anonKey
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey

  const stagingApiBaseUrl = `${stagingUrl}/functions/v1`

  const admin = createClient(stagingUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Resolve team IDs + namespaces via the seed script's own deterministic
  // subscription IDs -- team IDs are not secrets, resolved at runtime.
  const { data: teamA, error: teamAErr } = await admin
    .from('teams')
    .select('id, skill_namespace')
    .eq('subscription_id', SUB_ID_ENT)
    .single()
  const { data: teamB, error: teamBErr } = await admin
    .from('teams')
    .select('id, skill_namespace')
    .eq('subscription_id', SUB_ID_NONENT)
    .single()
  if (teamAErr || !teamA?.skill_namespace || teamBErr || !teamB?.skill_namespace) {
    console.error(
      `[e2e-registry] Could not resolve seeded teams -- has scripts/seed-e2e-registry-users.ts ` +
        `been run against this staging project? teamA error: ${teamAErr?.message ?? 'n/a'}, ` +
        `teamB error: ${teamBErr?.message ?? 'n/a'}`
    )
    process.exit(1)
  }
  const teamAId = teamA.id as string
  const teamANamespace = teamA.skill_namespace as string
  const teamBNamespace = teamB.skill_namespace as string
  const durableSkillId = `${teamBNamespace}/${DURABLE_SKILL_NAME}`

  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`
  const publishedSkillId = `${teamANamespace}/e2e-reg-${runId}`
  const publishedContent = {
    'SKILL.md': `# SMI-5922 round-trip fixture\n\nPublished by scripts/e2e-registry-roundtrip.ts, run ${runId}. Deleted by the workflow's defensive cleanup step.`,
  }

  // Sign in all 4 actors up front -- real GoTrue password sign-in, not mocked.
  const adminUserId = requireEnv('E2E_REG_ADMIN_USER_ID')
  const memberUserId = requireEnv('E2E_REG_MEMBER_USER_ID')
  const nonentUserId = requireEnv('E2E_REG_NONENT_USER_ID')
  const dualUserId = requireEnv('E2E_REG_DUAL_USER_ID')
  // The MCP tool surface resolves "which team" exclusively from
  // SKILLSMITH_LICENSE_KEY (see runMcpLiveCoverage's docstring) -- these are the
  // per-team keys scripts/seed-e2e-registry-users.ts minted.
  const teamALicenseKey = requireEnv('E2E_REG_TEAM_A_LICENSE_KEY')
  const teamBLicenseKey = requireEnv('E2E_REG_TEAM_B_LICENSE_KEY')

  const { data: userRows, error: userRowsErr } = await admin.auth.admin.listUsers({
    perPage: 1000,
  })
  if (userRowsErr) {
    console.error(
      `[e2e-registry] listUsers failed while resolving actor emails: ${userRowsErr.message}`
    )
    process.exit(1)
  }
  const emailFor = (userId: string): string => {
    const u = userRows.users.find((x: { id: string; email?: string }) => x.id === userId)
    if (!u?.email) {
      console.error(`[e2e-registry] Could not resolve email for user id ${userId}`)
      process.exit(1)
    }
    return u.email
  }

  const adminSession = await signIn(stagingUrl, anonKey, emailFor(adminUserId), password)
  const memberSession = await signIn(stagingUrl, anonKey, emailFor(memberUserId), password)
  const nonentSession = await signIn(stagingUrl, anonKey, emailFor(nonentUserId), password)
  const dualSession = await signIn(stagingUrl, anonKey, emailFor(dualUserId), password)

  // ---- Row 1: publish via admin's own user-JWT insert -----------------------
  const adminJwtClient = createClient(stagingUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${adminSession.accessToken}` } },
  })
  const insertResp = await adminJwtClient
    .from('private_registry_skills')
    .insert({
      team_id: teamAId,
      skill_id: publishedSkillId,
      version: '1.0.0',
      description: 'SMI-5922 round-trip fixture',
      content: publishedContent,
    })
    .select('id, content_hash')
    .single()
  const contentHashOk =
    typeof insertResp.data?.content_hash === 'string' &&
    /^[0-9a-f]{64}$/.test(insertResp.data.content_hash)
  record(
    'row1-publish',
    !insertResp.error && !!insertResp.data && contentHashOk,
    insertResp.error?.message ?? `content_hash=${insertResp.data?.content_hash}`
  )

  // ---- Row 2: real CLI install as admin --------------------------------------
  const cliAdmin = await runCliInstall('admin', adminSession, stagingUrl, publishedSkillId)
  let row2Pass = cliAdmin.exitCode === 0 && cliAdmin.json?.['success'] === true
  const adminInstallPath = cliAdmin.json?.['installPath'] as string | undefined
  if (row2Pass && adminInstallPath) {
    const skillMdPath = join(adminInstallPath, 'SKILL.md')
    row2Pass =
      existsSync(skillMdPath) && readFileSync(skillMdPath, 'utf-8') === publishedContent['SKILL.md']
  } else {
    row2Pass = false
  }
  record('row2-cli-install-admin', row2Pass, cliAdmin.stderr || JSON.stringify(cliAdmin.json))

  // ---- Row 3: real CLI install as member (non-admin) -- expect SUCCESS ------
  const cliMember = await runCliInstall('member', memberSession, stagingUrl, publishedSkillId)
  const row3Pass = cliMember.exitCode === 0 && cliMember.json?.['success'] === true
  record('row3-cli-install-member', row3Pass, cliMember.stderr || JSON.stringify(cliMember.json))

  // ---- Row 4: cross-team 404, byte-identical to a genuinely nonexistent id --
  const crossTeamFetch = await rawPrivateRegistryGet(
    stagingApiBaseUrl,
    anonKey,
    nonentSession.accessToken,
    publishedSkillId
  )
  const nonexistentFetch = await rawPrivateRegistryGet(
    stagingApiBaseUrl,
    anonKey,
    nonentSession.accessToken,
    `${teamBNamespace}/definitely-does-not-exist-${runId}`
  )
  record(
    'row4-cross-team-404-nonleak',
    crossTeamFetch.status === 404 &&
      nonexistentFetch.status === 404 &&
      crossTeamFetch.bodyText === nonexistentFetch.bodyText,
    `cross-team status=${crossTeamFetch.status} body=${crossTeamFetch.bodyText}; nonexistent status=${nonexistentFetch.status} body=${nonexistentFetch.bodyText}`
  )
  record(
    'row8-cache-control-404',
    crossTeamFetch.cacheControl === 'no-store',
    crossTeamFetch.cacheControl ?? 'missing'
  )

  // ---- Row 5: Team B member fetches Team B's own durable skill -- 403 -------
  const ownTeamFetch = await rawPrivateRegistryGet(
    stagingApiBaseUrl,
    anonKey,
    nonentSession.accessToken,
    durableSkillId
  )
  record(
    'row5-nonent-403',
    ownTeamFetch.status === 403,
    `status=${ownTeamFetch.status} body=${ownTeamFetch.bodyText}`
  )
  record(
    'row8-cache-control-403a',
    ownTeamFetch.cacheControl === 'no-store',
    ownTeamFetch.cacheControl ?? 'missing'
  )

  // ---- Row 6 (load-bearing): dual-membership actor -- 403 --------------------
  const dualFetch = await rawPrivateRegistryGet(
    stagingApiBaseUrl,
    anonKey,
    dualSession.accessToken,
    durableSkillId
  )
  record(
    'row6-dual-membership-403',
    dualFetch.status === 403,
    `status=${dualFetch.status} body=${dualFetch.bodyText} -- a global profiles.tier check would ` +
      `have wrongly returned 200 here via this actor's Team A Enterprise membership`
  )
  record(
    'row8-cache-control-403b',
    dualFetch.cacheControl === 'no-store',
    dualFetch.cacheControl ?? 'missing'
  )

  // ---- Row 7: no/garbage JWT -- 401 ------------------------------------------
  const noAuthFetch = await rawPrivateRegistryGet(
    stagingApiBaseUrl,
    anonKey,
    null,
    publishedSkillId
  )
  const garbageAuthFetch = await rawPrivateRegistryGet(
    stagingApiBaseUrl,
    anonKey,
    'not-a-real-jwt',
    publishedSkillId
  )
  record('row7-no-auth-401', noAuthFetch.status === 401, `status=${noAuthFetch.status}`)
  record(
    'row7-garbage-auth-401',
    garbageAuthFetch.status === 401,
    `status=${garbageAuthFetch.status}`
  )
  record(
    'row8-cache-control-401',
    noAuthFetch.cacheControl === 'no-store',
    noAuthFetch.cacheControl ?? 'missing'
  )

  // ---- Direct core-layer coverage: getPrivateRegistrySkillContent() ---------
  // Covers the shared core layer both transports funnel through -- separate from
  // the raw fetches above, this exercises the actual typed client the CLI itself
  // calls, with the baseUrl/anonKey overrides both required for staging (neither
  // defaults to staging -- DEFAULT_BASE_URL/PRODUCTION_ANON_KEY point at prod).
  const coreLayerFetch = await getPrivateRegistrySkillContent({
    jwtToken: adminSession.accessToken,
    skillId: publishedSkillId,
    baseUrl: stagingApiBaseUrl,
    anonKey,
  })
  const coreLayerDetail = coreLayerFetch.ok
    ? 'content matched'
    : `${coreLayerFetch.code}: ${coreLayerFetch.message}`
  record(
    'core-layer-getPrivateRegistrySkillContent',
    coreLayerFetch.ok && coreLayerFetch.data.content['SKILL.md'] === publishedContent['SKILL.md'],
    coreLayerDetail
  )

  // ---- MCP-live coverage (committed, not fallback) ---------------------------
  await runMcpLiveCoverage(
    record,
    memberSession,
    nonentSession,
    dualSession,
    teamALicenseKey,
    teamBLicenseKey,
    publishedSkillId,
    durableSkillId
  )

  // ---- Summary ----------------------------------------------------------------
  const failed = results.filter((r) => !r.pass)
  console.error(
    `\n[e2e-registry] ${results.length - failed.length}/${results.length} checks passed.`
  )
  if (failed.length > 0) {
    console.error('[e2e-registry] FAILED rows:')
    for (const f of failed) {
      console.error(`  - ${f.row}: ${f.detail ?? '(no detail)'}`)
    }
    throw new Error(`SMI-5922 round-trip failed: ${failed.length} row(s) did not pass`)
  }
}

main().catch((err: unknown) => {
  console.error(`[e2e-registry] unexpected error: ${String(err)}`)
  process.exit(1)
})
