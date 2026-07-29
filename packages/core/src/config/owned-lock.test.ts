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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import * as path from 'node:path'
import * as os from 'node:os'

import { acquireOwnedLock, StuckLockError } from './owned-lock.js'
import { createLockExclusive } from './owned-lock.claim.js'
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
    const release = acquireOwnedLock(target, { timeoutMs: 1_000 })
    const raw = readFileSync(lockPath, 'utf-8')
    const parsed = JSON.parse(raw) as { v: number; pid: number; token: string; host: string }
    expect(parsed.v).toBe(1)
    expect(parsed.pid).toBe(process.pid)
    expect(parsed.host).toBe(hostname())
    expect(/^[0-9a-f]{16}$/.test(parsed.token)).toBe(true)
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
