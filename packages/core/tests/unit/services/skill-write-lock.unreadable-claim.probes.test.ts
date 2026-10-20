/**
 * SMI-6531 / SMI-6676 (mutation hunt round 2): the re-probe of an unreadable
 * lock claim (`probeClaim` in `config/file-lock.ts`), one case per errno and
 * per way the owner can be unknown. Companion to
 * `skill-write-lock.unreadable-claim.test.ts`, whose seam it repeats: the
 * container reads any file as root, so an unreadable claim is simulated by
 * failing `openSync` of the claim path while the file exists.
 *
 *  - EPERM, like EACCES, on another user's claim is waited out to the deadline
 *    and ends with the "another user, do not remove" detail;
 *  - ENFILE on the re-probe is retried (descriptor exhaustion clears by itself),
 *    keeping the "another user" wording once an earlier probe saw the claim
 *    unreadable;
 *  - ENOENT on the re-probe is retried but is NOT evidence of another user's
 *    claim: with no earlier unreadable probe the detail stays owned-lock's own;
 *  - a claim whose owner cannot be established (`lstat` throws, or the platform
 *    has no `getuid`) stays "unreadable", the cautious reading, so it is waited
 *    out rather than refused at once.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const inject = vi.hoisted(() => ({
  path: null as string | null,
  failures: 0,
  /** Failure n (1-based) gets this errno; each attempt is two opens: owned-lock's, then the re-probe's. */
  codeFor: ((): string => 'EACCES') as (n: number) => string,
  /** The uid `lstat` reports for the claim (null: the real one, this process's). */
  lstatUid: null as number | null,
  /** `lstat` of the claim throws this errno (null: it does not). */
  lstatThrows: null as string | null,
  lstatCalls: 0,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const openSync = ((p: import('node:fs').PathLike, ...rest: unknown[]) => {
    if (inject.path !== null && String(p) === inject.path && actual.existsSync(inject.path)) {
      inject.failures += 1
      const code = inject.codeFor(inject.failures)
      throw Object.assign(new Error(`${code}: injected, open '${String(p)}'`), { code })
    }
    return (actual.openSync as (...a: unknown[]) => number)(p, ...rest)
  }) as typeof actual.openSync
  const lstatSync = ((p: import('node:fs').PathLike, ...rest: unknown[]) => {
    if (inject.path !== null && String(p) === inject.path) {
      inject.lstatCalls += 1
      if (inject.lstatThrows !== null) {
        const code = inject.lstatThrows
        throw Object.assign(new Error(`${code}: injected, lstat '${String(p)}'`), { code })
      }
    }
    const st = (actual.lstatSync as (...a: unknown[]) => import('node:fs').Stats)(p, ...rest)
    if (inject.lstatUid === null || String(p) !== inject.path) return st
    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: inject.lstatUid })
  }) as typeof actual.lstatSync
  return { ...actual, openSync, lstatSync, default: { ...actual, openSync, lstatSync } }
})

vi.mock('../../../src/services/skill-write-lock.gitignore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/skill-write-lock.gitignore.js')>()),
  stagingGitignoreHint: vi.fn(async () => null),
}))

import { setLockTrackerEnabledForTests } from '../../../src/config/lock-tracker.js'
import { withSkillWriteLock } from '../../../src/services/skill-write-lock.js'

let root: string
let claim: string
let realGetuid: typeof process.getuid

const foreignClaim = (): string =>
  JSON.stringify({
    v: 1,
    pid: process.pid,
    token: 'a'.repeat(16),
    host: os.hostname(),
    acquiredAt: Date.now(),
  })

const ANOTHER_USER = (path: string): string =>
  `the write lock at ${path} is held by another user whose claim this user cannot read. ` +
  'Try again later; do not remove the lock file.'

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  realGetuid = process.getuid
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-write-lock-probes-')))
  claim = path.join(root, '.skillsmith-writes.lock')
  fs.writeFileSync(claim, `${foreignClaim()}\n`, { mode: 0o600 })
  inject.path = claim
  inject.failures = 0
  inject.codeFor = () => 'EACCES'
  inject.lstatUid = (process.getuid?.() ?? 0) + 1 // another user's claim
  inject.lstatThrows = null
  inject.lstatCalls = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  Object.defineProperty(process, 'getuid', {
    value: realGetuid,
    configurable: true,
    writable: true,
  })
  inject.path = null
  inject.lstatUid = null
  inject.lstatThrows = null
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('an unreadable claim is waited out whatever the permission errno', () => {
  it.each(['EACCES', 'EPERM'])(
    '%s on another user’s claim: waits to the deadline, ends busy with the do-not-remove detail',
    async (code) => {
      inject.codeFor = () => code
      const fn = vi.fn(async () => 'ran')
      const t0 = performance.now()
      const r = await withSkillWriteLock(root, 't', fn, { timeoutMs: 400 })
      const waited = performance.now() - t0
      expect(fn).not.toHaveBeenCalled()
      expect(!r.ok && r.stop.code).toBe('busy')
      if (r.ok) throw new Error('unreachable')
      expect(waited).toBeGreaterThanOrEqual(350)
      expect(inject.failures).toBeGreaterThan(4) // it polled, it did not refuse on the first attempt
      expect(r.stop.detail).toBe(ANOTHER_USER(claim))
    }
  )
})

