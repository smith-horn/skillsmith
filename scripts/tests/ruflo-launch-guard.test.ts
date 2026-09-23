/**
 * scripts/tests/ruflo-launch-guard.test.ts -- SMI-6744 A1.4, ADR-170 §§ 4, 7.
 *
 * Exercises scripts/ruflo-launch-guard.mjs, the per-spawn guard
 * scripts/mcp-ruflo-launcher.sh pipes into `docker exec -i <svc> node -`
 * immediately before it execs the real ruflo server. The guard reads
 * /proc/<pid>/stat, which does not exist on macOS -- this suite is written
 * to run in the ruflo service container (Linux) or in CI, and SKIPS
 * cleanly, printing why, everywhere else (this host session's own
 * `npx vitest run` of this file is expected to report the skip reason, not
 * a pass, on macOS/Darwin -- that is the honest never-ran state, not a
 * green result).
 *
 * All six arms use a real temp cwd with `.claude-flow/policy` and `.swarm`
 * pre-created (what scripts/ruflo-service-entrypoint.sh does at container
 * start) and a real file for RUFLO_GUARD_CLI_PATH so the entrypoint
 * realpath check passes. RUFLO_GUARD_TEST_HOLD_MS (guard-side test seam,
 * documented in the guard's own header) is used ONLY by the contention arm,
 * to widen the window deterministically instead of relying on timing luck.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD_PATH = fileURLToPath(new URL('../ruflo-launch-guard.mjs', import.meta.url))
const isLinux = process.platform === 'linux'
const skipReason = isLinux
  ? ''
  : `skipped: no /proc on ${process.platform} -- this suite requires Linux (the ruflo service container or CI)`

/** field 22 (starttime) of /proc/<pid>/stat, mirroring the guard's own extraction. */
function readStartTime(pid: number): string {
  const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const close = raw.lastIndexOf(')')
  const rest = raw
    .slice(close + 2)
    .trim()
    .split(/\s+/)
  return rest[19]
}

function makeCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ruflo-guard-test-'))
  mkdirSync(join(dir, '.claude-flow', 'policy'), { recursive: true })
  mkdirSync(join(dir, '.swarm'), { recursive: true })
  return dir
}

function makeCliPath(cwd: string): string {
  const p = join(cwd, 'fake-cli.js')
  writeFileSync(p, '// fixture\n')
  return p
}

/**
 * Runs the guard against `cwd`; never throws -- returns {status, stdout, stderr}.
 * spawnSync, not execFileSync: the latter returns only stdout on exit 0 and
 * drops stderr, so an arm asserting a success-path message (the stale-lock
 * "removed" line) would read '' and fail on Linux while looking correct on
 * a macOS host where every arm skips.
 */
