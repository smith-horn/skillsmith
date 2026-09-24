/**
 * scripts/tests/ruflo-launch-guard.test.ts -- SMI-6744 A1.8, ADR-170 §§ 4, 7.
 *
 * Exercises scripts/ruflo-launch-guard.mjs, the per-spawn guard
 * scripts/mcp-ruflo-launcher.sh pipes into `docker exec -i <svc> node -`
 * immediately before it execs the real ruflo server.
 *
 * The guard reads /proc/<pid>/stat and holds its mutex with a SQLite
 * `BEGIN IMMEDIATE` (a kernel fcntl lock), so this suite needs Linux AND a
 * loadable better-sqlite3. It SKIPS cleanly, printing why, everywhere else
 * -- this host session's own `npx vitest run` of this file on macOS is
 * expected to report the skip reason, not a pass. That is the honest
 * never-ran state, not a green result.
 *
 * WHAT THESE ARMS PIN (A1.8 redesign). The cross-family pre-merge gate
 * blocked the A1.4 sibling-FILE protocol on two paths that both end in a
 * LIVE lock record being deleted. The replacement makes deletion
 * structurally impossible rather than merely unlikely, so the arms are
 * about two properties:
 *   (1) the mutex is an OS-released lock -- contenders SERIALIZE inside
 *       the busy timeout, REFUSE past it, and a SIGKILLed holder's lock is
 *       released by the kernel with nothing left to clean up;
 *   (2) the guard NEVER removes the runtime's state.lock, in any branch,
 *       including when the lock is replaced underneath it between
 *       classification and action.
 *
 * All arms use a real temp cwd with `.claude-flow/policy` and `.swarm`
 * pre-created (what scripts/ruflo-service-entrypoint.sh does at container
 * start) and a real file for RUFLO_GUARD_CLI_PATH so the entrypoint
 * realpath check passes. Every arm prints its measured elapsed times, so a
 * timing-shaped regression is visible in the run output and not only in a
 * threshold that happened to still hold.
 *
 * RUFLO_GUARD_TEST_OVERRIDE_PATH points the whole suite at a different
 * guard file (a mutated scratch copy) without editing this file per
 * mutation -- used only for the red-test protocol (CLAUDE.md's "a
 * regression test you have not run against the unfixed code is
 * unverified"), never in normal runs.
 *
 * The M-14 (setpriv) arms additionally require the `setpriv` binary AND
 * real root (CAP_SETUID, to drop to an unprivileged uid) -- both true in
 * the dev/ruflo containers, but not guaranteed of every CI runner, so
 * those two arms carry their own independent skip guard and print why.
 */
import { describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const GUARD_PATH =
  process.env.RUFLO_GUARD_TEST_OVERRIDE_PATH ||
  fileURLToPath(new URL('../ruflo-launch-guard.mjs', import.meta.url))
const isLinux = process.platform === 'linux'

/**
 * The guard resolves better-sqlite3 by ABSOLUTE path (it is piped into a
 * bare `node -` with no node_modules of its own), defaulting to the served
 * ruflo image's copy. Inside the dev container that path does not exist, so
 * the suite resolves the workspace copy and hands it to the guard through
 * the RUFLO_GUARD_SQLITE_MODULE seam. A bare specifier would NOT work --
 * the guard resolves relative to its own cwd, which is a temp dir here.
 */
function resolveSqliteModule(): string | null {
  const servedImageCopy = '/opt/ruflo-seed/node_modules/better-sqlite3'
  for (const candidate of [servedImageCopy, 'better-sqlite3']) {
    try {
      return require_.resolve(candidate)
    } catch {
      // try the next candidate
    }
  }
  return null
}

const sqliteModule = isLinux ? resolveSqliteModule() : null
const canRun = isLinux && sqliteModule !== null
const skipReason = !isLinux
  ? `skipped: no /proc on ${process.platform} -- this suite requires Linux (the ruflo service container or CI)`
  : sqliteModule === null
    ? 'skipped: better-sqlite3 is not resolvable here -- the guard mutex cannot be exercised'
    : ''

function commandExists(cmd: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0
}

// M-14 arms need real root (to drop privilege with setpriv) and the
// setpriv binary itself; neither is guaranteed off the dev/ruflo containers.
const isRoot = isLinux && process.getuid?.() === 0
const hasSetpriv = canRun && isRoot && commandExists('setpriv')
// '' when the arms actually run, matching the skipReason convention above,
// so a running title never carries a stale "(skipped: ...)" label.
const setprivSkipReason = hasSetpriv
  ? ''
  : !canRun
    ? skipReason
    : !isRoot
      ? 'skipped: M-14 arms require running as root (to setpriv down to an unprivileged uid)'
      : 'skipped: setpriv binary not found on PATH'

/** A pid that cannot exist (above every Linux pid_max), so /proc says ENOENT. */
const DEAD_PID = 2147483647
/** The runtime's own LOCK_STALE_MS, measured live in policy-runtime.js. */
const RUNTIME_LOCK_STALE_MS = 30000

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** Measured timings go to stdout so every arm's numbers are in the run log. */
const note = (line: string) => process.stdout.write(`    [measured] ${line}\n`)

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

const policyDirOf = (cwd: string) => join(cwd, '.claude-flow', 'policy')
const mutexPathOf = (cwd: string) => join(policyDirOf(cwd), 'state.lock.launcher.db')
const realLockPathOf = (cwd: string) => join(policyDirOf(cwd), 'state.lock')

interface GuardRun {
  status: number | null
  signal: NodeJS.Signals | null
  output: string
  /** Absolute wall-clock bounds, so an arm can assert that one guard
   * finished AFTER another rather than trusting an absolute duration -- a
   * container-wide stall moves both, and only the relation survives it. */
  startedAt: number
  endedAt: number
  elapsed: number
}

/**
 * Starts the guard and returns the live child plus a promise of its result.
 * `spawn`, not `spawnSync`: the contention arms must start a second guard
 * while the first is still mid-hold, and the SIGKILL arm needs the holder's
 * real pid. stdout and stderr are merged -- every guard message is on
 * stderr, and an arm asserting a success-path message would read '' if
 * stderr were dropped.
 */
function launchGuard(cwd: string, cliPath: string, extraEnv: Record<string, string> = {}) {
  const startedAt = Date.now()
  const child = spawn('node', [GUARD_PATH], {
    cwd,
    env: {
      ...process.env,
      RUFLO_GUARD_CLI_PATH: cliPath,
      ...(sqliteModule ? { RUFLO_GUARD_SQLITE_MODULE: sqliteModule } : {}),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (d) => {
    output += String(d)
  })
  child.stderr.on('data', (d) => {
    output += String(d)
  })
  const done = new Promise<GuardRun>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (status, signal) => {
      const endedAt = Date.now()
      resolve({ status, signal, output, startedAt, endedAt, elapsed: endedAt - startedAt })
    })
  })
  // `seen` exposes the output accumulated SO FAR, so an arm can wait for
  // the guard to announce a decision instead of guessing how long it takes
  // to reach one.
  return { child, done, seen: () => output }
}

