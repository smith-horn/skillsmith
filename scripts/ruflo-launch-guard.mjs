#!/usr/bin/env node
/**
 * ruflo-launch-guard.mjs -- SMI-6744 A1.8, ADR-170 §§ 4, 7.
 *
 * Runs INSIDE the ruflo service container, piped into `node -` over
 * `docker exec -i`'s stdin by scripts/mcp-ruflo-launcher.sh, immediately
 * before that launcher execs the real server. Single file, one runtime
 * dependency (better-sqlite3, resolved by absolute path out of the served
 * image -- see § Mutex below), because it is piped into a bare `node -`
 * with no package.json and no node_modules of its own.
 *
 * Two things this does, both host-unreachable (no /proc on macOS, and the
 * writability/uid check must run as the server's own uid):
 *
 * 1. PER-SPAWN WRITABILITY PROBES (§ 4): exclusive-create-then-delete a
 *    probe file in <cwd>/.claude-flow/policy, <cwd>/.swarm (the database
 *    dir), and the cwd root. `mkdir -p` at container start proves a dir can
 *    be CREATED, not that it stays WRITABLE (a read-only remount still
 *    passes `mkdir -p` on an already-existing dir) -- why this reprobes.
 *
 * 2. SERIALIZING THE REAL-LOCK DECISION, then reading (never writing) the
 *    runtime's own `<cwd>/.claude-flow/policy/state.lock`.
 *
 * -- Mutex (replaces the A1.4 sibling-file protocol) ---------------------
 *
 * The A1.4 design serialized launchers with a sibling FILE
 * (`state.lock.launcher`) carrying pid + /proc start time, captured by
 * atomic rename and re-validated after capture. The SMI-6744 A1.8
 * cross-family pre-merge gate (GPT-5.6-Sol, pr-reviewer 1.4.3) BLOCKED it
 * on two paths that both end in a LIVE record being deleted, which is the
 * one outcome the guard exists to prevent:
 *
 *   (a) "checkRealLock() classifies one state.lock incarnation and then
 *       unlinks the current path -- a live runtime lock created between
 *       those two operations is deleted";
 *   (b) "with three contenders, B can capture A's live sibling by rename,
 *       C can wx-create on the now-empty path, B cannot rename back, and
 *       A's unconditional finally-cleanup deletes C's live record."
 *
 * Both are the same root cause: a lock made of ORDINARY FILES has to be
 * cleaned up by a PROCESS, so every crash leaves debris, every debris
 * sweep is a delete, and every delete can hit a successor. The gate asked
 * for "recovery-lock/incarnation-safe revalidation and ownership-checked
 * cleanup ... or stop pre-deleting the runtime lock". This file does both
 * halves by removing the file-shaped lock entirely:
 *
 *   The mutex is a SQLite database at
 *   `<cwd>/.claude-flow/policy/state.lock.launcher.db`, held across the
 *   real-lock decision with `BEGIN IMMEDIATE` and released with `COMMIT`.
 *   SQLite's RESERVED lock is a kernel fcntl(2) byte-range lock: the
 *   kernel drops it when the holder's file descriptors close, crash
 *   included. So there is NO staleness to detect, NO record to classify,
 *   and NOTHING to delete -- ever. A dead holder has already released;
 *   a live one releases when it exits. Measured, SMI-6744 A1.8: a holder
 *   SIGKILLed mid-hold let the next contender acquire in 14 ms.
 *
 *   ROLLBACK JOURNAL, NOT WAL (`journal_mode = delete`, SQLite's own
 *   default, set explicitly here): a contender that gets SQLITE_BUSY must
 *   still be able to READ the owner row to name who it lost to, and WAL
 *   would additionally leave `-wal`/`-shm` siblings in the policy dir --
 *   exactly the residue this redesign exists to eliminate.
 *
 *   `busy_timeout = 3000`: overlapping session starts should SERIALIZE,
 *   not refuse. The decision itself takes single-digit milliseconds, so
 *   3 s absorbs any realistic overlap. Known, bounded exception: the
 *   stale-state.lock wait below (up to 30 s) runs INSIDE the held mutex,
 *   so a second launcher arriving during that window refuses with exit 3
 *   instead of waiting. That refusal is safe and self-describing (retry),
 *   and it is the price of keeping "exactly one launcher decides" true
 *   for the whole decision rather than only part of it.
 *
 *   The `owner` row (pid, /proc start time, nonce, ISO timestamp) is
 *   upserted in its own short transaction BEFORE the mutex is taken, and
 *   is PURELY INFORMATIONAL -- nothing reads it to make a decision. It
 *   exists so a refusal can name who was last seen holding the mutex.
 *   Because it is written before the lock is taken, two launchers that
 *   start within the same couple of milliseconds can leave the loser's
 *   own pid in the row; the refusal message says so rather than
 *   pretending otherwise.
 *
 *   DEVIATION FROM ADR-170 § 4, recorded as ADR-170 v5.4 items 20/21:
 *   § 4's wording describes the sibling-FILE protocol (atomic `wx`
 *   create, pid + start-time record, owner removes it before exec). None
 *   of that survives here. What survives is § 4's actual requirement --
 *   "exactly one performs the staleness decision" -- now discharged by a
 *   kernel lock instead of a file this code has to clean up.
 *
 * -- The runtime's own state.lock: read, never written ------------------
 *
 * `state.lock`'s format is owned by @claude-flow/cli, not this repo.
 * Measured live: policy-runtime.js writes it as JSON
 * `{"pid":<int>,"acquiredAt":<Date.now() ms>}`, holds it only across a
 * policy transaction, and on a CONTENDED acquire unlinks any lock whose
 * mtime is older than its own LOCK_STALE_MS (30 s) before retrying,
 * within a LOCK_WAIT_MS (5 s) budget. That self-heal is the ONLY thing
 * that removes a state.lock. This guard never does, in any branch:
 *
 *   live      -> refuse, exit 5 (another server is mid-transaction).
 *   malformed
 *   /unresolved -> warn and PROCEED (a shape this guard cannot
 *                authenticate means an unknown/future runtime format, not
 *                evidence of an owner; wedging the server on it would be
 *                strictly worse than trusting the runtime's own rule).
 *   stale     -> do NOT unlink. Sleep exactly long enough for the lock's
 *                mtime to clear the runtime's 30 s window
 *                (`30000 - (now - mtimeMs)`, skipped when already <= 0),
 *                so the server this launcher is about to exec clears it
 *                itself on its first contended acquire, well inside its
 *                own 5 s budget. The decision is printed either way.
 *
 * A live pid is distinguished from a RECYCLED one by converting
 * /proc/<pid>/stat field 22 (clock ticks since boot) plus /proc/stat's
 * `btime` to an epoch-ms start time: a start time later than the lock's
 * own `acquiredAt` (plus RUNTIME_RECYCLE_SLACK_MS of clock noise) means
 * the pid was reused by an unrelated process, so the lock is stale.
 *
 * This file deliberately does NOT reuse packages/core/src/config/
 * owned-lock* (the `V1Claim {v,pid,token,host,acquiredAt}` shape) even
 * though the shapes rhyme: piped into a bare `node -`, it can never
 * import from @skillsmith/core.
 *
 * Threat model: UNCHANGED from A1.4 -- excludes a same-uid process able
 * to forge files in the policy dir (it could forge a state.lock, or
 * corrupt the mutex database). Then this is advisory. The mutex removes a
 * CRASH-and-DEBRIS class of bug, not a hostile-local-process class.
 *
 * Exit codes (each prints one "[ruflo] guard: ..." line to stderr naming
 * the failing check; every refusal -- 3, 4, 5 -- ends that line with a
 * one-line recovery command):
 *   0 authorized
 *   1 writability probe failed, OR (SMI-6744 L-5, post-merge governance
 *     retro on PR #2931) getconf CLK_TCK measured something other than the
 *     assumed 100 (see USER_HZ below) -- fails CLOSED rather than trusting
 *     an unverified constant classifyRecord()/pidStartTimeEpochMs() depend
 *     on for the live/stale/recycled decision, because a wrong USER_HZ
 *     inflates a live owner's computed start time past the lock's own
 *     acquiredAt and misclassifies it as a recycled pid -- i.e. stale --
 *     which would let this guard proceed PAST a live real-lock instead of
 *     refusing on it (exit 5). The message names the value read and the
 *     dependent function.
 *   2 entrypoint realpath mismatch
 *   3 launcher mutex held by another launcher (busy timeout elapsed)
 *   4 launcher mutex database unusable (cannot open / not a database)
 *   5 the runtime's real state.lock is held by a LIVE server
 *   6 RETIRED -- never emitted; kept so a future genuinely-fatal
 *     real-lock condition has a free slot
 *   7 internal error (a bug here, or a broken image: also the catch-all
 *     for any uncaught exception from main(), and for a better-sqlite3
 *     that cannot be loaded at all -- which is an image defect, not a
 *     refusal, and must NOT be answered with exit 4's "delete the
 *     database file" advice)
 *
 * Test seams (no-ops in production, all read from the environment):
 *   RUFLO_GUARD_SQLITE_MODULE -- absolute path to better-sqlite3;
 *     defaults to the served image's copy.
 *   RUFLO_GUARD_TEST_HOLD_MS -- hold the mutex this long INSIDE the
 *     transaction, to make contention observable.
 *   RUFLO_GUARD_TEST_PAUSE_AFTER_REALLOCK_CLASSIFY_MS -- pause after
 *     classifying state.lock, before acting on that classification, so a
 *     test can replace the lock underneath a live guard and prove the
 *     guard still never deletes it. The classification line is printed
 *     BEFORE this pause on purpose, so such a test synchronises on an
 *     observed fact rather than on a guessed timing margin.
 *   RUFLO_GUARD_TEST_STDERR_PAD_BYTES -- emit one additional diagnostic
 *     line this many bytes long, via the same emitLine()/writeSync path as
 *     every other line, immediately before the successful exit. Exists to
 *     let a test push a single line past a pipe's buffer size and confirm
 *     it still arrives intact -- see emitLine()'s own doc comment for the
 *     hazard this guards against.
 *   RUFLO_GUARD_TEST_CLK_TCK -- override the measured USER_HZ value
 *     (SMI-6744 L-5) without actually calling getconf. Set to a non-100
 *     value to exercise the fail-closed refusal deterministically; the
 *     real container's own getconf CLK_TCK is confirmed 100 (measured
 *     2026-09-23), so a test cannot otherwise reach that refusal without
 *     this seam.
 */
