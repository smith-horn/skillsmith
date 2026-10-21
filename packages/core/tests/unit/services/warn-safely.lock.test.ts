/**
 * SMI-7143 (retro finding 6): warnings on the lock paths cannot throw.
 *
 * A lock release runs in `withFileLock`'s `finally`, so a throwing
 * `console.warn` there (an embedding application's logger) would replace the
 * work's result, a saved manifest included, or the `ManifestLockLost` that
 * triggers the retry. The legacy-wait notice is the same: a throw there would
 * abort a wait that should succeed. Each case runs with `console.warn`
 * throwing and checks that the warning was attempted, so a path that stopped
 * warning at all would not pass for the wrong reason.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { releaseOwned } from '../../../src/config/owned-lock.release.js'
import { withFileLock } from '../../../src/config/file-lock.js'
import { runManifestUpdate } from '../../../src/services/skill-manifest.lock.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})
const target = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'warn-safely-')))
  roots.push(root)
  return path.join(root, 'manifest.json')
}
const throwingWarn = () =>
  vi.spyOn(console, 'warn').mockImplementation(() => {
    throw new Error('logger exploded')
  })

describe('lock-path warnings with a throwing console.warn', () => {
  it('releaseOwned on a claim it cannot read warns, does not throw, and leaves the lock', () => {
    const t = target()
    const lockPath = `${t}.lock`
    fs.writeFileSync(lockPath, 'someone else') // unparseable, so unverified rather than not-owner
    const warn = throwingWarn()

    expect(() => releaseOwned(lockPath, 'our-token')).not.toThrow()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lock_release_unverified'))
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('someone else')
  })

  it('releaseOwned on a readable claim naming someone else warns, does not throw, and leaves the lock', () => {
    const t = target()
    const lockPath = `${t}.lock`
    const foreign = JSON.stringify({
      v: 1,
      pid: process.pid,
      token: 'f'.repeat(16),
      host: os.hostname(),
      acquiredAt: Date.now(),
    })
    fs.writeFileSync(lockPath, `${foreign}\n`)
    const warn = throwingWarn()

    expect(() => releaseOwned(lockPath, 'our-token')).not.toThrow()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lock_release_not_owner'))
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(`${foreign}\n`)
  })

  it("withFileLock returns the work's result when its lock was replaced while held", async () => {
    const t = target()
    const warn = throwingWarn()

    const out = await withFileLock(
      t,
      'test',
      async () => {
        fs.writeFileSync(`${t}.lock`, 'replaced by another process')
        return 'saved'
      },
      { rank: 'unordered' }
    )

    expect(out).toBe('saved')
    // The replacement text is not a claim anyone can read, so it is unverified.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lock_release_unverified'))
  })

  it('runManifestUpdate waits out an older version and saves, its default notice included', async () => {
    const t = target()
    fs.writeFileSync(t, JSON.stringify({ version: '1.0.0', installedSkills: {} }))
    fs.writeFileSync(`${t}.lock`, '31337')
    setTimeout(() => fs.rmSync(`${t}.lock`, { force: true }), 300)
    const warn = throwingWarn()

    await runManifestUpdate<{ version: string; installedSkills: Record<string, unknown> }>({
      manifestPath: t,
      load: async () => JSON.parse(fs.readFileSync(t, 'utf8')),
      update: (m) => ({ ...m, installedSkills: { a: {} } }),
    })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pid 31337'))
    expect(JSON.parse(fs.readFileSync(t, 'utf8')).installedSkills).toEqual({ a: {} })
  })
})
