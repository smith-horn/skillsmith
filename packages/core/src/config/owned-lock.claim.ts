/**
 * Claim parsing and lock-file mechanics (exclusive creation, reclaim,
 * release) for the owned-lock primitive.
 * @module @skillsmith/core/config/owned-lock.claim
 * @see owned-lock.ts for the full soundness argument and the PUBLIC API.
 * @see owned-lock.acquire.ts for the core acquire loop + `StuckLockError`,
 * split into a sibling file purely to keep both under the repo's
 * 500-line-per-file gate.
 *
 * INTERNAL module -- not part of the public surface (no `package.json`
 * subpath export). Co-located tests and the cross-process race-test child
 * harness import directly from here, by relative path, specifically to
 * reach `createLockExclusive`'s `linkSyncOverride` test seam -- see
 * `owned-lock.acquire.ts` for the analogous rationale on the acquire loop's
 * own destructive test-only options.
 */

import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fstatSync,
  linkSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'

import {
  HARDLINK_UNAVAILABLE_CODES,
  LOCK_RETRY_DELAY_MS,
  MAX_LOCK_BYTES,
  RECLAIM_LOCK_TIMEOUT_MS,
} from './owned-lock.types.js'
import type { Claim, ReclaimOutcome, RefusalCategory } from './owned-lock.types.js'

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

/**
 * Synchronously block the calling thread for `ms` milliseconds without
 * spinning the CPU. `Atomics.wait` on a throwaway `SharedArrayBuffer` is the
 * standard synchronous-sleep primitive in Node (unlike browsers, Node does
 * not forbid calling it on the main thread).
 */
export function sleepSync(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(view, 0, 0, ms)
}

// ---------------------------------------------------------------------------
// Claim parsing + bounded, TOCTOU-free read
// ---------------------------------------------------------------------------

/**
 * Parse raw lock-file text into a {@link Claim}. A v1 claim is one line of
 * canonical JSON; a legacy claim is a bare decimal integer (today's
 * `acquireConfigLock` format, `String(process.pid)`); anything else --
 * including valid JSON at a DIFFERENT `v` -- is `unparseable` and therefore
 * NEVER auto-reclaimed.
 */
export function parseClaim(text: string): Claim {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { kind: 'unparseable' }

  if (/^[0-9]+$/.test(trimmed)) {
    const pid = Number(trimmed)
    if (Number.isSafeInteger(pid)) return { kind: 'legacy', pid }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'unparseable' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'unparseable' }
  const p = parsed as Record<string, unknown>
  if (
    p['v'] === 1 &&
    typeof p['pid'] === 'number' &&
    typeof p['token'] === 'string' &&
    typeof p['host'] === 'string' &&
    typeof p['acquiredAt'] === 'number'
  ) {
    return {
      kind: 'v1',
      pid: p['pid'],
      token: p['token'],
      host: p['host'],
      acquiredAt: p['acquiredAt'],
    }
  }
  return { kind: 'unparseable' }
}

/**
 * Bounded, TOCTOU-free claim read: open once, `fstat` THAT fd (not the
 * path), refuse above {@link MAX_LOCK_BYTES}, read from the same fd. Returns
 * `{ kind: 'absent' }` on `ENOENT` (or any other open failure).
 */
export function readClaim(path: string): Claim {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return { kind: 'absent' }
  }
  try {
    const st = fstatSync(fd)
    if (st.size > MAX_LOCK_BYTES) return { kind: 'unparseable' }
    const buf = Buffer.allocUnsafe(MAX_LOCK_BYTES)
    const n = readSync(fd, buf, 0, MAX_LOCK_BYTES, 0)
    return parseClaim(buf.subarray(0, n).toString('utf8'))
  } catch {
    return { kind: 'unparseable' }
  } finally {
    closeSync(fd)
  }
}

export function isAutoReclaimDisabled(): boolean {
  return process.env['SKILLSMITH_LOCK_NO_AUTO_RECLAIM'] === '1'
}

