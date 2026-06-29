/**
 * SMI-5426 W0.1 — integration tests for scripts/retrieval-autoheal.sh.
 *
 * Drives the bash orchestrator via spawnSync with:
 *   SKILLSMITH_AUTOHEAL_TEST=1   — enables the probe/repair/install/lock seams
 *   SKILLSMITH_AUTOHEAL_HOME     — unique per-test tmp dir (never touches ~/.skillsmith)
 *
 * Heal-path + lock tests run EVERYWHERE (incl. the CI container) via the
 * FORCE_NON_DOCKER seam (runHeal) so the core invariants are covered exactly
 * where CI runs vitest. The mkdir-lock suite additionally forces the mkdir path
 * (runMkdirLock / FORCE_MKDIR_LOCK) so the NON-evicting reclaim logic gets CI
 * coverage even on a flock-equipped host. A separate flock suite runs only where
 * flock exists. bash passes its resolved MAIN_REPO to the state CLI via --key,
 * so the test + script agree on the state key in every environment.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'
import {
  ATTEMPT_CAP,
  resolveMainRepoKey,
  type AutohealEntry,
} from '../../packages/doc-retrieval-mcp/src/retrieval-log/autoheal-state.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'retrieval-autoheal.sh')
const SCRIPT_DIR = resolve(__dirname, '..')

/**
 * The main-repo key the bash script writes state under. Mirrors the bash
 * MAIN_REPO chain (git worktree list → rev-parse → parent dir) so it is NEVER
 * empty and tests assert non-vacuously even where `git worktree list` fails
 * (e.g. a worktree's .git pointing outside a container). bash passes this exact
 * value to the state CLI via --key, so test + script always agree.
 */
