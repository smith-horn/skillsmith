/**
 * SMI-6531 (A1 step 6a-iii, governance tests T1-T3, T6, T7):
 *
 *  - T1: an entry added to OP at `beforeMetadataCleanup` makes the
 *    cross-device finish, and the finish from a park intent, refuse before any
 *    unlink.
 *  - T2: doctor's own marker rewrite: `record.json` rewritten in place inside
 *    the ENOSPC stop leaves it untouched and says the marker was not recorded;
 *    the rewrite's trace order; and a resume from a crashed marked temp.
 *  - T3: the cross-device sidecar rewrite in `finishCopy` (the source edited
 *    after its sidecar, the step-12 copy killed at `afterBackupCopy` or
 *    `afterBackupVerify`), its adopted unlink refusing a sidecar rewritten in
 *    place, and the adopted unlink's area-path guard.
 *  - T6: `owner.json` with this uid wins over an intent with another uid.
 *  - T7: the space block's bytes boundary: free at the need minus one block is
 *    refused, free at the need is not.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { adoptInto } from '../../../../src/services/skill-recovery.adopt.js'
import type { SwapState } from '../../../../src/services/skill-swap.ops.js'
import { bytesNeeded, shapeOf } from '../../../../src/services/skill-swap.space.js'
import { computeRecordSha256 } from '../../../../src/services/skill-swap.js'
import type { SwapRecord } from '../../../../src/services/skill-swap.js'
import {
  areaOf,
  hashOf,
  isSubsequence,
  modify,
  OP_ID,
  plan,
  readRecord,
  run,
  useTmpCleanup,
} from '../skill-swap.helpers.js'
import {
  errnoError,
  isCreateUnder,
  useOtherDeviceCleanup,
  useStubs,
} from '../skill-swap.xdev.helpers.js'
import { opReport, s3, syncManifest } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import { act, contentSnapshot, done } from './recovery.act.helpers.js'
import {
  backupOf,
  copyTemp,
  killed,
  partialTrees,
  theParkedCopy,
  xfile,
  xs3,
} from './recovery.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()
const stub = useStubs()
type AnyFn = (...a: unknown[]) => unknown

const world = (st: State): string => contentSnapshot(st.fx.skillsDir, st.fx.stateRoot, st.fx.base)
const recPath = (st: State): string => path.join(st.opDir, 'record.json')

/** The update's own step 13 killed after its record unlink: OP holds old, owner.json and the intent. */
async function step13Left(): Promise<State> {
  const fx = xfile()
  const p = plan(fx, [modify('SKILL.md', '# v2\n')])
  await run(p, { hooks: { afterRecordUnlink: () => killed('afterRecordUnlink') } })
  const st: State = { fx, p, opId: OP_ID, opDir: fx.opDir }
  syncManifest(st)
  expect(fs.readdirSync(st.opDir).sort()).toEqual(['old', 'owner.json', 'park-intent.json'])
  return st
}

const stray = (st: State) => () => fs.writeFileSync(path.join(st.opDir, 'stray.txt'), 'late\n')

describe('T1: an entry added at beforeMetadataCleanup refuses before any unlink', () => {
  it('the cross-device finish: stopped, the record and owner kept, nothing unlinked', async () => {
    const st = await s3(xfile())
    const a = await act(st, 'apply', {}, { swap: { hooks: { beforeMetadataCleanup: stray(st) } } })
    expect(a.result).toMatchObject({ status: 'stopped', reason: 'op-not-empty' })
    // The keep's own sidecar temp is unlinked earlier, in the area; nothing in OP is.
    expect(a.trace.some((t) => t.op === 'unlink' && t.path.endsWith('.json.tmp'))).toBe(true)
    expect(a.trace.filter((t) => t.op === 'unlink' && path.dirname(t.path) === st.opDir)).toEqual(
      []
    )
    expect(a.trace.some((t) => t.op === 'park')).toBe(false)
    expect(fs.existsSync(recPath(st))).toBe(true)
    expect(fs.existsSync(path.join(st.opDir, 'owner.json'))).toBe(true)
  })

  it('the finish from a park intent: stopped, owner.json kept, nothing unlinked', async () => {
    const st = await step13Left()
    const a = await act(st, 'apply', {}, { swap: { hooks: { beforeMetadataCleanup: stray(st) } } })
    expect(a.result).toMatchObject({ status: 'stopped', reason: 'op-not-empty' })
    expect(a.trace.filter((t) => t.op === 'unlink')).toEqual([])
    expect(fs.existsSync(path.join(st.opDir, 'owner.json'))).toBe(true)
  })

  it('the pair: without the stray entry the intent finish unlinks owner.json and parks', async () => {
    const st = await step13Left()
    const a = await done(st, 'apply')
    expect(a.trace.filter((t) => t.op === 'unlink').map((t) => t.path)).toEqual([
      path.join(st.opDir, 'owner.json'),
    ])
    expect(theParkedCopy(st.fx)).toBeTruthy()
  })
})