describe('descriptor exhaustion and a vanished claim on the re-probe', () => {
  it.each(['EMFILE', 'ENFILE'])(
    'unreadable twice, then %s at the deadline: still retried, still says do not remove',
    async (code) => {
      // Odd failures are owned-lock's open (always EACCES); the first two re-probes find the
      // claim unreadable, every later one is `code`.
      inject.codeFor = (n) => (n % 2 === 1 || n <= 4 ? 'EACCES' : code)
      const r = await withSkillWriteLock(root, 't', async () => 'ran', { timeoutMs: 400 })
      expect(!r.ok && r.stop.code).toBe('busy')
      if (r.ok) throw new Error('unreachable')
      expect(inject.failures).toBeGreaterThan(6) // it really went on to the `code` probes
      expect(r.stop.detail).toBe(ANOTHER_USER(claim))
    }
  )

  it('ENOENT on the re-probe with no earlier unreadable probe: retried to the deadline, owned-lock’s own detail', async () => {
    inject.codeFor = (n) => (n % 2 === 1 ? 'EACCES' : 'ENOENT')
    const t0 = performance.now()
    const r = await withSkillWriteLock(root, 't', async () => 'ran', { timeoutMs: 400 })
    const waited = performance.now() - t0
    expect(!r.ok && r.stop.code).toBe('busy')
    if (r.ok) throw new Error('unreachable')
    expect(waited).toBeGreaterThanOrEqual(350) // ENOENT is retried
    expect(inject.failures).toBeGreaterThan(4)
    expect(r.stop.detail).toContain(`rm ${claim}`) // owned-lock's remedy, kept
    expect(r.stop.detail).not.toContain('another user whose claim this user cannot read')
  })
})

describe('a claim whose owner cannot be established is waited on, not refused at once', () => {
  it('control: an lstat that works and names this user’s uid refuses at once (the seam sees the owner check)', async () => {
    inject.lstatUid = null // the real lstat: this process owns the claim
    const t0 = performance.now()
    const r = await withSkillWriteLock(root, 't', async () => 'ran', { timeoutMs: 2000 })
    expect(!r.ok && r.stop.code).toBe('busy')
    expect(performance.now() - t0).toBeLessThan(1500) // well under the 2000 ms a wait would take
    expect(inject.lstatCalls).toBeGreaterThan(0)
  })

  it('the owner lstat throws: treated as unreadable, waited out to the deadline', async () => {
    inject.lstatThrows = 'EIO'
    const t0 = performance.now()
    const r = await withSkillWriteLock(root, 't', async () => 'ran', { timeoutMs: 400 })
    const waited = performance.now() - t0
    expect(inject.lstatCalls).toBeGreaterThan(0) // the lstat really was asked, and really threw
    expect(!r.ok && r.stop.code).toBe('busy')
    if (r.ok) throw new Error('unreachable')
    expect(waited).toBeGreaterThanOrEqual(350)
    expect(r.stop.detail).toBe(ANOTHER_USER(claim))
  })

  it('the platform has no getuid: treated as unreadable, waited out to the deadline', async () => {
    // The real lstat: the claim is this process's own, so only the missing getuid can make the
    // owner unknown. A foreign lstat uid here would also wait, and could not tell the two apart.
    inject.lstatUid = null
    Object.defineProperty(process, 'getuid', {
      value: undefined,
      configurable: true,
      writable: true,
    })
    const t0 = performance.now()
    const r = await withSkillWriteLock(root, 't', async () => 'ran', { timeoutMs: 400 })
    const waited = performance.now() - t0
    expect(typeof process.getuid).toBe('undefined') // the stub held for the whole call
    expect(!r.ok && r.stop.code).toBe('busy')
    if (r.ok) throw new Error('unreachable')
    expect(waited).toBeGreaterThanOrEqual(350)
    expect(r.stop.detail).toBe(ANOTHER_USER(claim))
  })
})
