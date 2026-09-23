#!/usr/bin/env node
/**
 * ruflo-launch-guard.mjs -- SMI-6744 A1.4, ADR-170 §§ 4, 7.
 *
 * Runs INSIDE the ruflo service container, piped into `node -` over
 * `docker exec -i`'s stdin by scripts/mcp-ruflo-launcher.sh, immediately
 * before that launcher execs the real server. Plain Node ESM, no deps (must
 * run against whatever Node ships in the `ruflo` image stage, unmodified).
 *
 * Two things this does, both host-unreachable (no /proc on macOS, and the
 * writability/uid check must run as the server's own uid):
 *
 * 1. Per-spawn writability probes (§ 4): exclusive-create-then-delete a
 *    probe file in <cwd>/.claude-flow/policy, <cwd>/.swarm (the database
 *    dir), and the cwd root. `mkdir -p` at container start proves a dir can
 *    be CREATED, not that it stays WRITABLE (a read-only remount still
 *    passes `mkdir -p` on an already-existing dir) -- why this reprobes.
 *
 * 2. The sibling-lock staleness protocol (§ 4): the launcher never acquires
 *    the runtime's own `<cwd>/.claude-flow/policy/state.lock` -- releasing
 *    it before exec reopens the race it exists to close, and holding it
 *    across exec would make the spawned server's own
 *    `openSync(state.lock, 'wx')` fail every time. Staleness decisions
 *    about state.lock are instead serialized by a DISTINCT sibling file,
 *    `state.lock.launcher`, created with atomic `wx`, whose record carries
 *    a format version, PID, the Linux start time read from
 *    /proc/self/stat field 22, an instance nonce, and a timestamp. A
 *    contender validates a record by PID AND start time -- liveness alone,
 *    or elapsed time alone, never proves ownership or staleness (a
 *    recycled PID with a different start time must still recover). The
 *    owner removes the sibling immediately before the launcher's exec,
 *    after the real-lock decision. An unreadable, malformed, or otherwise
 *    unauthenticated record is UNRESOLVED and NEVER removed automatically
 *    -- sibling or real lock. STALE TAKEOVER USES AN ATOMIC RENAME, NEVER
 *    unlink-then-recreate (H-4, SMI-6744 governance review round 2):
 *    `renameSync` moves whatever CURRENTLY sits at the ORIGINAL sibling
 *    path -- a late contender's rename of an ALREADY-VACATED path (the
 *    winner moved it away and hasn't recreated it yet) gets ENOENT, and
 *    that is the common case in production, where the classify-to-rename
 *    gap is a handful of synchronous statements. Unlink followed by a
 *    separate write is NOT atomic across two processes: A can unlink the
 *    stale record, write its own, and have that live record unlinked out
 *    from under it by B's own (stale-classified, already-in-flight)
 *    recovery attempt, before A ever reads back what it wrote -- a
 *    post-hoc nonce read-back cannot close this, because the clobber
 *    happens strictly after the read that would have caught it. Renaming
 *    makes the decision itself the atomic step ADR-170 § 4 requires
 *    ("exactly one performs the staleness decision"), not a decision
 *    followed by a hopeful verification.
 *
 *    RENAME ALONE IS NOT SUFFICIENT (measured, same round): rename moves by
 *    PATH, not by identity. A contender that pauses between classifying a
 *    record stale and actually renaming it (the RUFLO_GUARD_TEST_PAUSE_
 *    AFTER_CLASSIFY_MS test seam widens this window on purpose; an unlucky
 *    OS-level descheduling could in principle do the same in production)
 *    can successfully rename a DIFFERENT record into its own capture file
 *    -- one a faster contender already wrote in its place after winning
 *    its own, earlier rename. Confirmed live: without a post-capture
 *    re-check, this produced two contenders BOTH exiting 0, one of them
 *    having silently destroyed the live winner's record -- the exact
 *    double-spawn hazard this file exists to prevent. So every captured
 *    record is re-classified immediately after the rename succeeds, before
 *    being trusted: genuinely stale -> discard and proceed; anything else
 *    -> rename it back to the sibling path (best-effort) and refuse,
 *    because a live record captured by mistake is evidence, not garbage.
 *
 *    Two residuals, stated rather than claimed (SMI-6744 A1.4 fix round,
 *    handed to the A1.8 cross-family gate as the SMI-6015 confirmation round):
 *    (a) the lost-race branch below (rename hit ENOENT) re-reads before it
 *    acts, but that re-read is reachable only through a sub-millisecond window
 *    -- an 8-way racer caught its removal 1 run in 25 -- so no committed arm
 *    pins it reliably; (b) with three or more contenders, a LIVE record that
 *    was captured and is being renamed back leaves the sibling path empty for
 *    the duration of the re-validation, and a third contender's wx write
 *    succeeds in that gap. The harm of (b) is bounded to two launchers both
 *    performing the real-lock staleness decision, one spawn per session start
 *    apart; a recovery-lock level would close it and is ADR-170 v5.4 item (10)
 *    if the gate asks for it.
 *
 * The real `state.lock`'s on-disk format is owned by @claude-flow/cli, not
 * this repo, and is not committed anywhere this script can read at build
 * time. Measured live (SMI-6744 governance review, C-1):
 * @claude-flow/cli's policy-runtime.js writes it as JSON
 * `{"pid":<int>,"acquiredAt":<Date.now() ms>}`, holds it only across a
 * policy transaction, and self-heals a lock whose mtime exceeds its own
 * 30 s staleness window -- this guard never authenticated that shape and
 * refused every real lock as malformed. This guard now accepts BOTH that
 * runtime shape and this file's own sibling shape (pid + a numeric startTime
 * string, /proc/self/stat field 22 clock ticks) when reading a record; a
 * runtime-shaped pid is classified live/stale by
 * converting /proc/<pid>/stat field 22 (clock ticks since boot) plus
 * /proc/stat's `btime` line to an epoch-ms process start time and comparing
 * it against the lock's `acquiredAt` (later than acquiredAt+2s means the
 * pid was recycled -- stale). Any OTHER shape (a shape this guard cannot
 * authenticate) is UNRESOLVED. For the SIBLING file, UNRESOLVED is refused
 * and never deleted, matching the original design. For the REAL lock,
 * UNRESOLVED must not wedge the server (the runtime's own served process
 * writes the shape this guard now understands, so a genuinely unresolved
 * real lock means a future/unknown runtime format, not a bug in this
 * guard) -- it is logged as a warning and the guard proceeds, trusting the
 * runtime's own 30 s staleness rule. Threat model: excludes a same-uid
 * process able to forge files in the policy dir -- then this is advisory.
 *
 * This file deliberately does NOT reuse packages/core/src/config/
 * owned-lock* (the `V1Claim {v,pid,token,host,acquiredAt}` shape) even
 * though the shapes rhyme: this script is piped into a bare `node -` with
 * no node_modules and must stay a dependency-free single file, so it can
 * never import from @skillsmith/core.
 *
 * Exit codes (each prints one "[ruflo] guard: ..." line to stderr naming
 * the failing check, and every refusal -- codes 3, 4, 5 -- ends that line
 * with a one-line recovery command): 0 authorized; 1 writability probe
 * failed; 2 entrypoint realpath mismatch; 3 sibling lock live (another
 * launcher); 4 sibling lock unresolved; 5 real state.lock live (another
 * server); 6 UNUSED/retired -- an unresolved or malformed REAL state.lock
 * no longer refuses (see above; it warns and proceeds), so this code is
 * never emitted, kept only so a future genuinely-fatal real-lock condition
 * has a free slot; 7 internal error (a bug here, not a refusal -- also now
 * the catch-all for any uncaught exception from main()).
 */
