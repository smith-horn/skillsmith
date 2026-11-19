/**
 * SMI-6531 (A1 step 6d-ii, governance round): the re-plan under the lock does
 * not make a whole-machine listing or an `assignLocks` pass while the root's
 * lock 1 is held (design note D12, §5.1 step 3).
 */
import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ listBackups: 0, assignLocks: 0 }))
vi.mock('../../../src/services/skill-backups.listing.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/skill-backups.listing.js')>()
  return {
    ...actual,
    listBackups: (...a: Parameters<typeof actual.listBackups>) => {
      calls.listBackups++
      return actual.listBackups(...a)
    },
  }
})
vi.mock('../../../src/services/skill-backups.locks.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/skill-backups.locks.js')>()
  return {
    ...actual,
    assignLocks: (...a: Parameters<typeof actual.assignLocks>) => {
      calls.assignLocks++
      return actual.assignLocks(...a)
    },
  }
})

import { executeRestore } from '../../../src/services/skill-restore.exec.js'
import { mkEnv, parkEntry, planOk, type Env } from './skill-restore.helpers.js'

let env: Env
afterEach(() => fs.rmSync(env.base, { recursive: true, force: true }))

describe('the re-plan under the lock', () => {
  it('rediscovers and reclassifies the one copy: no listBackups, no assignLocks', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-a')
    const plan = await planOk(m.copyPath, env.opts)
    expect(calls.listBackups).toBeGreaterThan(0)
    expect(calls.assignLocks).toBeGreaterThan(0)
    calls.listBackups = 0
    calls.assignLocks = 0
    const r = await executeRestore(plan)
    expect(r.status).toBe('restored')
    expect(calls.listBackups).toBe(0)
    expect(calls.assignLocks).toBe(0)
  })
})