/**
 * Conservative in every ambiguous direction: PID reuse and a not-our-signal
 * `EPERM` both read as ALIVE (declining to reclaim costs a timeout; an
 * incorrect reclaim costs a lost caller). `pid <= 0` is rejected WITHOUT
 * probing -- `kill(0, 0)` signals the process GROUP, which would make the
 * liveness probe meaningless.
 */
export function isOwnerDefinitelyDead(
  claim: Claim,
  killProbe: typeof process.kill = process.kill
): boolean {
  if (isAutoReclaimDisabled()) return false
  if (claim.kind !== 'v1') return false // legacy | unparseable | absent -- never (D-5/D-6)
  if (claim.host !== hostname()) return false
  if (!Number.isInteger(claim.pid) || claim.pid <= 0) return false
  try {
    killProbe(claim.pid, 0)
    return false // signalable -> alive
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true // no such process -> dead
    return false // EPERM (exists, not ours) or any other errno -> assume alive
  }
}

export function classifyRefusal(claim: Claim): RefusalCategory {
  if (isAutoReclaimDisabled()) return 'reclaim-disabled'
  if (claim.kind === 'legacy') return 'legacy'
  if (claim.kind === 'unparseable' || claim.kind === 'absent') return 'unparseable'
  return 'held'
}

// ---------------------------------------------------------------------------
// Exclusive creation -- atomic AND content-complete (D-6)
// ---------------------------------------------------------------------------

/**
 * Create the temp file that {@link createLockExclusive} will `linkSync` into
 * place, EXCLUSIVELY (`wx`) rather than with the default truncating `w`.
 * `randomHex(8)` collisions are astronomically unlikely, but a `w`-flag
 * write is a silent last-writer-wins on collision -- including clobbering
 * another caller's temp file AFTER it has already been `linkSync`'d into a
 * live lock (the temp file's own content no longer matters to that lock at
 * that point, but a `w`-flag collision earlier in the window, before the
 * link, could still corrupt an in-flight sibling attempt). `wx` turns any
 * collision into a loud `EEXIST` retry with a fresh random suffix instead of
 * a silent overwrite.
 */
function writeTempClaimExclusive(dir: string, base: string, recordJson: string): string {
  for (let attempt = 0; attempt < 5; attempt++) {
    const tmp = join(dir, `.${base}.${randomHex(8)}.tmp`)
    let fd: number
    try {
      fd = openSync(tmp, 'wx', 0o600)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue // collision -- retry with a fresh suffix
      throw err
    }
    try {
      writeFileSync(fd, recordJson)
    } finally {
      closeSync(fd)
    }
    chmodSync(tmp, 0o600) // defeat a permissive umask BEFORE the file is reachable as a lock
    return tmp
  }
  throw new Error(
    `[skillsmith] could not create a unique temp claim file under ${dir} after 5 attempts`
  )
}

/**
 * Create `path` exclusively via a temp file + `linkSync` (atomic; `EEXIST`
 * if `path` exists) so a lock file is NEVER observable without a complete
 * claim -- closing R2 (a writer could otherwise crash between create and
 * write, leaving a permanently unreclaimable main lock). On filesystems
 * without hardlink support this throws rather than falling back to a
 * non-atomic `openSync('wx')` + separate write -- that two-step sequence
 * would itself reopen R2 (an observer between the two steps, or a crash in
 * between, sees an empty/truncated lock that is then PERMANENTLY
 * unreclaimable, since an `unparseable` claim is never auto-reclaimed by
 * design). Failing closed on an unsupported filesystem is the sound
 * resolution the reviewer required; hardlink support is effectively
 * universal on the filesystems Node actually runs on.
 *
 * @param linkSyncOverride - @internal test seam (owned-lock.test.ts item 14)
 * to exercise the hardlink-unavailable fail-closed path deterministically.
 * Never set outside that test.
 */
