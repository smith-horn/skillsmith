/**
 * SMI-6531 (A1 step 8-i-a-3a, governance finding 1): an undo whose put-back
 * of the old folder succeeded but whose sync of the folder it left (OP)
 * failed stops `write-failed` naming OP, even though a later sync of OP would
 * succeed. Linux reports a failed write-back to one `fsync` only, so the later
 * sync cannot stand in for the failed one. Two paths put O back: the update's
 * own undo (`restoreOld`, `skill-swap.undo.ts`) and doctor's S2 `--undo`
 * (`installAt`, `skill-recovery.resume.ts`). `syncDirectory` is wrapped for
 * the module: once armed, OP's next sync fails, then the real sync runs again.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const sync = vi.hoisted(() => ({ failDir: null as string | null, failTimes: 0, failed: 0 }))
vi.mock('../../../src/install/dir-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/install/dir-sync.js')>()
  return {
    ...actual,
    syncDirectory: async (dir: string) => {
      if (dir === sync.failDir && sync.failed < sync.failTimes) {
        sync.failed++
        return { outcome: 'failed', code: 'EDQUOT', error: new Error('EDQUOT') }
      }
      return actual.syncDirectory(dir)
    },
  }
})

const { hashOf, makeFixture, modify, plan, run, useTmpCleanup } =
  await import('./skill-swap.helpers.js')
const { s2 } = await import('./recovery/recovery.helpers.js')
const { act } = await import('./recovery/recovery.act.helpers.js')

useTmpCleanup()
afterEach(() => {
  sync.failDir = null
  sync.failTimes = 0
  sync.failed = 0
})

const FILES = { 'SKILL.md': '# v1\n', 'docs/a.md': 'a\n' }

/** Arms OP's next sync to fail once: the first one after the arming is claimPublish's source sync. */
const armOnce = (opDir: string) => () => {
  sync.failDir = opDir
  sync.failTimes = 1
}

describe('the update’s own undo (restoreOld)', () => {
  it('OP fails its sync after O is back: stopped write-failed naming OP; O at the path', async () => {
    const fx = makeFixture(FILES)
    const oldHash = hashOf(fx.realDir)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    p.manifest.failCasOnCall = 2
    const { result } = await run(p, { hooks: { beforeRestore: armOnce(fx.opDir) } })
    expect(sync.failed).toBe(1)
    expect(result).toMatchObject({
      status: 'stopped',
      reason: 'write-failed',
      detail: `${fx.opDir} could not be synced (EDQUOT)`,
    })
    // O was put back before the sync failed; the op dir and its record stay.
    expect(hashOf(fx.realDir)).toBe(oldHash)
    expect(fs.existsSync(path.join(fx.opDir, 'record.json'))).toBe(true)
  })

  it('control: the same undo with every sync working ends undone', async () => {
    const fx = makeFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    p.manifest.failCasOnCall = 2
    const { result } = await run(p)
    expect(result.status).toBe('undone')
    expect(sync.failed).toBe(0)
  })
})

describe('doctor’s S2 --undo (installAt)', () => {
  it('OP fails its sync after O is back: not done, the failure names OP; O at the path, the record kept', async () => {
    const fx = makeFixture(FILES)
    const st = await s2(fx)
    const oldHash = hashOf(path.join(st.opDir, 'old'))
    const a = await act(st, 'undo', {}, { swap: { hooks: { beforeRestore: armOnce(st.opDir) } } })
    expect(sync.failed).toBe(1)
    expect(a.result.status).not.toBe('done')
    expect(JSON.stringify(a.result)).toContain(`${st.opDir} could not be synced (EDQUOT)`)
    expect(hashOf(fx.realDir)).toBe(oldHash)
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
  })
})
