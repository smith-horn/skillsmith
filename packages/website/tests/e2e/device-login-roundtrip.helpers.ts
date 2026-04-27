/**
 * device-login-roundtrip.helpers.ts
 *
 * SMI-4460 — process / parse / Supabase / cleanup helpers for the device-login
 * round-trip e2e. Kept distinct from `complete-profile.helpers.ts` because
 * THIS suite intentionally bypasses the stub and talks to real staging
 * Supabase (the whole point — see retro lesson #5: "mocks lie consistently").
 *
 * Helper signatures track the SMI-4460 plan §Wave 3 contract:
 *   - spawnCli({args, env}): CliHandle with stdout/stderr/waitForExit/kill
 *   - parseUserCode(stdout, {timeoutMs}): strip-ANSI before regex (plan-review fix #11)
 *   - assertCommandExists({cliPath, cmd}): TWO-SOURCE validation (plan-review fix #3)
 *   - registeredCliCommands({cliPath}): diagnostic helper, kept exported
 *   - injectRealSupabase(page, {url, anonKey})
 *   - signInTestUser(page, {email, password})
 *   - queryDeviceCode({userCode}), cleanupDeviceCode(deviceCode)
 *   - queryAuditLogConsumed({userId, sinceMs}): metadata->>'user_id' only
 *     (audit_logs has no user_id column — see CLAUDE.md memory
 *     `feedback_audit_logs_no_user_id_column.md`).
 *   - tmpdirForThisRun(): os.tmpdir() + mkdtemp; afterEach cleanup expected
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { createInterface } from 'node:readline'
import stripAnsi from 'strip-ansi'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Page } from '@playwright/test'
import { getConfig } from './device-login-roundtrip.config'

import { withTimeout, STAGING_CALL_TIMEOUT_MS } from './device-login-roundtrip.timeout'

// ─── Process management ───────────────────────────────────────────────────

export interface CliExitResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface CliHandle {
  path: string
  env: NodeJS.ProcessEnv
  stdout: Readable
  stderr: Readable
  exited: boolean
  /** Resolves when the child exits (or when timeoutMs elapses → SIGTERM). */
  waitForExit(opts: { timeoutMs: number }): Promise<CliExitResult>
  /**
   * Snapshot the buffered stdout/stderr without waiting for exit. Lets
   * `afterEach` dump CLI output when the test hung BEFORE `waitForExit()`
   * was called — the case where SMI-4506 lost evidence.
   */
  snapshot(): { stdout: string; stderr: string }
  /** SIGTERM, then SIGKILL after 5s. Idempotent. */
  kill(): Promise<void>
}

interface SpawnCliOpts {
  args: string[]
  env?: NodeJS.ProcessEnv
}

/**
 * Spawn `node <cliPath> <...args>`. cliPath comes from the resolved config
 * (CLI_PATH env, set in the workflow to the freshly-built dist).
 *
 * stdout / stderr are exposed as Readable streams; waitForExit accumulates
 * the captured strings so callers can assert against them post-exit.
 */
export function spawnCli(opts: SpawnCliOpts): CliHandle {
  const cfg = getConfig()
  const env = opts.env ?? { ...process.env }
  const child: ChildProcessWithoutNullStreams = spawn('node', [cfg.cliPath, ...opts.args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c))
  child.stderr.on('data', (c: Buffer) => stderrChunks.push(c))

  let exitedFlag = false
  const exitPromise = new Promise<{ code: number | null }>((resolve) => {
    child.on('exit', (code) => {
      exitedFlag = true
      resolve({ code })
    })
  })

  const handle: CliHandle = {
    path: cfg.cliPath,
    env,
    stdout: child.stdout,
    stderr: child.stderr,
    get exited() {
      return exitedFlag
    },
    snapshot() {
      return {
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      }
    },
    async waitForExit({ timeoutMs }) {
      const timeout = new Promise<{ code: number | null }>((resolve) => {
        setTimeout(() => resolve({ code: null }), timeoutMs)
      })
      const result = await Promise.race([exitPromise, timeout])
      if (result.code === null && !exitedFlag) {
        // Timeout — terminate so the test runner can move on.
        await handle.kill()
      }
      return {
        code: result.code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      }
    },
    async kill() {
      if (exitedFlag) return
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          if (!exitedFlag) child.kill('SIGKILL')
          resolve()
        }, 5_000)
        child.on('exit', () => {
          clearTimeout(t)
          resolve()
        })
      })
    },
  }
  return handle
}

