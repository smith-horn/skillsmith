/**
 * e2e-registry-roundtrip.helpers.ts
 *
 * SMI-5922 — standalone HTTP/CLI-subprocess helpers for e2e-registry-roundtrip.ts, split
 * out to stay under the 500-line file-length gate (audit:standards).
 */

import { createClient } from '@supabase/supabase-js'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storeCredentials } from '@skillsmith/core'
import type { ActorSession } from './e2e-registry-roundtrip.types.js'

/**
 * Seeds an isolated $HOME with a real login session (storeCredentials()) for the
 * duration of `fn`, then restores $HOME — the in-process-call sibling of
 * {@link runCliInstall}'s isolated-HOME seeding, for callers that invoke a
 * `dist/` import directly in THIS process rather than spawning a CLI subprocess.
 *
 * SMI-5949 D-7 (pr-reviewer PR-12 finding, plan finding H1): `private_registry_publish`
 * now runs as `getMemberUserClient('publish')`, which resolves the caller's identity via
 * `resolveUserAccessToken()` -> `loadCredentials()` -> `os.homedir()` -> `process.env.HOME`
 * at CALL time — not merely at process start. `runCliInstall` restores `HOME` right after
 * seeding because its subprocess gets `HOME` explicitly in its own `env`; an in-process
 * call has no such subprocess boundary, so `HOME` must stay swapped for the full duration
 * of `fn`, not just the write. `SKILLSMITH_LICENSE_KEY` no longer being sufficient on its
 * own is exactly the plan's H1 finding ("audit internal tooling for license-key-only
 * `private_registry_publish` usage and migrate it before Wave 2 merges") — this script was
 * the one unmigrated hit.
 */
export async function withUserCredentials<T>(
  session: ActorSession,
  fn: () => Promise<T>
): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'e2e-reg-inproc-'))
  const origHome = process.env.HOME
  process.env.HOME = home
  try {
    await storeCredentials({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: Date.now() + session.expiresIn * 1000,
      version: 2,
    })
    return await fn()
  } finally {
    process.env.HOME = origHome
  }
}

export async function signIn(
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
export async function rawPrivateRegistryGet(
  baseUrl: string,
  anonKey: string,
  jwt: string | null,
  skillId: string
): Promise<{ status: number; cacheControl: string | null; bodyText: string }> {
  const headers: Record<string, string> = { apikey: anonKey }
  if (jwt) headers.Authorization = `Bearer ${jwt}`
  const res = await fetch(
    `${baseUrl}/private-registry-get?skillId=${encodeURIComponent(skillId)}`,
    {
      method: 'GET',
      headers,
    }
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
export async function runCliInstall(
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

/**
 * Approves a pending private-registry submission via the real
 * `private_registry_manage {action:'approve'}` handler, authenticated as the given
 * (admin/owner) session -- split out of the main script to stay under the 500-line
 * file-length gate.
 *
 * SMI-5949 D-4/D-7 (pr-reviewer PR-12 finding): a fresh `publish` now lands `pending`
 * and is invisible on every read surface until a team admin/owner approves it -- this
 * is the missing step between the main script's row 1 (publish) and its rows
 * 2/3/mcp-live-row3, which install/read the just-published skill immediately after
 * publish with no approval step of their own. Uses the same dist/ import + isolated
 * SKILLSMITH_LICENSE_KEY/HOME-credential pattern as row 1's own publish call
 * (`withUserCredentials()` above) -- the approver must differ from the publisher
 * (D-6 blocks self-approval), so callers pass an admin/owner session, never the
 * publisher's own.
 */
export async function approvePendingSubmission(
  adminSession: ActorSession,
  licenseKey: string,
  skillId: string,
  version: string
): Promise<{ success: boolean; error?: string }> {
  const mod = (await import('../packages/mcp-server/dist/src/tools/registry-tools.js')) as {
    executePrivateRegistryManage: (
      input: { action: 'approve'; skillId: string; version: string },
      context: unknown
    ) => Promise<{ success: boolean; error?: string }>
  }
  const contextMod = (await import('../packages/mcp-server/dist/src/context.js')) as {
    createToolContext: (options?: { dbPath?: string }) => unknown
    closeToolContext: (context: unknown) => Promise<void>
  }

  const origLicenseKey = process.env.SKILLSMITH_LICENSE_KEY
  const toolContext = contextMod.createToolContext({ dbPath: ':memory:' })
  try {
    process.env.SKILLSMITH_LICENSE_KEY = licenseKey
    return await withUserCredentials(adminSession, () =>
      mod.executePrivateRegistryManage({ action: 'approve', skillId, version }, toolContext)
    )
  } finally {
    if (origLicenseKey === undefined) {
      delete process.env.SKILLSMITH_LICENSE_KEY
    } else {
      process.env.SKILLSMITH_LICENSE_KEY = origLicenseKey
    }
    await contextMod.closeToolContext(toolContext)
  }
}
