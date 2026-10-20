/**
 * SMI-6531 (A1 step 2, C2) and the lock-wait half of T-K2: another user's lock
 * claim is mode 0600, so this user cannot read it (`open` fails EACCES).
 * Lock 1 must WAIT for such a claim and end `busy` at its deadline; the default
 * `withFileLock` still fails on it at once, and a claim that opens but is
 * corrupt is not waited on.
 *
 * The container runs as root, which reads any file, so the unreadable claim is
 * simulated by failing `openSync` of the claim path with EACCES while the file
 * exists (the same seam `lock-tracker.release-failure.test.ts` uses). That also
 * exercises the real code path: owned-lock sees the failed open, and the
 * wrapper re-probes with its own open.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const inject = vi.hoisted(() => ({
  path: null as string | null,
  code: 'EACCES',
  failures: 0,
  /** The other user releases the instant our first open is refused (E: ENOENT on the re-probe). */
  releaseOnFirstFailure: false,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const openSync = ((p: import('node:fs').PathLike, ...rest: unknown[]) => {
    if (inject.path !== null && String(p) === inject.path && actual.existsSync(inject.path)) {
      inject.failures += 1
      if (inject.releaseOnFirstFailure && inject.failures === 1) {
        // The other user's writer finishes: its claim is gone, and nothing is refused after this open.
        actual.unlinkSync(inject.path)
        inject.path = null
        throw Object.assign(new Error(`${inject.code}: injected, open '${String(p)}'`), {
          code: inject.code,
        })
      }
      throw Object.assign(new Error(`${inject.code}: injected, open '${String(p)}'`), {
        code: inject.code,
      })
    }
    return (actual.openSync as (...a: unknown[]) => number)(p, ...rest)
  }) as typeof actual.openSync
  return { ...actual, openSync, default: { ...actual, openSync } }
})

vi.mock('../../../src/services/skill-write-lock.gitignore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/skill-write-lock.gitignore.js')>()),
  stagingGitignoreHint: vi.fn(async () => null),
}))

import { withFileLock } from '../../../src/config/file-lock.js'
import { setLockTrackerEnabledForTests } from '../../../src/config/lock-tracker.js'
import { StuckLockError } from '../../../src/config/owned-lock.js'
import { withSkillWriteLock } from '../../../src/services/skill-write-lock.js'

let root: string
let claim: string

/** A well-formed claim naming a live process on this host (as another user's would). */
const foreignClaim = (): string =>
  JSON.stringify({
    v: 1,
    pid: process.pid,
    token: 'a'.repeat(16),
    host: os.hostname(),
    acquiredAt: Date.now(),
  })

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-write-lock-unreadable-')))
  claim = path.join(root, '.skillsmith-writes.lock')
  fs.writeFileSync(claim, `${foreignClaim()}\n`, { mode: 0o600 })
  inject.path = claim
  inject.code = 'EACCES'
  inject.failures = 0
  inject.releaseOnFirstFailure = false
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  inject.path = null
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('lock 1 on a claim this user cannot read', () => {
  it('waits until its deadline, polling, and ends busy with owned-lock’s reason; fn never runs', async () => {
    const fn = vi.fn(async () => 'ran')
    const t0 = performance.now()
    const r = await withSkillWriteLock(root, 't', fn, { timeoutMs: 400 })
    const waited = performance.now() - t0
    expect(fn).not.toHaveBeenCalled()
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.stop.code).toBe('busy')
    expect(r.stop.reason).toBe('unreclaimable_unparseable')
    expect(r.stop.detail.length).toBeGreaterThan(0) // owned-lock's remedy text is kept
    expect(waited).toBeGreaterThanOrEqual(350)
    // It tried more than once: at least a few polls in 400 ms (each attempt opens the claim twice).
    expect(inject.failures).toBeGreaterThan(4)
  })

  it('the busy detail tells the user the lock is another user’s, to retry later, and not to remove it', async () => {
    const r = await withSkillWriteLock(root, 't', async () => 'ran', { timeoutMs: 300 })
    expect(!r.ok && r.stop.code).toBe('busy')
    if (r.ok) throw new Error('unreachable')
    expect(r.stop.detail).toBe(
      `the write lock at ${claim} is held by another user whose claim this user cannot read. ` +
        'Try again later; do not remove the lock file.'
    )
    expect(r.stop.detail).not.toContain('rm ')
  })

  it('control: a corrupt but readable claim keeps owned-lock’s own remedy text as the detail', async () => {
    inject.path = null // readable
    fs.writeFileSync(claim, 'not a claim at all\n')
    const r = await withSkillWriteLock(root, 't', async () => 'ran', { timeoutMs: 300 })
    expect(!r.ok && r.stop.code).toBe('busy')
    if (r.ok) throw new Error('unreachable')
    expect(r.stop.detail).toContain(`rm ${claim}`)
    expect(r.stop.detail).not.toContain('another user whose claim this user cannot read')
  })

  it('a claim released between owned-lock’s EACCES and the re-probe (ENOENT) is retried, and lock 1 is taken', async () => {
    inject.releaseOnFirstFailure = true
    const fn = vi.fn(async () => 'ran')
    const r = await withSkillWriteLock(root, 't', fn, { timeoutMs: 5000 })
    expect(inject.failures).toBeGreaterThanOrEqual(1) // the refusal really happened first
    expect(fs.existsSync(claim)).toBe(false) // and the other user's claim really was released
    expect(r).toMatchObject({ ok: true, value: 'ran' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('waiting pays off: when the other user releases, lock 1 is taken', async () => {
    const fn = vi.fn(async () => 'ran')
    setTimeout(() => fs.rmSync(claim), 150)
    const r = await withSkillWriteLock(root, 't', fn, { timeoutMs: 5000 })
    expect(r).toMatchObject({ ok: true, value: 'ran' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('control: the default withFileLock path fails at once on the same claim', async () => {
    const t0 = performance.now()
    const err = await withFileLock(path.join(root, '.skillsmith-writes'), 't', async () => 'ran', {
      rank: 'unordered',
      timeoutMs: 1000, // a wait would take 1 s; an immediate refusal is well under 300 ms
    }).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(StuckLockError)
    expect((err as StuckLockError).reason).toBe('unreclaimable_unparseable')
    expect(performance.now() - t0).toBeLessThan(300)
  })

  it('control: a claim that opens but is corrupt is not waited on, even for lock 1', async () => {
    inject.path = null // readable
    fs.writeFileSync(claim, 'not a claim at all\n')
    const t0 = performance.now()
    const r = await withSkillWriteLock(root, 't', async () => 'ran', { timeoutMs: 1000 })
    expect(!r.ok && r.stop.reason).toBe('unreclaimable_unparseable')
    expect(performance.now() - t0).toBeLessThan(300)
  })

  it('control: a non-permission open failure (EIO) is not waited on either', async () => {
    inject.code = 'EIO'
    const t0 = performance.now()
    const r = await withSkillWriteLock(root, 't', async () => 'ran', { timeoutMs: 1000 })
    expect(!r.ok && r.stop.reason).toBe('unreclaimable_unparseable')
    expect(performance.now() - t0).toBeLessThan(300)
  })
})