function resolveExpectedKey(): string {
  const viaWorktree = resolveMainRepoKey(SCRIPT_DIR)
  if (viaWorktree) return viaWorktree
  try {
    return execFileSync('git', ['-C', SCRIPT_DIR, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim()
  } catch {
    /* fall through to the parent-dir fallback */
  }
  return resolve(SCRIPT_DIR, '..')
}
const MAIN_REPO_KEY = resolveExpectedKey()

/**
 * True when the `flock` command is available (Linux/CI). The dedicated flock
 * suite runs only here; the mkdir suite forces the mkdir path regardless.
 */
const hasFlock = spawnSync('bash', ['-c', 'command -v flock'], { encoding: 'utf8' }).status === 0

// ── Cleanup tracking ──────────────────────────────────────────────────────────

const tmpDirs: string[] = []
const bgProcs: ReturnType<typeof spawn>[] = []

afterEach(() => {
  for (const proc of bgProcs.splice(0)) {
    try {
      proc.kill()
    } catch {
      /* best-effort */
    }
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

function makeHome(): string {
  const d = makeFixtureTempDir('autoheal-bash-test')
  tmpDirs.push(d)
  return d
}

// ── Run helpers ───────────────────────────────────────────────────────────────

interface RunResult {
  status: number
  log: string
  stdout: string
  stderr: string
}

function baseEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...makeFixtureEnv(),
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    SKILLSMITH_AUTOHEAL_TEST: '1',
    SKILLSMITH_AUTOHEAL_HOME: home,
    ...extra,
  }
}

function runScript(
  home: string,
  extraEnv: Record<string, string> = {},
  args: string[] = []
): RunResult {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: baseEnv(home, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  })
  // Read the day's log by glob, NOT by computing the date: the script names the
  // file with LOCAL `date +%Y-%m-%d`, so a UTC-derived name would mismatch after
  // local midnight crosses into the next UTC day (and vice-versa). Each test uses
  // a fresh tmp HOME, so there is at most one such file.
  const logsDir = join(home, '.skillsmith', 'logs')
  let log = ''
  try {
    log = readdirSync(logsDir)
      .filter((f) => f.startsWith('retrieval-autoheal-') && f.endsWith('.log'))
      .map((f) => readFileSync(join(logsDir, f), 'utf8'))
      .join('')
  } catch {
    /* log dir may not exist for early exits */
  }
  return {
    status: result.status ?? 1,
    log,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/**
 * Heal-path runner: forces the script PAST the Docker no-op so the heal logic
 * executes inside the CI container (where /.dockerenv exists). On a flock host
 * (Linux/CI) this exercises the flock path; on macOS (no flock) the mkdir path.
 */
function runHeal(
  home: string,
  extraEnv: Record<string, string> = {},
  args: string[] = []
): RunResult {
  return runScript(home, { SKILLSMITH_AUTOHEAL_FORCE_NON_DOCKER: '1', ...extraEnv }, args)
}

/**
 * mkdir-lock runner: forces BOTH past the Docker guard AND the macOS mkdir-lock
 * path (even on a flock-equipped CI host), so the no-live-eviction reclaim logic
 * gets real CI coverage instead of host-only coverage.
 */
function runMkdirLock(home: string, extraEnv: Record<string, string> = {}): RunResult {
  return runScript(home, {
    SKILLSMITH_AUTOHEAL_FORCE_NON_DOCKER: '1',
    SKILLSMITH_AUTOHEAL_FORCE_MKDIR_LOCK: '1',
    ...extraEnv,
  })
}

function statePath(home: string): string {
  return join(home, '.skillsmith', 'retrieval-autoheal.state')
}

function lockDir(home: string): string {
  return join(home, '.skillsmith', 'retrieval-autoheal.lock')
}

function pidFile(home: string): string {
  return join(lockDir(home), 'pid')
}

function readStateFile(home: string): Record<string, AutohealEntry> {
  try {
    return JSON.parse(readFileSync(statePath(home), 'utf8')) as Record<string, AutohealEntry>
  } catch {
    return {}
  }
}

function writeStateEntry(home: string, key: string, entry: AutohealEntry): void {
  const dir = join(home, '.skillsmith')
  mkdirSync(dir, { recursive: true })
  writeFileSync(statePath(home), JSON.stringify({ [key]: entry }, null, 2) + '\n', 'utf8')
}

// ── Static-source assertions ──────────────────────────────────────────────────

describe('static-source assertions', () => {
  const src = readFileSync(SCRIPT, 'utf8')

  it('contains nohup in the launch comment', () => {
    expect(src).toContain('nohup')
  })

  it('does NOT contain setsid', () => {
    expect(src).not.toContain('setsid')
  })

  it('does NOT contain disown', () => {
    expect(src).not.toContain('disown')
  })

  it('parses the worktree path with sed (space-safe), not space-truncating awk (retro Low-1)', () => {
    expect(src).toContain("sed -n 's/^worktree //p'")
    expect(src).not.toMatch(/worktree list[^\n]*awk '\/\^worktree \/\{print \$2/)
  })

  it('strips ANSI with a literal-ESC form portable to BSD sed, not GNU-only \\x1b (retro Low-2)', () => {
    expect(src).toContain('strip_ansi()')
    // No ACTIVE sed command may use the GNU-only \x1b escape (a comment may
    // still mention it to explain why it's avoided).
    expect(src).not.toMatch(/sed[^\n]*\\x1b/)
  })

  it('real probe uses better-sqlite3', () => {
    expect(src).toContain('better-sqlite3')
  })

  it('real repair calls repair-host-native-deps.sh', () => {
    expect(src).toContain('repair-host-native-deps.sh')
  })

  it('probe seam is gated by SKILLSMITH_AUTOHEAL_TEST', () => {
    // The probe seam checks AUTOHEAL_TEST before using PROBE_CMD
    const probeBlock = src.match(/probe_binding\(\)[^}]*\}/s)?.[0] ?? ''
    expect(probeBlock).toContain('AUTOHEAL_TEST')
    expect(probeBlock).toContain('SKILLSMITH_AUTOHEAL_PROBE_CMD')
  })

  it('install-detector seam is gated by SKILLSMITH_AUTOHEAL_TEST', () => {
    const detectorBlock = src.match(/foreign_install_running\(\)[^}]*\}/s)?.[0] ?? ''
    expect(detectorBlock).toContain('AUTOHEAL_TEST')
    expect(detectorBlock).toContain('SKILLSMITH_AUTOHEAL_FORCE_INSTALL')
  })

  it('repair seam is gated by SKILLSMITH_AUTOHEAL_TEST', () => {
    expect(src).toContain('SKILLSMITH_AUTOHEAL_REPAIR_CMD')
    // Verify it's inside the AUTOHEAL_TEST=1 guard
    const repairIdx = src.indexOf('SKILLSMITH_AUTOHEAL_REPAIR_CMD')
    const guardIdx = src.lastIndexOf('AUTOHEAL_TEST', repairIdx)
    expect(guardIdx).toBeGreaterThan(0)
  })
})

// ── --print-banner mode ───────────────────────────────────────────────────────
// This mode exits BEFORE the Docker check so it works everywhere.

describe('--print-banner mode', () => {
  it('healthy binding → empty stdout', () => {
    const home = makeHome()
    const { stdout } = runScript(home, { SKILLSMITH_AUTOHEAL_PROBE_CMD: 'true' }, [
      '--print-banner',
    ])
    expect(stdout.trim()).toBe('')
  })

  it('broken binding + no state → stdout contains "first run launched" + disable var', () => {
    const home = makeHome()
    // Only run if tsx is available (needed for run_state_cli banner)
    const { stdout } = runScript(home, { SKILLSMITH_AUTOHEAL_PROBE_CMD: 'false' }, [
      '--print-banner',
    ])
    expect(stdout).toContain('first run launched')
    expect(stdout).toContain('SKILLSMITH_RETRIEVAL_AUTOHEAL_DISABLE=1')
  })

  it('broken binding + pre-written fail state → stdout contains "failed:" + disable var', () => {
    const home = makeHome()
    const failEntry: AutohealEntry = {
      lastAttemptEpoch: Math.floor(Date.now() / 1000) - 60,
      consecutiveFailures: 1,
      lastVerdict: 'fail',
      lastFailureReason: 'test module missing',
    }
    writeStateEntry(home, MAIN_REPO_KEY, failEntry)
    const { stdout } = runScript(home, { SKILLSMITH_AUTOHEAL_PROBE_CMD: 'false' }, [
      '--print-banner',
    ])
    expect(stdout).toContain('failed:')
    expect(stdout).toContain('SKILLSMITH_RETRIEVAL_AUTOHEAL_DISABLE=1')
  })
})

// ── Early-exit checks: disable + docker ──────────────────────────────────────
// Disable check (step 1) fires BEFORE the Docker check, so it works in Docker.
// Docker check test works everywhere (/.dockerenv also present in Docker).

describe('early-exit checks', () => {
  it('disable: SKILLSMITH_RETRIEVAL_AUTOHEAL_DISABLE=1 → log "skip: disabled"', () => {
    const home = makeHome()
    const { log } = runScript(home, {
      SKILLSMITH_RETRIEVAL_AUTOHEAL_DISABLE: '1',
      SKILLSMITH_AUTOHEAL_PROBE_CMD: 'false',
    })
    expect(log).toContain('skip: disabled')
    // No REPAIR_CMD should have been created (no state writes either)
    expect(existsSync(statePath(home))).toBe(false)
  })

  it('docker: IS_DOCKER=true → log "skip: inside Docker"', () => {
    const home = makeHome()
    const { log } = runScript(home, {
      IS_DOCKER: 'true',
      SKILLSMITH_AUTOHEAL_PROBE_CMD: 'false',
    })
    expect(log).toContain('skip: inside Docker')
  })
})

// ── Heal-path tests ───────────────────────────────────────────────────────────
// Run EVERYWHERE (incl. the CI container) via the FORCE_NON_DOCKER seam, so the
// core heal/cooldown/cap/detector logic is covered exactly where CI runs vitest.
// On a flock host (Linux/CI) these exercise the flock lock path; on macOS the
// mkdir path. The dedicated mkdir + flock lock suites below pin each path.

describe('heal path', () => {
  it('healthy: PROBE_CMD=true → log "skip: binding healthy"; no lock dir; no state', () => {
    const home = makeHome()
    const { log } = runHeal(home, { SKILLSMITH_AUTOHEAL_PROBE_CMD: 'true' })
    expect(log).toContain('skip: binding healthy')
    expect(existsSync(lockDir(home))).toBe(false)
    expect(existsSync(statePath(home))).toBe(false)
  })

  it('heal success: repair creates the probe file → log "heal: success"; state ok', () => {
    const home = makeHome()
    const fixedFile = join(home, 'binding-fixed')
    const { log } = runHeal(home, {
      SKILLSMITH_AUTOHEAL_PROBE_CMD: `test -f ${fixedFile}`,
      SKILLSMITH_AUTOHEAL_REPAIR_CMD: `touch ${fixedFile}`,
    })
    expect(log).toContain('heal: success')
    const state = readStateFile(home)
    expect(state[MAIN_REPO_KEY]).toBeDefined()
    expect(state[MAIN_REPO_KEY].lastVerdict).toBe('ok')
    expect(state[MAIN_REPO_KEY].consecutiveFailures).toBe(0)
  })

  it('heal fail: PROBE_CMD=false, REPAIR_CMD fails → log "heal: FAILED"; state cf=1', () => {
    const home = makeHome()
    const { log } = runHeal(home, {
      SKILLSMITH_AUTOHEAL_PROBE_CMD: 'false',
      SKILLSMITH_AUTOHEAL_REPAIR_CMD: 'echo "Error: toolchain missing" >&2; exit 1',
    })
    expect(log).toContain('heal: FAILED')
    const state = readStateFile(home)
    expect(state[MAIN_REPO_KEY]).toBeDefined()
    expect(state[MAIN_REPO_KEY].consecutiveFailures).toBe(1)
    expect(state[MAIN_REPO_KEY].lastVerdict).toBe('fail')
    expect(state[MAIN_REPO_KEY].lastFailureReason).toContain('toolchain missing')
  })

  it('heal fail with no "Error:" line → reason falls back to last output line', () => {
    // Exercises extract_reason()'s awk last-line fallback (no grep "Error:" hit).
    const home = makeHome()
    const { log } = runHeal(home, {
      SKILLSMITH_AUTOHEAL_PROBE_CMD: 'false',
      SKILLSMITH_AUTOHEAL_REPAIR_CMD: 'echo "build toolchain absent"; exit 3',
    })
    expect(log).toContain('heal: FAILED')
    const reason = readStateFile(home)[MAIN_REPO_KEY]?.lastFailureReason ?? ''
    expect(reason).toContain('build toolchain absent')
  })

  it('heal fail → second run → log "defer: in cooldown"; REPAIR not re-run', () => {
    const home = makeHome()
    const ranFile = join(home, 'RAN')
    // First run: fail
    runHeal(home, {
      SKILLSMITH_AUTOHEAL_PROBE_CMD: 'false',
      SKILLSMITH_AUTOHEAL_REPAIR_CMD: `echo "Error: toolchain missing" >&2; exit 1`,
    })
    // Second run: should be in cooldown
    const { log } = runHeal(home, {
      SKILLSMITH_AUTOHEAL_PROBE_CMD: 'false',
      SKILLSMITH_AUTOHEAL_REPAIR_CMD: `touch ${ranFile}`,
    })
    expect(log).toContain('defer: in cooldown')
    expect(existsSync(ranFile)).toBe(false)
  })

  it('attempt cap: pre-written cf=ATTEMPT_CAP → log "hold: attempt cap"; REPAIR not run', () => {
    const home = makeHome()
    const ranFile = join(home, 'RAN')
    const cappedEntry: AutohealEntry = {
      lastAttemptEpoch: Math.floor(Date.now() / 1000) - 10,
      consecutiveFailures: ATTEMPT_CAP,
      lastVerdict: 'fail',
      lastFailureReason: 'persistent failure',
    }
    writeStateEntry(home, MAIN_REPO_KEY, cappedEntry)
    const { log } = runHeal(home, {
      SKILLSMITH_AUTOHEAL_PROBE_CMD: 'false',
      SKILLSMITH_AUTOHEAL_REPAIR_CMD: `touch ${ranFile}`,
    })
    expect(log).toContain('hold: attempt cap reached')
    expect(existsSync(ranFile)).toBe(false)
  })

  it('install detector: SKILLSMITH_AUTOHEAL_FORCE_INSTALL=1 → "defer: concurrent npm install"', () => {
    const home = makeHome()
    const ranFile = join(home, 'RAN')
    const { log } = runHeal(home, {
      SKILLSMITH_AUTOHEAL_PROBE_CMD: 'false',
      SKILLSMITH_AUTOHEAL_FORCE_INSTALL: '1',
      SKILLSMITH_AUTOHEAL_REPAIR_CMD: `touch ${ranFile}`,
    })
    expect(log).toContain('defer: concurrent npm install/build detected')
    expect(existsSync(ranFile)).toBe(false)
  })

  it('docker no-op is NOT bypassed without the seam: IS_DOCKER=true still skips', () => {
    // Defense-in-depth: FORCE_NON_DOCKER only fires under AUTOHEAL_TEST=1; the
    // real Docker guard must still hold for an explicit IS_DOCKER=true with no seam.
    const home = makeHome()
    const { log } = runScript(home, {
      IS_DOCKER: 'true',
      SKILLSMITH_AUTOHEAL_PROBE_CMD: 'false',
    })
    expect(log).toContain('skip: inside Docker')
  })
})

// ── mkdir lock path ─────────────────────────────────────────────────────────
// Pinned to the macOS mkdir-lock path via FORCE_MKDIR_LOCK so the NON-evicting
// reclaim logic gets real CI coverage (CI is Linux+flock; without the seam it
// would take the flock path and never exercise mkdir reclaim).

describe('mkdir lock path', () => {
  it('lock no-eviction: live pid holder → log "defer: lock held by live pid"; REPAIR not run', () => {
    const home = makeHome()
    const ranFile = join(home, 'RAN')

    // Create the lock dir and write a live pid (use our own process as the "holder")
    mkdirSync(lockDir(home), { recursive: true })
    const startEpoch = Math.floor(Date.now() / 1000)
    writeFileSync(pidFile(home), `${process.pid} ${startEpoch}\n`, 'utf8')

    const { log } = runMkdirLock(home, {
      SKILLSMITH_AUTOHEAL_PROBE_CMD: 'false',
      SKILLSMITH_AUTOHEAL_REPAIR_CMD: `touch ${ranFile}`,
    })
    expect(log).toContain('defer: lock held by live pid')
    expect(existsSync(ranFile)).toBe(false)
    // Cleanup lock dir (test left it, not the script)
    rmSync(lockDir(home), { recursive: true, force: true })
  })

  it('lock reclaim dead holder: dead pid in pid file → reclaim → heal succeeds', () => {
    const home = makeHome()
    const fixedFile = join(home, 'fixed')

    // Spawn a short-lived process, wait for it to exit, then use its (now-dead) PID
    const deadProc = spawnSync('true', [], { encoding: 'utf8' })
    const deadPid = deadProc.pid ?? 99999999

    mkdirSync(lockDir(home), { recursive: true })
    const oldEpoch = Math.floor(Date.now() / 1000) - 5
    writeFileSync(pidFile(home), `${deadPid} ${oldEpoch}\n`, 'utf8')

    const { log } = runMkdirLock(home, {
      SKILLSMITH_AUTOHEAL_PROBE_CMD: `test -f ${fixedFile}`,
      SKILLSMITH_AUTOHEAL_REPAIR_CMD: `touch ${fixedFile}`,
    })
    expect(log).toContain('reclaiming')
    expect(log).toContain('heal: success')
    expect(existsSync(fixedFile)).toBe(true)
  })

  it('lock T_max backstop: live pid but epoch > T_MAX → reclaim → heal succeeds', () => {
    const home = makeHome()
    const fixedFile = join(home, 'fixed2')

    // Use our own PID (alive) but write a start epoch well past T_MAX (1800s) so
    // the staleness backstop fires (3600s > T_MAX). A truly slow-but-live rebuild
    // under T_MAX is intentionally NOT evicted (audit M1).
    mkdirSync(lockDir(home), { recursive: true })
    const staleEpoch = Math.floor(Date.now() / 1000) - 3600
    writeFileSync(pidFile(home), `${process.pid} ${staleEpoch}\n`, 'utf8')

    const { log } = runMkdirLock(home, {
      SKILLSMITH_AUTOHEAL_PROBE_CMD: `test -f ${fixedFile}`,
      SKILLSMITH_AUTOHEAL_REPAIR_CMD: `touch ${fixedFile}`,
    })
    expect(log).toContain('reclaiming')
    expect(log).toContain('heal: success')
    expect(existsSync(fixedFile)).toBe(true)
    // Cleanup lock (reclaim should have done it; be safe)
    rmSync(lockDir(home), { recursive: true, force: true })
  })

  it('TOCTOU grace: lock dir exists but no pid file → reclaim after grace → heal succeeds', () => {
    const home = makeHome()
    const fixedFile = join(home, 'fixed3')

    // Create the lock DIR but NOT the pid file — simulates a crash between mkdir and write
    mkdirSync(lockDir(home), { recursive: true })

    const { log } = runMkdirLock(home, {
      SKILLSMITH_AUTOHEAL_PROBE_CMD: `test -f ${fixedFile}`,
      SKILLSMITH_AUTOHEAL_REPAIR_CMD: `touch ${fixedFile}`,
    })
    // Script waits T_GRACE_MS (2000ms) then reclaims
    expect(log).toMatch(/reclaiming|heal: success/)
  }, 8_000) // 2s grace + buffer
})

// ── flock lock path ───────────────────────────────────────────────────────────
// Runs only where flock exists (Linux/CI). Verifies the flock holder is deferred
// (never evicted) — flock auto-releases on holder exit, so there is no reclaim.

describe.skipIf(!hasFlock)('flock lock path', () => {
  it('flock held by another → log "defer: flock held"; REPAIR not run', async () => {
    const home = makeHome()
    const ranFile = join(home, 'RAN')
    const flockFile = join(home, '.skillsmith', 'retrieval-autoheal.flock')
    const heldMarker = join(home, '.skillsmith', 'HELD')
    mkdirSync(join(home, '.skillsmith'), { recursive: true })

    // Background holder: grab the flock, signal readiness, hold for 30s.
    const holder = spawn(
      'bash',
      ['-c', `exec 9>"${flockFile}"; flock 9; touch "${heldMarker}"; sleep 30`],
      { stdio: 'ignore' }
    )
    bgProcs.push(holder)

    // Wait until the holder has actually acquired the flock.
    const deadline = Date.now() + 5000
    while (!existsSync(heldMarker) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(existsSync(heldMarker)).toBe(true)

    const { log } = runHeal(home, {
      SKILLSMITH_AUTOHEAL_PROBE_CMD: 'false',
      SKILLSMITH_AUTOHEAL_REPAIR_CMD: `touch ${ranFile}`,
    })
    expect(log).toContain('defer: flock held')
    expect(existsSync(ranFile)).toBe(false)
  }, 15_000)
})
