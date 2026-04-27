/**
 * device-login-roundtrip.spec.ts
 *
 * SMI-4460 — prod-parity device-code login round-trip.
 *
 * Single Playwright test that exercises the FULL stack against staging
 * Supabase (no mocks for the surfaces under test):
 *
 *   1. Spawn `skillsmith login --no-browser` as a child process,
 *   2. Parse user_code from stdout (strip-ANSI + boxed regex),
 *   3. Snapshot device_codes row from the DB so afterEach can clean up,
 *   4. Sign the test user in via supabase-js → transplant session into the page,
 *   5. Navigate browser to /device?user_code=…, wait for state-preview,
 *   6. Click Approve (#btn-approve) → wait for state-approved,
 *   7. Wait for CLI to exit 0 with `Logged in successfully` in stdout,
 *   8. Cross-validate the post-login hint subcommand against `--help` (B3 protection),
 *   9. Assert device_codes.consumed_at IS NOT NULL (B2 protection),
 *  10. Assert audit_logs row with event_type='auth:device_code:consumed' exists.
 *
 * Catches B1 (relative URL), B2 (claim_device_token ambiguity), B3 (nonexistent
 * post-login command) in a single run — see SMI-4454 retro lesson #5.
 *
 * Staging-only: STAGING_SUPABASE_URL must contain `ovhcifugwqnzoebwfuku`.
 * Helpers/config refuse to boot if the prod project ref appears in the URL.
 */

import { test, expect } from '@playwright/test'
import {
  spawnCli,
  parseUserCode,
  assertCommandExists,
  registeredCliCommands,
  injectRealSupabase,
  signInTestUser,
  queryDeviceCode,
  cleanupDeviceCode,
  queryAuditLogConsumed,
  tmpdirForThisRun,
  cleanupAllTmpdirs,
  dumpCliLogs,
  type CliHandle,
  type CliExitResult,
} from './device-login-roundtrip.helpers'
import { getConfig } from './device-login-roundtrip.config'