import {
  closeSync,
  constants as FS,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TAG = '[ruflo] guard:'
const FORMAT_VERSION = 1
const RUFLO_CONTAINER = 'skillsmith-ruflo-1'
const USER_HZ = 100
// A runtime-shaped lock's owning pid started strictly after acquiredAt --
// its start time can only ever be >= acquiredAt for a genuine owner. Slack
// absorbs clock/measurement noise (Date.now() ms vs. tick-derived ms);
// anything past it means the pid was recycled onto an unrelated process.
const RUNTIME_RECYCLE_SLACK_MS = 2000
const errMsg = (err) => (err && err.message ? err.message : String(err))

function fail(code, message) {
  process.stderr.write(`${TAG} ${message}\n`)
  process.exit(code)
}

/** One-line recovery command for a live/contended REAL state.lock refusal. */
function realLockRecoveryHint(lockPath) {
  return (
    `recover: confirm no live server first (docker exec ${RUFLO_CONTAINER} ` +
    `ps -eo pid,etimes,args), then docker exec ${RUFLO_CONTAINER} rm -f ${lockPath}`
  )
}

/** One-line recovery command for a live/contended/unresolved SIBLING refusal. */
function siblingRecoveryHint(siblingPath) {
  return (
    `recover: confirm no live launcher first (docker exec ${RUFLO_CONTAINER} ` +
    `ps -eo pid,etimes,args), then docker exec ${RUFLO_CONTAINER} rm -f ${siblingPath}`
  )
}

/** /proc/<pid>/stat field 22 (starttime), as a decimal string of clock ticks
 * since boot. Throws on any read/parse failure. */
function readStartTime(pid) {
  const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const close = raw.lastIndexOf(')')
  if (close === -1) throw new Error(`unparseable /proc/${pid}/stat (no comm delimiter)`)
  // rest[0] is field 3 (state); field 22 (starttime) is rest[19].
  const rest = raw
    .slice(close + 2)
    .trim()
    .split(/\s+/)
  const starttime = rest[19]
  if (!starttime || !/^\d+$/.test(starttime)) {
    throw new Error(`unparseable /proc/${pid}/stat (starttime field missing)`)
  }
  return starttime
}

/** System boot time in epoch seconds, from /proc/stat's `btime` line. Throws
 * on any read/parse failure. */
function readBootTimeEpochSec() {
  const raw = readFileSync('/proc/stat', 'utf8')
  const line = raw.split('\n').find((l) => l.startsWith('btime '))
  if (!line) throw new Error('no btime line in /proc/stat')
  const sec = Number(line.trim().split(/\s+/)[1])
  if (!Number.isFinite(sec)) throw new Error(`unparseable btime line in /proc/stat: ${line}`)
  return sec
}

/** `pid`'s process start time as epoch milliseconds, derived from
 * /proc/<pid>/stat field 22 (clock ticks since boot, USER_HZ=100 on Linux)
 * plus /proc/stat's `btime`. Throws on any read/parse failure. */
function pidStartTimeEpochMs(pid) {
  const ticks = Number(readStartTime(pid))
  const bootSec = readBootTimeEpochSec()
  return bootSec * 1000 + (ticks / USER_HZ) * 1000
}

/** true = alive; false = confirmed absent (ENOENT); throws = cannot determine. */
function isPidAlive(pid) {
  try {
    readFileSync(`/proc/${pid}/stat`, 'utf8')
    return true
  } catch (err) {
    if (err && err.code === 'ENOENT') return false
    throw err
  }
}

/**
 * Exclusive-create then delete a probe file under `dir`. Throws, naming
 * `dir`, on failure to create. The filename is fixed per-pid (not per-call
 * randomUUID()) so a swallowed unlink failure can never accumulate more
 * than one leaked probe per directory per running guard process (L-16) --
 * `.swarm` is the SQLite directory on a persistent volume, so unbounded
 * `.ruflo-guard-probe-*` litter there is a real accumulation risk, not
 * cosmetic. A failed unlink is warned to stderr, never swallowed: the probe
 * already proved writability by the time unlink is attempted, so this is
 * diagnostic, not a refusal.
 */
function probeWritable(dir) {
  const p = join(dir, `.ruflo-guard-probe-${process.pid}`)
  let fd
  try {
    fd = openSync(p, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY)
  } catch (err) {
    throw new Error(`cannot write to ${dir}: ${errMsg(err)}`)
  }
  closeSync(fd)
  try {
    unlinkSync(p)
  } catch (err) {
    process.stderr.write(`${TAG} warning: could not remove probe file ${p}: ${errMsg(err)}\n`)
  }
}

/**
 * Reads+parses `path`. Never throws:
 *   {present:false}
 * | {present:true, malformed:true, reason}
 * | {present:true, malformed:false, shape:'sibling', record}
 * | {present:true, malformed:false, shape:'runtime', record}
 *
 * Recognizes TWO shapes (C-1): this file's own sibling-record shape
 * ({pid, startTime}, this repo's format, strict) and the runtime's actual
 * `state.lock` shape ({pid, acquiredAt}, @claude-flow/cli's
 * policy-runtime.js, measured live). A record matching neither is
 * malformed. Callers reading the SIBLING path must additionally reject a
 * runtime-shaped record as unexpected there (sibling reads stay strict to
 * this repo's own format) -- this function only classifies the shape, it
 * does not decide which shapes are acceptable at which path.
 */
function readRecord(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return { present: false }
    return { present: true, malformed: true, reason: errMsg(err) }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { present: true, malformed: true, reason: `not valid JSON: ${err.message}` }
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { present: true, malformed: true, reason: 'missing/invalid pid or startTime' }
  }
  const isSibling =
    Number.isInteger(parsed.pid) &&
    typeof parsed.startTime === 'string' &&
    /^\d+$/.test(parsed.startTime)
  if (isSibling) return { present: true, malformed: false, shape: 'sibling', record: parsed }
  const isRuntime = Number.isInteger(parsed.pid) && Number.isFinite(parsed.acquiredAt)
  if (isRuntime) return { present: true, malformed: false, shape: 'runtime', record: parsed }
  return { present: true, malformed: true, reason: 'missing/invalid pid or startTime' }
}