/** ENOSPC at the 2nd file create inside doctor's copy temp; `also` runs when it fires. */
function noSpaceInCopy(st: State, also: () => void = () => undefined) {
  let creates = 0
  let failing = true
  stub(fs.promises, 'open', (orig: AnyFn) => async (...a: unknown[]) => {
    if (failing && isCreateUnder(a, copyTemp(st.fx)) && ++creates === 2) {
      also()
      throw errnoError('ENOSPC')
    }
    return orig(...a)
  })
  return { off: () => void (failing = false) }
}

describe("T2: doctor's own marker rewrite", () => {
  it('record.json rewritten in place inside the stop: untouched, and the stop says not recorded', async () => {
    const st = await s3(xfile())
    let replaced = ''
    const ns = noSpaceInCopy(st, () => {
      const v = JSON.parse(fs.readFileSync(recPath(st), 'utf8')) as unknown
      replaced = JSON.stringify(v)
      fs.writeFileSync(recPath(st), replaced)
    })
    const a = await act(st, 'apply')
    ns.off()
    expect(a.result).toMatchObject({ status: 'stopped', reason: 'write-failed' })
    if (a.result.status === 'stopped') {
      expect(a.result.detail).toContain('the full-device marker was not recorded in record.json')
    }
    expect(replaced).not.toBe('')
    expect(fs.readFileSync(recPath(st), 'utf8')).toBe(replaced)
    expect(readRecord(recPath(st)).fullDevice).toBeUndefined()
  })

  it('the trace order: temp created and synced, renamed over record.json, then OP synced', async () => {
    const st = await s3(xfile())
    const ns = noSpaceInCopy(st)
    const a = await act(st, 'apply')
    ns.off()
    const rec = recPath(st)
    expect(
      isSubsequence(a.trace, [
        { op: 'create', path: `${rec}.tmp` },
        { op: 'fsync', path: `${rec}.tmp` },
        { op: 'rename', path: `${rec}.tmp`, dest: rec },
        { op: 'dirsync', path: st.opDir },
      ])
    ).toEqual({ ok: true })
    expect(a.trace.some((t) => t.op === 'unlink' && t.path === rec)).toBe(false)
    expect(readRecord(rec).fullDevice).toMatchObject({ cause: 'ENOSPC', stage: 'copy' })
  })

  it('a resume from a crashed marked temp: the op is marked, finished, and the temp unlinked', async () => {
    const st = await xs3({ hooks: { afterSidecar: () => killed('afterSidecar') } })
    const { recordSha256: _h, ...body } = readRecord(recPath(st))
    const marked = {
      ...body,
      fullDevice: {
        cause: 'ENOSPC',
        stage: 'copy',
        area: areaOf(st.fx),
        opId: OP_ID,
        dest: backupOf(st.fx),
      },
    } as Omit<SwapRecord, 'recordSha256'>
    fs.writeFileSync(
      `${recPath(st)}.tmp`,
      JSON.stringify({ ...marked, recordSha256: computeRecordSha256(marked) })
    )
    const op = await opReport(st)
    expect(op.cls).toMatchObject({ kind: 'state', facts: { fullDevice: { cause: 'ENOSPC' } } })
    const a = await done(st, 'apply')
    expect(a.trace).toContainEqual({ op: 'unlink', path: `${recPath(st)}.tmp` })
    expect(fs.existsSync(st.opDir)).toBe(false)
  })
})

