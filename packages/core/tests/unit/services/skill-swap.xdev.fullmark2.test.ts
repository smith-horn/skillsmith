/**
 * SMI-6531 (A1 step 4c review round 4, owner decision): the full-device
 * marker names no paths; its leftovers are every entry of its `area` that
 * `isFullDeviceLeftover(name, opId)` matches. This file holds:
 *  - the predicate's case table: positives from the producers' grammar (a
 *    base, `destFor`'s `<opId>.<kind>[.<k>]` or the backup's `<opId>`; its
 *    copy temp `.tmp-<base>`; its sidecar `<base>.json` and that sidecar's
 *    temp `<base>.json.tmp`), negatives that include prefix-sharing opIds and
 *    `.tmp-` combined with `.json` (round 5), and an empty opId;
 *  - the stops round 4's reviews found uncovered: a copy that fails for
 *    another reason followed by a keep that fills the device (the keep's error
 *    is now the stop's cause, governance Major 1), which also needs
 *    `fullDeviceCause`'s third level (a sync's errno inside a keep's failure,
 *    Sol's depth mutation); an ENOSPC raised inside a write, after its file
 *    exists; a first mismatch kept, then ENOSPC on the second copy;
 *  - round 5: ENOSPC at the sidecar rewrite's link, after the old sidecar is
 *    unlinked (the new sidecar is left as `<dest>.json.tmp`, no `<dest>.json`
 *    beside it); a failed build kept across devices that fills the device (no
 *    record exists, so the note names the keep's `dest`);
 *  - the two notes for a marker that is written but not synced, or not
 *    written; and `recordSha256` over a marker built in another key order.
 *
 * Each derived set is checked against a real `readdir` of the area.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { computeRecordSha256 } from '../../../src/services/skill-swap.js'
import type { SwapRecord, SwapResult } from '../../../src/services/skill-swap.js'
import { isFullDeviceLeftover } from '../../../src/services/skill-swap.fullmark.js'
import { ALL_DELETES, refusedOf, runSpied } from './skill-swap.abort.helpers.js'
import {
  areaOf,
  hashOf,
  modify,
  OP_ID,
  plan,
  readRecord,
  useTmpCleanup,
} from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'
import {
  errnoError,
  failDirSync,
  isCreateUnder,
  useOtherDeviceCleanup,
  useStubs,
  xdevFixture,
} from './skill-swap.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

const FILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n', 'sub/b.txt': 'b\n', 'sub/c.txt': 'c\n' }
type AnyFn = (...a: unknown[]) => unknown
const stub = useStubs()

const OP = OP_ID
const temp = (fx: Fixture) => path.join(areaOf(fx), `.tmp-${OP}`)
const dest = (fx: Fixture) => path.join(areaOf(fx), OP)
const recordOf = (fx: Fixture) => readRecord(path.join(fx.opDir, 'record.json'))

/** `code` at the Nth file create under the copy temp; returns how often it fired. */
function failCopyCreate(fx: Fixture, code: string, nth = 2): { fired: number } {
  const hit = { fired: 0 }
  let creates = 0
  stub(fs.promises, 'open', (orig) => async (...a: unknown[]) => {
    if (isCreateUnder(a, temp(fx)) && ++creates === nth) {
      hit.fired++
      throw errnoError(code)
    }
    return orig(...a)
  })
  return hit
}

function committedAtPublish(r: SwapResult) {
  expect(r.status).toBe('committed')
  if (r.status !== 'committed') throw new Error('unreachable')
  expect(r.incomplete).toMatchObject({ step: 'publish', reason: 'write-failed' })
  return r
}

const marker = (fx: Fixture, cause: string, stage: string) => ({
  cause,
  stage,
  area: areaOf(fx),
  opId: OP,
  dest: dest(fx),
})

/** The predicate over a real `readdir`: it matches every entry, and the entries are `want`. */
function expectDerived(fx: Fixture, want: string[]): void {
  const names = fs.readdirSync(areaOf(fx)).sort()
  expect(names.filter((n) => isFullDeviceLeftover(n, OP))).toEqual(names)
  expect(names).toEqual([...want].sort())
}

