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
 * All arms use a real temp cwd with `.claude-flow/policy` and `.swarm`
 * pre-created (what scripts/ruflo-service-entrypoint.sh does at container
 * start) and a real file for RUFLO_GUARD_CLI_PATH so the entrypoint
 * realpath check passes. RUFLO_GUARD_TEST_HOLD_MS (guard-side test seam,
 * documented in the guard's own header) is used by the contention arms, to
 * widen the window deterministically instead of relying on timing luck.
 *
 * RUFLO_GUARD_TEST_OVERRIDE_PATH points the whole suite at a different
 * guard file (a mutated scratch copy) without editing this file per
 * mutation -- used only for the governance-review red-test protocol
 * (CLAUDE.md's "a regression test you have not run against the unfixed
 * code is unverified"), never in normal runs.
 *
 * The M-14 (setpriv) arms additionally require the `setpriv` binary AND
 * real root (CAP_SETUID, to drop to an unprivileged uid) -- both true in
 * the dev/ruflo containers per the governance review's own measurement,
 * but not guaranteed of every CI runner, so those two arms carry their own
 * independent skip guard and print why when they skip.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD_PATH =
  process.env.RUFLO_GUARD_TEST_OVERRIDE_PATH ||
  fileURLToPath(new URL('../ruflo-launch-guard.mjs', import.meta.url))
const isLinux = process.platform === 'linux'
const skipReason = isLinux
  ? ''
  : `skipped: no /proc on ${process.platform} -- this suite requires Linux (the ruflo service container or CI)`

function commandExists(cmd: string): boolean {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' })
  return r.status === 0
}

// M-14 arms need real root (to drop privilege with setpriv) and the
// setpriv binary itself; neither is guaranteed off the dev/ruflo
// containers this suite otherwise targets.
const isRoot = isLinux && process.getuid?.() === 0
const setprivAvailable = isLinux && commandExists('setpriv')
const hasSetpriv = isRoot && setprivAvailable
// '' when the arms actually run, matching the skipReason convention above,
// so a passing/running title never carries a stale "(skipped: ...)" label.
const setprivSkipReason = hasSetpriv
  ? ''
  : !isLinux
    ? skipReason
    : !isRoot
      ? 'skipped: M-14 arms require running as root (to setpriv down to an unprivileged uid)'
      : 'skipped: setpriv binary not found on PATH'

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

  // -- C-1: the REAL state.lock's actual on-disk shape ------------------
  // policy-runtime.js writes {"pid":<int>,"acquiredAt":<Date.now() ms>},
  // not this file's own {pid,startTime} sibling shape. These three arms
  // use that LITERAL runtime shape against the real lock path.

  it.skipIf(!isLinux)(
    `a stale REAL state.lock in the runtime's own {pid,acquiredAt} shape is recovered and removed (${skipReason})`,
    () => {
      const cwd = scratchCwd()
      const cliPath = makeCliPath(cwd)
      const lockPath = join(cwd, '.claude-flow', 'policy', 'state.lock')
      writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, acquiredAt: Date.now() - 60000 }))
      const r = runGuard(cwd, cliPath)
      expect(r.status, `stderr: ${r.stderr}`).toBe(0)
      expect(r.stderr).toContain('removed stale state.lock')
      expect(() => readFileSync(lockPath, 'utf8')).toThrow()
    }
  )

  it.skipIf(!isLinux)(
    `a live REAL state.lock in the runtime's own {pid,acquiredAt} shape is refused and not deleted (${skipReason})`,
    () => {
      const cwd = scratchCwd()
      const cliPath = makeCliPath(cwd)
      const lockPath = join(cwd, '.claude-flow', 'policy', 'state.lock')
      const record = { pid: process.pid, acquiredAt: Date.now() }
      writeFileSync(lockPath, JSON.stringify(record))
      const r = runGuard(cwd, cliPath)
      expect(r.status, `stderr: ${r.stderr}`).toBe(5)
      expect(r.stderr).toContain('held by a live server')
      expect(readFileSync(lockPath, 'utf8')).toBe(JSON.stringify(record))
    }
  )

  it.skipIf(!isLinux)(
    `a recycled pid in a REAL state.lock ({pid,acquiredAt}) is recovered as stale (${skipReason})`,
    () => {
      const cwd = scratchCwd()
      const cliPath = makeCliPath(cwd)
      const lockPath = join(cwd, '.claude-flow', 'policy', 'state.lock')
      // A real, currently-live pid, backgrounded so it survives this
      // spawnSync call returning; acquiredAt is set 10 minutes in the past,
      // so this pid's ACTUAL /proc start time (right now) unavoidably
      // postdates it -- the recycled-pid case the runtime shape must
      // recover from rather than treat as the live owner. stdio is
      // detached to /dev/null: without that, the backgrounded `sleep`
      // inherits this `sh`'s stdout/stderr pipe, and spawnSync then blocks
      // for the full 30s waiting for that pipe to close (measured; the
      // parent `sh` exiting is not enough while the child still holds it).
      const spawned = spawnSync('sh', ['-c', 'sleep 30 </dev/null >/dev/null 2>&1 & echo $!'], {
        encoding: 'utf8',
      })
      const childPid = Number(spawned.stdout.trim())
      expect(Number.isInteger(childPid) && childPid > 0, `spawn stderr: ${spawned.stderr}`).toBe(
        true
      )
      try {
        writeFileSync(lockPath, JSON.stringify({ pid: childPid, acquiredAt: Date.now() - 600000 }))
        const r = runGuard(cwd, cliPath)
        expect(r.status, `stderr: ${r.stderr}`).toBe(0)
        expect(r.stderr).toContain('recycled pid')
        expect(() => readFileSync(lockPath, 'utf8')).toThrow()
      } finally {
        try {
          process.kill(childPid, 'SIGKILL')
        } catch {
          // already gone -- fine
        }
      }
    }
  )

  it.skipIf(!isLinux)(
    `a malformed REAL state.lock warns and proceeds -- never wedges the server, never deletes it (${skipReason})`,
    () => {
      const cwd = scratchCwd()
      const cliPath = makeCliPath(cwd)
      const lockPath = join(cwd, '.claude-flow', 'policy', 'state.lock')
      const raw = JSON.stringify({ garbage: true })
      writeFileSync(lockPath, raw)
      const r = runGuard(cwd, cliPath)
      expect(r.status, `stderr: ${r.stderr}`).toBe(0)
      expect(r.stderr).toContain('unresolved')
      expect(r.stderr).toContain('proceeding')
      expect(readFileSync(lockPath, 'utf8')).toBe(raw)
    }
  )

  // -- H-4: stale-recovery race on the SIBLING file ----------------------
  // Two guards race a pre-seeded STALE sibling record. Whichever writes
  // last wins (its own read-back sees its own nonce); the other must
  // observe the mismatch (or an EEXIST against the winner's live record)
  // and refuse -- never both proceed. Exact interleaving is scheduler-
  // dependent, so this asserts the invariant (exactly one winner, sibling
  // ends up clean), not a specific code path.
  it.skipIf(!isLinux)(
    `H-4: two guards racing a stale sibling record -- exactly one wins, sibling ends up clean (${skipReason})`,
    () => {
      const cwd = scratchCwd()
      const cliPath = makeCliPath(cwd)
      const siblingPath = join(cwd, '.claude-flow', 'policy', 'state.lock.launcher')
      writeFileSync(
        siblingPath,
        JSON.stringify({
          formatVersion: 1,
          pid: 2147483646,
          startTime: '1',
          nonce: 'h4-dead-owner',
          createdAt: new Date().toISOString(),
        })
      )
      const aOut = join(cwd, 'a.out')
      const bOut = join(cwd, 'b.out')
      const aExitFile = join(cwd, 'a.exit')
      const bExitFile = join(cwd, 'b.exit')
      // Both guards launched from the SAME shell invocation, backgrounded
      // back-to-back with no sleep between them, so their node process
      // startups (tens of ms) overlap the microsecond-scale
      // unlink-then-write recovery race this arm exists to exercise. Each
      // backgrounded command is wrapped in its OWN subshell `( ... ) &` --
      // without the parens, `cmd1; cmd2 &` backgrounds only cmd2 and runs
      // cmd1 (the node invocation) in the FOREGROUND first, which fully
      // serializes the two guards instead of racing them (measured: this
      // exact bug made an earlier version of this arm show B starting
      // >1s after A had already finished and cleaned up -- no race at
      // all). RUFLO_GUARD_TEST_HOLD_MS on BOTH (not just the eventual
      // winner): node's own startup jitter (single-digit-to-tens of ms) is
      // comparable to a guard's whole uncontended run time, so without a
      // hold on both sides a "loser" that starts a few ms late can find
      // the winner has ALREADY finished and cleaned up its own sibling
      // record -- a clean empty slot, not a race at all (measured: this
      // exact false negative -- both exiting 0 with the second one having
      // legitimately re-acquired a freshly-vacated sibling -- happened
      // repeatedly with only the winner held). Holding both keeps
      // whichever one wins observable as the live owner for long enough
      // that the other reliably sees the contention.
      const script = [
        `( RUFLO_GUARD_CLI_PATH="$1" RUFLO_GUARD_TEST_HOLD_MS=500 node "$2" >"$3" 2>&1; echo $? > "$4" ) &`,
        `( RUFLO_GUARD_CLI_PATH="$1" RUFLO_GUARD_TEST_HOLD_MS=500 node "$2" >"$5" 2>&1; echo $? > "$6" ) &`,
        `wait`,
      ].join('\n')
      execFileSync(
        'sh',
        ['-c', script, '_', cliPath, GUARD_PATH, aOut, aExitFile, bOut, bExitFile],
        {
          cwd,
          encoding: 'utf8',
        }
      )
      const aExit = Number(readFileSync(aExitFile, 'utf8').trim())
      const bExit = Number(readFileSync(bExitFile, 'utf8').trim())
      const winners = [aExit, bExit].filter((c) => c === 0)
      const losers = [aExit, bExit].filter((c) => c !== 0)
      const diag = `a=${aExit} (${readFileSync(aOut, 'utf8')}) b=${bExit} (${readFileSync(bOut, 'utf8')})`
      expect(winners.length, diag).toBe(1)
      expect(losers.length, diag).toBe(1)
      expect([3, 4], diag).toContain(losers[0])
      expect(() => readFileSync(siblingPath, 'utf8')).toThrow()
    }
  )

  // -- H-4 (deterministic): rename arbitration under a controlled gap ----
  // A pauses 500ms after classifying the pre-seeded stale record, before
  // its arbitrating rename (RUFLO_GUARD_TEST_PAUSE_AFTER_CLASSIFY_MS); B
  // (started ~50ms after A) pauses 850ms. Both classify the SAME stale
  // record before either acts: B's own classify happens at B's process
  // startup (~50ms + Node startup jitter after A's start), which needs a
  // wide margin below A's 500ms pause -- measured, Node startup jitter
  // under container load can occasionally exceed 150ms, and an earlier,
  // tighter 200ms/600ms pairing let B's classify land AFTER A's write on
  // one observed run (B then correctly refused via the OUTER live-check
  // instead of the post-capture one this arm exists to pin -- still safe,
  // but not what this arm is targeted at). A's rename+write completes at
  // ~500ms after A's own start; A then holds (RUFLO_GUARD_TEST_HOLD_MS)
  // long enough that its fresh record is still the live owner when B acts
  // at ~900ms (50 + 850) after A's start -- comfortably inside A's
  // 500-1500ms live window. B's rename SUCCEEDS at that point -- rename
  // moves whatever is CURRENTLY at the path, not the specific object
  // classified 850ms earlier, so it captures A's live record, not the
  // original stale one -- but the guard's post-capture re-validation
  // catches this: B re-reads what it just captured, finds it is A's LIVE
  // record, restores it to the sibling path, and refuses. Measured
  // directly (debug instrumentation) before that re-validation existed:
  // this exact scenario made BOTH processes exit 0, a real double-spawn,
  // not a hypothetical one -- so this arm pins that fix specifically, not
  // just the rename-vs-unlink one the stochastic arm above covers.
  it.skipIf(!isLinux)(
    `H-4 (deterministic): A wins via pause=500ms, B loses via pause=850ms, captured-record re-validation (${skipReason})`,
    () => {
      const cwd = scratchCwd()
      const cliPath = makeCliPath(cwd)
      const policyDir = join(cwd, '.claude-flow', 'policy')
      const siblingPath = join(policyDir, 'state.lock.launcher')
      writeFileSync(
        siblingPath,
        JSON.stringify({
          formatVersion: 1,
          pid: 2147483645,
          startTime: '1',
          nonce: 'h4-det-dead-owner',
          createdAt: new Date().toISOString(),
        })
      )
      const aOut = join(cwd, 'a.out')
      const bOut = join(cwd, 'b.out')
      const aExitFile = join(cwd, 'a.exit')
      const bExitFile = join(cwd, 'b.exit')
      // A and B are each backgrounded in their OWN subshell (the earlier
      // `cmd1; cmd2 &` sequencing-bug fix), with the `sleep 0.05` gap
      // INSIDE this same script -- not a separate execFileSync/spawnSync
      // call from the test process. Measured: an out-of-process sleep
      // call's own overhead (spawning `sh` plus `sleep` from Node) can
      // itself run over 1000ms under load, dwarfing the intended 50ms gap
      // and letting A fully finish (and clean up) before B even starts --
      // collapsing the intended race into two sequential, uncontested
      // acquisitions. A single in-script `sleep` avoids that overhead.
      const script = [
        `( RUFLO_GUARD_CLI_PATH="$1" RUFLO_GUARD_TEST_PAUSE_AFTER_CLASSIFY_MS=500 RUFLO_GUARD_TEST_HOLD_MS=1000 node "$2" >"$3" 2>&1; echo $? > "$4" ) &`,
        `sleep 0.05`,
        `( RUFLO_GUARD_CLI_PATH="$1" RUFLO_GUARD_TEST_PAUSE_AFTER_CLASSIFY_MS=850 node "$2" >"$5" 2>&1; echo $? > "$6" ) &`,
        `wait`,
      ].join('\n')
      execFileSync(
        'sh',
        ['-c', script, '_', cliPath, GUARD_PATH, aOut, aExitFile, bOut, bExitFile],
        { cwd, encoding: 'utf8' }
      )
      const aExit = Number(readFileSync(aExitFile, 'utf8').trim())
      const bExit = Number(readFileSync(bExitFile, 'utf8').trim())
      const diag = `a=${aExit} (${readFileSync(aOut, 'utf8')}) b=${bExit} (${readFileSync(bOut, 'utf8')})`
      expect(aExit, diag).toBe(0)
      expect(bExit, diag).toBe(3)
      expect(readFileSync(bOut, 'utf8'), diag).toContain('taken by another launcher')
      expect(() => readFileSync(siblingPath, 'utf8')).toThrow()
      const staleFiles = readdirSync(policyDir).filter((f) => f.includes('.stale.'))
      expect(staleFiles, diag).toEqual([])
    }
  )

  // -- M-14: writability-probe failure arms (setpriv-gated) --------------
  // The dev/ruflo containers run as root, which bypasses every permission
  // check these arms depend on -- so they must drop to an unprivileged uid
  // via setpriv to actually observe a directory refusing a write. Measured
  // live: mkdirSync's default mode here is 0755 owned by root -- "others"
  // (uid 1000, outside the owning group) get only r-x on EVERY probed
  // directory by default, so cwd/.claude-flow/the non-target probe dir must
  // be explicitly opened to 0777 (world-writable) wherever the test does
  // NOT want that directory to be the one that fails -- otherwise the
  // FIRST directory in main()'s probe order ([policyDir, swarmDir, cwd])
  // fails regardless of which one the test means to target. Only the ONE
  // directory each arm is actually testing is set to 0555 (read+execute,
  // no write).

  function runAsUid1000(cwd: string, cliPath: string) {
    const r = spawnSync(
      'setpriv',
      ['--reuid=1000', '--regid=1000', '--clear-groups', 'node', GUARD_PATH],
      { cwd, env: { ...process.env, RUFLO_GUARD_CLI_PATH: cliPath }, encoding: 'utf8' }
    )
    if (r.error) throw r.error
    return r
  }

  it.skipIf(!hasSetpriv)(
    `M-14: writable cwd, read-only .claude-flow/policy -- exit 1 naming that path (${setprivSkipReason})`,
    () => {
      const cwd = scratchCwd()
      const cliPath = makeCliPath(cwd)
      const policyDir = join(cwd, '.claude-flow', 'policy')
      chmodSync(cwd, 0o777)
      chmodSync(join(cwd, '.claude-flow'), 0o777)
      chmodSync(join(cwd, '.swarm'), 0o777)
      chmodSync(policyDir, 0o555)
      try {
        const r = runAsUid1000(cwd, cliPath)
        expect(r.status, `stderr: ${r.stderr}`).toBe(1)
        expect(r.stderr).toContain(policyDir)
      } finally {
        chmodSync(policyDir, 0o755)
      }
    }
  )

  it.skipIf(!hasSetpriv)(
    `M-14: writable cwd, read-only .swarm -- exit 1 naming that path (${setprivSkipReason})`,
    () => {
      const cwd = scratchCwd()
      const cliPath = makeCliPath(cwd)
      const policyDir = join(cwd, '.claude-flow', 'policy')
      const swarmDir = join(cwd, '.swarm')
      chmodSync(cwd, 0o777)
      chmodSync(join(cwd, '.claude-flow'), 0o777)
      chmodSync(policyDir, 0o777)
      chmodSync(swarmDir, 0o555)
      try {
        const r = runAsUid1000(cwd, cliPath)
        expect(r.status, `stderr: ${r.stderr}`).toBe(1)
        expect(r.stderr).toContain(swarmDir)
      } finally {
        chmodSync(swarmDir, 0o755)
      }
    }
  )

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
