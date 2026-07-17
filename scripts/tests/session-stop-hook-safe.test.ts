/**
 * SMI-5712 retro follow-up: tests for scripts/session-stop-hook-safe.sh.
 *
 * Drives the script against a fabricated `$CLAUDE_PROJECT_DIR` containing a
 * stub `node_modules/ruflo/bin/ruflo.js` — never the real ruflo binary, which
 * is the very thing this wrapper exists to bound. Each fixture stub is a tiny
 * Node script controlling its own exit timing so the reap/no-reap paths are
 * deterministic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { makeFixtureTempDir } from './_lib/git-fixture-env'

const SCRIPT = join(__dirname, '..', 'session-stop-hook-safe.sh')

function writeStub(projectDir: string, body: string) {
  const binDir = join(projectDir, 'node_modules', 'ruflo', 'bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'ruflo.js'), body)
}

function runHook(projectDir: string, extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, HOME: projectDir, ...extraEnv },
    encoding: 'utf8',
  })
}

describe('session-stop-hook-safe.sh', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = makeFixtureTempDir('stop-hook-safe')
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('exits 0 well before the reap timeout when the underlying command finishes on its own', () => {
    // Regression guard: an earlier version wrapped the watchdog's `sleep` in
    // an extra `( sleep N; kill ... ) &` subshell. Killing the subshell's PID
    // didn't kill the `sleep` it forked as ITS OWN child, so the orphaned
    // sleep kept the inherited stdout/stderr pipe open for the FULL
    // REAP_TIMEOUT_SECS regardless of how fast the real command exited — a
    // caller reading this script's output via a pipe (spawnSync, exactly how
    // Claude Code itself invokes hook commands) saw no EOF until then. This
    // asserts the happy path is fast, not merely "eventually returns".
    writeStub(projectDir, 'process.exit(0)')
    const start = Date.now()
    const result = runHook(projectDir, { SKILLSMITH_STOP_HOOK_REAP_SECS: '20' })
    const elapsed = Date.now() - start
    expect(result.status).toBe(0)
    expect(elapsed).toBeLessThan(3000)
  })

  it('reaps a hanging process after the bounded timeout instead of hanging forever', () => {
    // Never exits on its own — the exact SMI-5712 failure mode.
    writeStub(projectDir, 'setInterval(() => {}, 1000)')
    const start = Date.now()
    const result = runHook(projectDir, { SKILLSMITH_STOP_HOOK_REAP_SECS: '1' })
    const elapsed = Date.now() - start
    expect(result.status).toBe(0)
    expect(elapsed).toBeGreaterThanOrEqual(900)
    expect(elapsed).toBeLessThan(5000)
  })

  it('prunes log files older than the retention window before writing a new one', () => {
    writeStub(projectDir, 'process.exit(0)')
    const logDir = join(projectDir, '.skillsmith', 'logs')
    mkdirSync(logDir, { recursive: true })
    const staleLog = join(logDir, 'ruflo-session-end-111.log')
    writeFileSync(staleLog, 'old')
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    utimesSync(staleLog, eightDaysAgo, eightDaysAgo)

    runHook(projectDir, { SKILLSMITH_STOP_HOOK_LOG_RETENTION_DAYS: '7' })

    const remaining = readdirSync(logDir)
    expect(remaining).not.toContain('ruflo-session-end-111.log')
  })

  it('does not prune a log file within the retention window', () => {
    writeStub(projectDir, 'process.exit(0)')
    const logDir = join(projectDir, '.skillsmith', 'logs')
    mkdirSync(logDir, { recursive: true })
    const freshLog = join(logDir, 'ruflo-session-end-222.log')
    writeFileSync(freshLog, 'recent')

    runHook(projectDir, { SKILLSMITH_STOP_HOOK_LOG_RETENTION_DAYS: '7' })

    const remaining = readdirSync(logDir)
    expect(remaining).toContain('ruflo-session-end-222.log')
  })
})