// ─── Stdout parsing ───────────────────────────────────────────────────────

// CLI prints the boxed code via renderCodeBox (login.ts:50-56). We read the
// inner line, strip the unicode box chars, strip-ANSI (chalk wraps in cyan),
// strip dashes/whitespace, and validate it matches an 8-char alnum code.
//
// strip-ANSI is plan-review fix #11; we use the strip-ansi npm package
// (already hoisted at top-level node_modules; CJS export). Avoids stuffing
// raw escape sequences into source.

const CODE_RE = /│\s*([A-Z0-9]{4})-?([A-Z0-9]{4})\s*│/

/**
 * Drain `stdout` line-by-line until the boxed user_code appears, or
 * timeoutMs elapses.
 */
export async function parseUserCode(
  stdout: Readable,
  opts: { timeoutMs: number }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: stdout })
    const timer = setTimeout(() => {
      rl.removeAllListeners('line')
      rl.close()
      reject(new Error(`[SMI-4460] parseUserCode timed out after ${opts.timeoutMs}ms`))
    }, opts.timeoutMs)

    rl.on('line', (raw) => {
      const line = stripAnsi(raw)
      const m = line.match(CODE_RE)
      if (m) {
        clearTimeout(timer)
        rl.removeAllListeners('line')
        rl.close()
        resolve(`${m[1]}${m[2]}`)
      }
    })
    rl.on('close', () => clearTimeout(timer))
  })
}

// ─── CLI command surface validation (TWO-SOURCE — B3 protection) ─────────

/**
 * Spawn `node <cliPath> --help` and parse Commander's "Commands:" block.
 * Used as one input to assertCommandExists; kept exported for diagnostic
 * messages / debugging from inside the spec on failure.
 */
export async function registeredCliCommands(opts: { cliPath: string }): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [opts.cliPath, '--help'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`[SMI-4460] '${opts.cliPath} --help' exited ${code}`))
        return
      }
      const out = stripAnsi(Buffer.concat(chunks).toString('utf8'))
      // Commander format: a "Commands:" header followed by indented "<name> [args]   description"
      const lines = out.split('\n')
      const idx = lines.findIndex((l) => /^Commands:\s*$/i.test(l))
      const cmds: string[] = []
      if (idx >= 0) {
        for (let i = idx + 1; i < lines.length; i++) {
          const l = lines[i]
          if (!l.startsWith(' ') && l.trim().length > 0) break
          const trimmed = l.trim()
          if (trimmed.length === 0) continue
          // Take the first whitespace-delimited token as the command name.
          // Commander prints `<name> [<args>]  <desc>`; first word is what we want.
          const name = trimmed.split(/\s+/)[0]
          if (name && name !== 'help') cmds.push(name)
        }
      }
      resolve(cmds)
    })
  })
}

/**
 * TWO-SOURCE validation per plan-review fix #3 — both must pass:
 *   1. `node <cliPath> <cmd> --help` exits 0 (Commander rejects unknown commands)
 *   2. <cmd> appears in the Commands: section of `--help`
 * Diverging results = surface drift; throw with both diagnostics.
 */