/**
 * 'live' (pid alive AND start time/acquiredAt corroborate -- refuse, never
 * delete), 'stale' (pid dead, or a live pid whose actual start time
 * contradicts the record -- a recycled pid -- both recoverable), or
 * 'unresolved' (liveness could not be determined -- refuse, never delete).
 *
 * `shape` selects the validation discipline: 'sibling' uses this repo's own
 * pid+startTime match (exact string equality, as before); 'runtime' uses
 * the real state.lock's pid+acquiredAt shape, converting the pid's actual
 * /proc start time to epoch ms and requiring it not to postdate the
 * record's acquiredAt by more than RUNTIME_RECYCLE_SLACK_MS (a start time
 * meaningfully AFTER acquiredAt means the pid was recycled onto an
 * unrelated process after the lock was written).
 */
function classifyRecord(record, shape) {
  let alive
  try {
    alive = isPidAlive(record.pid)
  } catch {
    return { status: 'unresolved', reason: `pid ${record.pid} liveness undeterminable` }
  }
  if (!alive) return { status: 'stale', reason: `pid ${record.pid} is not running` }

  if (shape === 'runtime') {
    let startedAtMs
    try {
      startedAtMs = pidStartTimeEpochMs(record.pid)
    } catch (err) {
      return {
        status: 'unresolved',
        reason: `pid ${record.pid} start time unreadable (${errMsg(err)})`,
      }
    }
    if (startedAtMs > record.acquiredAt + RUNTIME_RECYCLE_SLACK_MS) {
      return {
        status: 'stale',
        reason:
          `pid ${record.pid} started at ${startedAtMs} after lock acquiredAt ` +
          `${record.acquiredAt} (recycled pid)`,
      }
    }
    return {
      status: 'live',
      reason: `pid ${record.pid} (started ${startedAtMs}, acquiredAt ${record.acquiredAt}) is the live owner`,
    }
  }

  let actual
  try {
    actual = readStartTime(record.pid)
  } catch {
    return { status: 'unresolved', reason: `pid ${record.pid} start time unreadable` }
  }
  if (actual !== record.startTime) {
    return {
      status: 'stale',
      reason: `pid ${record.pid} start time ${actual} != recorded ${record.startTime} (recycled pid)`,
    }
  }
  return {
    status: 'live',
    reason: `pid ${record.pid} (start ${record.startTime}) is the live owner`,
  }
}

