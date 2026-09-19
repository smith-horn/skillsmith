/**
 * Unit tests for the two-level owned-lock primitive (SMI-5883 §8a).
 * @module @skillsmith/core/config/owned-lock.test
 *
 * Single-process tests of `acquireOwnedLock` itself. Cross-process tests
 * (the reclaim-race proof, the orphaned-reclaim-lock residual, and the
 * end-to-end lost-update stress test) live in
 * `packages/core/tests/integration/owned-lock-reclaim-race.test.ts` (§8b/8c)
 * and `packages/core/tests/integration/owned-lock-lost-update.test.ts` (§8f).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { hostname } from 'node:os'
import * as path from 'node:path'
import * as os from 'node:os'

import {
  acquireOwnedLock,
  describeRemedy,
  RECLAIM_LOCK_TIMEOUT_MS,
  StuckLockError,
  type StuckLockReason,
} from './owned-lock.js'
import { acquireOwnedLockCore, toTimingMs } from './owned-lock.acquire.js'
import { createLockExclusive, isOwnerDefinitelyDead } from './owned-lock.claim.js'
import { mintDeadPid } from '../../tests/helpers/deterministic-dead-pid.js'

let dir: string
let target: string
let lockPath: string
let reclaimPath: string

beforeEach(() => {
  dir =
    os.tmpdir() + path.sep + `owned-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  mkdirSync(dir, { recursive: true })
  target = path.join(dir, 'store.json')
  lockPath = `${target}.lock`
  reclaimPath = `${lockPath}.reclaim`
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function seed(content: string, at: string = lockPath): void {
  writeFileSync(at, content)
}

function v1(
  pid: number,
  opts: Partial<{ token: string; host: string; acquiredAt: number }> = {}
): string {
  return (
    JSON.stringify({
      v: 1,
      pid,
      token: opts.token ?? 'a'.repeat(16),
      host: opts.host ?? hostname(),
      acquiredAt: opts.acquiredAt ?? Date.now(),
    }) + '\n'
  )
}

describe('acquireOwnedLock', () => {
  it('1. acquire on a free path succeeds; the lock file is 0600, v1, this pid/host, 16-hex token', () => {
    const before = Date.now() - 1
    const release = acquireOwnedLock(target, { timeoutMs: 1_000 })
    const raw = readFileSync(lockPath, 'utf-8')
    const parsed = JSON.parse(raw) as {
      v: number
      pid: number
      token: string
      host: string
      acquiredAt: number
    }
    expect(parsed.v).toBe(1)
    expect(parsed.pid).toBe(process.pid)
    expect(parsed.host).toBe(hostname())
    expect(/^[0-9a-f]{16}$/.test(parsed.token)).toBe(true)
    // SMI-6776 C1: nothing asserted this, so `acquiredAt: 0` shipped a claim
    // stamped at the Unix epoch past the whole suite. Anyone inspecting a lock
    // file read a false timestamp. A window, not an exact value -- the point is
    // that it tracks now, not that it equals any particular instant.
    expect(parsed.acquiredAt).toBeGreaterThan(before)
    expect(parsed.acquiredAt).toBeLessThanOrEqual(Date.now())
    release()
  })

  it('2. a second acquire while held times out with reason held; the lock file is byte-identical afterwards', () => {
    const release = acquireOwnedLock(target, { timeoutMs: 5_000 })
    const before = readFileSync(lockPath)
    try {
      let caught: StuckLockError | undefined
      try {
        acquireOwnedLock(target, { timeoutMs: 200 })
      } catch (err) {
        caught = err as StuckLockError
      }
      expect(caught).toBeInstanceOf(StuckLockError)
      expect(caught?.reason).toBe('held')
      expect(readFileSync(lockPath).equals(before)).toBe(true)
    } finally {
      release()
    }
  })

  it('3. release removes the lock; a subsequent acquire succeeds immediately', () => {
    const release = acquireOwnedLock(target, { timeoutMs: 1_000 })
    release()
    expect(existsSync(lockPath)).toBe(false)
    const release2 = acquireOwnedLock(target, { timeoutMs: 200 })
    release2()
  })

  it('4. release is idempotent — a second call neither throws nor unlinks', () => {
    const release = acquireOwnedLock(target, { timeoutMs: 1_000 })
    release()
    expect(() => release()).not.toThrow()
  })

  it('5. ownership-verified release: a foreign token in the lock file is never unlinked', () => {
    const release = acquireOwnedLock(target, { timeoutMs: 1_000 })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // Overwrite the lock file out-of-band with a DIFFERENT v1 token.
    seed(v1(process.pid, { token: 'f'.repeat(16) }))
    release()
    expect(existsSync(lockPath)).toBe(true)
    expect(JSON.parse(readFileSync(lockPath, 'utf-8')).token).toBe('f'.repeat(16))
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('lock_release_not_owner'))).toBe(
      true
    )
    warnSpy.mockRestore()
    rmSync(lockPath)
  })

  it('6. v1 dead-PID reclaim: acquire succeeds well inside a tight budget; the reclaim lock is gone afterwards', () => {
    const deadPid = mintDeadPid()
    seed(v1(deadPid))
    const start = Date.now()
    const release = acquireOwnedLock(target, { timeoutMs: 5_000, reclaimProbeAfterMs: 0 })
    expect(Date.now() - start).toBeLessThan(2_000)
    expect(existsSync(reclaimPath)).toBe(false)
    release()
  })

  it('7. v1 live-PID refusal: times out, reason held, file byte-identical', () => {
    seed(v1(process.pid))
    const before = readFileSync(lockPath)
    let caught: StuckLockError | undefined
    try {
      acquireOwnedLock(target, { timeoutMs: 200, reclaimProbeAfterMs: 0 })
    } catch (err) {
      caught = err as StuckLockError
    }
    expect(caught?.reason).toBe('held')
    expect(readFileSync(lockPath).equals(before)).toBe(true)
  })

  it('H-11: a live-PID lock with a 10-minute-old acquiredAt still times out (age is irrelevant, D-2 regression test)', () => {
    seed(v1(process.pid, { acquiredAt: Date.now() - 10 * 60 * 1000 }))
    const before = readFileSync(lockPath)
    let caught: StuckLockError | undefined
    try {
      acquireOwnedLock(target, { timeoutMs: 200, reclaimProbeAfterMs: 0 })
    } catch (err) {
      caught = err as StuckLockError
    }
    expect(caught).toBeInstanceOf(StuckLockError)
    expect(caught?.message).toContain(String(process.pid))
    expect(caught?.message).toContain(hostname())
    expect(readFileSync(lockPath).equals(before)).toBe(true)
  })

  it('8. EPERM from the liveness probe counts as alive — no reclaim, timeout', () => {
    const deadPid = mintDeadPid() // would otherwise be reclaimed
    seed(v1(deadPid))
    const killProbe = (): never => {
      const err = new Error('EPERM') as NodeJS.ErrnoException
      err.code = 'EPERM'
      throw err
    }
    let caught: StuckLockError | undefined
    try {
      // The kill-probe override is threaded via the internal claim module in
      // production; here we assert behaviourally via the public surface by
      // making `process.kill` itself throw EPERM for this one PID.
      const spy = vi.spyOn(process, 'kill').mockImplementation((pid) => {
        if (pid === deadPid) return killProbe()
        return true
      })
      try {
        acquireOwnedLock(target, { timeoutMs: 200, reclaimProbeAfterMs: 0 })
      } catch (err) {
        caught = err as StuckLockError
      } finally {
        spy.mockRestore()
      }
    } finally {
      /* no-op */
    }
    expect(caught?.reason).toBe('held')
  })

  it('9. pid <= 0 rejected without probing (kill(0,0) would signal the process group)', () => {
    for (const pid of [0, -1]) {
      rmSync(lockPath, { force: true })
      seed(v1(pid))
      const spy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      let caught: StuckLockError | undefined
      try {
        acquireOwnedLock(target, { timeoutMs: 150, reclaimProbeAfterMs: 0 })
      } catch (err) {
        caught = err as StuckLockError
      }
      expect(caught?.reason).toBe('held')
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    }
  })

  it('10. host mismatch: a dead PID on another host is never reclaimed', () => {
    const deadPid = mintDeadPid()
    seed(v1(deadPid, { host: 'some-other-host' }))
    const before = readFileSync(lockPath)
    let caught: StuckLockError | undefined
    try {
      acquireOwnedLock(target, { timeoutMs: 200, reclaimProbeAfterMs: 0 })
    } catch (err) {
      caught = err as StuckLockError
    }
    expect(caught?.reason).toBe('held')
    expect(readFileSync(lockPath).equals(before)).toBe(true)
  })

  it('11. unparseable claims (empty / truncated / garbage / wrong version) refuse with a byte-identical file (H-13 a-d)', () => {
    const deadPid = mintDeadPid()
    const cases = [
      '', // (c) empty
      '{"v":1,"pid":', // (c) truncated
      'not json at all {{{', // (b) garbage bytes
      JSON.stringify({
        v: 2,
        pid: deadPid,
        token: 'a'.repeat(16),
        host: hostname(),
        acquiredAt: Date.now(),
      }), // (d) valid JSON, wrong version -- never auto-reclaimed even with a genuinely dead PID
    ]
    for (const content of cases) {
      rmSync(lockPath, { force: true })
      seed(content)
      const before = readFileSync(lockPath)
      let caught: StuckLockError | undefined
      try {
        acquireOwnedLock(target, { timeoutMs: 150, reclaimProbeAfterMs: 0 })
      } catch (err) {
        caught = err as StuckLockError
      }
      expect(caught?.reason, `content: ${JSON.stringify(content)}`).toBe(
        'unreclaimable_unparseable'
      )
      expect(readFileSync(lockPath).equals(before)).toBe(true)
    }
  })

  it('12. legacy refusal, dead PID (D-5): a bare minted-dead PID is never reclaimed', () => {
    const deadPid = mintDeadPid()
    seed(String(deadPid))
    const before = readFileSync(lockPath)
    let caught: StuckLockError | undefined
    try {
      acquireOwnedLock(target, { timeoutMs: 150, reclaimProbeAfterMs: 0 })
    } catch (err) {
      caught = err as StuckLockError
    }
    expect(caught?.reason).toBe('unreclaimable_legacy')
    expect(readFileSync(lockPath).equals(before)).toBe(true)
  })

  it('13. SKILLSMITH_LOCK_NO_AUTO_RECLAIM=1: a v1 dead-PID lock is not reclaimed; reason reclaim_disabled', () => {
    const deadPid = mintDeadPid()
    seed(v1(deadPid))
    process.env['SKILLSMITH_LOCK_NO_AUTO_RECLAIM'] = '1'
    let caught: StuckLockError | undefined
    try {
      acquireOwnedLock(target, { timeoutMs: 150, reclaimProbeAfterMs: 0 })
    } catch (err) {
      caught = err as StuckLockError
    } finally {
      delete process.env['SKILLSMITH_LOCK_NO_AUTO_RECLAIM']
    }
    expect(caught?.reason).toBe('reclaim_disabled')
  })

  it('14. hardlink-unavailable (R2 branch): a linkSync throwing ENOSYS fails CLOSED, no lock file left behind', () => {
    // SMI-5883 code-review round 1 finding 1: the original fallback
    // (openSync('wx') + a separate writeFileSync) was NOT content-complete --
    // a crash or observer between those two steps would see an empty/
    // truncated lock file, which is then PERMANENTLY unreclaimable (an
    // `unparseable` claim is never auto-reclaimed by design). Fixed by
    // failing closed instead: a filesystem without hardlink support cannot
    // provide the atomic-and-content-complete creation this primitive
    // requires, so `createLockExclusive` now throws rather than falling back.
    const enosys = (): never => {
      const err = new Error('ENOSYS') as NodeJS.ErrnoException
      err.code = 'ENOSYS'
      throw err
    }
    // Exercised directly against createLockExclusive (owned-lock.claim.ts) --
    // the internal primitive this test targets -- rather than through the
    // public acquireOwnedLock(), which no longer accepts a linkSyncOverride.
    expect(() => createLockExclusive(lockPath, '{"v":1}\n', enosys)).toThrow(
      /does not support hardlinks/
    )
    expect(existsSync(lockPath)).toBe(false)
    // No stray temp file left behind either.
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false)
  })

  it('15. no litter: after acquire/release cycles above, the directory holds no *.tmp and no *.reclaim', () => {
    const release = acquireOwnedLock(target, { timeoutMs: 1_000 })
    release()
    const entries = readdirSync(dir)
    expect(entries.some((f) => f.endsWith('.tmp'))).toBe(false)
    expect(entries.some((f) => f.endsWith('.reclaim'))).toBe(false)
  })

  it('16. public acquireOwnedLock() strips injected unsafe properties before reaching the core loop (SMI-5883 code-review round 2)', async () => {
    // Round 2 finding: TypeScript's excess-property check only fires on an
    // object LITERAL passed directly at the call site -- a caller passing a
    // variable (or a plain-JavaScript caller with no type checking at all)
    // is NOT constrained by AcquireOwnedLockOptions omitting the two unsafe
    // fields, and the core loop reads them by property name at runtime.
    // owned-lock.ts's public acquireOwnedLock() must therefore reconstruct a
    // FRESH, allowlisted object rather than forward `opts` as-is. Verified
    // here by spying on the core loop itself and asserting neither unsafe
    // key ever reaches it, regardless of what the caller injects.
    const acquireModule = await import('./owned-lock.acquire.js')
    const spy = vi.spyOn(acquireModule, 'acquireOwnedLockCore')
    const maliciousOpts = {
      timeoutMs: 1_000,
      unsafeSkipReclaimRevalidation: true,
      linkSyncOverride: () => {
        throw new Error('should never be called -- injected via a non-literal cast')
      },
    } as unknown as Parameters<typeof acquireOwnedLock>[1]

    const release = acquireOwnedLock(target, maliciousOpts)
    release()

    expect(spy).toHaveBeenCalledTimes(1)
    const forwarded = spy.mock.calls[0]?.[1]
    // Round 3: the reconstructed object sets both unsafe fields to an
    // explicit OWN `undefined` (to shadow a polluted Object.prototype --
    // see item 17), so the property now exists but must never be truthy /
    // never be the injected function.
    expect(forwarded?.unsafeSkipReclaimRevalidation).toBeUndefined()
    expect(forwarded?.linkSyncOverride).toBeUndefined()
    spy.mockRestore()
  })

  it('17. public acquireOwnedLock() is immune to a globally-polluted Object.prototype (SMI-5883 code-review round 3)', async () => {
    // Round 3 finding: a plain `{ ...safeFields }` reconstruction still
    // inherits from Object.prototype -- if that prototype were ever globally
    // polluted (a distinct, severe vulnerability class in its own right,
    // reachable only by an attacker who already has arbitrary code execution
    // in this process), ordinary property access on an object with no OWN
    // `unsafeSkipReclaimRevalidation`/`linkSyncOverride` would still resolve
    // them via the prototype chain. Fixed by explicitly setting both to
    // `undefined` as OWN properties, which shadows any inherited value.
    // Always restored in `finally` -- this is global, shared mutable state.
    // Round 4 (test-hygiene finding): restore the ORIGINAL descriptors
    // (undefined if the key was absent beforehand) rather than unconditionally
    // deleting -- unconditional delete would be wrong if either key somehow
    // already had a legitimate descriptor on Object.prototype before this test.
    const acquireModule = await import('./owned-lock.acquire.js')
    const spy = vi.spyOn(acquireModule, 'acquireOwnedLockCore')
    const pollutedLinkSync = (): never => {
      throw new Error('should never be called -- reached via Object.prototype pollution')
    }
    const origUnsafeSkip = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'unsafeSkipReclaimRevalidation'
    )
    const origLinkSync = Object.getOwnPropertyDescriptor(Object.prototype, 'linkSyncOverride')
    try {
      ;(Object.prototype as Record<string, unknown>)['unsafeSkipReclaimRevalidation'] = true
      ;(Object.prototype as Record<string, unknown>)['linkSyncOverride'] = pollutedLinkSync

      const release = acquireOwnedLock(target, { timeoutMs: 1_000 })
      release()

      expect(spy).toHaveBeenCalledTimes(1)
      const forwarded = spy.mock.calls[0]?.[1]
      expect(forwarded?.unsafeSkipReclaimRevalidation).toBeUndefined()
      expect(forwarded?.linkSyncOverride).toBeUndefined()
    } finally {
      if (origUnsafeSkip) {
        Object.defineProperty(Object.prototype, 'unsafeSkipReclaimRevalidation', origUnsafeSkip)
      } else {
        delete (Object.prototype as Record<string, unknown>)['unsafeSkipReclaimRevalidation']
      }
      if (origLinkSync) {
        Object.defineProperty(Object.prototype, 'linkSyncOverride', origLinkSync)
      } else {
        delete (Object.prototype as Record<string, unknown>)['linkSyncOverride']
      }
      spy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// §8c — orphaned reclaim lock (residual R1). Single-process: the "orphan" is
// simulated by hand-planting a live-owner reclaim-lock file, not by a real
// crash — the assertions are about R1's documented BLAST RADIUS (auto-reclaim
// disabled, locking itself unaffected), not about producing a real orphan.
// ---------------------------------------------------------------------------

describe('orphaned reclaim lock (residual R1, §8c)', () => {
  it('1. a pre-existing (live-owner) reclaim lock blocks reclaim of a genuinely dead-PID main lock', () => {
    const deadPid = mintDeadPid()
    seed(v1(deadPid), lockPath)
    seed(v1(process.pid), reclaimPath) // "orphan" stand-in: live-owner reclaim lock
    const beforeLock = readFileSync(lockPath)
    const beforeReclaim = readFileSync(reclaimPath)

    let caught: StuckLockError | undefined
    try {
      acquireOwnedLock(target, { timeoutMs: 800, reclaimProbeAfterMs: 0 })
    } catch (err) {
      caught = err as StuckLockError
    }

    expect(caught).toBeInstanceOf(StuckLockError)
    expect(caught?.reason).toBe('reclaim_unavailable')
    expect(caught?.message).toContain(lockPath)
    expect(caught?.message).toContain(reclaimPath)
    expect(caught?.message.toLowerCase()).toContain('manual unstick')
    expect(readFileSync(lockPath).equals(beforeLock)).toBe(true)
    expect(readFileSync(reclaimPath).equals(beforeReclaim)).toBe(true)
  })

  it('2. with no main lock present, acquisition succeeds despite an orphaned reclaim lock (locking unaffected)', () => {
    seed(v1(process.pid), reclaimPath) // orphan stand-in; no `.lock` file exists
    const release = acquireOwnedLock(target, { timeoutMs: 1_000 })
    release()
  })

  it('3. removing the orphan restores service — the dead-PID lock reclaims normally afterward', () => {
    const deadPid = mintDeadPid()
    seed(v1(deadPid), lockPath)
    seed(v1(process.pid), reclaimPath)

    rmSync(reclaimPath) // the documented manual unstick

    const release = acquireOwnedLock(target, { timeoutMs: 2_000, reclaimProbeAfterMs: 0 })
    expect(existsSync(reclaimPath)).toBe(false)
    release()
  })
})

// ---------------------------------------------------------------------------
// SMI-6529 round 8 — non-waiting callers (`timeoutMs: 0`), as fan-out's
// destination lock uses the primitive: each attempt is one try, and the
// caller awaits between attempts itself.
// ---------------------------------------------------------------------------

describe('non-waiting callers (SMI-6529 round 8)', () => {
  it('1. a lock released between our failed create and the claim read is reported as held, not unparseable', () => {
    seed(v1(process.pid)) // a live holder
    // The holder releases in the window after our link fails with EEXIST.
    const releaseOnEexist = (existing: string, newPath: string): void => {
      try {
        linkSync(existing, newPath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') rmSync(newPath, { force: true })
        throw err
      }
    }

    let caught: StuckLockError | undefined
    try {
      acquireOwnedLockCore(target, {
        timeoutMs: 0,
        reclaimProbeAfterMs: 0,
        linkSyncOverride: releaseOnEexist,
      })
    } catch (err) {
      caught = err as StuckLockError
    }

    // 'held' is retried by the caller; 'unreclaimable_unparseable' was
    // fatal, and its message told the user to delete a live lock.
    expect(caught).toBeInstanceOf(StuckLockError)
    expect(caught?.reason).toBe('held')
  })

  it('2. reclaimLockTimeoutMs: 0 gives up on an orphaned reclaim lock at once instead of sleeping', () => {
    seed(v1(mintDeadPid()), lockPath)
    seed(v1(process.pid), reclaimPath) // orphan stand-in

    const started = Date.now()
    let caught: StuckLockError | undefined
    try {
      acquireOwnedLock(target, { timeoutMs: 0, reclaimProbeAfterMs: 0, reclaimLockTimeoutMs: 0 })
    } catch (err) {
      caught = err as StuckLockError
    }
    expect(caught?.reason).toBe('reclaim_unavailable')
    expect(Date.now() - started).toBeLessThan(RECLAIM_LOCK_TIMEOUT_MS / 2)

    // Control: the default waits the full reclaim timeout in a synchronous sleep.
    const controlStarted = Date.now()
    expect(() => acquireOwnedLock(target, { timeoutMs: 0, reclaimProbeAfterMs: 0 })).toThrow(
      StuckLockError
    )
    expect(Date.now() - controlStarted).toBeGreaterThanOrEqual(RECLAIM_LOCK_TIMEOUT_MS)
  })
})

// ---------------------------------------------------------------------------
// SMI-6529 round 9 — a lock that can never be released fails fast, a live
// holder is named even with auto-reclaim off, and bad timing options can't
// hang the synchronous wait.
// ---------------------------------------------------------------------------

describe('unreleasable locks and timing options (SMI-6529 round 9)', () => {
  function attempt(): StuckLockError | undefined {
    try {
      acquireOwnedLock(target, { timeoutMs: 0, reclaimProbeAfterMs: 0 })
    } catch (err) {
      return err as StuckLockError
    }
    return undefined
  }

  it('1. a dangling symlink at the lock path is unparseable, not a released lock', () => {
    symlinkSync(path.join(dir, 'nowhere'), lockPath)
    expect(attempt()?.reason).toBe('unreclaimable_unparseable')
  })

  // root can read a mode-000 file, so the case only exists for other users.
  it.skipIf(process.getuid?.() === 0)(
    '2. a lock we may not read is unparseable, not a released lock',
    () => {
      seed(v1(process.pid))
      chmodSync(lockPath, 0o000)
      expect(attempt()?.reason).toBe('unreclaimable_unparseable')
    }
  )

  it('3. with auto-reclaim off, a live holder is still reported as held, by pid', () => {
    seed(v1(process.pid))
    process.env['SKILLSMITH_LOCK_NO_AUTO_RECLAIM'] = '1'
    let caught: StuckLockError | undefined
    try {
      caught = attempt()
    } finally {
      delete process.env['SKILLSMITH_LOCK_NO_AUTO_RECLAIM']
    }
    expect(caught?.reason).toBe('held')
    expect(caught?.message).toContain(`pid ${process.pid}`)
  })

  it('4. timing options fall back to the default unless finite and non-negative', () => {
    const cases: Array<[number | undefined, number]> = [
      [undefined, 7],
      [Number.NaN, 7],
      [Number.POSITIVE_INFINITY, 7],
      [Number.NEGATIVE_INFINITY, 7],
      [-1, 7],
      [0, 0],
      [0.5, 0.5],
      [250, 250],
    ]
    for (const [input, expected] of cases) {
      expect(toTimingMs(input, 7), String(input)).toBe(expected)
    }
  })

  it('5. reclaimLockTimeoutMs: NaN no longer hangs the synchronous wait', () => {
    seed(v1(mintDeadPid()), lockPath)
    seed(v1(process.pid), reclaimPath) // orphan stand-in
    // Run in a child: a regression is an endless synchronous loop, which
    // would hang this test process instead of failing it.
    const moduleUrl = new URL('./owned-lock.ts', import.meta.url).href
    const script =
      `const { acquireOwnedLock } = await import(${JSON.stringify(moduleUrl)});` +
      `try { acquireOwnedLock(${JSON.stringify(target)}, ` +
      `{ timeoutMs: 0, reclaimProbeAfterMs: 0, reclaimLockTimeoutMs: NaN }); ` +
      `console.log('acquired') } catch (err) { console.log(err.reason) }`
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { encoding: 'utf-8', timeout: 15_000 }
    )
    expect(child.signal, child.stderr).toBeNull()
    expect(child.stdout.trim()).toBe('reclaim_unavailable')
  }, 20_000)
})

describe('SMI-6764: one verb for every reason, and a remedy that may say "it depends"', () => {
  const ABSENT = { kind: 'absent' } as const
  const REASONS: StuckLockReason[] = [
    'held',
    'reclaim_unavailable',
    'unreclaimable_legacy',
    'unreclaimable_unparseable',
    'reclaim_disabled',
  ]

  const render = (reason: StuckLockReason): string =>
    new StuckLockError('/tmp/t.lock', '/tmp/t.lock.reclaim', 'config lock', reason, ABSENT).message

  // A v1 claim, because `describeReason`'s `held` branch renders the pid/host
  // text ONLY for `kind: 'v1'`. The first version of test 4 below used the
  // absent claim above and therefore never reached that branch: restoring
  // "(still alive)" passed it. A probe that cannot reach the code it is about
  // returns the same answer whichever state is true.
  const V1 = {
    kind: 'v1',
    pid: 4242,
    token: 'a'.repeat(16),
    host: 'testhost',
    acquiredAt: 0,
  } as const
  const renderV1 = (reason: StuckLockReason): string =>
    new StuckLockError('/tmp/t.lock', '/tmp/t.lock.reclaim', 'config lock', reason, V1).message

  /**
   * EXACT expected remedy per reason, not a phrase from it (SMI-6768 round 6).
   *
   * Two rounds of phrase lists failed here, and the second failure is the
   * argument for abandoning the technique rather than extending it. A list of
   * spellings only ever catches a wording someone already imagined: round 5
   * re-stated a liveness claim one sentence to the right and passed a
   * `/still alive/` grep; round 6 then defeated the broadened list with "The
   * lock is held by a running process that will release it", and separately
   * showed that DELETING both new sentences, or INVERTING their truth, left
   * every assertion green. A phrase list constrains the absence of known
   * strings. It cannot constrain presence, and it cannot constrain truth.
   *
   * `toBe` constrains all three. It does not understand the prose -- nothing
   * available here does -- but it makes every change to it fail, which forces
   * the change back through a human. That is the honest guarantee, and it is
   * strictly more than the list gave.
   */
  const EXPECTED_REMEDY: Record<StuckLockReason, string> = {
    held:
      'The holder was not established to be gone, so retrying is the right first response. ' +
      'If it persists, the claim may name another host or a pid this process cannot probe; ' +
      'neither is auto-reclaimed from here, so only the manual steps clear those.',
    reclaim_unavailable:
      'If a reclaim is in flight, retrying clears this. If it persists, the reclaim lock named ' +
      'below was orphaned by a crash inside the critical section; nothing reclaims that one ' +
      'automatically, so only the manual steps clear it.',
    unreclaimable_legacy:
      'A legacy claim is never auto-reclaimed, in any configuration (SMI-5883 D-5). If its ' +
      'process is alive it still releases on its own; if it is dead, only the manual steps clear it.',
    unreclaimable_unparseable:
      'An unparseable claim is never auto-reclaimed, so only the manual steps clear it.',
    reclaim_disabled:
      'The holder is already dead and auto-reclaim is off in this process, so retrying HERE ' +
      'cannot reclaim it -- though a peer process without SKILLSMITH_LOCK_NO_AUTO_RECLAIM set ' +
      'still can. Unset it here and restart this process, or use the manual steps.',
  }

  /**
   * The `held` reason clause, both claim kinds, exact. Round 6 showed the
   * remedy table alone leaves `describeReason` free: appending "(the process
   * is still running)" to the v1 branch, or ", which is still running" to the
   * non-v1 branch, both rendered a false liveness claim with the suite green.
   * The message has two prose layers and pinning one is not pinning it.
   */
  const EXPECTED_HELD_REASON = {
    v1: "held by pid 4242 on host 'testhost'",
    absent: 'held by another process',
  } as const

  /**
   * The full rendered message, composed from parts THIS TEST owns (SMI-6776).
   *
   * The cross-family round proposed nine mutations and all nine survived. Six
   * same-family rounds had never generated any of their categories. The common
   * shape: every assertion checked the PRESENCE of a string -- a heading, a
   * path, a phrase -- and none checked what that string was doing. So step 2
   * could be made to run `rm` under the heading "inspect (read-only)", the
   * headline could name the reclaim lock, and `namesReclaim` could be inverted,
   * all with the suite green.
   *
   * Composing the expectation fixes the class rather than the nine instances:
   * the test states which paths each reason may name and which command belongs
   * to each step, so any change to either side fails. Nothing here is read off
   * the implementation.
   */
  const L = '/tmp/t.lock'
  const R = '/tmp/t.lock.reclaim'

  /** Which paths each reason is allowed to name. Pinned in BOTH directions. */
  const PATHS_NAMED: Record<StuckLockReason, string[]> = {
    held: [L],
    reclaim_unavailable: [L, R],
    unreclaimable_legacy: [L],
    unreclaimable_unparseable: [L],
    reclaim_disabled: [L],
  }

  /** Step 2 inspects (read-only). Step 3 removes. Asserted, not assumed. */
  const steps = (paths: string[]): string =>
    `Manual unstick -- 1) confirm no skillsmith process is running: ps -ax | grep -E '[s]killsmith|[s]klx'; ` +
    `2) inspect (read-only): ${paths.map((x) => `cat ${x}`).join(' ; ')}; ` +
    `3) remove ONLY the file(s) named above: ${paths.map((x) => `rm ${x}`).join(' ; ')}.`

  const EXPECTED_REASON_CLAUSE: Record<StuckLockReason, string> = {
    held: 'held by another process',
    reclaim_unavailable: `the reclaim lock at ${R} is held or was orphaned by a crash inside the reclaim critical section (residual R1)`,
    unreclaimable_legacy:
      'held by a legacy (pre-v1) claim -- legacy claims carry no host attribution and are NEVER auto-reclaimed (SMI-5883 D-5)',
    unreclaimable_unparseable:
      'the lock file could not be parsed as a recognized claim -- never auto-reclaimed',
    reclaim_disabled: 'auto-reclaim is disabled (SKILLSMITH_LOCK_NO_AUTO_RECLAIM=1)',
  }

  const fullMessage = (reason: StuckLockReason): string =>
    `[skillsmith] Could not acquire config lock at ${L}: ` +
    `${EXPECTED_REASON_CLAUSE[reason]}. ${EXPECTED_REMEDY[reason]} ${steps(PATHS_NAMED[reason])}`

  it('0. every reason renders EXACTLY the composed message, headline to final period', () => {
    for (const reason of REASONS) {
      expect(render(reason), reason).toBe(fullMessage(reason))
    }
  })

  it('0a. the public lockPath/reclaimPath properties equal the constructor inputs', () => {
    // Nothing in core asserted these, and they are public API -- CLAUDE.md's
    // StuckLockError troubleshooting row tells users to read them and remove
    // ONLY the files they name. Two mutations (SMI-6776 C4/C5) swapped them
    // for each other and survived every message assertion, because the message
    // is built from the constructor's locals rather than from `this`.
    for (const reason of REASONS) {
      const err = new StuckLockError(L, R, 'config lock', reason, ABSENT)
      expect(err.lockPath, `${reason}: lockPath`).toBe(L)
      expect(err.reclaimPath, `${reason}: reclaimPath`).toBe(R)
      expect(err.lockPath, `${reason}: the two must never collapse`).not.toBe(err.reclaimPath)
    }
  })

  it('0b. the reclaim path is named by exactly one reason, and by no other', () => {
    // Pinned both ways: inverting `namesReclaim` strips it from the reason that
    // needs it AND adds it to four that never implicate that file. One
    // direction alone leaves the other free (SMI-6776 C2, superseding SMI-6769).
    for (const reason of REASONS) {
      const shouldName = reason === 'reclaim_unavailable'
      expect(render(reason).includes(R), `${reason} names reclaim path?`).toBe(shouldName)
    }
  })

  it('0c. the unparseable remedy names no single cause, because several produce it', () => {
    // Not closable by exact-match alone: production and its oracle can be
    // reworded together. But the invariant is real and independent of wording --
    // `unparseable` is reached by malformed JSON, an oversized claim, an empty
    // file, a permission failure, a dangling symlink and an unsupported version,
    // so naming any one of them is false for the rest (SMI-6776 C9).
    const remedy = EXPECTED_REMEDY.unreclaimable_unparseable
    for (const cause of [
      /JSON/i,
      /symlink/i,
      /permission/i,
      /empty file/i,
      /version/i,
      /too large/i,
    ]) {
      expect(remedy, `must not name a single cause: ${cause}`).not.toMatch(cause)
    }
    expect(describeRemedy('unreclaimable_unparseable')).toBe(remedy)
  })

  it('1. every reason opens with the same verb, and none claims a timeout', () => {
    // "Timed out waiting" asserted a wait this class often never measured:
    // `file-lock.ts` calls in with `timeoutMs: 0` and keeps its own 30s budget
    // outside, so the wait the old message described was zero milliseconds.
    for (const reason of REASONS) {
      expect(render(reason), reason).toMatch(/^\[skillsmith\] Could not acquire config lock at /)
      expect(render(reason), reason).not.toMatch(/Timed out/)
    }
  })

  it('2. every reason renders its remedy EXACTLY, and no other reason\u2019s', () => {
    for (const reason of REASONS) {
      // Presence and truth, not just absence of a known-bad phrase.
      expect(describeRemedy(reason), `${reason} remedy must be exact`).toBe(EXPECTED_REMEDY[reason])
      const message = render(reason)
      expect(message, `${reason} must render its own remedy`).toContain(EXPECTED_REMEDY[reason])
      for (const other of REASONS) {
        if (other === reason) continue
        expect(message, `${reason} must not state ${other}'s remedy`).not.toContain(
          EXPECTED_REMEDY[other]
        )
      }
    }
  })

  it('2b. `held`\u2019s reason clause is exact too, on both claim kinds', () => {
    expect(renderV1('held')).toContain(`: ${EXPECTED_HELD_REASON.v1}. `)
    expect(render('held')).toContain(`: ${EXPECTED_HELD_REASON.absent}. `)
  })

  it('3. the reasons whose answer is not determined say so, rather than guessing', () => {
    // This is why the verb had to go. Each of these three depends on a fact
    // `reason` does not carry, so a binary verb could only guess -- and for an
    // orphaned reclaim lock, which never clears, it guessed "Timed out waiting".
    expect(render('reclaim_unavailable')).toMatch(/If a reclaim is in flight, retrying clears this/)
    expect(render('reclaim_unavailable')).toMatch(/only the manual steps clear it/)
    expect(render('unreclaimable_legacy')).toMatch(/if it is dead, only the manual steps clear it/)
    expect(render('reclaim_disabled')).toMatch(/retrying HERE cannot reclaim it/)
  })

  /**
   * Every spelling of "the holder is alive" this message has carried, plus the
   * one that replaced it. A list of literals is a weak instrument -- it only
   * ever catches a phrasing someone already thought of -- which is precisely
   * how the second entry shipped: the first version of test 4 grepped for
   * `/still alive/` alone, so moving the same assertion one sentence to the
   * right, into `describeRemedy`, passed it. Test 6 below is the property
   * test this list cannot be; keep both.
   */
  const LIVENESS_ASSERTIONS: RegExp[] = [
    /still alive/,
    /A live holder is expected to release/,
    /the holder is (still )?(alive|running|live)/i,
  ]

  it('4. no reason asserts liveness that was never probed', () => {
    // Known-positive control FIRST: prove this fixture reaches the branch the
    // assertion is about. Without it the negative below is vacuous, which is
    // exactly how it passed once already.
    expect(renderV1('held')).toMatch(/held by pid 4242 on host 'testhost'/)
    // `held` is also the SAFE DEFAULT when the probe never ran, so the old
    // "(still alive)" rendered for a deliberately dead pid. Measured.
    for (const reason of REASONS) {
      for (const pattern of LIVENESS_ASSERTIONS) {
        expect(renderV1(reason), `v1/${reason} vs ${pattern}`).not.toMatch(pattern)
        expect(render(reason), `absent/${reason} vs ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it('5. the unstick procedure is identical under every reason', () => {
    for (const reason of REASONS) {
      const message = render(reason)
      expect(message, reason).toContain('1) confirm no skillsmith process is running')
      expect(message, reason).toContain('2) inspect (read-only)')
      expect(message, reason).toContain('3) remove ONLY the file(s) named above')
    }
  })

  /**
   * The property test tests 1-5 are not. Those all construct `StuckLockError`
   * directly, so they assert what the message SAYS for a reason chosen by the
   * test. This one drives the real acquire loop into the state where `held`'s
   * remedy would be false, and reads what it actually renders there.
   *
   * That distinction is what the previous round missed. `describeRemedy` takes
   * only `reason` -- it cannot see the claim at all, strictly less than
   * `describeReason`, which at least gets the pid -- and `held` is not the
   * determined case it was treated as. Three states reach it with no live
   * holder, each measured (SMI-6764 round 5):
   *
   *   a. the probe never ran (`timeoutMs` < `reclaimProbeAfterMs`), so `held`
   *      is the safe default and the pid may be long dead;
   *   b. the claim names another host -- `isV1OwnerDead` returns false on the
   *      host mismatch, before it signals anything;
   *   c. the claim carries a pid `isV1OwnerDead` refuses to probe at all
   *      (non-integer, or <= 0) -- which `parseClaim` accepts as v1, and which
   *      therefore nothing will ever reclaim.
   *
   * (b) and (c) are the sharper half: there the lock does NOT clear by
   * retrying, so a remedy promising that it will is the same never-clears trap
   * SMI-6759/SMI-6764 removed from `reclaim_unavailable`, surviving under the
   * one reason nobody re-examined.
   */
  it('6. `held` renders no liveness claim in the states that produce it without one', () => {
    const cases: { name: string; claim: Record<string, unknown>; opts: object }[] = [
      {
        // Known-positive control is asserted inline below: this pid is dead.
        name: 'a. definitely-dead pid, this host, probe never runs',
        claim: { v: 1, pid: mintDeadPid(), token: 'a'.repeat(16), host: hostname(), acquiredAt: 0 },
        opts: { timeoutMs: 50 }, // < RECLAIM_PROBE_AFTER_MS (250)
      },
      {
        name: 'b. claim from another host -- liveness never probed',
        claim: {
          v: 1,
          // DEAD, deliberately (SMI-6768 round 6). With a live pid, `false`
          // from the control below is equally consistent with "probed and
          // found alive", so it cannot witness the host-mismatch bail this
          // case is named for. Dead + foreign host makes `false` mean
          // "declined to probe" and nothing else. Verified: removing the host
          // guard from `isV1OwnerDead` now fails this case by name.
          pid: mintDeadPid(),
          token: 'b'.repeat(16),
          host: `not-${hostname()}`,
          acquiredAt: 0,
        },
        opts: { timeoutMs: 0, reclaimProbeAfterMs: 0, reclaimLockTimeoutMs: 0 },
      },
      {
        name: 'c. pid <= 0 -- unprobeable, so never auto-reclaimed',
        claim: { v: 1, pid: -1, token: 'c'.repeat(16), host: hostname(), acquiredAt: 0 },
        opts: { timeoutMs: 0, reclaimProbeAfterMs: 0, reclaimLockTimeoutMs: 0 },
      },
    ]

    for (const { name, claim, opts } of cases) {
      rmSync(lockPath, { force: true })
      writeFileSync(lockPath, JSON.stringify(claim) + '\n')

      // Known-positive control: prove the fixture reaches the state it names,
      // so a failure to render the liveness claim cannot be a fixture that
      // simply never got there. For (a) the pid must genuinely be dead; for
      // (b) and (c) the probe must genuinely decline to call it dead.
      const parsed = { kind: 'v1', ...claim } as unknown as Parameters<
        typeof isOwnerDefinitelyDead
      >[0]
      expect(isOwnerDefinitelyDead(parsed), `${name}: control`).toBe(name.startsWith('a.'))

      let caught: unknown
      try {
        acquireOwnedLockCore(target, { label: 'config lock', ...opts })()
      } catch (err) {
        caught = err
      }
      expect(caught, `${name}: must refuse`).toBeInstanceOf(StuckLockError)
      const error = caught as StuckLockError
      // Guard the guard: if any of these ever stops classifying as `held`,
      // this test silently stops covering `held` at all.
      expect(error.reason, `${name}: must classify as held`).toBe('held')

      for (const pattern of LIVENESS_ASSERTIONS) {
        expect(error.message, `${name} vs ${pattern}`).not.toMatch(pattern)
      }
      // Tie the rendered text to its single source, so re-wording `held`'s
      // remedy has to come back through this test and its three states.
      expect(error.message, name).toContain(describeRemedy('held'))
      // Case (a) is the only path that reaches the deadline's final read-only
      // claim fetch. Deleting that fetch left every test green while the
      // message silently degraded from the holder's pid and host to "held by
      // another process" -- and `file-lock.ts` passes `timeoutMs: 0`, so every
      // caller through it takes this path (SMI-6768 round 6).
      if (name.startsWith('a.')) {
        expect(error.message, `${name}: must name the holder it read`).toMatch(
          new RegExp(`held by pid ${String(claim.pid)} on host '${hostname()}'`)
        )
      }
    }
  })
})