export async function assertCommandExists(opts: { cliPath: string; cmd: string }): Promise<void> {
  const [help1, registered] = await Promise.all([
    new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn('node', [opts.cliPath, opts.cmd, '--help'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const errChunks: Buffer[] = []
      child.stderr.on('data', (c: Buffer) => errChunks.push(c))
      child.on('exit', (code) =>
        resolve({ code, stderr: Buffer.concat(errChunks).toString('utf8') })
      )
    }),
    registeredCliCommands({ cliPath: opts.cliPath }),
  ])

  const helpOk = help1.code === 0
  const listOk = registered.includes(opts.cmd)
  if (!helpOk || !listOk) {
    throw new Error(
      `[SMI-4460] assertCommandExists FAILED for cmd="${opts.cmd}" — ` +
        `helpExitCode=${help1.code} (expected 0), ` +
        `inHelpCommands=${listOk} (registered=${JSON.stringify(registered)}). ` +
        `stderr: ${help1.stderr.slice(0, 500)}`
    )
  }
}

// ─── Real Supabase fixtures (page side) ──────────────────────────────────

/**
 * Inject `__SUPABASE_CONFIG__` pointing at REAL staging. Mirrors the
 * `injectSupabaseStub` shape from complete-profile.helpers.ts but does NOT
 * route page traffic — fetches go to the real staging Supabase host.
 */
export async function injectRealSupabase(
  page: Page,
  opts: { url: string; anonKey: string }
): Promise<void> {
  await page.addInitScript(
    ({ url, anonKey }) => {
      ;(window as unknown as Record<string, unknown>).__SUPABASE_CONFIG__ = { url, anonKey }
    },
    { url: opts.url, anonKey: opts.anonKey }
  )
}

/**
 * Sign the test user in via supabase-js inside the page context. The
 * resulting session is persisted to localStorage by supabase-js so the
 * subsequent /device load boots authenticated.
 */
export async function signInTestUser(
  page: Page,
  opts: { email: string; password: string }
): Promise<void> {
  // Bootstrap a Supabase session by hitting auth/v1/token directly from
  // node, then transplant the session into the browser's localStorage. This
  // avoids needing supabase-js loaded in a blank page and the resulting
  // CORS/init dance.
  const cfg = getConfig()
  const admin = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await withTimeout(
    admin.auth.signInWithPassword({
      email: opts.email,
      password: opts.password,
    }),
    STAGING_CALL_TIMEOUT_MS,
    'signInTestUser/signInWithPassword'
  )
  if (error || !data.session) {
    throw new Error(`[SMI-4460] signInTestUser failed: ${error?.message ?? 'no session'}`)
  }
  const session = data.session
  // Compute the localStorage key supabase-js v2 uses for persistence.
  // Key shape: sb-<project-ref>-auth-token. Project ref = the URL host's first label.
  const ref = new URL(cfg.supabaseUrl).hostname.split('.')[0]
  const storageKey = `sb-${ref}-auth-token`
  // Push into localStorage BEFORE any page navigation completes so
  // getSupabaseClient() sees the session on first read.
  await page.addInitScript(
    ({ key, value }) => {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        /* localStorage may be unavailable in some test contexts */
      }
    },
    {
      key: storageKey,
      value: JSON.stringify({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        expires_in: session.expires_in,
        token_type: session.token_type,
        user: session.user,
      }),
    }
  )
}

// ─── DB queries (service-role) ───────────────────────────────────────────