describe('isFullDeviceLeftover: a base, .tmp-<base>, <base>.json or <base>.json.tmp for its opId, and no other shape', () => {
  const OTHER = `${OP.slice(0, 31)}b`
  const POSITIVE = [
    OP,
    `${OP}.json`,
    `${OP}.json.tmp`,
    `.tmp-${OP}`,
    `${OP}.undone`,
    `${OP}.undone.json`,
    `.tmp-${OP}.undone`,
    `${OP}.conflict`,
    `${OP}.conflict.2.json`,
    `${OP}.failed-build`,
    `${OP}.edited-new`,
    `.tmp-${OP}.edited-new.2`,
    `${OP}.unrecorded-new.json.tmp`,
    `${OP}.partial-copy`,
    `${OP}.partial-copy.json`,
    `${OP}.partial-copy.json.tmp`,
    `${OP}.partial-copy.1`,
    `${OP}.partial-copy.12.json`,
    `.tmp-${OP}.partial-copy.3`,
  ]
  const NEGATIVE = [
    OTHER,
    `${OTHER}.json`,
    `.tmp-${OTHER}`,
    `${OTHER}.partial-copy`,
    `${OP}b`,
    `${OP}b.json`,
    `.tmp-${OP}b`,
    OP.slice(0, 31),
    `x${OP}`,
    `.tmp-x${OP}`,
    `${OP}.backup`,
    `${OP}.tmp`,
    `${OP}.json.json`,
    `${OP}.partial-copy.0`,
    `${OP}.partial-copy.01`,
    `${OP}.partial-copy.1.2`,
    `${OP}.partial-copy.x`,
    `${OP}..partial-copy`,
    // `.tmp-` is never combined with `.json`: no producer makes that name.
    `.tmp-${OP}.json`,
    `.tmp-${OP}.json.tmp`,
    `.tmp-${OP}.partial-copy.2.json`,
    `.tmp-${OP}.undone.json`,
    `.tmp-.tmp-${OP}`,
    `${OP}.json.tmp.json`,
    '.skillsmith-parked',
    '',
  ]
  for (const n of POSITIVE) it(`matches ${n}`, () => expect(isFullDeviceLeftover(n, OP)).toBe(true))
  for (const n of NEGATIVE) {
    it(`does not match ${JSON.stringify(n)}`, () => expect(isFullDeviceLeftover(n, OP)).toBe(false))
  }
  for (const n of ['', '.json', '.json.tmp', '.tmp-', '.partial-copy', '.tmp-.json', OP]) {
    it(`an empty opId matches nothing: ${JSON.stringify(n)}`, () => {
      expect(isFullDeviceLeftover(n, '')).toBe(false)
    })
  }
})

describe('round 4: stops the stop-time listing missed', () => {
  it('copy EIO, then the partial keep fills the device at its area sync: marked partial-keep (the keep error is the cause, depth 3)', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const copy = failCopyCreate(fx, 'EIO')
    const partial = path.join(areaOf(fx), `${OP}.partial-copy`)
    const f = failDirSync(
      (d) => d === areaOf(fx),
      () => fs.existsSync(partial),
      'ENOSPC'
    )
    let run
    try {
      run = await runSpied(p, ALL_DELETES)
    } finally {
      f.restore()
    }
    expect(copy.fired).toBe(1)
    expect(f.fired()).toBe(1)
    const r = committedAtPublish(run.result)
    expect(r.incomplete?.detail).toContain('write-failed at')
    expect(recordOf(fx).fullDevice).toEqual(marker(fx, 'ENOSPC', 'partial-keep'))
    expectDerived(fx, [`${OP}.json`, `${OP}.partial-copy`, `${OP}.partial-copy.json`])
  })

  it('ENOSPC raised inside the write of the partial sidecar (its temp exists): marked, the .json.tmp derived', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const copy = failCopyCreate(fx, 'ENOSPC')
    const sideTmp = path.join(areaOf(fx), `${OP}.partial-copy.json.tmp`)
    let fired = 0
    stub(fs.promises, 'open', (orig) => async (...a: unknown[]) => {
      const fh = (await orig(...a)) as fs.promises.FileHandle
      if (a[0] === sideTmp) {
        ;(fh as unknown as { write: AnyFn }).write = async () => {
          fired++
          throw errnoError('ENOSPC')
        }
      }
      return fh
    })
    const run = await runSpied(p, ALL_DELETES)
    expect(copy.fired).toBe(1)
    expect(fired).toBe(1)
    committedAtPublish(run.result)
    expect(fs.statSync(sideTmp).size).toBe(0)
    expect(recordOf(fx).fullDevice).toEqual(marker(fx, 'ENOSPC', 'partial-keep'))
    expectDerived(fx, [`${OP}.json`, `.tmp-${OP}`, `${OP}.partial-copy.json.tmp`])
  })

  it('a first mismatch kept, then ENOSPC on the second copy: both partials and their sidecars derived (Sol round 4)', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    // The first copy creates four files; the second copy's second create fails.
    const copy = failCopyCreate(fx, 'ENOSPC', 4 + 2)
    let n = 0
    const run = await runSpied(p, ALL_DELETES, {
      hooks: {
        afterBackupCopy: () => {
          if (n++ === 0) fs.appendFileSync(path.join(fx.opDir, 'old', 'a.txt'), 'late\n')
        },
      },
    })
    expect(n).toBe(1)
    expect(copy.fired).toBe(1)
    committedAtPublish(run.result)
    expect(recordOf(fx).fullDevice).toEqual(marker(fx, 'ENOSPC', 'copy'))
    expectDerived(fx, [
      `${OP}.json`,
      `${OP}.partial-copy`,
      `${OP}.partial-copy.json`,
      `${OP}.partial-copy.1`,
      `${OP}.partial-copy.1.json`,
    ])
  })
})

