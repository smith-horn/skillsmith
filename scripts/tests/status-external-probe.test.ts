/**
 * SMI-5756 (Wave 7, public status page) — integration tests for
 * scripts/status-external-probe.sh.
 *
 * Drives the bash script via spawnSync with:
 *   SKILLSMITH_STATUS_PROBE_TEST=1     — enables all test seams
 *   SKILLSMITH_STATUS_PROBE_CURL_CMD   — stub script deciding per-URL success/failure
 *   SKILLSMITH_STATUS_PROBE_GH_CMD     — capture-only `gh` stub (mirrors
 *                                        scripts/tests/_lib/liveness-fixtures.ts's
 *                                        createGhScript technique, extended here with
 *                                        a `view` branch this script's recovery/throttle
 *                                        paths need that the shared helper doesn't cover)
 *
 * ALL seams require SKILLSMITH_STATUS_PROBE_TEST=1 (mirrors retrieval-liveness's
 * convention — production can't be hijacked by a stray env var).
 *
 * Note on the "3 in-run attempts" retry loop: under SKILLSMITH_STATUS_PROBE_CURL_CMD,
 * check_url() calls the stub exactly ONCE and returns its exit code directly — the
 * real 3-attempt/15s-apart retry loop is the *else* branch, deliberately bypassed by
 * the seam (a live 30s-worst-case sleep has no place in a unit test). That loop's
 * shape is covered by a static-source assertion below instead, the same tradeoff
 * retrieval-liveness-check.test.ts's "tsx unavailable guard (M3)" case documents for
 * an analogous not-exercisable-via-seam branch.
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureTempDir } from './_lib/git-fixture-env.js'

// ── Constants ──────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'status-external-probe.sh')
const SUPABASE_URL = 'https://vrcnzpmndtroqxxoqkzy.supabase.co/functions/v1/status-public'
const API_URL = 'https://api.skillsmith.app/functions/v1/status-public'

// ── Fixture helpers ────────────────────────────────────────────────────────────

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

function makeHome(): string {
  const d = makeFixtureTempDir('status-probe-bash-test')
  tmpDirs.push(d)
  return d
}

/**
 * Stub for the check_url() curl seam. Decides success/failure per-URL by
 * matching on a substring of the URL argument the real script passes in
 * ($1 to this script), so tests never need to override the prod URLs.
 */
function createCurlScript(
  home: string,
  opts: { rawOk: boolean; apiOk: boolean }
): { scriptPath: string; captureFile: string } {
  const captureFile = join(home, 'curl-calls.log')
  const script = [
    '#!/bin/bash',
    `printf '%s\\n' "url:$1" >> "${captureFile}"`,
    'case "$1" in',
    `  *supabase.co*) exit ${opts.rawOk ? 0 : 1} ;;`,
    `  *api.skillsmith.app*) exit ${opts.apiOk ? 0 : 1} ;;`,
    '  *) exit 1 ;;',
    'esac',
  ].join('\n')
  const scriptPath = join(home, 'fake-curl.sh')
  writeFileSync(scriptPath, script, { mode: 0o755 })
  return { scriptPath, captureFile }
}

/**
 * Capture-only `gh` stub, extended beyond createGhScript's list/create/comment
 * cases with a `view` branch (this script reads --json createdAt on recovery
 * and --json comments for the 55-min re-comment throttle — neither of which
 * the shared retrieval-liveness fixture needs).
 */
function createStatusGhScript(
  home: string,
  opts: { existingIssueNum?: number; createdAt?: string; lastCommentAt?: string } = {}
): { scriptPath: string; captureFile: string } {
  const captureFile = join(home, 'gh-calls.log')
  const { existingIssueNum, createdAt, lastCommentAt } = opts
  const listBranch =
    existingIssueNum != null ? `  list) printf '%d\\n' "${existingIssueNum}" ;;` : '  list) ;;'
  const script = [
    '#!/bin/bash',
    `printf '%s\\n' "cmd:$*" >> "${captureFile}"`,
    'case "$2" in',
    listBranch,
    '  view)',
    '    case "$*" in',
    `      *"--json comments"*) printf '%s\\n' "${lastCommentAt ?? ''}" ;;`,
    `      *"--json createdAt"*) printf '%s\\n' "${createdAt ?? ''}" ;;`,
    '      *) ;;',
    '    esac',
    '    ;;',
    `  create) printf 'https://github.com/o/r/issues/42\\n' ;;`,
    '  comment) ;;',
    '  close) ;;',
    '  label) ;;',
    'esac',
  ].join('\n')
  const scriptPath = join(home, 'fake-gh.sh')
  writeFileSync(scriptPath, script, { mode: 0o755 })
  return { scriptPath, captureFile }
}

interface RunResult {
  status: number
  stdout: string
}