import {
  closeSync,
  constants as FS,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const TAG = '[ruflo] guard:'
const RUFLO_CONTAINER = 'skillsmith-ruflo-1'
// The served image has no `ps` -- measured live -- so every hint that wants
// to list live processes scans /proc directly instead. Field order matches
// `ps -eo pid,args`'s intent (pid, then the full argv) without depending on
// a binary this image does not ship. Kept as one constant (not inlined per
// hint) so the two exit-3/exit-5 hints can never drift from each other.
const PROC_SCAN_CMD_HINT =
  'sh -c \'for p in /proc/[0-9]*; do printf "%s " "${p#/proc/}"; tr "\\0" " " < "$p/cmdline"; echo; done\''
// .claude/development/claude-flow-guide.md carries a literal copy of this
// hint (L-1, post-merge governance retro on PR #2931) -- update the guide
// together with this constant, never one without the other.
// SMI-6744 L-5 (post-merge governance retro on PR #2931): this was an
// UNVERIFIED assumption -- pidStartTimeEpochMs() below divides by it to
// convert /proc/<pid>/stat's tick-based starttime into epoch ms, and
// classifyRecord() uses that result to decide live vs. stale vs. recycled.
// A wrong USER_HZ silently inflates or deflates every computed startedAtMs,
// which can misclassify a LIVE owner as a recycled (i.e. stale) pid and let
// this guard proceed PAST a real, live state.lock instead of refusing on it
// (exit 5) -- the exact failure mode a fail-OPEN wrong constant produces.
// verifyUserHz() (called once, at the top of main(), before any of that
// logic runs) measures the container's actual getconf CLK_TCK and refuses
// (fails CLOSED, exit 1) unless it equals this literal -- it never
// substitutes the measured value in its place, on purpose: this guard has
// no basis for trusting an unexpected tick rate's arithmetic either, so
// "measured but different" and "could not measure" get the same fail-closed
// treatment as "not measured at all".
const USER_HZ = 100
// A runtime-shaped lock's owning pid started strictly before acquiredAt --
// its start time can only ever be <= acquiredAt for a genuine owner. Slack
// absorbs clock/measurement noise (Date.now() ms vs. tick-derived ms);
// anything past it means the pid was recycled onto an unrelated process.
const RUNTIME_RECYCLE_SLACK_MS = 2000
// @claude-flow/cli policy-runtime.js's own LOCK_STALE_MS, measured live.
// Duplicated here (not imported) because that module is inside the served
// image, not this repo; the two must be kept in step by hand.
const RUNTIME_LOCK_STALE_MS = 30000
const MUTEX_BUSY_TIMEOUT_MS = 3000
const DEFAULT_SQLITE_MODULE = '/opt/ruflo-seed/node_modules/better-sqlite3'
const OWNER_TABLE_DDL =
  'CREATE TABLE IF NOT EXISTS launcher_owner (' +
  'id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, ' +
  'start_time TEXT NOT NULL, nonce TEXT NOT NULL, recorded_at TEXT NOT NULL)'
const OWNER_UPSERT_SQL =
  'INSERT INTO launcher_owner (id, pid, start_time, nonce, recorded_at) ' +
  'VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ' +
  'pid = excluded.pid, start_time = excluded.start_time, ' +
  'nonce = excluded.nonce, recorded_at = excluded.recorded_at'

const errMsg = (err) => (err && err.message ? err.message : String(err))

/**
 * Writes one diagnostic line to stderr SYNCHRONOUSLY, via writeSync(2).
 *
 * NOT process.stderr.write. Stderr is always a pipe here (the launcher
 * captures the guard's output with `guard_out="$(docker exec ... )"`),
 * Node's stream write to a pipe is asynchronous, and `process.exit()` does
 * not drain what is still queued -- and this file's synchronous
 * Atomics.wait sleeps never yield to the event loop, so nothing else
 * drains it either.
 *
 * MEASURED, SMI-6744 A1.8, in this container, write-then-sleep-then-
 * write-then-process.exit(0) with stderr captured by command substitution:
 * with process.stderr.write, a 200-byte second line survived 40/40 runs
 * but a 200 KB second line was lost 20/20; with the writeSync loop below,
 * both survived 20/20. So the hazard is real but starts past the pipe
 * buffer, and it does NOT reach this guard's own few-hundred-byte lines.
 * (It is therefore NOT the cause of anything observed here -- an earlier
 * revision of this comment claimed it explained a flaky test; that was
 * wrong, and the real cause was a fractional-millisecond value in the
 * test's own regex. Retracted rather than quietly deleted.)
 *
 * The loop is kept anyway: it removes the whole hazard class for one line
 * of code, and a refusal whose explanation is silently truncated would be
 * exactly the invisible-success failure this guard exists to prevent.
 *
 * A short EAGAIN retry covers a non-blocking pipe whose buffer is
 * momentarily full; any other error is swallowed, because diagnostics must
 * never be the thing that breaks the guard.
 */
function emitLine(message) {
  const buf = Buffer.from(`${TAG} ${message}\n`, 'utf8')
  let offset = 0
  while (offset < buf.length) {
    try {
      offset += writeSync(2, buf, offset, buf.length - offset)
    } catch (err) {
      if (err && (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK')) {
        sleepMs(1)
        continue
      }
      return
    }
  }
}

const note = (message) => emitLine(message)

function fail(code, message) {
  emitLine(message)
  process.exit(code)
}

/** Recovery line for exit 3. The whole point of the mutex is that there is
 * never anything to remove, so this hint must not suggest removing one. */
function mutexHeldHint() {
  return (
    `recover: nothing to delete -- this mutex is an OS lock, so a live holder ` +
    `releases it on exit and a dead one released it already; just retry. If it ` +
    `never clears, list live launchers with docker exec ${RUFLO_CONTAINER} ${PROC_SCAN_CMD_HINT}`
  )
}

/** Recovery line for exit 4. Safe to state unconditionally: the mutex
 * database holds no state anyone needs -- only the informational owner row. */
function mutexUnusableHint(dbPath) {
  return (
    `recover: this file holds no state worth keeping -- docker exec ` +
    `${RUFLO_CONTAINER} rm -rf ${dbPath} (remove ONLY that path; never ` +
    `state.lock or state.json)`
  )
}

/** Recovery line for exit 5. */
function realLockLiveHint() {
  return (
    `recover: nothing to delete -- another server is mid policy transaction; ` +
    `retry, and the runtime clears its own lock after ${RUNTIME_LOCK_STALE_MS}ms. ` +
    `Confirm with docker exec ${RUFLO_CONTAINER} ${PROC_SCAN_CMD_HINT}`
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

/** `pid`'s process start time as epoch milliseconds. Throws on failure. */
function pidStartTimeEpochMs(pid) {
  const ticks = Number(readStartTime(pid))
  return readBootTimeEpochSec() * 1000 + (ticks / USER_HZ) * 1000
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

/** Synchronous sleep. Atomics.wait, not a busy loop: this process has no
 * event loop work pending and must not spin a core for up to 30 s. */
function sleepMs(ms) {
  if (!(ms > 0)) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // best-effort: a failed sleep only costs us the runtime's own retry,
    // never correctness -- the guard still never deletes anything.
  }
}

function testSeamHold() {
  sleepMs(Number(process.env.RUFLO_GUARD_TEST_HOLD_MS || 0))
}

function testSeamPauseAfterRealLockClassify() {
  sleepMs(Number(process.env.RUFLO_GUARD_TEST_PAUSE_AFTER_REALLOCK_CLASSIFY_MS || 0))
}

/** No-op unless RUFLO_GUARD_TEST_STDERR_PAD_BYTES is set. Emits one line of
 * that many bytes through the SAME emitLine() path as every other guard
 * message, so a test can prove a line that size survives the pipe intact --
 * see emitLine()'s doc comment. */
function testSeamStderrPad() {
  const bytes = Number(process.env.RUFLO_GUARD_TEST_STDERR_PAD_BYTES || 0)
  if (!(bytes > 0)) return
  note(`test-seam padding line follows: ${'x'.repeat(bytes)}`)
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
 *
 * L-6 (post-merge governance retro on PR #2931): a probe file LEAKED at
 * this exact pid-scoped path by an earlier crashed run (its own unlink
 * above never ran) -- or, since pids get reused, a leaked probe from a
 * DIFFERENT process that once held this same pid -- makes the O_EXCL
 * create below fail with EEXIST even though `dir` genuinely IS writable.
 * That was previously indistinguishable from a real permission failure and
 * misreported as "cannot write to <dir>". On EEXIST specifically: unlink
 * the stale file once and retry the create; if the retry ALSO fails,
 * report that retry's own real error (never re-report the original EEXIST,
 * which would be stale information once the unlink succeeded).
 */
function probeWritable(dir) {
  const p = join(dir, `.ruflo-guard-probe-${process.pid}`)
  let fd
  try {
    fd = openSync(p, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY)
  } catch (err) {
    if (!err || err.code !== 'EEXIST') {
      throw new Error(`cannot write to ${dir}: ${errMsg(err)}`)
    }
    try {
      unlinkSync(p)
    } catch (unlinkErr) {
      throw new Error(
        `cannot write to ${dir}: a stale probe ${p} exists (from an earlier crashed run, or a ` +
          `reused pid) and could not be removed: ${errMsg(unlinkErr)}`
      )
    }
    try {
      fd = openSync(p, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY)
    } catch (retryErr) {
      throw new Error(`cannot write to ${dir}: ${errMsg(retryErr)}`)
    }
  }
  closeSync(fd)
  try {
    unlinkSync(p)
  } catch (err) {
    note(`warning: could not remove probe file ${p}: ${errMsg(err)}`)
  }
}

/**
 * Reads+parses the runtime's state.lock. Never throws:
 *   {present:false}
 * | {present:true, malformed:true, reason}
 * | {present:true, malformed:false, record}
 *
 * ONE shape is authenticated: @claude-flow/cli policy-runtime.js's
 * `{pid:<int>, acquiredAt:<ms>}`, measured live. Anything else is
 * malformed, which for the real lock means "warn and proceed", never a
 * refusal and never a delete -- see the header.
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
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !Number.isInteger(parsed.pid) ||
    !Number.isFinite(parsed.acquiredAt)
  ) {
    return { present: true, malformed: true, reason: "not the runtime's {pid, acquiredAt} shape" }
  }
  return { present: true, malformed: false, record: parsed }
}

/**
 * 'live' (pid alive AND its start time corroborates acquiredAt -- refuse),
 * 'stale' (pid dead, or a live pid whose start time postdates acquiredAt by
 * more than the slack -- a recycled pid), or 'unresolved' (liveness could
 * not be determined). No branch of this function, or of its callers,
 * removes anything.
 */
function classifyRecord(record) {
  let alive
  try {
    alive = isPidAlive(record.pid)
  } catch {
    return { status: 'unresolved', reason: `pid ${record.pid} liveness undeterminable` }
  }
  if (!alive) return { status: 'stale', reason: `pid ${record.pid} is not running` }

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

/**
 * The A1.4 sibling FILE is inert under this design -- nothing reads it and
 * nothing writes it. Remove one left behind by a pre-A1.8 launcher ONLY
 * when it is provably harmless to remove: it parses as the old record
 * shape AND its pid is confirmed not running. Anything else (unparseable,
 * a foreign shape, a live pid, an undeterminable pid) is LEFT IN PLACE and
 * warned about -- this guard does not delete files it cannot account for,
 * and an inert file costs nothing.
 */
function cleanupLegacySibling(siblingPath) {
  let raw
  try {
    raw = readFileSync(siblingPath, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return
    note(`warning: legacy ${siblingPath} is unreadable (${errMsg(err)}); left in place (inert)`)
    return
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    note(`warning: legacy ${siblingPath} is not valid JSON; left in place (inert)`)
    return
  }
  const isLegacyShape =
    parsed !== null &&
    typeof parsed === 'object' &&
    Number.isInteger(parsed.pid) &&
    typeof parsed.startTime === 'string' &&
    /^\d+$/.test(parsed.startTime)
  if (!isLegacyShape) {
    note(`warning: legacy ${siblingPath} is not the pre-A1.8 record shape; left in place (inert)`)
    return
  }
  let alive
  try {
    alive = isPidAlive(parsed.pid)
  } catch {
    note(
      `warning: legacy ${siblingPath} names pid ${parsed.pid}, whose liveness is ` +
        `undeterminable; left in place (inert)`
    )
    return
  }
  if (alive) {
    note(
      `warning: legacy ${siblingPath} names pid ${parsed.pid}, which is still ` +
        `running; left in place (inert)`
    )
    return
  }
  try {
    unlinkSync(siblingPath)
    note(`removed inert pre-A1.8 ${siblingPath} (its pid ${parsed.pid} is not running)`)
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      note(`warning: could not remove inert legacy ${siblingPath}: ${errMsg(err)}`)
    }
  }
}

/** better-sqlite3, by ABSOLUTE path out of the served image. A failure here
 * is an image defect, not a refusal -- exit 7, never exit 4, whose recovery
 * advice (delete the database file) would be actively wrong. */
function loadSqliteDriver() {
  const modulePath = process.env.RUFLO_GUARD_SQLITE_MODULE || DEFAULT_SQLITE_MODULE
  try {
    // createRequire needs a base FILE path; the module path itself is
    // absolute, so the base only has to be syntactically valid.
    return createRequire(join(process.cwd(), 'ruflo-launch-guard.require-base.cjs'))(modulePath)
  } catch (err) {
    fail(
      7,
      `could not load better-sqlite3 from ${modulePath} (${errMsg(err)}) -- the served ` +
        `image is missing the guard's only dependency; set RUFLO_GUARD_SQLITE_MODULE to ` +
        `an absolute path if it lives elsewhere`
    )
  }
}

const isBusy = (err) => typeof err?.code === 'string' && err.code.startsWith('SQLITE_BUSY')

/** The informational owner row, read back to name a refusal's counterparty. */
function readOwner(db) {
  try {
    return db.prepare('SELECT pid, start_time, recorded_at FROM launcher_owner WHERE id = 1').get()
  } catch {
    return undefined
  }
}

function describeOwner(owner) {
  if (!owner) return 'no launcher has recorded itself in it yet'
  if (owner.pid === process.pid) {
    return (
      `the last recorded owner is THIS process (pid ${owner.pid}) -- the actual ` +
      `holder started within a millisecond or so of us and had not recorded itself yet`
    )
  }
  return `last recorded owner: pid ${owner.pid} (start ${owner.start_time}), recorded at ${owner.recorded_at}`
}

/**
 * Runs `decide` while holding the launcher mutex, then releases it.
 *
 * Every statement before BEGIN IMMEDIATE can itself block on another
 * launcher's RESERVED lock (measured: a contender blocks at the owner
 * upsert, not at BEGIN IMMEDIATE, because the upsert is the first write it
 * attempts). SQLITE_BUSY from ANY of them means the same thing -- another
 * launcher holds the mutex -- so they share one handler.
 *
 * Nothing in here ever removes the database: a crashed holder's lock is
 * released by the kernel, so there is no debris to sweep.
 */
function withLauncherMutex(dbPath, decide) {
  const Database = loadSqliteDriver()
  let db
  try {
    db = new Database(dbPath)
  } catch (err) {
    fail(
      4,
      `launcher mutex ${dbPath} could not be opened (${errMsg(err)}). ${mutexUnusableHint(dbPath)}`
    )
  }
  let holding = false
  try {
    const mode = db.pragma('journal_mode = delete', { simple: true })
    if (mode !== 'delete') {
      note(
        `warning: launcher mutex ${dbPath} is in journal_mode=${mode}, not the ` +
          `rollback journal this guard expects; the mutex still serializes, but ` +
          `may leave -wal/-shm files in the policy dir`
      )
    }
    db.pragma(`busy_timeout = ${MUTEX_BUSY_TIMEOUT_MS}`)
    db.exec(OWNER_TABLE_DDL)
    let startTime
    try {
      startTime = readStartTime(process.pid)
    } catch {
      startTime = 'unknown'
    }
    db.prepare(OWNER_UPSERT_SQL).run(process.pid, startTime, randomUUID(), new Date().toISOString())
    db.exec('BEGIN IMMEDIATE')
    holding = true
  } catch (err) {
    if (isBusy(err)) {
      fail(
        3,
        `launcher mutex ${dbPath} is held by another launcher after ` +
          `${MUTEX_BUSY_TIMEOUT_MS}ms (${describeOwner(readOwner(db))}). ${mutexHeldHint()}`
      )
    }
    fail(4, `launcher mutex ${dbPath} is unusable (${errMsg(err)}). ${mutexUnusableHint(dbPath)}`)
  }
  try {
    testSeamHold()
    decide()
  } finally {
    // Best-effort: a failed COMMIT (or a process.exit() from a refusal
    // inside `decide`, which skips this block entirely) still releases the
    // kernel lock when this process's descriptors close.
    if (holding) {
      try {
        db.exec('COMMIT')
      } catch (err) {
        note(`warning: could not commit the launcher mutex (${errMsg(err)}); exit releases it`)
      }
    }
  }
}

/**
 * Reads the runtime's state.lock and decides whether a new server may be
 * spawned. NEVER writes, renames, or unlinks it -- see the header for why
 * that is the whole point of this revision.
 */
function checkRealLock(lockPath) {
  const existing = readRecord(lockPath)
  if (!existing.present) {
    note(`no state.lock at ${lockPath} -- authorized`)
    return
  }
  let mtimeMs = null
  try {
    mtimeMs = statSync(lockPath).mtimeMs
  } catch (err) {
    note(
      `warning: could not stat state.lock ${lockPath} (${errMsg(err)}); not waiting on its mtime`
    )
  }
  const verdict = existing.malformed
    ? { status: 'unresolved', reason: existing.reason }
    : classifyRecord(existing.record)

  // Printed BEFORE the seam pause, and deliberately separate from the
  // action lines below: what this guard CONCLUDED and what it DID are two
  // different facts, and a reader diagnosing a refusal needs both. It also
  // gives the A1.8 successor-replacement test a real signal to synchronise
  // on -- an arm that instead guessed a millisecond margin for "the guard
  // has read the lock by now" would be measuring container load, not this
  // guard's behaviour.
  note(`state.lock ${lockPath} classified ${verdict.status} (${verdict.reason})`)

  testSeamPauseAfterRealLockClassify()

  if (verdict.status === 'live') {
    fail(
      5,
      `state.lock ${lockPath} held by a live server -- ${verdict.reason}. ${realLockLiveHint()}`
    )
  }
  if (verdict.status === 'unresolved') {
    note(
      `warning: state.lock ${lockPath} unresolved (${verdict.reason}); proceeding without ` +
        `touching it, the runtime applies its own ${RUNTIME_LOCK_STALE_MS}ms staleness rule`
    )
    return
  }
  // stale: proven no live owner. The runtime clears it itself once its
  // mtime clears the 30 s window, so wait out whatever is left of that
  // window rather than deleting a file a successor may have just written.
  if (mtimeMs === null) {
    note(`state.lock ${lockPath} is stale (${verdict.reason}); proceeding, mtime unreadable`)
    return
  }
  // Rounded: statSync's mtimeMs is a float, and an operator-facing line
  // reading "waiting 19954.9990234375ms" is noise, not precision. Rounding
  // here (not at print time) also keeps the figure printed and the figure
  // actually slept identical.
  const age = Math.round(Date.now() - mtimeMs)
  // Clamped to [0, RUNTIME_LOCK_STALE_MS]: `age` can be NEGATIVE when the
  // lock's mtime is in the future (clock skew, a manually-touched file, or a
  // filesystem that rounds mtimes forward), and an unclamped
  // `RUNTIME_LOCK_STALE_MS - age` then exceeds the runtime's own 30s window
  // -- this guard would wait longer than the thing it is waiting FOR. The
  // ceiling side is symmetric and free: a correct `age` never drives
  // `remaining` above RUNTIME_LOCK_STALE_MS in the first place, so clamping
  // it costs nothing on the normal path.
  const mtimeInFuture = age < 0
  const remaining = Math.min(RUNTIME_LOCK_STALE_MS, Math.max(0, RUNTIME_LOCK_STALE_MS - age))
  if (remaining > 0) {
    note(
      `state.lock ${lockPath} is stale (${verdict.reason}) but only ${age}ms old` +
        (mtimeInFuture ? ` (mtime is in the FUTURE by ${-age}ms)` : '') +
        `; waiting ${remaining}ms for the runtime's own ${RUNTIME_LOCK_STALE_MS}ms staleness ` +
        `window (this guard never deletes state.lock)`
    )
    sleepMs(remaining)
    return
  }
  note(
    `state.lock ${lockPath} is stale (${verdict.reason}) and ${age}ms old, past the runtime's ` +
      `${RUNTIME_LOCK_STALE_MS}ms staleness window; proceeding without waiting ` +
      `(this guard never deletes state.lock)`
  )
}

/**
 * SMI-6744 L-5 (post-merge governance retro on PR #2931): measure the
 * container's actual clock-ticks-per-second once, at the very start of
 * main(), and refuse (exit 1, fail CLOSED) unless it equals the USER_HZ
 * literal pidStartTimeEpochMs() assumes. RUFLO_GUARD_TEST_CLK_TCK overrides
 * the measured value without invoking getconf, for deterministic tests --
 * see this file's header for why this seam exists (a real container's own
 * getconf CLK_TCK is confirmed 100).
 */
function verifyUserHz() {
  const override = process.env.RUFLO_GUARD_TEST_CLK_TCK
  let raw
  if (override !== undefined) {
    raw = override
  } else {
    const result = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' })
    if (result.error || result.status !== 0) {
      const detail = result.error ? errMsg(result.error) : `exit ${result.status}: ${result.stderr}`
      fail(
        1,
        `getconf CLK_TCK could not be measured (${detail}) -- refusing rather than trusting ` +
          `the unverified USER_HZ=${USER_HZ} assumption pidStartTimeEpochMs() depends on for its ` +
          `live/stale/recycled classification`
      )
    }
    raw = result.stdout.trim()
  }
  const measured = Number(raw)
  if (!Number.isFinite(measured) || !Number.isInteger(measured)) {
    fail(
      1,
      `getconf CLK_TCK returned a non-numeric value '${raw}' -- refusing rather than trusting the ` +
        `unverified USER_HZ=${USER_HZ} assumption pidStartTimeEpochMs() depends on for its ` +
        `live/stale/recycled classification`
    )
  }
  if (measured !== USER_HZ) {
    fail(
      1,
      `getconf CLK_TCK measured ${measured}, not the assumed USER_HZ=${USER_HZ} this guard's ` +
        `pidStartTimeEpochMs() (used by classifyRecord() to decide live vs. stale vs. recycled) ` +
        `depends on -- refusing rather than risk misclassifying a LIVE state.lock owner as stale ` +
        `and proceeding past it`
    )
  }
}

function main() {
  verifyUserHz()
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

  cleanupLegacySibling(join(policyDir, 'state.lock.launcher'))
  const mutexPath = join(policyDir, 'state.lock.launcher.db')
  const realLockPath = join(policyDir, 'state.lock')
  withLauncherMutex(mutexPath, () => checkRealLock(realLockPath))

  testSeamStderrPad()
  process.exit(0)
}

try {
  main()
} catch (err) {
  fail(7, 'internal error: ' + errMsg(err))
}