describe('round 5: the sidecar rewrite link, and a failed-build keep', () => {
  it('ENOSPC at the rewrite link, after the old sidecar is unlinked: the new sidecar left as <dest>.json.tmp, stage sidecar-rewrite', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const side = `${dest(fx)}.json`
    let armed = false
    let fired = 0
    stub(fs.promises, 'link', (orig) => async (...a: unknown[]) => {
      if (armed && a[1] === side) {
        fired++
        throw errnoError('ENOSPC')
      }
      return orig(...a)
    })
    const run = await runSpied(p, ALL_DELETES, {
      hooks: {
        afterSidecar: () => fs.appendFileSync(path.join(fx.opDir, 'old', 'a.txt'), 'late\n'),
        afterSidecarUnlink: () => void (armed = true),
      },
    })
    expect(armed).toBe(true)
    expect(fired).toBe(1)
    committedAtPublish(run.result)
    expect(recordOf(fx).fullDevice).toEqual(marker(fx, 'ENOSPC', 'sidecar-rewrite'))
    expectDerived(fx, [`.tmp-${OP}`, `${OP}.json.tmp`])
    // No `<dest>.json` beside it: the temp IS the sidecar, the rewritten one
    // (this op's, for the verified copy), not unlinkable metadata.
    expect(JSON.parse(fs.readFileSync(`${side}.tmp`, 'utf8'))).toMatchObject({
      opId: OP,
      kind: 'backup',
      treeHash: hashOf(temp(fx)),
    })
  })

  it('a failed build kept across devices fills the device: no record to mark, and the note names the keep dest', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const keepTemp = path.join(areaOf(fx), `.tmp-${OP}.failed-build`)
    let creates = 0
    let fired = 0
    stub(fs.promises, 'open', (orig) => async (...a: unknown[]) => {
      if (isCreateUnder(a, keepTemp) && ++creates === 2) {
        fired++
        throw errnoError('ENOSPC')
      }
      return orig(...a)
    })
    const run = await runSpied(p, ALL_DELETES, {
      hooks: {
        afterCopy: () => {
          throw new Error('forced build failure')
        },
      },
    })
    expect(fired).toBe(1)
    const r = refusedOf(run.result)
    expect(r).toMatchObject({ staged: 'left', detail: 'forced build failure' })
    // A failed build has no postTree, so no record was ever written: the stop's
    // own warning is the only description of what the move left.
    expect(fs.existsSync(path.join(fx.opDir, 'record.json'))).toBe(false)
    const w = r.warnings.find((x) => x.code === 'removal-not-done')
    expect(w?.detail).toContain(
      '; the full-device marker was not recorded in record.json (this run holds no record.json to mark); ' +
        `it would have named ${path.join(areaOf(fx), `${OP}.failed-build`)}`
    )
    expectDerived(fx, [`${OP}.failed-build.json`, `${OP}.partial-copy`, `${OP}.partial-copy.json`])
  })
})