/**
 * Resolves once the still-running guard has printed `marker`. Rejects with
 * everything it did print if it never does -- a silent timeout here would
 * turn a real regression into a differently-shaped assertion failure two
 * lines later.
 */
async function waitForOutput(
  guard: { seen: () => string },
  marker: string,
  timeoutMs = 15000
): Promise<number> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (guard.seen().includes(marker)) return Date.now() - startedAt
    await delay(20)
  }
  throw new Error(`guard never printed ${JSON.stringify(marker)}; saw: ${guard.seen()}`)
}

function runGuard(cwd: string, cliPath: string, extraEnv: Record<string, string> = {}) {
  return launchGuard(cwd, cliPath, extraEnv).done
}

/**
 * Directly asks the kernel whether the launcher mutex is held right now, by
 * attempting the same `BEGIN IMMEDIATE` with a zero busy timeout. Used as a
 * KNOWN-POSITIVE before the SIGKILL arm kills its holder: without it, an
 * arm that killed a holder which had not yet acquired anything would pass
 * while proving nothing about kernel release.
 */
function mutexIsHeld(dbPath: string): boolean {
  const Database = require_(sqliteModule as string)
  const db = new Database(dbPath)
  try {
    db.pragma('busy_timeout = 0')
    db.exec('BEGIN IMMEDIATE')
    db.exec('COMMIT')
    return false
  } catch (err) {
    return String((err as { code?: string }).code || '').startsWith('SQLITE_BUSY')
  } finally {
    try {
      db.close()
    } catch {
      // best-effort
    }
  }
}

/** A real, currently-running pid (a detached sleeper), plus its killer. */
function spawnSleeper(): { pid: number; kill: () => void } {
  // stdio detached to /dev/null: otherwise the backgrounded `sleep`
  // inherits this `sh`'s pipe and spawnSync blocks for the full sleep.
  const r = spawnSync('sh', ['-c', 'sleep 120 </dev/null >/dev/null 2>&1 & echo $!'], {
    encoding: 'utf8',
  })
  const pid = Number(r.stdout.trim())
  expect(Number.isInteger(pid) && pid > 0, `sleeper spawn stderr: ${r.stderr}`).toBe(true)
  return {
    pid,
    kill: () => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone -- fine
      }
    },
  }
}