describe("T3: finishCopy's cross-device sidecar rewrite, and the adopted unlink", () => {
  const editO = (st: { opDir: string }) => () =>
    fs.writeFileSync(path.join(st.opDir, 'old', 'a.txt'), 'O edited after its sidecar\n')

  for (const point of ['afterBackupCopy', 'afterBackupVerify'] as const) {
    it(`killed at ${point}: the sidecar rewritten to the copy's hash, then the rename; no partial`, async () => {
      const fx = xfile()
      const st = await xs3({ hooks: { afterSidecar: editO(fx), [point]: () => killed(point) } }, fx)
      const oHash = hashOf(path.join(st.opDir, 'old'))
      const side = `${backupOf(fx)}.json`
      const a = await done(st, 'apply')
      expect((JSON.parse(fs.readFileSync(side, 'utf8')) as { treeHash: string }).treeHash).toBe(
        oHash
      )
      expect(hashOf(backupOf(fx))).toBe(oHash)
      expect(partialTrees(fx)).toEqual([])
      expect(
        isSubsequence(a.trace, [
          { op: 'unlink', path: side },
          { op: 'link', path: `${side}.tmp`, dest: side },
          { op: 'rename', path: copyTemp(fx), dest: backupOf(fx) },
        ])
      ).toEqual({ ok: true })
      expect(a.result.warnings.map((w) => w.code)).toContain('backup-holds-foreign-change')
    })
  }

  it('a sidecar rewritten in place after the re-plan: the adopted unlink refuses, it stays', async () => {
    const fx = xfile()
    const st = await xs3(
      { hooks: { afterSidecar: editO(fx), afterBackupCopy: () => killed('copy') } },
      fx
    )
    const side = `${backupOf(fx)}.json`
    let bytes = ''
    const a = await act(
      st,
      'apply',
      {},
      {
        afterReplan: () => {
          bytes = JSON.stringify(JSON.parse(fs.readFileSync(side, 'utf8')))
          fs.writeFileSync(side, bytes)
        },
      }
    )
    expect(a.result).toMatchObject({ status: 'stopped', reason: 'backup-unsafe' })
    expect(fs.readFileSync(side, 'utf8')).toBe(bytes)
    expect(a.trace.some((t) => t.op === 'unlink' && t.path === side)).toBe(false)
  })

  it('the area-path guard: a file outside the area, even one the re-plan read, is not adopted', async () => {
    const fake = { areaPath: '/area', owned: new Map() } as unknown as SwapState
    const identity = { dev: '1', ino: '2', birthtimeNs: '3', fmt: '32768' }
    const read = (key: string) => ({
      method: 'readFile' as const,
      key,
      derived: false,
      fact: { ok: true as const, identity, size: 2, sha256: 'x', truncated: false },
    })
    adoptInto(fake, [read('/elsewhere/x.json'), read('/area/unread-sibling.json')], {
      files: [{ path: '/op/record.json', identity, sha256: 'y' }],
      intent: null,
      tmp: null,
    })
    expect(await fake.unlinkAdopted!('/elsewhere/x.json', 'backup-unsafe')).toBe(false)
    expect(await fake.unlinkAdopted!('/area/never-read.json', 'backup-unsafe')).toBe(false)
  })
})

describe("T6: owner.json's uid wins over the intent's", () => {
  it('owner.json with this uid and an intent with another uid: offered, and finished', async () => {
    const st = await step13Left()
    const intent = path.join(st.opDir, 'park-intent.json')
    const v = JSON.parse(fs.readFileSync(intent, 'utf8')) as { owner: Record<string, unknown> }
    fs.writeFileSync(intent, JSON.stringify({ ...v, owner: { ...v.owner, uid: 424242 } }))
    const a = await done(st, 'apply')
    expect(a.result.status).toBe('done')
    expect(theParkedCopy(st.fx)).toBeTruthy()
  })
})

describe('T7: the space block bytes boundary', () => {
  /** P1 across devices, with statfs of the state root reporting `blocks` available. */
  async function atBlocks(delta: bigint) {
    const st = await xs3({ hooks: { afterSidecar: () => killed('afterSidecar') } })
    const real = await fs.promises.statfs(st.fx.stateRoot, { bigint: true })
    const need = bytesNeeded(shapeOf(path.join(st.opDir, 'old'), null), real.bsize)
    expect(need % real.bsize).toBe(0n)
    stub(fs.promises, 'statfs', (orig: AnyFn) => async (...a: unknown[]) => {
      const s = (await orig(...a)) as fs.BigIntStatsFs
      return String(a[0]).startsWith(st.fx.stateRoot) ? { ...s, bavail: need / s.bsize + delta } : s
    })
    return st
  }

  it('free at the need minus one block: refused state-root-full, nothing changed', async () => {
    const st = await atBlocks(-1n)
    const before = world(st)
    const a = await act(st, 'apply')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'state-root-full' })
    expect(world(st)).toBe(before)
  })

  it('free at exactly the need: not refused by the space block (the pair)', async () => {
    const st = await atBlocks(0n)
    const a = await act(st, 'apply')
    expect(a.result).not.toMatchObject({ status: 'refused', reason: 'state-root-full' })
    expect(a.trace.length).toBeGreaterThan(0)
  })
})