test.describe('SMI-4460 — Device-code login round-trip (staging)', () => {
  let userCode: string | undefined
  let deviceCode: string | undefined
  let cli: CliHandle | undefined
  let result: CliExitResult | undefined

  // SMI-4495: CLI flow test — iPhone viewport (mobile, WebKit) provides no
  // additional coverage and the CI runner only installs Chromium
  // (`npx playwright install chromium`), so mobile fails immediately with
  // `webkit-2272/pw_run.sh: Executable doesn't exist`. Scope to desktop only.
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'SMI-4495: CLI login flow runs on desktop project only'
    )
  })

  test.afterEach(async ({}, testInfo) => {
    // SMI-4506: dump CLI logs unconditionally. Previously this only ran
    // when `result` was set (i.e. waitForExit completed), which meant a
    // hang BEFORE the polling phase produced no CLI evidence at all —
    // exactly when we need it most. Snapshot the buffered streams instead.
    if (result) dumpCliLogs(testInfo.testId, result)
    else if (cli) dumpCliLogs(testInfo.testId, cli.snapshot())
    if (deviceCode) {
      try {
        await cleanupDeviceCode(deviceCode)
      } catch (err) {
        // Cleanup failure shouldn't mask a test failure; log only.
        // eslint-disable-next-line no-console
        console.error(`[SMI-4460 CLEANUP-WARN] device_code=${deviceCode}: ${String(err)}`)
      }
    }
    if (cli && !cli.exited) await cli.kill()
    cleanupAllTmpdirs()
    userCode = undefined
    deviceCode = undefined
    cli = undefined
    result = undefined
  })

  test('CLI login + browser approve + claim => CLI exits 0 with valid hint', async ({ page }) => {
    test.setTimeout(120_000) // 2-min budget per Wave 4 §Timeout discipline

    const cfg = getConfig()

    // ─── 1. Spawn CLI as child process ───
    const tmp = tmpdirForThisRun()
    cli = spawnCli({
      args: ['login', '--no-browser'],
      env: {
        ...process.env,
        // Point CLI's getApiBaseUrl() at the staging Supabase functions host.
        SKILLSMITH_API_URL: `${cfg.supabaseUrl}/functions/v1`,
        // Isolate config dir so a previous login on the runner cannot
        // short-circuit the "Already authenticated" branch (login.ts:308).
        SKILLSMITH_CONFIG_DIR: tmp,
        // Force non-TTY / headless branches in the CLI.
        CI: 'true',
      },
    })

    // ─── 2. Parse user_code from stdout ───
    userCode = await parseUserCode(cli.stdout, { timeoutMs: 30_000 })
    expect(userCode).toMatch(/^[A-Z0-9]{8}$/)

    // ─── 3. Capture device_code from DB so afterEach can clean up ───
    const initialRow = await queryDeviceCode({ userCode })
    expect(initialRow).not.toBeNull()
    deviceCode = initialRow!.device_code

    // ─── 4. Drive browser through approve flow ───
    await injectRealSupabase(page, { url: cfg.supabaseUrl, anonKey: cfg.supabaseAnonKey })
    await signInTestUser(page, { email: cfg.testUserEmail, password: cfg.testUserPassword })

    await page.goto(`${cfg.websiteBaseUrl}/device?user_code=${userCode}`)

    // The /device page calls auth-device-preview from the URL-prefilled code path.
    // B1 protection: the ORIGINAL bug made this 404 because the URL was relative —
    // the assertion would have failed because state-preview would never become visible.
    await expect(page.locator('#state-preview')).toBeVisible({ timeout: 15_000 })

    // Click Approve. Calls auth-device-approve → approve_device_code RPC.
    await page.locator('#btn-approve').click()

    // Approved confirmation visible.
    await expect(page.locator('#state-approved')).toBeVisible({ timeout: 15_000 })

    // ─── 5. Wait for CLI to complete ───
    // CLI is polling auth-device-token every 5s. Worst case ≈ 12 polls.
    result = await cli.waitForExit({ timeoutMs: 60_000 })

    // ─── 6. Assert CLI output ───
    expect(result.code, `CLI stderr: ${result.stderr.slice(0, 500)}`).toBe(0)
    expect(result.stdout).toMatch(/Logged in successfully/i)

    // Extract the post-login hint (B3 shape).
    const hintMatch = result.stdout.match(/Try it:\s+skillsmith\s+(\S+)/)
    expect(hintMatch, `Stdout did not contain hint: ${result.stdout.slice(-500)}`).not.toBeNull()
    const hintSubcommand = hintMatch![1]

    // ─── 7. Cross-validate hint against the actual command surface (B3 protection) ───
    // TWO-SOURCE check: the registered list + a `<cmd> --help` exit-0 probe.
    await assertCommandExists({ cliPath: cli.path, cmd: hintSubcommand })

    // Diagnostic surface kept handy: registered list still asserted via positive match.
    const registered = await registeredCliCommands({ cliPath: cli.path })
    expect(registered).toContain(hintSubcommand)

    // ─── 8. Assert DB invariants (B2 protection) ───
    // claim_device_token must have run successfully → consumed_at set.
    const claimedRow = await queryDeviceCode({ userCode })
    expect(claimedRow).not.toBeNull()
    expect(claimedRow!.consumed_at).not.toBeNull()
    expect(claimedRow!.user_id).toBe(cfg.testUserId)

    // ─── 9. Audit log invariant: claim_device_token writes the consumed event ───
    const auditRow = await queryAuditLogConsumed({
      userId: cfg.testUserId,
      sinceMs: 5 * 60_000,
    })
    expect(auditRow, 'audit_logs row for auth:device_code:consumed not found').not.toBeNull()
    expect(auditRow!.event_type).toBe('auth:device_code:consumed')
  })
})
