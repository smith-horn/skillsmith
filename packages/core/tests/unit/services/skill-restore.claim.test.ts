/**
 * SMI-6531 (A1 step 6d-ii): a claim-publish that stops after the claim `mkdir`
 * leaves the empty claim, reports it, and keeps the copy and its record
 * (design note §5.2 D3, D4; exit 4, D10). The directory sync is forced to fail
 * by wrapping `fs/promises` `open` (the specifier `dir-sync.ts` imports), the
 * rename by a spy on `fs.promises.rename`.
 */
import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const sync = vi.hoisted(() => ({ fail: false }))
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    open: (...a: Parameters<typeof actual.open>) => {
      if (sync.fail) return Promise.reject(Object.assign(new Error('forced'), { code: 'EIO' }))
      return actual.open(...a)
    },
  }
})

import { executeRestore } from '../../../src/services/skill-restore.exec.js'
import { mkEnv, parkEntry, planOk, type Env } from './skill-restore.helpers.js'

let env: Env
afterEach(() => {
  sync.fail = false
  vi.restoreAllMocks()
  fs.rmSync(env.base, { recursive: true, force: true })
})

describe('R-claim-left', () => {
  it('sync-failed: an empty folder is left at the origin and reported; the copy and its record stay', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-a')
    const plan = await planOk(m.copyPath, env.opts)
    const r = await executeRestore(plan, {
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
    const r = await executeRestore(plan)
    expect(r.status).toBe('stopped')
    if (r.status === 'restored') return
    expect(r.reason).toBe('claim-left')
    expect(r.changed).toBe(true)
    expect(r.message).toContain('ENOTEMPTY')
    expect(fs.readdirSync(m.origin)).toEqual([])
    expect(fs.existsSync(m.copyPath)).toBe(true)
    expect(fs.existsSync(m.sidecarPath)).toBe(true)
  })
})