function writeOwnRecord(path) {
  const startTime = readStartTime(process.pid)
  const record = {
    formatVersion: FORMAT_VERSION,
    pid: process.pid,
    startTime,
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
  }
  const fd = openSync(path, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY)
  try {
    writeSync(fd, JSON.stringify(record))
  } finally {
    closeSync(fd)
  }
  return record
}

// Test seam only (scripts/tests/ruflo-launch-guard.test.ts): synchronously
// blocks for RUFLO_GUARD_TEST_HOLD_MS after acquiring the sibling, widening
// the contention window so a second real invocation deterministically
// observes this process as the live owner. No-op in production (unset).
function testSeamHold() {
  const ms = Number(process.env.RUFLO_GUARD_TEST_HOLD_MS || 0)
  if (!(ms > 0)) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // best-effort; only affects test determinism, never a real refusal
  }
}

// Test seam only (scripts/tests/ruflo-launch-guard.test.ts): read once at
// startup, unlike RUFLO_GUARD_TEST_HOLD_MS above. Pauses AFTER classifying
// an existing sibling record as stale but BEFORE the arbitrating rename, so
// a test can deterministically land two contenders on the SAME classified
// stale record before either acts, instead of relying on process-startup
// timing luck. No-op in production (unset/NaN).
const TEST_PAUSE_AFTER_CLASSIFY_MS = Number(
  process.env.RUFLO_GUARD_TEST_PAUSE_AFTER_CLASSIFY_MS || 0
)