export function createLockExclusive(
  path: string,
  recordJson: string,
  linkSyncOverride?: (existingPath: string, newPath: string) => void
): boolean {
  const dir = dirname(path)
  const tmp = writeTempClaimExclusive(dir, basename(path), recordJson)
  const doLink = linkSyncOverride ?? linkSync
  try {
    doLink(tmp, path)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    if (code && HARDLINK_UNAVAILABLE_CODES.has(code)) {
      throw new Error(
        `[skillsmith] cannot create an owned lock at ${path}: this filesystem does not ` +
          `support hardlinks (${code}), which the lock's atomic-and-content-complete creation ` +
          `guarantee depends on. Failing closed rather than falling back to a non-atomic write ` +
          `(which could leave a permanently unreclaimable lock on a crash mid-write).`
      )
    }
    throw err
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      // Already gone (nlink 2 -> 1 on a successful link), or never created.
    }
  }
}

// ---------------------------------------------------------------------------
// Reclaim -- validate and destroy inside ONE exclusive region
// ---------------------------------------------------------------------------

export interface ReclaimInternalOptions {
  /** @internal NEGATIVE CONTROL ONLY (owned-lock-reclaim-race.test.ts) -- removes the authoritative re-read that makes this mechanism sound. Never set outside that spec. */
  unsafeSkipRevalidation?: boolean
  linkSyncOverride?: (existingPath: string, newPath: string) => void
}

/**
 * Validate and destroy a stale main lock inside a region from which every
 * other reclaimer is excluded (the reclaim lock). This is the ONLY code path
 * that may ever unlink `<target>.lock` on the strength of a liveness
 * inference: a caller's own pre-filter is advisory and discarded; only the
 * re-read performed HERE, under the reclaim lock, authorizes the unlink.
 */
export function tryReclaimUnderLock(
  lockPath: string,
  reclaimPath: string,
  opts: ReclaimInternalOptions
): ReclaimOutcome {
  const rToken = randomHex(8)
  const rRecord =
    JSON.stringify({
      v: 1,
      pid: process.pid,
      token: rToken,
      host: hostname(),
      acquiredAt: Date.now(),
    }) + '\n'
  const rDeadline = Date.now() + RECLAIM_LOCK_TIMEOUT_MS
  for (;;) {
    if (createLockExclusive(reclaimPath, rRecord, opts.linkSyncOverride)) break
    if (Date.now() >= rDeadline) return 'unavailable' // concurrent reclaimer, or an R1 orphan
    sleepSync(LOCK_RETRY_DELAY_MS)
  }
  try {
    // ===== RECLAIM CRITICAL SECTION -- mutually exclusive against every other reclaimer =====
    const claim = readClaim(lockPath) // AUTHORITATIVE re-read
    if (!opts.unsafeSkipRevalidation) {
      if (claim.kind === 'absent') return 'gone'
      if (!isOwnerDefinitelyDead(claim)) return 'not-stale'
    } else if (claim.kind === 'absent') {
      return 'gone' // even the negative control cannot unlink something not there
    }
    try {
      unlinkSync(lockPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'gone'
      throw err
    }
    return 'reclaimed'
  } finally {
    releaseOwned(reclaimPath, rToken)
  }
}

// ---------------------------------------------------------------------------
// Release -- ownership-verified, idempotent
// ---------------------------------------------------------------------------

export function releaseOwned(path: string, token: string): void {
  const claim = readClaim(path)
  if (claim.kind === 'v1' && claim.token === token) {
    try {
      unlinkSync(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(
          `[skillsmith] lock_release_unlink_failed: could not remove ${path}: ${(err as Error).message}`
        )
      }
    }
  } else {
    // We no longer own it -- unlinking would destroy a live holder's lock
    // (it was reclaimed from us after we appeared dead, or hand-edited).
    console.warn(
      `[skillsmith] lock_release_not_owner: ${path} is no longer owned by this process -- not removing it.`
    )
  }
}

export function makeRelease(lockPath: string, token: string): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    releaseOwned(lockPath, token)
  }
}
