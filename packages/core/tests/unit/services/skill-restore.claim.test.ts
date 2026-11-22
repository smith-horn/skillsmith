/**
 * SMI-6531 (A1 step 6d-ii): a claim-publish that stops after the claim `mkdir`
 * leaves the empty claim, reports it, and keeps the copy and its record
 * (design note §5.2 D3, D4; exit 4, D10). The directory sync is forced to fail
 * by wrapping `fs/promises` `open` (the specifier `dir-sync.ts` imports), the
 * rename by a spy on `fs.promises.rename`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const sync = vi.hoisted(() => ({ fail: false, failPath: null as string | null }))
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    open: (...a: Parameters<typeof actual.open>) => {
      if (sync.fail || (sync.failPath !== null && a[0] === sync.failPath)) {
        return Promise.reject(Object.assign(new Error('forced'), { code: 'EIO' }))
      }
      return actual.open(...a)
    },
  }
})

import { executeRestoreWith } from '../../../src/services/skill-restore.exec.js'
import { mkEnv, parkEntry, planOk, type Env } from './skill-restore.helpers.js'

let env: Env
afterEach(() => {
  sync.fail = false
  sync.failPath = null
  vi.restoreAllMocks()
  fs.rmSync(env.base, { recursive: true, force: true })
})

describe('R-claim-left', () => {
  it('sync-failed: an empty folder is left at the origin and reported; the copy and its record stay', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-a')
    const plan = await planOk(m.copyPath, env.opts)
    const r = await executeRestoreWith(plan, {
      beforeClaim: () => {
        sync.fail = true
      },
    })
    sync.fail = false
    expect(r.status).toBe('stopped')
    if (r.status === 'restored') return
    expect(r.reason).toBe('sync-failed')
    expect(r.changed).toBe(true)
    expect(r.message).toContain('an empty folder was created')
    expect(r.message).toContain('EIO')
    expect(r.message).toContain('rmdir')
    expect(fs.readdirSync(m.origin)).toEqual([])
    expect(fs.existsSync(m.copyPath)).toBe(true)
    expect(fs.existsSync(m.sidecarPath)).toBe(true)
  })

  it('rename-failed: the claim is left and reported; the copy and its record stay', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-a')
    const plan = await planOk(m.copyPath, env.opts)
    vi.spyOn(fs.promises, 'rename').mockRejectedValue(
      Object.assign(new Error('forced'), { code: 'ENOTEMPTY' })
    )
    const r = await executeRestoreWith(plan)
    expect(r.status).toBe('stopped')
    if (r.status === 'restored') return
    expect(r.reason).toBe('claim-left')
    expect(r.changed).toBe(true)
    expect(r.message).toContain('ENOTEMPTY')
    expect(fs.readdirSync(m.origin)).toEqual([])
    expect(fs.existsSync(m.copyPath)).toBe(true)
    expect(fs.existsSync(m.sidecarPath)).toBe(true)
  })

  it('8-i-a-3a: the folder the copy was set aside in fails its sync: restored, with a warning naming it', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-a')
    const plan = await planOk(m.copyPath, env.opts)
    const bytes = fs.readFileSync(path.join(m.copyPath, 'SKILL.md'))
    // Only the parked area's own directory fails to open for its sync.
    sync.failPath = path.dirname(m.copyPath)
    const r = await executeRestoreWith(plan)
    sync.failPath = null
    expect(r.status).toBe('restored')
    expect(r.warnings).toEqual([
      'Restored, but the folder it was set aside in could not be synced (EIO); it may not survive a power loss.',
    ])
    // Presence and absence from the same run: the folder is back, the copy gone.
    expect(fs.readFileSync(path.join(m.origin, 'SKILL.md'))).toEqual(bytes)
    expect(fs.existsSync(m.copyPath)).toBe(false)
  })

  it('8-i-a-3a control: with every sync working, restored with no warning', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-a')
    const plan = await planOk(m.copyPath, env.opts)
    const r = await executeRestoreWith(plan)
    expect(r.status).toBe('restored')
    expect(r.warnings).toEqual([])
    expect(fs.existsSync(path.join(m.origin, 'SKILL.md'))).toBe(true)
  })
})
