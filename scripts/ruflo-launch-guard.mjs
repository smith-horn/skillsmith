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
 *    -- sibling or real lock.
 *
 * The real `state.lock`'s on-disk format is owned by @claude-flow/cli, not
 * this repo, and is not committed anywhere this script can read at build
 * time. This guard applies the SAME pid+start-time validation to it when
 * the file parses as JSON with numeric `pid`/`startTime` fields; otherwise
 * (a shape this guard cannot authenticate) it is UNRESOLVED -- refused,
 * never deleted. The ADR requires either authenticating a live owner or
 * proving under "the documented lock format" that none is live, and an
 * unverifiable shape can prove neither. Threat model: excludes a same-uid
 * process able to forge files in the policy dir -- then this is advisory.
 *
 * Exit codes (each prints one "[ruflo] guard: ..." line to stderr naming
 * the failing check): 0 authorized; 1 writability probe failed; 2
 * entrypoint realpath mismatch; 3 sibling lock live (another launcher); 4
 * sibling lock unresolved; 5 real state.lock live (another server); 6 real
 * state.lock unresolved; 7 internal error (a bug here, not a refusal).
 */
import {
  closeSync,
  constants as FS,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TAG = '[ruflo] guard:'
const FORMAT_VERSION = 1
const errMsg = (err) => (err && err.message ? err.message : String(err))

function fail(code, message) {
  process.stderr.write(`${TAG} ${message}\n`)
  process.exit(code)
}

/** /proc/<pid>/stat field 22 (starttime). Throws on any read/parse failure. */
function readStartTime(pid) {
  const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const close = raw.lastIndexOf(')')
  if (close === -1) throw new Error(`unparseable /proc/${pid}/stat (no comm delimiter)`)
  // rest[0] is field 3 (state); field 22 (starttime) is rest[19].
  const rest = raw
    .slice(close + 2)
    .trim()
    .split(/\s+/) // eslint-disable-line
  const starttime = rest[19]
  if (!starttime || !/^\d+$/.test(starttime)) {
    throw new Error(`unparseable /proc/${pid}/stat (starttime field missing)`)
  }
  return starttime
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

/** Exclusive-create then delete a probe file under `dir`. Throws, naming `dir`, on failure. */
function probeWritable(dir) {
  const p = join(dir, `.ruflo-guard-probe-${process.pid}-${randomUUID()}`)
  let fd
  try {
    fd = openSync(p, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY)
  } catch (err) {
    throw new Error(`cannot write to ${dir}: ${errMsg(err)}`)
  }
  closeSync(fd)
  try {
    unlinkSync(p)
  } catch {
    // best-effort cleanup; the write already proved writability
  }
}

/** Reads+parses `path`. Never throws: {present:false} | {present:true, malformed, reason?, record?}. */
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
  const ok =
    parsed !== null &&
    typeof parsed === 'object' &&
    Number.isInteger(parsed.pid) &&
    typeof parsed.startTime === 'string' &&
    /^\d+$/.test(parsed.startTime)
  if (!ok) return { present: true, malformed: true, reason: 'missing/invalid pid or startTime' }
  return { present: true, malformed: false, record: parsed }
}

/**
 * 'live' (pid alive AND start time matches -- refuse, never delete),
 * 'stale' (pid dead, or a live pid with a mismatched start time -- a
 * recycled pid -- both recoverable), or 'unresolved' (liveness could not
 * be determined -- refuse, never delete).
 */
function classifyRecord(record) {
  let alive
  try {
    alive = isPidAlive(record.pid)
  } catch {
    return { status: 'unresolved', reason: `pid ${record.pid} liveness undeterminable` }
  }
  if (!alive) return { status: 'stale', reason: `pid ${record.pid} is not running` }
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

function acquireSiblingRecord(siblingPath) {
  let mine
  try {
    mine = writeOwnRecord(siblingPath)
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err
  }
  if (!mine) {
    // Contention: someone else's sibling record is already there.
    const existing = readRecord(siblingPath)
    if (existing.malformed) fail(4, `sibling ${siblingPath} unresolved (${existing.reason})`)
    const v = classifyRecord(existing.record)
    if (v.status === 'live')
      fail(3, `sibling ${siblingPath} held by a live launcher -- ${v.reason}`)
    if (v.status === 'unresolved') fail(4, `sibling ${siblingPath} unresolved (${v.reason})`)
    // status === 'stale': recover, then retry exactly once (a third
    // contender racing this window is the runtime's own residual contention).
    try {
      unlinkSync(siblingPath)
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err
    }
    mine = writeOwnRecord(siblingPath)
  }
  testSeamHold()
  return mine
}

function checkRealLock(lockPath) {
  const existing = readRecord(lockPath)
  if (!existing.present) return // absent -- ok
  if (existing.malformed) fail(6, `state.lock ${lockPath} unresolved (${existing.reason})`)
  const v = classifyRecord(existing.record)
  if (v.status === 'live') fail(5, `state.lock ${lockPath} held by a live server -- ${v.reason}`)
  if (v.status === 'unresolved') fail(6, `state.lock ${lockPath} unresolved (${v.reason})`)
  // stale -- proven no live owner under the same pid+startTime discipline.
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

main()