let _admin: SupabaseClient | null = null
function admin(): SupabaseClient {
  if (_admin) return _admin
  const cfg = getConfig()
  _admin = createClient(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return _admin
}

export interface DeviceCodeRow {
  device_code: string
  user_code: string
  user_id: string | null
  approved_at: string | null
  consumed_at: string | null
  expires_at: string
  client_type: string | null
}

export async function queryDeviceCode(opts: { userCode: string }): Promise<DeviceCodeRow | null> {
  const { data, error } = await withTimeout(
    admin()
      .from('device_codes')
      .select('device_code,user_code,user_id,approved_at,consumed_at,expires_at,client_type')
      // CLI strips dash + uppercases; DB stores raw; normalise both sides.
      .eq('user_code', opts.userCode.replace(/-/g, '').toUpperCase())
      .maybeSingle(),
    STAGING_CALL_TIMEOUT_MS,
    'queryDeviceCode'
  )
  if (error) throw new Error(`[SMI-4460] queryDeviceCode: ${error.message}`)
  return (data as DeviceCodeRow | null) ?? null
}

export async function cleanupDeviceCode(deviceCode: string): Promise<void> {
  const { error } = await withTimeout(
    admin().from('device_codes').delete().eq('device_code', deviceCode),
    STAGING_CALL_TIMEOUT_MS,
    'cleanupDeviceCode'
  )
  if (error) throw new Error(`[SMI-4460] cleanupDeviceCode: ${error.message}`)
}

export interface AuditLogRow {
  id: string
  event_type: string
  metadata: Record<string, unknown>
  created_at: string
}

/**
 * Audit-log query with the user_id filter expressed via metadata only.
 *
 * IMPORTANT: audit_logs has no user_id column (per CLAUDE.md memory
 * `feedback_audit_logs_no_user_id_column.md`). User identity is stored as
 * metadata->>'user_id'. This helper enforces the discipline so the
 * implementation cannot drift to `audit_logs.user_id`.
 */
export async function queryAuditLogConsumed(opts: {
  userId: string
  sinceMs: number
}): Promise<AuditLogRow | null> {
  const since = new Date(Date.now() - opts.sinceMs).toISOString()
  const { data, error } = await withTimeout(
    admin()
      .from('audit_logs')
      .select('id,event_type,metadata,created_at')
      .eq('event_type', 'auth:device_code:consumed')
      .contains('metadata', { user_id: opts.userId })
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1),
    STAGING_CALL_TIMEOUT_MS,
    'queryAuditLogConsumed'
  )
  if (error) throw new Error(`[SMI-4460] queryAuditLogConsumed: ${error.message}`)
  return ((data?.[0] as AuditLogRow | undefined) ?? null) as AuditLogRow | null
}

// ─── Run-scoped tmpdir ───────────────────────────────────────────────────

const _tmpDirs: string[] = []

/**
 * Allocate a per-test tmpdir. Caller is responsible for cleanup via
 * `cleanupAllTmpdirs()` in afterEach (see spec) — keeps CI runner FS quiet.
 */
export function tmpdirForThisRun(): string {
  const dir = mkdtempSync(join(tmpdir(), 'smi-4460-'))
  _tmpDirs.push(dir)
  return dir
}

export function cleanupAllTmpdirs(): void {
  while (_tmpDirs.length > 0) {
    const d = _tmpDirs.pop()!
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* swallow — best effort, OS will reap on next boot */
    }
  }
}

// ─── CLI log capture (plan-review fix #10) ───────────────────────────────

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'

/**
 * Write captured stdout/stderr to test-results so uploaded artifacts include
 * them on failure. Workflow's artifact upload step globs
 * `test-results/cli-*.log`.
 *
 * SMI-4506: accepts either a completed `CliExitResult` (preferred — includes
 * exit code) OR a `{ stdout, stderr }` snapshot from `cli.snapshot()` for
 * the case where the test hung BEFORE `waitForExit()` ran. The
 * `inFlight` flag in the dump output makes the difference visible to the
 * reader.
 */
export function dumpCliLogs(
  testId: string,
  source: CliExitResult | { stdout: string; stderr: string }
): void {
  const dir = 'test-results'
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return
    }
  }
  const isExitResult = 'code' in source
  const header = isExitResult
    ? `--- exit ${(source as CliExitResult).code} ---`
    : `--- in-flight snapshot (waitForExit not reached — likely SMI-4506 hang) ---`
  try {
    writeFileSync(
      join(dir, `cli-${testId}.log`),
      `${header}\n--- stdout ---\n${source.stdout}\n--- stderr ---\n${source.stderr}\n`
    )
  } catch {
    /* swallow */
  }
}