function testSeamPauseAfterClassify() {
  if (!(TEST_PAUSE_AFTER_CLASSIFY_MS > 0)) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TEST_PAUSE_AFTER_CLASSIFY_MS)
  } catch {
    // best-effort; only affects test determinism, never a real refusal
  }
}

/** Sibling reads are strict to this repo's own shape (readRecord recognizes
 * both shapes; a runtime-shaped record found at the SIBLING path is treated
 * as unexpected/malformed here, never authenticated). */
function classifySiblingRead(existing) {
  if (existing.malformed || existing.shape !== 'sibling') {
    const reason = existing.malformed ? existing.reason : 'unexpected record shape'
    return { unresolved: true, reason }
  }
  return { unresolved: false, record: existing.record }
}

function acquireSiblingRecord(siblingPath) {
  let mine
  try {
    mine = writeOwnRecord(siblingPath)
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err
  }
  if (!mine) {
    // Contention: someone else's sibling record is already there.
    const existing = classifySiblingRead(readRecord(siblingPath))
    if (existing.unresolved)
      fail(
        4,
        `sibling ${siblingPath} unresolved (${existing.reason}). ${siblingRecoveryHint(siblingPath)}`
      )
    const v = classifyRecord(existing.record, 'sibling')
    if (v.status === 'live')
      fail(
        3,
        `sibling ${siblingPath} held by a live launcher -- ${v.reason}. ${siblingRecoveryHint(siblingPath)}`
      )
    if (v.status === 'unresolved')
      fail(
        4,
        `sibling ${siblingPath} unresolved (${v.reason}). ${siblingRecoveryHint(siblingPath)}`
      )
    // status === 'stale': ARBITRATE the takeover with an atomic rename, not
    // unlink-then-recreate (H-4 round 2). renameSync arbitrates on the
    // sibling's inode: exactly one contender's rename of THIS path can
    // succeed; every other contender's rename of the same path gets ENOENT.
    // That makes the staleness decision itself the atomic step, closing the
    // window a separate unlink+write pair (and a post-hoc nonce read-back)
    // cannot -- see the header for the full interleaving this replaces.
    testSeamPauseAfterClassify()
    const stalePath = `${siblingPath}.stale.${process.pid}`
    try {
      renameSync(siblingPath, stalePath)
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        fail(
          4,
          `sibling ${siblingPath} stale-recovery rename failed (${errMsg(err)}). ${siblingRecoveryHint(siblingPath)}`
        )
      }
      // We LOST the rename race: another contender already renamed the
      // original sibling away. Re-read whatever is at the sibling path now
      // -- never assume it is safe to write over.
      const after = readRecord(siblingPath)
      if (!after.present) {
        // Nothing there yet (the winner hasn't written its own record, or
        // already finished and cleaned up). Retry our own acquisition
        // exactly once; a fresh contender racing THIS window is the
        // runtime's own residual contention, not ours to keep chasing.
        try {
          mine = writeOwnRecord(siblingPath)
        } catch (err2) {
          if (!err2 || err2.code !== 'EEXIST') throw err2
          const raced = classifySiblingRead(readRecord(siblingPath))
          if (raced.unresolved)
            fail(
              4,
              `sibling ${siblingPath} unresolved during stale recovery (${raced.reason}). ${siblingRecoveryHint(siblingPath)}`
            )
          const rv = classifyRecord(raced.record, 'sibling')
          if (rv.status === 'live')
            fail(
              3,
              `sibling ${siblingPath} taken by a live launcher during recovery -- ${rv.reason}. ${siblingRecoveryHint(siblingPath)}`
            )
          fail(
            4,
            `sibling ${siblingPath} contended during stale recovery (${rv.reason}). ${siblingRecoveryHint(siblingPath)}`
          )
        }
      } else {
        const afterClassified = classifySiblingRead(after)
        if (afterClassified.unresolved)
          fail(
            4,
            `sibling ${siblingPath} unresolved during stale recovery (${afterClassified.reason}). ${siblingRecoveryHint(siblingPath)}`
          )
        const av = classifyRecord(afterClassified.record, 'sibling')
        if (av.status === 'live')
          fail(
            3,
            `sibling ${siblingPath} taken by another launcher during recovery -- ${av.reason}. ${siblingRecoveryHint(siblingPath)}`
          )
        // Present and STALE AGAIN: the winner of the rename we lost against
        // must have died between its rename and its own write (its record
        // is the OTHER contender's own `.stale.<pid>` file, not this one --
        // we cannot tell whose), and a new stale record has appeared here.
        // Refuse rather than loop; the next invocation gets a fresh attempt.
        fail(
          4,
          `sibling ${siblingPath} unresolved during stale recovery (a new stale record appeared -- ${av.reason}). ${siblingRecoveryHint(siblingPath)}`
        )
      }
    }
    if (!mine) {
      // We WON the rename: the original sibling is now ours alone at
      // `stalePath`, unreachable by any other contender (they only ever
      // race the ORIGINAL siblingPath). BUT winning the rename only proves
      // we captured WHATEVER was at that path -- not that it is still the
      // stale record we classified. `renameSync` moves by PATH, not by
      // identity, so a contender that paused between classifying-stale and
      // renaming (the test seam widens this; an unlucky descheduling could
      // in principle do the same in production) can capture a DIFFERENT,
      // now-LIVE record that a faster contender already wrote in its place
      // (measured: without this re-check, exactly this happened -- both
      // contenders exited 0 and the live owner's record was silently
      // destroyed, the double-spawn hazard this whole file exists to
      // prevent). So the captured file is re-classified before being
      // trusted, and only discarded if it is STILL provably stale.
      const captured = classifySiblingRead(readRecord(stalePath))
      const cv = captured.unresolved ? null : classifyRecord(captured.record, 'sibling')
      if (captured.unresolved || cv.status !== 'stale') {
        // We captured a live (or unresolved) record by mistake. Put it
        // back where we found it so its real owner's own eventual cleanup
        // still works, then refuse -- never discard evidence we did not
        // prove is stale.
        try {
          renameSync(stalePath, siblingPath)
        } catch (err) {
          if (err && err.code === 'EEXIST') {
            // Something else already occupies siblingPath now: not ours to
            // overwrite. The captured file is retained (not discarded) so
            // its content is not lost.
            process.stderr.write(
              `${TAG} warning: could not restore captured record ${stalePath}: ${siblingPath} is occupied again; ${stalePath} retained\n`
            )
          } else {
            process.stderr.write(
              `${TAG} warning: could not restore captured record ${stalePath} to ${siblingPath}: ${errMsg(err)}\n`
            )
          }
        }
        if (captured.unresolved)
          fail(
            4,
            `sibling ${siblingPath} captured record unresolved during stale recovery (${captured.reason}). ${siblingRecoveryHint(siblingPath)}`
          )
        fail(
          3,
          `sibling ${siblingPath} was taken by another launcher during recovery (captured record turned out live) -- ${cv.reason}. ${siblingRecoveryHint(siblingPath)}`
        )
      }
      // Confirmed stale. Discard it -- best-effort, never a refusal --
      // then write our own fresh record at the sibling path.
      try {
        unlinkSync(stalePath)
      } catch (err) {
        if (!err || err.code !== 'ENOENT') {
          process.stderr.write(
            `${TAG} warning: could not remove captured stale record ${stalePath}: ${errMsg(err)}\n`
          )
        }
      }
      try {
        mine = writeOwnRecord(siblingPath)
      } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err
        // Only reachable if some OTHER contender performed a fresh (never
        // renamed-away) `wx` acquisition in the narrow window between our
        // unlink of stalePath and this write -- every stale contender's own
        // rename of siblingPath would instead have hit ENOENT while we held
        // it. Classify exactly like the first contention branch.
        const raced = classifySiblingRead(readRecord(siblingPath))
        if (raced.unresolved)
          fail(
            4,
            `sibling ${siblingPath} unresolved during stale recovery (${raced.reason}). ${siblingRecoveryHint(siblingPath)}`
          )
        const rv = classifyRecord(raced.record, 'sibling')
        if (rv.status === 'live')
          fail(
            3,
            `sibling ${siblingPath} taken by a live launcher during recovery -- ${rv.reason}. ${siblingRecoveryHint(siblingPath)}`
          )
        fail(
          4,
          `sibling ${siblingPath} contended during stale recovery (${rv.reason}). ${siblingRecoveryHint(siblingPath)}`
        )
      }
    }
    // Cheap extra layer, no longer load-bearing (the rename above is the
    // actual arbitration): read back and require our own nonce.
    const verify = classifySiblingRead(readRecord(siblingPath))
    if (verify.unresolved || verify.record.nonce !== mine.nonce) {
      fail(
        3,
        `sibling ${siblingPath} was taken by another launcher during recovery. ${siblingRecoveryHint(siblingPath)}`
      )
    }
  }
  testSeamHold()
  return mine
}

