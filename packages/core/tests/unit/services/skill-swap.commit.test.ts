/**
 * SMI-6531 (A1 step 6a-ii, 7a retro): what a throw from inside lock 3 becomes
 * in step 10's commit (`skill-swap.commit.ts`), through the transaction and
 * through doctor's S2 `--apply`.
 *
 * Control (the mapping before 6a-ii): a `casMatches()` that throws
 * `ManifestUnwritableError`, and a lock-3 acquisition that throws
 * `StuckLockError`, ended `stopped` with reason `write-failed`. Now both are
 * `manifest-write-failed` with the cause's name in `detail`, the record kept
 * and the manifest unchanged; a `LockOrderError` from the same hold still
 * propagates.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LockOrderError } from '../../../src/config/lock-tracker.js'
import { StuckLockError } from '../../../src/config/owned-lock.js'
import { ManifestUnwritableError } from '../../../src/services/skill-manifest.read-state.js'
import type { ManifestCommitHandle, ManifestPort } from '../../../src/services/skill-swap.types.js'
import {
  FakeManifest,
  makeFixture,
  modify,
  plan,
  run,
  useTmpCleanup,
} from './skill-swap.helpers.js'
import { s2 } from './recovery/recovery.helpers.js'
import { act, entryOf } from './recovery/recovery.act.helpers.js'
import { PRE } from './recovery/recovery.helpers.js'

useTmpCleanup()

type Fault = 'unwritable' | 'stuck' | 'lock-order'

const errorFor = (f: Fault, file: string): Error =>
  f === 'unwritable'
    ? new ManifestUnwritableError('corrupt', file, 'the manifest cannot be parsed')
    : f === 'stuck'
      ? new StuckLockError(`${file}.lock`, `${file}.lock.reclaim`, 'manifest commit', 'held', {
          kind: 'absent',
        })
      : new LockOrderError('inversion', 'lock 3 requested out of order')

/**
 * The fake port, faulting on the step-10 hold: for `unwritable` its
 * `casMatches()` throws; for `stuck` and `lock-order` the hold's acquisition
 * throws. The step-4 hold (the first) is left alone.
 */
class FaultyManifest extends FakeManifest {
  holds = 0
  constructor(private readonly fault: Fault) {
    super({ version: '1.0.0' }, { version: '2.0.0' })
  }
  override async withManifestLock<T>(fn: (m: ManifestCommitHandle) => Promise<T>): Promise<T> {
    this.holds++
    if (this.holds < 2) return super.withManifestLock(fn)
    if (this.fault !== 'unwritable') throw errorFor(this.fault, 'manifest.json')
    return super.withManifestLock((m) =>
      fn({
        ...m,
        casMatches: async () => {
          throw errorFor('unwritable', 'manifest.json')
        },
      })
    )
  }
}

const NAME: Record<Exclude<Fault, 'lock-order'>, string> = {
  unwritable: 'ManifestUnwritableError',
  stuck: 'StuckLockError',
}

describe('via swapInPlace', () => {
  for (const fault of ['unwritable', 'stuck'] as const) {
    it(`a ${NAME[fault]} under lock 3 is stopped/manifest-write-failed, the record kept`, async () => {
      const fx = makeFixture({ 'SKILL.md': '# v1\n' })
      const p = plan(fx, [modify('SKILL.md', '# v2\n')])
      const m = new FaultyManifest(fault)
      p.input = { ...p.input, manifest: m }
      const r = await run(p)
      expect(r.result).toMatchObject({ status: 'stopped', reason: 'manifest-write-failed' })
      if (r.result.status === 'stopped') {
        expect(r.result.detail).toContain(NAME[fault])
        expect(r.result.recordPath).toBeDefined()
        expect(fs.existsSync(r.result.recordPath!)).toBe(true)
      }
      expect(m.writes).toBe(0)
      expect(m.entry).toEqual({ version: '1.0.0' })
      expect(m.holds).toBe(2)
    })
  }

  it('a LockOrderError from the same hold propagates', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    p.input = { ...p.input, manifest: new FaultyManifest('lock-order') }
    await expect(run(p)).rejects.toBeInstanceOf(LockOrderError)
  })
})

/** A port whose single hold faults as `fault` does on the step-10 hold. */
function faultyPort(fault: Fault, file: string): ManifestPort {
  return {
    withManifestLock: async <T>(fn: (m: ManifestCommitHandle) => Promise<T>): Promise<T> => {
      if (fault !== 'unwritable') throw errorFor(fault, file)
      return fn({
        classify: async () => 'pre',
        casMatches: async () => {
          throw errorFor('unwritable', file)
        },
        write: async () => {
          throw new Error('never reached')
        },
      })
    },
  }
}

describe('via doctor S2 --apply', () => {
  for (const fault of ['unwritable', 'stuck'] as const) {
    it(`a ${NAME[fault]} under lock 3 stops manifest-write-failed, the record and manifest kept`, async () => {
      const st = await s2(makeFixture({ 'SKILL.md': '# v1\n' }))
      const manifestFile = path.join(st.fx.stateRoot, 'manifest.json')
      const before = fs.readFileSync(manifestFile)
      const a = await act(st, 'apply', {}, { manifestPort: faultyPort(fault, manifestFile) })
      expect(a.result).toMatchObject({ status: 'stopped', reason: 'manifest-write-failed' })
      if (a.result.status === 'stopped') expect(a.result.detail).toContain(NAME[fault])
      expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
      expect(fs.existsSync(path.join(st.opDir, 'old'))).toBe(true)
      expect(fs.readFileSync(manifestFile).equals(before)).toBe(true)
      expect(entryOf(st.fx)).toEqual(PRE)
    })
  }

  it('a LockOrderError from the same hold propagates', async () => {
    const st = await s2(makeFixture({ 'SKILL.md': '# v1\n' }))
    const file = path.join(st.fx.stateRoot, 'manifest.json')
    await expect(
      act(st, 'apply', {}, { manifestPort: faultyPort('lock-order', file) })
    ).rejects.toBeInstanceOf(LockOrderError)
  })
})
