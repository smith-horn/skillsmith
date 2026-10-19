/**
 * SMI-7143 (A1 step 0): `withFileLock`'s opt-in wait on a bare-PID (legacy)
 * claim (A1 plan §3.8, #8). A live older Skillsmith process may hold the
 * manifest lock in its own format; the manifest lock waits it out like any
 * live holder instead of failing at once. Every other caller keeps failing
 * at once, which is the default.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { withFileLock } from './file-lock.js'
import { StuckLockError } from './owned-lock.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})
const target = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flock-legacy-')))
  roots.push(root)
  return path.join(root, 'manifest.json')
}

describe('withFileLock and a bare-PID claim', () => {
  it('with waitOnLegacy: waits until the older process releases, warns once with its pid, then runs', async () => {
    const t = target()
    fs.writeFileSync(`${t}.lock`, '31337')
    const warned: (number | null)[] = []
    // The older process releases after 300 ms, several polls later.
    setTimeout(() => fs.rmSync(`${t}.lock`, { force: true }), 300)
    const t0 = Date.now()
    const out = await withFileLock(t, 'test', async () => 'ran', {
      waitOnLegacy: true,
      onLegacyWait: (pid) => warned.push(pid),
      rank: 'unordered',
    })
    expect(out).toBe('ran')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
    expect(warned).toEqual([31337])
  })

  it('control: without the option the same claim fails at once, as before', async () => {
    const t = target()
    fs.writeFileSync(`${t}.lock`, '31337')
    const t0 = Date.now()
    const err = await withFileLock(t, 'test', async () => 'ran', { rank: 'unordered' }).catch(
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(StuckLockError)
    expect((err as StuckLockError).reason).toBe('unreclaimable_legacy')
    expect(Date.now() - t0).toBeLessThan(200)
    expect(fs.readFileSync(`${t}.lock`, 'utf8')).toBe('31337')
  })

  it('with waitOnLegacy, a legacy holder that never releases ends at the deadline with the legacy error', async () => {
    const t = target()
    fs.writeFileSync(`${t}.lock`, '31337')
    const t0 = Date.now()
    const err = await withFileLock(t, 'test', async () => 'ran', {
      waitOnLegacy: true,
      onLegacyWait: () => {},
      timeoutMs: 300,
      rank: 'unordered',
    }).catch((e: unknown) => e)
    const waited = Date.now() - t0
    expect((err as StuckLockError).reason).toBe('unreclaimable_legacy')
    expect(waited).toBeGreaterThanOrEqual(300)
    expect(waited).toBeLessThan(2000)
    expect(fs.readFileSync(`${t}.lock`, 'utf8')).toBe('31337')
  })

  it('an unparseable claim still fails at once with waitOnLegacy (the option covers legacy only)', async () => {
    const t = target()
    fs.writeFileSync(`${t}.lock`, 'not a claim')
    let warned = 0
    const err = await withFileLock(t, 'test', async () => 'ran', {
      waitOnLegacy: true,
      onLegacyWait: () => (warned += 1),
      rank: 'unordered',
    }).catch((e: unknown) => e)
    expect((err as StuckLockError).reason).toBe('unreclaimable_unparseable')
    expect(warned).toBe(0)
  })
})
