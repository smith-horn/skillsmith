/**
 * SMI-7148: `releaseOwned` is total on its own, not only because
 * `releaseClaimFile` is. It runs in callers' `finally` blocks and is
 * documented never to throw, so a throw from either release it makes must be
 * contained HERE: the main one still lets the `.reclaim` guard go, and the
 * guard's one keeps the main lock's answer.
 *
 * `releaseClaimFile` is wrapped (not replaced) so a throw can be injected
 * AROUND it, past its own containment. The fs-level counterparts, where the
 * throw comes from `closeSync`, are T6 in owned-lock.release-under-reclaim.test.ts.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const inject = vi.hoisted(() => ({
  throwFor: null as string | null,
  hits: 0,
  seenPaths: [] as string[],
}))

vi.mock('../../../src/config/owned-lock.claim.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/owned-lock.claim.js')>()
  return {
    ...actual,
    releaseClaimFile: (p: string, token: string): boolean => {
      inject.seenPaths.push(p)
      if (inject.throwFor !== null && p === inject.throwFor) {
        inject.hits++
        throw new Error(`injected throw releasing ${p}`)
      }
      return actual.releaseClaimFile(p, token)
    },
  }
})

import { releaseOwned } from '../../../src/config/owned-lock.release.js'

const roots: string[] = []
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  inject.throwFor = null
  inject.hits = 0
  inject.seenPaths = []
  vi.restoreAllMocks()
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

const TOKEN = 'a'.repeat(16)

function fresh(): { lockPath: string; reclaimPath: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-total-')))
  roots.push(dir)
  const lockPath = path.join(dir, 'm.json.lock')
  return { lockPath, reclaimPath: `${lockPath}.reclaim` }
}

function v1(): string {
  return (
    JSON.stringify({ v: 1, pid: process.pid, token: TOKEN, host: os.hostname(), acquiredAt: 1 }) +
    '\n'
  )
}

const warnings = (): string[] => warnSpy.mock.calls.map((c: unknown[]) => String(c[0]))

describe('releaseOwned contains a throw from either release it makes', () => {
  it('control: with no throw, it releases and the guard goes (both releases ran)', () => {
    const { lockPath, reclaimPath } = fresh()
    fs.writeFileSync(lockPath, v1())
    expect(releaseOwned(lockPath, TOKEN)).toBe(true)
    expect(inject.seenPaths).toEqual([lockPath, reclaimPath])
    expect(fs.existsSync(lockPath)).toBe(false)
    expect(fs.existsSync(reclaimPath)).toBe(false)
  })

  it('the main release throws: false, no throw, lock untouched, and the guard is still released', () => {
    const { lockPath, reclaimPath } = fresh()
    fs.writeFileSync(lockPath, v1())
    inject.throwFor = lockPath

    let released: boolean | undefined
    expect(() => {
      released = releaseOwned(lockPath, TOKEN)
    }).not.toThrow()

    expect(inject.hits, 'the injected throw fired').toBe(1)
    expect(released).toBe(false)
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(v1())
    expect(inject.seenPaths).toEqual([lockPath, reclaimPath]) // the guard release was still attempted
    expect(fs.existsSync(reclaimPath)).toBe(false)
    expect(warnings().some((m) => m.includes('lock_release_failed') && m.includes(lockPath))).toBe(
      true
    )
  })

  it('the guard release throws: the main answer is kept and a warning names the guard', () => {
    const { lockPath, reclaimPath } = fresh()
    fs.writeFileSync(lockPath, v1())
    inject.throwFor = reclaimPath

    let released: boolean | undefined
    expect(() => {
      released = releaseOwned(lockPath, TOKEN)
    }).not.toThrow()

    expect(inject.hits, 'the injected throw fired').toBe(1)
    expect(released).toBe(true) // the main lock really was released
    expect(fs.existsSync(lockPath)).toBe(false)
    expect(
      warnings().some((m) => m.includes('lock_release_guard_failed') && m.includes(reclaimPath))
    ).toBe(true)
  })

  it('an unexpected throw outside both releases (the wait) returns false and never escapes', () => {
    const { lockPath, reclaimPath } = fresh()
    fs.writeFileSync(lockPath, v1())
    fs.writeFileSync(reclaimPath, v1()) // held, so release must wait
    const wait = vi.spyOn(Atomics, 'wait').mockImplementation(() => {
      throw new Error('injected wait failure')
    })

    let released: boolean | undefined
    expect(() => {
      released = releaseOwned(lockPath, TOKEN, { reclaimLockTimeoutMs: 1_000 })
    }).not.toThrow()

    expect(wait, 'the injected wait failure fired').toHaveBeenCalled()
    expect(released).toBe(false)
    expect(fs.existsSync(lockPath)).toBe(true)
    expect(warnings().some((m) => m.includes('lock_release_failed'))).toBe(true)
  })
})