describe('the marker notes (governance round 4)', () => {
  it('recorded, then the OP sync fails: the note says it was recorded and may not survive a power loss', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const copy = failCopyCreate(fx, 'ENOSPC')
    const rec = path.join(fx.opDir, 'record.json')
    const f = failDirSync(
      (d) => d === fx.opDir,
      () => fs.existsSync(rec) && fs.readFileSync(rec, 'utf8').includes('"fullDevice"')
    )
    let run
    try {
      run = await runSpied(p, ALL_DELETES)
    } finally {
      f.restore()
    }
    expect(copy.fired).toBe(1)
    expect(f.fired()).toBe(1)
    const r = committedAtPublish(run.result)
    expect(r.incomplete?.detail).toContain(
      `; the full-device marker was recorded in record.json, but ${fx.opDir} could not be synced (`
    )
    expect(r.incomplete?.detail).not.toContain('not recorded')
    expect(recordOf(fx).fullDevice).toEqual(marker(fx, 'ENOSPC', 'copy'))
  })

  it('not written at all (its temp cannot be made): the note says not recorded', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const copy = failCopyCreate(fx, 'ENOSPC')
    const recTmp = path.join(fx.opDir, 'record.json.tmp')
    let armed = false
    stub(fs.promises, 'open', (orig) => async (...a: unknown[]) => {
      if (armed && a[0] === recTmp) throw errnoError('EIO')
      return orig(...a)
    })
    const run = await runSpied(p, ALL_DELETES, {
      hooks: { afterSidecar: () => void (armed = true) },
    })
    expect(copy.fired).toBe(1)
    const r = committedAtPublish(run.result)
    expect(r.incomplete?.detail).toContain(
      '; the full-device marker was not recorded in record.json'
    )
    expect(r.incomplete?.detail).not.toContain('was recorded')
  })
})

describe('recordSha256 over the marker (governance round 4)', () => {
  it('is the same for a marker built in another key order, and differs when a value differs', () => {
    const base = {
      schema: 1,
      op: 'update',
      opId: OP,
      pid: 1,
      host: 'h',
      uid: 0,
      target: {
        comparedPath: '/c',
        realDir: '/r',
        skillsDir: '/s',
        manifestPath: '/m',
        manifestKey: 'k',
        client: 'c',
        scope: 'global',
        dirName: 'k',
      },
      rootIdentity: { dev: '1', ino: '2', birthtimeNs: '3', fmt: '4' },
      opDirIdentity: { dev: '1', ino: '2', birthtimeNs: '3', fmt: '4' },
      oldIdentity: { dev: '1', ino: '2', birthtimeNs: '3', fmt: '4' },
      newIdentity: { dev: '1', ino: '2', birthtimeNs: '3', fmt: '4' },
      preTree: 'a',
      postTree: 'b',
      preEntry: null,
      postEntry: null,
      backupDest: '/area/op',
    } as const
    const inOrder = {
      ...base,
      fullDevice: { cause: 'ENOSPC', stage: 'copy', area: '/area', opId: OP, dest: '/area/op' },
    } as Omit<SwapRecord, 'recordSha256'>
    const reordered = {
      ...base,
      fullDevice: { dest: '/area/op', opId: OP, area: '/area', stage: 'copy', cause: 'ENOSPC' },
    } as Omit<SwapRecord, 'recordSha256'>
    const differs = {
      ...base,
      fullDevice: { cause: 'EDQUOT', stage: 'copy', area: '/area', opId: OP, dest: '/area/op' },
    } as Omit<SwapRecord, 'recordSha256'>
    expect(JSON.stringify(inOrder.fullDevice)).not.toBe(JSON.stringify(reordered.fullDevice))
    expect(computeRecordSha256(reordered)).toBe(computeRecordSha256(inOrder))
    expect(computeRecordSha256(differs)).not.toBe(computeRecordSha256(inOrder))
  })
})

describe('the opId seam (governance round 6)', () => {
  it.each(['a.b', 'a/b', '', '..'])(
    'refuses %j before anything is written: a dot or slash would make leftovers ambiguous',
    async (opId) => {
      const fx = xdevFixture(FILES)
      const p = plan(fx, [modify('SKILL.md', '# v2\n')])
      const st = path.join(fx.skillsDir, '.skillsmith-staging')
      expect(fs.existsSync(st)).toBe(false)
      const refused = runSpied(p, ALL_DELETES, { opId })
      await expect(refused).rejects.toThrow(TypeError)
      await expect(refused).rejects.toThrow(`invalid opId seam: ${JSON.stringify(opId)}`)
      // Nothing was written, not even the staging root.
      expect(fs.existsSync(st)).toBe(false)
      // Presence control: a valid seam opId with upper case, digits, '-' and '_' commits.
      const ok = await runSpied(plan(fx, [modify('SKILL.md', '# v2\n')]), ALL_DELETES, {
        opId: 'Seam-OK_9',
      })
      expect(ok.result.status).toBe('committed')
      expect(fs.existsSync(st)).toBe(true)
    }
  )
})