function runGuard(cwd: string, cliPath: string, extraEnv: Record<string, string> = {}) {
  const r = spawnSync('node', [GUARD_PATH], {
    cwd,
    env: { ...process.env, RUFLO_GUARD_CLI_PATH: cliPath, ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (r.error) throw r.error
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe('ruflo-launch-guard.mjs (ADR-170 §§ 4, 7)', () => {
  const dirs: string[] = []
  function scratchCwd(): string {
    const dir = makeCwd()
    dirs.push(dir)
    return dir
  }

  it.skipIf(!isLinux)(`sibling contention: two forked processes (${skipReason})`, () => {
    const cwd = scratchCwd()
    const cliPath = makeCliPath(cwd)
    const aOut = join(cwd, 'a.out')
    // Process A holds the sibling for 1500ms after acquiring it (the
    // guard-side RUFLO_GUARD_TEST_HOLD_MS test seam), backgrounded via the
    // shell so this test can start process B while A is still mid-hold;
    // process B starts ~300ms later and must observe A as the live owner.
    execFileSync(
      'sh',
      [
        '-c',
        'RUFLO_GUARD_CLI_PATH="$1" RUFLO_GUARD_TEST_HOLD_MS=1500 node "$2" >"$3" 2>&1 &',
        '_',
        cliPath,
        GUARD_PATH,
        aOut,
      ],
      { cwd, encoding: 'utf8' }
    )
    execFileSync('sleep', ['0.3'])
    const b = runGuard(cwd, cliPath)
    expect(b.status, `B's stderr: ${b.stderr}`).toBe(3)
    expect(b.stderr).toContain('held by a live launcher')
    // Let A finish (and clean up its own sibling record) before returning.
    execFileSync('sleep', ['1.5'])
  })

  it.skipIf(!isLinux)(`stale sibling record (dead pid) is recovered (${skipReason})`, () => {
    const cwd = scratchCwd()
    const cliPath = makeCliPath(cwd)
    const siblingPath = join(cwd, '.claude-flow', 'policy', 'state.lock.launcher')
    writeFileSync(
      siblingPath,
      JSON.stringify({
        formatVersion: 1,
        pid: 2147483647, // essentially certain not to exist
        startTime: '1',
        nonce: 'dead-owner',
        createdAt: new Date().toISOString(),
      })
    )
    const r = runGuard(cwd, cliPath)
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
  })

  it.skipIf(!isLinux)(
    `recycled pid, mismatched start time, sibling recovered (${skipReason})`,
    () => {
      const cwd = scratchCwd()
      const cliPath = makeCliPath(cwd)
      const siblingPath = join(cwd, '.claude-flow', 'policy', 'state.lock.launcher')
      // This TEST process's own pid is alive throughout, but the recorded
      // start time is fabricated and will not match the real one.
      writeFileSync(
        siblingPath,
        JSON.stringify({
          formatVersion: 1,
          pid: process.pid,
          startTime: '1',
          nonce: 'recycled-owner',
          createdAt: new Date().toISOString(),
        })
      )
      const r = runGuard(cwd, cliPath)
      expect(r.status, `stderr: ${r.stderr}`).toBe(0)
    }
  )

  it.skipIf(!isLinux)(`malformed sibling record is refused, never deleted (${skipReason})`, () => {
    const cwd = scratchCwd()
    const cliPath = makeCliPath(cwd)
    const siblingPath = join(cwd, '.claude-flow', 'policy', 'state.lock.launcher')
    writeFileSync(siblingPath, 'not json at all')
    const r = runGuard(cwd, cliPath)
    expect(r.status).toBe(4)
    expect(r.stderr).toContain('unresolved')
    expect(readFileSync(siblingPath, 'utf8')).toBe('not json at all')
  })

  it.skipIf(!isLinux)(`a live state.lock is refused and not deleted (${skipReason})`, () => {
    const cwd = scratchCwd()
    const cliPath = makeCliPath(cwd)
    const lockPath = join(cwd, '.claude-flow', 'policy', 'state.lock')
    const record = {
      formatVersion: 1,
      pid: process.pid,
      startTime: readStartTime(process.pid),
      nonce: 'live-server',
      createdAt: new Date().toISOString(),
    }
    writeFileSync(lockPath, JSON.stringify(record))
    const r = runGuard(cwd, cliPath)
    expect(r.status, `stderr: ${r.stderr}`).toBe(5)
    expect(r.stderr).toContain('held by a live server')
    expect(readFileSync(lockPath, 'utf8')).toBe(JSON.stringify(record))
  })

  it.skipIf(!isLinux)(`a stale state.lock is recovered and removed (${skipReason})`, () => {
    const cwd = scratchCwd()
    const cliPath = makeCliPath(cwd)
    const lockPath = join(cwd, '.claude-flow', 'policy', 'state.lock')
    writeFileSync(
      lockPath,
      JSON.stringify({
        formatVersion: 1,
        pid: 2147483647,
        startTime: '1',
        nonce: 'dead-server',
        createdAt: new Date().toISOString(),
      })
    )
    const r = runGuard(cwd, cliPath)
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
    expect(r.stderr).toContain('removed stale state.lock')
    expect(() => readFileSync(lockPath, 'utf8')).toThrow()
  })

  if (!isLinux) {
    it(`prints its skip reason (${skipReason})`, () => {
      // A non-skipped canary so a `vitest run` of this file on a non-Linux
      // host always reports at least one PASS naming why the rest skipped,
      // rather than a suite of silent skips with no visible reason.
      expect(skipReason).toContain('no /proc on')
    })
  }

  // Cleanup happens per-process-exit (mktemp dirs under the OS tmpdir), but
  // best-effort explicit cleanup keeps a long-lived CI runner tidy too.
  it.skipIf(!isLinux)('cleanup', () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })
})