describe('ruflo-launch-guard.mjs (ADR-170 §§ 4, 7)', () => {
  const dirs: string[] = []
  function scratchCwd(): string {
    const dir = makeCwd()
    dirs.push(dir)
    return dir
  }

  // ---- 1-4: the mutex is an OS-released lock --------------------------

  it.skipIf(!canRun)(
    `arm 1: a contender WAITS inside the busy timeout rather than refusing (${skipReason})`,
    async () => {
      const cwd = scratchCwd()
      const cliPath = makeCliPath(cwd)
      const a = launchGuard(cwd, cliPath, { RUFLO_GUARD_TEST_HOLD_MS: '1500' })
      await delay(200)
      const b = launchGuard(cwd, cliPath)
      const [ar, br] = await Promise.all([a.done, b.done])
      note(
        `arm 1: A exit=${ar.status} elapsed=${ar.elapsed}ms | B exit=${br.status} elapsed=${br.elapsed}ms | B ended ${br.endedAt - ar.endedAt}ms after A`
      )
      expect(ar.status, `A output: ${ar.output}`).toBe(0)
      expect(br.status, `B output: ${br.output}`).toBe(0)
      // The load-independent property: B cannot finish before A releases,
      // because it is waiting on A. A container-wide stall moves both
      // endpoints together, so only this RELATION is evidence -- an
      // absolute duration is not. Deferred BEGIN (no lock taken at all) and
      // a zero busy timeout both put B's end WELL before A's.
      expect(br.endedAt - ar.endedAt, `B output: ${br.output}`).toBeGreaterThanOrEqual(-50)
      // And it WAITED rather than refusing.
      expect(br.elapsed, `B output: ${br.output}`).toBeGreaterThanOrEqual(1000)
      expect(br.output).not.toContain('held by another launcher')
    },
    30000
  )

  it.skipIf(!canRun)(
    `arm 2: a contender REFUSES with exit 3, naming the holder, once the busy timeout elapses (${skipReason})`,
    async () => {
      const cwd = scratchCwd()
      const cliPath = makeCliPath(cwd)
      const a = launchGuard(cwd, cliPath, { RUFLO_GUARD_TEST_HOLD_MS: '5000' })
      await delay(200)
      const br = await runGuard(cwd, cliPath)
      note(`arm 2: B exit=${br.status} elapsed=${br.elapsed}ms (holder pid ${a.child.pid})`)
      // Exit 3 is itself the proof that it REFUSED rather than outlasting
      // A's hold (acquiring late would have been exit 0), so no upper bound
      // is needed -- and an upper bound would only add a stall-shaped
      // flake. The floor is what matters: it must have waited out the full
      // busy timeout, which a zero busy_timeout would cut to ~50ms.
      expect(br.status, `B output: ${br.output}`).toBe(3)
      expect(br.elapsed, `B output: ${br.output}`).toBeGreaterThanOrEqual(2800)
      expect(br.output).toContain('held by another launcher')
      expect(br.output).toContain(`pid ${a.child.pid}`)
      // The refusal must not tell anyone to delete anything.
      expect(br.output).toContain('nothing to delete')
      const ar = await a.done
      note(`arm 2: A exit=${ar.status} elapsed=${ar.elapsed}ms`)
      expect(ar.status, `A output: ${ar.output}`).toBe(0)
    },
    30000
  )

  it.skipIf(!canRun)(
    `arm 3: three contenders all proceed and leave only the mutex db behind (${skipReason})`,
    async () => {
      const cwd = scratchCwd()
      const cliPath = makeCliPath(cwd)
      // 600ms, not 1500ms: all three must complete INSIDE the 3000ms busy
      // timeout, and this container has been measured stalling for over 3s
      // at a time, so the convoy needs most of that budget as headroom
      // rather than spending it on the hold itself.
      const a = launchGuard(cwd, cliPath, { RUFLO_GUARD_TEST_HOLD_MS: '600' })
      await delay(50)
      const b = launchGuard(cwd, cliPath)
      await delay(50)
      const c = launchGuard(cwd, cliPath)
      const [ar, br, cr] = await Promise.all([a.done, b.done, c.done])
      note(
        `arm 3: A exit=${ar.status} elapsed=${ar.elapsed}ms | B exit=${br.status} elapsed=${br.elapsed}ms | C exit=${cr.status} elapsed=${cr.elapsed}ms`
      )
      const diag = `A: ${ar.output}\nB: ${br.output}\nC: ${cr.output}`
      expect([ar.status, br.status, cr.status], diag).toEqual([0, 0, 0])
      // The whole point of replacing the sibling-file protocol: no debris
      // to sweep, so nothing that a later sweep could delete out from under
      // a successor. No `.stale.<pid>`, no `state.lock.launcher`, no
      // leaked probe files, no `-wal`/`-shm`.
      expect(readdirSync(policyDirOf(cwd)).sort(), diag).toEqual(['state.lock.launcher.db'])
    },
    30000
  )

  it.skipIf(!canRun)(
    `arm 4: the kernel releases a SIGKILLed holder's mutex -- no staleness, nothing to recover (${skipReason})`,
    async () => {
      const cwd = scratchCwd()
      const cliPath = makeCliPath(cwd)
      const mutexPath = mutexPathOf(cwd)
      const a = launchGuard(cwd, cliPath, { RUFLO_GUARD_TEST_HOLD_MS: '20000' })
      // KNOWN-POSITIVE first: confirm the mutex really is held before the
      // kill, so a pass cannot come from killing a holder that never held.
      let held = false
      const pollStartedAt = Date.now()
      for (let i = 0; i < 200 && !held; i++) {
        await delay(50)
        held = existsSync(mutexPath) && mutexIsHeld(mutexPath)
      }
      note(
        `arm 4: holder observed holding after ${Date.now() - pollStartedAt}ms (pid ${a.child.pid})`
      )
      expect(held, 'the holder never acquired the mutex -- the kill would prove nothing').toBe(true)
      process.kill(a.child.pid as number, 'SIGKILL')
      const ar = await a.done
      expect(ar.signal).toBe('SIGKILL')
      const br = await runGuard(cwd, cliPath)
      note(`arm 4: successor exit=${br.status} elapsed=${br.elapsed}ms`)
      expect(br.status, `successor output: ${br.output}`).toBe(0)
      // Exit 0 already proves release (a still-held lock ends in exit 3
      // after the busy timeout). The bound adds "immediately": it stays
      // under the 3000ms timeout with room for a container stall, rather
      // than pinning the ~25ms this actually measures.
      expect(br.elapsed, `successor output: ${br.output}`).toBeLessThan(2500)
      expect(readdirSync(policyDirOf(cwd)).sort()).toEqual(['state.lock.launcher.db'])
    },
    40000
  )

  // ---- 5-7: the guard never writes or removes the runtime's state.lock -

  it.skipIf(!canRun)(
    `arm 5: a state.lock REPLACED after classification survives untouched (${skipReason})`,
    async () => {
      const cwd = scratchCwd()
      const cliPath = makeCliPath(cwd)
      const lockPath = realLockPathOf(cwd)
      // Pre-seed a lock the guard will classify STALE: dead pid, and an
      // mtime already past the runtime's own staleness window so the guard
      // proceeds without waiting.
      writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, acquiredAt: Date.now() - 600000 }))
      const past = new Date(Date.now() - 60000)
      utimesSync(lockPath, past, past)
      const sleeper = spawnSleeper()
      try {
        // The replacement must land strictly BETWEEN the guard's
        // classification and its action, and NO fixed delay can guarantee
        // that: this container has been measured stalling for over 3s,
        // which is long enough to put a 100ms (or an 800ms) write on the
        // wrong side of the guard's own first read -- the guard would then
        // classify the LIVE record and exit 5, a different arm entirely.
        // So the arm waits for the guard to ANNOUNCE its classification and
        // writes the replacement only then, inside the seam pause. That is
        // an observed fact rather than a timing guess.
        const g = launchGuard(cwd, cliPath, {
          RUFLO_GUARD_TEST_PAUSE_AFTER_REALLOCK_CLASSIFY_MS: '6000',
        })
        const sawAt = await waitForOutput(g, `classified stale (pid ${DEAD_PID} is not running)`)
        const liveRecord = JSON.stringify({ pid: sleeper.pid, acquiredAt: Date.now() })
        writeFileSync(lockPath, liveRecord)
        const r = await g.done
        note(
          `arm 5: classification seen at +${sawAt}ms, replacement written immediately after; guard exit=${r.status} elapsed=${r.elapsed}ms`
        )
        expect(r.status, `guard output: ${r.output}`).toBe(0)
        // It classified the pre-seeded STALE record, not the replacement.
        expect(r.output, `guard output: ${r.output}`).toContain(`pid ${DEAD_PID} is not running`)
        // And it was still inside the seam pause when the replacement
        // landed -- otherwise this arm proves nothing about that window.
        expect(r.elapsed, `guard output: ${r.output}`).toBeGreaterThan(sawAt)
        // And the LIVE successor record is still there, byte for byte.
        expect(existsSync(lockPath), `guard output: ${r.output}`).toBe(true)
        expect(readFileSync(lockPath, 'utf8')).toBe(liveRecord)
      } finally {
        sleeper.kill()
      }
    },
    30000
  )

  it.skipIf(!canRun)(
    `arm 6: a stale state.lock is WAITED OUT, never deleted (${skipReason})`,
    async () => {
      // (a) young stale lock: the guard must wait out the remainder of the
      //     runtime's 30s staleness window so the server it is about to
      //     exec clears the lock itself on its first contended acquire.
      const youngCwd = scratchCwd()
      const youngCli = makeCliPath(youngCwd)
      const youngLock = realLockPathOf(youngCwd)
      writeFileSync(youngLock, JSON.stringify({ pid: DEAD_PID, acquiredAt: Date.now() - 600000 }))
      const tenSecondsAgo = new Date(Date.now() - 10000)
      utimesSync(youngLock, tenSecondsAgo, tenSecondsAgo)
      const young = await runGuard(youngCwd, youngCli)
      note(`arm 6a (mtime 10s old): exit=${young.status} elapsed=${young.elapsed}ms`)
      expect(young.status, `output: ${young.output}`).toBe(0)
      // Two assertions, because they can fail independently.
      // (a) the ARITHMETIC: 10s of the 30s window had already elapsed, so
      //     ~20s is owed -- NOT the full 30s, and not zero. Read from the
      //     guard's own printed figure, which no container stall can move.
      // The fraction is deliberately OPTIONAL in this pattern. The arm is
      // asserting the guard's ARITHMETIC, not its number formatting, and a
      // `\d+ms`-only pattern silently failed whenever statSync's float
      // mtimeMs produced "19954.9990234375ms" -- an instrument that
      // reported a defect in the subject when the defect was in the
      // instrument.
      const owed = young.output.match(/waiting (\d+(?:\.\d+)?)ms/)
      expect(owed, `output: ${young.output}`).not.toBeNull()
      const owedMs = Number((owed as RegExpMatchArray)[1])
      note(`arm 6a: guard computed a ${owedMs}ms wait (expected ~${RUNTIME_LOCK_STALE_MS - 10000})`)
      expect(owedMs, `output: ${young.output}`).toBeGreaterThan(RUNTIME_LOCK_STALE_MS - 11500)
      expect(owedMs, `output: ${young.output}`).toBeLessThanOrEqual(RUNTIME_LOCK_STALE_MS - 9500)
      // (b) it actually SLEPT that long rather than only printing it. A
      //     container stall can only push this up, never down.
      expect(young.elapsed, `output: ${young.output}`).toBeGreaterThanOrEqual(
        RUNTIME_LOCK_STALE_MS - 10000 - 1000
      )
      expect(young.output).toContain('never deletes state.lock')
      expect(existsSync(youngLock), `output: ${young.output}`).toBe(true)

      // (b) old stale lock: already past the window, so no wait at all --
      //     and still no deletion.
      const oldCwd = scratchCwd()
      const oldCli = makeCliPath(oldCwd)
      const oldLock = realLockPathOf(oldCwd)
      const oldRaw = JSON.stringify({ pid: DEAD_PID, acquiredAt: Date.now() - 600000 })
      writeFileSync(oldLock, oldRaw)
      const sixtySecondsAgo = new Date(Date.now() - 60000)
      utimesSync(oldLock, sixtySecondsAgo, sixtySecondsAgo)
      const old = await runGuard(oldCwd, oldCli)
      note(`arm 6b (mtime 60s old): exit=${old.status} elapsed=${old.elapsed}ms`)
      expect(old.status, `output: ${old.output}`).toBe(0)
      // The discriminator is "did not sleep the window", not "was fast":
      // the failure this excludes is a ~20-30s wait, so a 10s ceiling
      // separates cleanly while tolerating a multi-second container stall.
      expect(old.elapsed, `output: ${old.output}`).toBeLessThan(10000)
      expect(old.output).toContain('past the runtime')
      // The WAIT LINE must be absent -- matched by its shape, not by the
      // bare word: the no-wait line itself reads "proceeding without
      // waiting", so a `not.toContain('waiting')` assertion fails on a
      // correct guard. (It did, on the first run of this arm.)
      expect(old.output, `output: ${old.output}`).not.toMatch(/waiting \d+ms/)
      expect(readFileSync(oldLock, 'utf8')).toBe(oldRaw)
    },
    60000
  )

  it.skipIf(!canRun)(
    `arm 7: a live state.lock refuses (exit 5); a malformed one warns and proceeds -- neither is deleted (${skipReason})`,
    async () => {
      const liveCwd = scratchCwd()
      const liveCli = makeCliPath(liveCwd)
      const liveLock = realLockPathOf(liveCwd)
      const sleeper = spawnSleeper()
      try {
        const liveRaw = JSON.stringify({ pid: sleeper.pid, acquiredAt: Date.now() })
        writeFileSync(liveLock, liveRaw)
        const live = await runGuard(liveCwd, liveCli)
        note(`arm 7a (live lock): exit=${live.status} elapsed=${live.elapsed}ms`)
        expect(live.status, `output: ${live.output}`).toBe(5)
        expect(live.output).toContain('held by a live server')
        expect(live.output).toContain('nothing to delete')
        expect(readFileSync(liveLock, 'utf8')).toBe(liveRaw)
      } finally {
        sleeper.kill()
      }

      const badCwd = scratchCwd()
      const badCli = makeCliPath(badCwd)
      const badLock = realLockPathOf(badCwd)
      const badRaw = JSON.stringify({ garbage: true })
      writeFileSync(badLock, badRaw)
      const bad = await runGuard(badCwd, badCli)
      note(`arm 7b (malformed lock): exit=${bad.status} elapsed=${bad.elapsed}ms`)
      expect(bad.status, `output: ${bad.output}`).toBe(0)
      expect(bad.output).toContain('unresolved')
      expect(bad.output).toContain('proceeding')
      expect(readFileSync(badLock, 'utf8')).toBe(badRaw)
    },
    30000
  )

  // ---- 8: an unusable mutex database is a distinct, self-describing refusal

  it.skipIf(!canRun)(
    `arm 8: an unusable mutex database refuses with exit 4, naming the file (${skipReason})`,
    async () => {
      const dirCwd = scratchCwd()
      const dirCli = makeCliPath(dirCwd)
      const dirMutex = mutexPathOf(dirCwd)
      mkdirSync(dirMutex)
      const asDir = await runGuard(dirCwd, dirCli)
      note(`arm 8a (directory at the mutex path): exit=${asDir.status} elapsed=${asDir.elapsed}ms`)
      expect(asDir.status, `output: ${asDir.output}`).toBe(4)
      expect(asDir.output).toContain(dirMutex)

      const fileCwd = scratchCwd()
      const fileCli = makeCliPath(fileCwd)
      const fileMutex = mutexPathOf(fileCwd)
      writeFileSync(fileMutex, 'this file is emphatically not a SQLite database\n')
      const notDb = await runGuard(fileCwd, fileCli)
      note(`arm 8b (non-database file): exit=${notDb.status} elapsed=${notDb.elapsed}ms`)
      expect(notDb.status, `output: ${notDb.output}`).toBe(4)
      expect(notDb.output).toContain(fileMutex)
    },
    30000
  )

  // ---- 9: a future-dated stale lock's wait is CLAMPED, not open-ended ---

  it.skipIf(!canRun)(
    `arm 9: a stale state.lock with a FUTURE mtime waits at most the ${RUNTIME_LOCK_STALE_MS}ms window, never longer (${skipReason})`,
    async () => {
      const cwd = scratchCwd()
      const cliPath = makeCliPath(cwd)
      const lockPath = realLockPathOf(cwd)
      // Unclamped, `RUNTIME_LOCK_STALE_MS - (now - mtimeMs)` goes negative
      // minus negative here and balloons to ~330s (5 min of "age" plus the
      // full 30s window) -- proving the clamp actually bites, not merely
      // that a normal wait completed quickly.
      writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, acquiredAt: Date.now() - 600000 }))
      const fiveMinFuture = new Date(Date.now() + 5 * 60 * 1000)
      utimesSync(lockPath, fiveMinFuture, fiveMinFuture)
      const guard = launchGuard(cwd, cliPath)
      // A hard kill at 40s, independent of vitest's own per-test timeout, so
      // a regression that removes the clamp fails this arm in ~40s instead
      // of the ~5.5 minutes the unclamped arithmetic actually sleeps for
      // (measured against a scratch mutant with the clamp reverted: it had
      // to be SIGKILLed after 40s, having printed a computed wait of
      // ~329000ms).
      const killer = setTimeout(() => {
        try {
          guard.child.kill('SIGKILL')
        } catch {
          // already gone
        }
      }, 40000)
      const r = await guard.done
      clearTimeout(killer)
      note(`arm 9: exit=${r.status} signal=${r.signal} elapsed=${r.elapsed}ms`)
      expect(
        r.signal,
        `guard had to be killed after 40s -- clamp missing? output: ${r.output}`
      ).toBe(null)
      expect(r.status, `output: ${r.output}`).toBe(0)
      // The clamp's ceiling, not the (here negative) raw arithmetic: at most
      // the runtime's own window plus generous scheduling slack, never the
      // ~330s the unclamped formula would actually produce.
      expect(r.elapsed, `output: ${r.output}`).toBeLessThanOrEqual(31000)
      expect(r.output, `output: ${r.output}`).toContain('mtime is in the FUTURE')
      expect(readFileSync(lockPath, 'utf8')).toContain(String(DEAD_PID))
    },
    45000
  )

  // ---- 10: recovery hints name a command this image actually has --------

  it.skipIf(!canRun)(
    `arm 10: exit-3 and exit-5 recovery hints scan /proc, not ps -eo, which this image lacks (${skipReason})`,
    async () => {
      const cwd3 = scratchCwd()
      const cli3 = makeCliPath(cwd3)
      const a = launchGuard(cwd3, cli3, { RUFLO_GUARD_TEST_HOLD_MS: '5000' })
      await delay(200)
      const exit3 = await runGuard(cwd3, cli3)
      note(`arm 10 (exit 3 hint): exit=${exit3.status}`)
      expect(exit3.status, `output: ${exit3.output}`).toBe(3)
      expect(exit3.output, `output: ${exit3.output}`).toContain('/proc/[0-9]*')
      expect(exit3.output, `output: ${exit3.output}`).not.toContain('ps -eo')
      await a.done

      const cwd5 = scratchCwd()
      const cli5 = makeCliPath(cwd5)
      const lock5 = realLockPathOf(cwd5)
      const sleeper = spawnSleeper()
      try {
        writeFileSync(lock5, JSON.stringify({ pid: sleeper.pid, acquiredAt: Date.now() }))
        const exit5 = await runGuard(cwd5, cli5)
        note(`arm 10 (exit 5 hint): exit=${exit5.status}`)
        expect(exit5.status, `output: ${exit5.output}`).toBe(5)
        expect(exit5.output, `output: ${exit5.output}`).toContain('/proc/[0-9]*')
        expect(exit5.output, `output: ${exit5.output}`).not.toContain('ps -eo')
      } finally {
        sleeper.kill()
      }
    },
    30000
  )

  // ---- 11: the mutex db is a rollback journal, not WAL (direct check) ---
  // Cheap and direct rather than relying on the -wal/-shm sidecar-file
  // absence arms 3/4 already assert incidentally: a WAL mutation is
  // measured to already fail those arms (WAL leaves -wal/-shm files behind,
  // which arm 3's/4's directory-listing assertion catches), so this is
  // belt-and-braces for the header's own explicit "ROLLBACK JOURNAL, NOT
  // WAL" claim, asserted against the property itself rather than a
  // byproduct of it.

  it.skipIf(!canRun)(
    `arm 11: the launcher mutex db is opened in journal_mode=delete, per the header's own claim (${skipReason})`,
    async () => {
      const cwd = scratchCwd()
      const cliPath = makeCliPath(cwd)
      const r = await runGuard(cwd, cliPath)
      expect(r.status, `output: ${r.output}`).toBe(0)
      const Database = require_(sqliteModule as string)
      const db = new Database(mutexPathOf(cwd))
      try {
        const mode = db.pragma('journal_mode', { simple: true })
        note(`arm 11: journal_mode=${mode}`)
        expect(mode).toBe('delete')
      } finally {
        db.close()
      }
    },
    30000
  )

  // ---- 12: a large diagnostic line survives the pipe intact -------------

  it.skipIf(!canRun)(
    `arm 12: a line past the pipe buffer size arrives intact (writeSync loop, not process.stderr.write) (${skipReason})`,
    async () => {
      const cwd = scratchCwd()
      const cliPath = makeCliPath(cwd)
      const PAD_BYTES = 300000
      const padding = 'x'.repeat(PAD_BYTES)
      for (let i = 0; i < 5; i++) {
        const r = await runGuard(cwd, cliPath, {
          RUFLO_GUARD_TEST_STDERR_PAD_BYTES: String(PAD_BYTES),
        })
        note(`arm 12 run ${i + 1}: exit=${r.status} captured length=${r.output.length}`)
        expect(r.status, `run ${i + 1} output length ${r.output.length}`).toBe(0)
        // The whole padding line, byte for byte -- a truncation at the pipe
        // buffer boundary (measured against a process.stderr.write mutant:
        // 5/5 runs cut off mid-line at 65636 captured bytes) would fail
        // this exact assertion, not merely shrink a length check.
        expect(
          r.output,
          `run ${i + 1}: line truncated, captured length ${r.output.length}`
        ).toContain(padding)
      }
    },
    30000
  )

  // ---- legacy sweep: the A1.4 sibling file is inert, not load-bearing --

  it.skipIf(!canRun)(
    `legacy: a dead-pid pre-A1.8 sibling file is swept; anything else is left in place (${skipReason})`,
    async () => {
      const deadCwd = scratchCwd()
      const deadCli = makeCliPath(deadCwd)
      const deadSibling = join(policyDirOf(deadCwd), 'state.lock.launcher')
      writeFileSync(
        deadSibling,
        JSON.stringify({ formatVersion: 1, pid: DEAD_PID, startTime: '1', nonce: 'x' })
      )
      const swept = await runGuard(deadCwd, deadCli)
      note(`legacy (dead pid): exit=${swept.status} elapsed=${swept.elapsed}ms`)
      expect(swept.status, `output: ${swept.output}`).toBe(0)
      expect(existsSync(deadSibling), `output: ${swept.output}`).toBe(false)

      const keepCwd = scratchCwd()
      const keepCli = makeCliPath(keepCwd)
      const keepSibling = join(policyDirOf(keepCwd), 'state.lock.launcher')
      writeFileSync(keepSibling, 'not json at all')
      const kept = await runGuard(keepCwd, keepCli)
      note(`legacy (unparseable): exit=${kept.status} elapsed=${kept.elapsed}ms`)
      expect(kept.status, `output: ${kept.output}`).toBe(0)
      expect(readFileSync(keepSibling, 'utf8')).toBe('not json at all')
    },
    30000
  )

  // ---- L-5: USER_HZ verification (post-merge governance retro, PR #2931) --
  it.skipIf(!canRun)(
    `L-5: a measured CLK_TCK that disagrees with the assumed USER_HZ=100 refuses, fail closed (${skipReason})`,
    async () => {
      const cwd = scratchCwd()
      const cliPath = makeCliPath(cwd)
      const r = await runGuard(cwd, cliPath, { RUFLO_GUARD_TEST_CLK_TCK: '250' })
      note(`L-5 (CLK_TCK=250): exit=${r.status} elapsed=${r.elapsed}ms`)
      expect(r.status, `output: ${r.output}`).toBe(1)
      expect(r.output).toContain('250')
      expect(r.output).toContain('USER_HZ=100')
    },
    15000
  )

  it.skipIf(!canRun)(
    `L-5: a measured CLK_TCK equal to the assumed USER_HZ=100 authorizes normally (${skipReason})`,
    async () => {
      const cwd = scratchCwd()
      const cliPath = makeCliPath(cwd)
      const r = await runGuard(cwd, cliPath, { RUFLO_GUARD_TEST_CLK_TCK: '100' })
      note(`L-5 (CLK_TCK=100): exit=${r.status} elapsed=${r.elapsed}ms`)
      expect(r.status, `output: ${r.output}`).toBe(0)
    },
    15000
  )

  // ---- L-6: a leaked same-pid probe file is retried, not misreported -----
  it.skipIf(!canRun)(
    `L-6: a leaked probe file at the guard's own pid is unlinked and retried, not misreported as unwritable (${skipReason})`,
    async () => {
      const cwd = scratchCwd()
      const cliPath = makeCliPath(cwd)
      const guard = launchGuard(cwd, cliPath)
      const pid = guard.child.pid
      expect(pid, 'guard child must have been assigned a pid').toBeTypeOf('number')
      // Pre-create a stale probe at the EXACT path probeWritable() will
      // O_EXCL-create for its own pid, in all three probed directories --
      // written synchronously, before any `await`, so this lands well
      // before the freshly-spawned node process finishes loading this
      // ~800-line file and reaches main()'s writability-probe loop.
      const leaked = [policyDirOf(cwd), join(cwd, '.swarm'), cwd].map((dir) =>
        join(dir, `.ruflo-guard-probe-${pid}`)
      )
      for (const f of leaked) writeFileSync(f, 'stale leaked probe from a prior crashed run')
      const result = await guard.done
      note(`L-6: exit=${result.status} elapsed=${result.elapsed}ms`)
      expect(result.status, `output: ${result.output}`).toBe(0)
      for (const f of leaked) {
        expect(existsSync(f), `output: ${result.output}`).toBe(false)
      }
    },
    15000
  )

  // ---- M-14: writability-probe failure arms (setpriv-gated) -----------
  // The dev/ruflo containers run as root, which bypasses every permission
  // check these arms depend on -- so they must drop to an unprivileged uid
  // via setpriv to actually observe a directory refusing a write. Measured
  // live: mkdirSync's default mode here is 0755 owned by root -- "others"
  // (uid 1000, outside the owning group) get only r-x on EVERY probed
  // directory by default, so cwd/.claude-flow/the non-target probe dir must
  // be explicitly opened to 0777 wherever the test does NOT want that
  // directory to be the one that fails -- otherwise the FIRST directory in
  // main()'s probe order ([policyDir, swarmDir, cwd]) fails regardless of
  // which one the test means to target. Only the ONE directory each arm is
  // actually testing is set to 0555 (read+execute, no write).

  function runAsUid1000(cwd: string, cliPath: string) {
    const r = spawnSync(
      'setpriv',
      ['--reuid=1000', '--regid=1000', '--clear-groups', 'node', GUARD_PATH],
      {
        cwd,
        env: {
          ...process.env,
          RUFLO_GUARD_CLI_PATH: cliPath,
          ...(sqliteModule ? { RUFLO_GUARD_SQLITE_MODULE: sqliteModule } : {}),
        },
        encoding: 'utf8',
      }
    )
    if (r.error) throw r.error
    return r
  }

  it.skipIf(!hasSetpriv)(
    `M-14: writable cwd, read-only .claude-flow/policy -- exit 1 naming that path (${setprivSkipReason})`,
    () => {
      const cwd = scratchCwd()
      const cliPath = makeCliPath(cwd)
      const policyDir = policyDirOf(cwd)
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
      const swarmDir = join(cwd, '.swarm')
      chmodSync(cwd, 0o777)
      chmodSync(join(cwd, '.claude-flow'), 0o777)
      chmodSync(policyDirOf(cwd), 0o777)
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

  if (!canRun) {
    it(`prints its skip reason (${skipReason})`, () => {
      // A non-skipped canary so a `vitest run` of this file where the suite
      // cannot run always reports at least one PASS naming why the rest
      // skipped, rather than a suite of silent skips with no visible reason.
      expect(skipReason).not.toBe('')
    })
  }

  // Cleanup happens per-process-exit (mktemp dirs under the OS tmpdir), but
  // best-effort explicit cleanup keeps a long-lived CI runner tidy too.
  it.skipIf(!canRun)('cleanup', () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })
})