function runScript(extraEnv: Record<string, string> = {}): RunResult {
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
      SKILLSMITH_STATUS_PROBE_TEST: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  })
  return { status: result.status ?? 1, stdout: (result.stdout ?? '') + (result.stderr ?? '') }
}

function ghCalls(captureFile: string): string[] {
  if (!existsSync(captureFile)) return []
  return readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean)
}

function countCmd(captureFile: string, cmd: string): number {
  return ghCalls(captureFile).filter((l) => l.includes(`cmd:issue ${cmd}`)).length
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('healthy', () => {
  it('exits 0, no mutating gh calls, when no issue is open', () => {
    const home = makeHome()
    const { scriptPath: curlPath } = createCurlScript(home, { rawOk: true, apiOk: true })
    const { scriptPath: ghPath, captureFile } = createStatusGhScript(home)
    const result = runScript({
      SKILLSMITH_STATUS_PROBE_CURL_CMD: curlPath,
      SKILLSMITH_STATUS_PROBE_GH_CMD: ghPath,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('healthy: both URLs OK')
    expect(countCmd(captureFile, 'create')).toBe(0)
    expect(countCmd(captureFile, 'comment')).toBe(0)
    expect(countCmd(captureFile, 'close')).toBe(0)
  })

  it('auto-closes an open outage issue with a recovery comment', () => {
    const home = makeHome()
    const { scriptPath: curlPath } = createCurlScript(home, { rawOk: true, apiOk: true })
    const { scriptPath: ghPath, captureFile } = createStatusGhScript(home, {
      existingIssueNum: 7,
      createdAt: '2026-07-25T00:00:00Z',
    })
    const result = runScript({
      SKILLSMITH_STATUS_PROBE_CURL_CMD: curlPath,
      SKILLSMITH_STATUS_PROBE_GH_CMD: ghPath,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('closed recovered issue #7')
    expect(countCmd(captureFile, 'comment')).toBe(1)
    expect(countCmd(captureFile, 'close')).toBe(1)
    const calls = readFileSync(captureFile, 'utf8')
    expect(calls).toContain('Recovered')
  })
})

describe('proxy-only degradation', () => {
  it('exits 2 and makes zero gh calls', () => {
    const home = makeHome()
    const { scriptPath: curlPath } = createCurlScript(home, { rawOk: true, apiOk: false })
    const { scriptPath: ghPath, captureFile } = createStatusGhScript(home)
    const result = runScript({
      SKILLSMITH_STATUS_PROBE_CURL_CMD: curlPath,
      SKILLSMITH_STATUS_PROBE_GH_CMD: ghPath,
    })
    expect(result.status).toBe(2)
    expect(result.stdout).toContain('proxy-only failure')
    expect(existsSync(captureFile)).toBe(false)
  })
})

describe('shadow mode (default)', () => {
  it('logs [shadow] WOULD and makes zero gh calls', () => {
    const home = makeHome()
    const { scriptPath: curlPath } = createCurlScript(home, { rawOk: false, apiOk: false })
    const { scriptPath: ghPath, captureFile } = createStatusGhScript(home)
    const result = runScript({
      SKILLSMITH_STATUS_PROBE_CURL_CMD: curlPath,
      SKILLSMITH_STATUS_PROBE_GH_CMD: ghPath,
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('[shadow] WOULD open/comment issue')
    expect(existsSync(captureFile)).toBe(false)
  })
})

describe('confirmed outage (SHADOW=0)', () => {
  it('creates exactly one issue when none is open', () => {
    const home = makeHome()
    const { scriptPath: curlPath } = createCurlScript(home, { rawOk: false, apiOk: false })
    const { scriptPath: ghPath, captureFile } = createStatusGhScript(home)
    const result = runScript({
      SKILLSMITH_STATUS_PROBE_CURL_CMD: curlPath,
      SKILLSMITH_STATUS_PROBE_GH_CMD: ghPath,
      SKILLSMITH_STATUS_EXTERNAL_PROBE_SHADOW: '0',
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('CONFIRMED OUTAGE')
    expect(countCmd(captureFile, 'create')).toBe(1)
  })

  it('comments on an already-open issue rather than duplicating', () => {
    const home = makeHome()
    const { scriptPath: curlPath } = createCurlScript(home, { rawOk: false, apiOk: false })
    const { scriptPath: ghPath, captureFile } = createStatusGhScript(home, {
      existingIssueNum: 9,
      lastCommentAt: '2026-07-20T00:00:00Z', // long ago — outside the 55-min throttle
    })
    const result = runScript({
      SKILLSMITH_STATUS_PROBE_CURL_CMD: curlPath,
      SKILLSMITH_STATUS_PROBE_GH_CMD: ghPath,
      SKILLSMITH_STATUS_EXTERNAL_PROBE_SHADOW: '0',
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('existing outage issue #9 still open')
    expect(countCmd(captureFile, 'create')).toBe(0)
    expect(countCmd(captureFile, 'comment')).toBe(1)
    expect(readFileSync(captureFile, 'utf8')).toContain('Still down')
  })

  it('skips the re-comment when the last one was under 55 minutes ago', () => {
    const home = makeHome()
    const { scriptPath: curlPath } = createCurlScript(home, { rawOk: false, apiOk: false })
    const recent = new Date(Date.now() - 5 * 60_000).toISOString() // 5 min ago
    const { scriptPath: ghPath, captureFile } = createStatusGhScript(home, {
      existingIssueNum: 9,
      lastCommentAt: recent,
    })
    const result = runScript({
      SKILLSMITH_STATUS_PROBE_CURL_CMD: curlPath,
      SKILLSMITH_STATUS_PROBE_GH_CMD: ghPath,
      SKILLSMITH_STATUS_EXTERNAL_PROBE_SHADOW: '0',
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('existing outage issue #9 still open')
    expect(countCmd(captureFile, 'comment')).toBe(0)
    expect(countCmd(captureFile, 'create')).toBe(0)
  })
})

describe('kill switch', () => {
  it('exits 0 immediately, attempts zero probes and zero gh calls', () => {
    const home = makeHome()
    const { scriptPath: curlPath, captureFile: curlCalls } = createCurlScript(home, {
      rawOk: true,
      apiOk: true,
    })
    const { scriptPath: ghPath, captureFile: ghCallsFile } = createStatusGhScript(home)
    const result = runScript({
      SKILLSMITH_STATUS_PROBE_CURL_CMD: curlPath,
      SKILLSMITH_STATUS_PROBE_GH_CMD: ghPath,
      SKILLSMITH_STATUS_EXTERNAL_PROBE_DISABLE: '1',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('skip: disabled')
    expect(existsSync(curlCalls)).toBe(false)
    expect(existsSync(ghCallsFile)).toBe(false)
  })
})

describe('audit_logs write (best-effort)', () => {
  it('a failed write does not change the exit code or skip the alert branch', () => {
    const home = makeHome()
    const { scriptPath: curlPath } = createCurlScript(home, { rawOk: false, apiOk: false })
    const result = runScript({
      SKILLSMITH_STATUS_PROBE_CURL_CMD: curlPath,
      // Port 1 refuses instantly — a real (unstubbed) curl call to it fails fast,
      // deterministically, without a network round-trip or the 5s max-time budget.
      SUPABASE_URL: 'http://127.0.0.1:1',
      SUPABASE_SERVICE_ROLE_KEY: 'fake-test-key',
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('audit_logs write failed (non-fatal')
    expect(result.stdout).toContain('[shadow] WOULD open/comment issue')
  })
})

describe('static source invariants', () => {
  let src: string
  beforeAll(() => {
    src = readFileSync(SCRIPT, 'utf8')
  })

  it('all test seams require SKILLSMITH_STATUS_PROBE_TEST=1 master switch', () => {
    expect(src).toContain('SKILLSMITH_STATUS_PROBE_GH_CMD')
    expect(src).toContain('SKILLSMITH_STATUS_PROBE_CURL_CMD')
    const codeOnly = src
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    const matches = [...codeOnly.matchAll(/SKILLSMITH_STATUS_PROBE_(GH_CMD|CURL_CMD)/g)]
    expect(matches.length).toBeGreaterThan(0)
    for (const m of matches) {
      const idx = m.index ?? 0
      const context = codeOnly.slice(Math.max(0, idx - 200), idx)
      expect(context).toMatch(/PROBE_TEST/)
    }
  })

  it('the real (non-seam) retry loop is 3 attempts, 15s apart', () => {
    expect(src).toContain('for attempt in 1 2 3')
    expect(src).toContain('sleep 15')
  })

  it('the critical alert path never references SUPABASE_URL or the service-role key', () => {
    // Structural proof of the plan's core invariant: gh issue create/comment/close
    // calls must have zero dependency on a Supabase call succeeding.
    const alertSection = src.slice(src.indexOf('# --- 6. Confirmed outage path'))
    expect(alertSection).not.toMatch(/SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY/)
  })

  it('never probes the staging Supabase ref', () => {
    // The staging ref legitimately appears once, by name, in a header-comment
    // warning not to use it (CLAUDE.md SMI-4252 rule) — assert it never appears
    // as an actual URL (the pattern a real probe target would take).
    expect(src).not.toMatch(/https:\/\/ovhcifugwqnzoebwfuku\.supabase\.co/)
    expect(src).toContain(SUPABASE_URL)
    expect(src).toContain(API_URL)
  })
})