/**
 * The REAL lock is fundamentally different from the sibling: an
 * unresolved/malformed record here must NOT wedge the server launch (C-1)
 * -- the runtime's own served process writes the {pid, acquiredAt} shape
 * this guard now authenticates, so a shape this guard still cannot
 * authenticate means an unknown/future runtime format, not evidence of a
 * live owner, and the runtime applies its own 30 s staleness rule
 * regardless of what this guard concludes. So: malformed/unresolved -> warn
 * and proceed (never delete); live -> refuse (exit 5, never delete); stale
 * -> remove and proceed, exactly as before.
 */
function checkRealLock(lockPath) {
  const existing = readRecord(lockPath)
  if (!existing.present) return // absent -- ok
  if (existing.malformed) {
    process.stderr.write(
      `${TAG} warning: state.lock ${lockPath} unresolved (${existing.reason}); proceeding, ` +
        `the runtime applies its own 30 s staleness rule\n`
    )
    return
  }
  const v = classifyRecord(existing.record, existing.shape)
  if (v.status === 'live')
    fail(
      5,
      `state.lock ${lockPath} held by a live server -- ${v.reason}. ${realLockRecoveryHint(lockPath)}`
    )
  if (v.status === 'unresolved') {
    process.stderr.write(
      `${TAG} warning: state.lock ${lockPath} unresolved (${v.reason}); proceeding, ` +
        `the runtime applies its own 30 s staleness rule\n`
    )
    return
  }
  // stale -- proven no live owner under the record's own validation discipline.
  try {
    unlinkSync(lockPath)
    process.stderr.write(`${TAG} removed stale state.lock at ${lockPath} (${v.reason})\n`)
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err
  }
}

function main() {
  const cliPath = process.env.RUFLO_GUARD_CLI_PATH
  if (!cliPath) fail(7, 'RUFLO_GUARD_CLI_PATH not set -- launcher must pass it via docker exec -e')
  let resolved
  try {
    resolved = realpathSync(cliPath)
  } catch (err) {
    fail(2, `entrypoint realpath failed for ${cliPath}: ${errMsg(err)}`)
  }
  if (resolved !== cliPath) fail(2, `entrypoint realpath ${resolved} != expected ${cliPath}`)

  const cwd = process.cwd()
  const policyDir = join(cwd, '.claude-flow', 'policy')
  const swarmDir = join(cwd, '.swarm')
  for (const dir of [policyDir, swarmDir, cwd]) {
    try {
      probeWritable(dir)
    } catch (err) {
      fail(1, errMsg(err))
    }
  }

  const siblingPath = join(policyDir, 'state.lock.launcher')
  const realLockPath = join(policyDir, 'state.lock')

  acquireSiblingRecord(siblingPath)
  try {
    checkRealLock(realLockPath)
  } finally {
    // Remove the sibling immediately before returning success. A refusal
    // above already called process.exit and never reaches here.
    try {
      unlinkSync(siblingPath)
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        process.stderr.write(
          `${TAG} warning: could not remove sibling ${siblingPath}: ${errMsg(err)}\n`
        )
      }
    }
  }

  process.exit(0)
}

try {
  main()
} catch (err) {
  fail(7, 'internal error: ' + errMsg(err))
}
