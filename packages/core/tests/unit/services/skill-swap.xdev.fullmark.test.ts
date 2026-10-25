/**
 * SMI-6531 (A1 step 4c review round 3, owner decision): the full-device
 * marker. A cross-device move that stops on `ENOSPC` or `EDQUOT`, at any stage
 * (the copy, a partial keep, the sidecar rewrite, the final rename, the area
 * sync after it), records in this op's kept `record.json` the cause, the
 * stage, area, opId and dest (round 4: the leftovers are derived, every area
 * entry `isFullDeviceLeftover(name, opId)` matches); the record survives the
 * stop (step 3's record scan, implementation-order step 5, then refuses the
 * next update). A stop that is not a full device records no marker. Replaces
 * round 2's area-scan cap, which matched names and missed a complete copy at
 * `<area>/<opId>` whose area sync failed (GPT-5.6-Sol round 3).
 *
 * Every failure is forced with a stub that records it fired: `ENOSPC` /
 * `EDQUOT` at a file create (`fs.promises.open`), a rename
 * (`fs.promises.rename`) or a directory sync (`failDirSync`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FullDeviceMarker, SwapResult } from '../../../src/services/skill-swap.js'
import { computeRecordSha256 } from '../../../src/services/skill-swap.js'
import { jsonBytes } from '../../../src/services/skill-swap.staging.js'
import { MAX_RECORD_BYTES, scanStagingRecords } from '../../../src/services/skill-swap.records.js'
import { isFullDeviceLeftover } from '../../../src/services/skill-swap.fullmark.js'
import { ALL_DELETES, runSpied } from './skill-swap.abort.helpers.js'
import { abortAt } from './skill-swap.abort.triggers.js'
import { areaOf, modify, OP_ID, plan, readRecord, useTmpCleanup } from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'
import {
  errnoError,
  failDirSync,
  isCreateUnder,
  partials,
  sidecarOf,
  treeDeletesX,
  useOtherDeviceCleanup,
  useStubs,
  xdevFixture,
} from './skill-swap.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

const FILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n', 'sub/b.txt': 'b\n', 'sub/c.txt': 'c\n' }
const stub = useStubs()

const counter = () => ({ fired: 0 })
const recordOf = (fx: Fixture) => readRecord(path.join(fx.opDir, 'record.json'))
const temp = (fx: Fixture) => path.join(areaOf(fx), `.tmp-${OP_ID}`)
const dest = (fx: Fixture) => path.join(areaOf(fx), OP_ID)

/** `code` at the Nth file create under the copy temp (the copy's own write). */
function failCopyCreate(fx: Fixture, code: string, nth = 2) {
  const hit = counter()
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

/** `code` at every create of `file`. */
function failCreate(file: string, code: string) {
  const hit = counter()
  stub(fs.promises, 'open', (orig) => async (...a: unknown[]) => {
    if (a[0] === file) {
      hit.fired++
      throw errnoError(code)
    }
    return orig(...a)
  })
  return hit
}

/** The committed result of step 12 that stopped at publish, with the record kept. */
function stoppedAtPublish(fx: Fixture, r: SwapResult) {
  expect(r.status).toBe('committed')
  if (r.status !== 'committed') throw new Error('unreachable')
  expect(r).toMatchObject({
    incomplete: { step: 'publish', reason: 'write-failed' },
    recordPath: path.join(fx.opDir, 'record.json'),
  })
  return r
}

function markerOf(fx: Fixture): FullDeviceMarker | undefined {
  return recordOf(fx).fullDevice
}

/** The marker round 4 records: no path list, the opId and the tree's dest. */
const markerFor = (fx: Fixture, cause: string, stage: string, to = dest(fx)) => ({
  cause,
  stage,
  area: areaOf(fx),
  opId: OP_ID,
  dest: to,
})

/**
 * The derived leftovers, checked against a real `readdir` of the area: every
 * entry there is this op's (the fixture's area holds no other op), the
 * predicate matches every one of them, and they are exactly `want`.
 */
function expectDerived(fx: Fixture, want: string[]): void {
  const names = fs.readdirSync(areaOf(fx)).sort()
  expect(names.filter((n) => isFullDeviceLeftover(n, OP_ID))).toEqual(names)
  expect(names).toEqual([...want].sort())
}

describe('the full-device marker, at each stop point', () => {
  for (const code of ['ENOSPC', 'EDQUOT'] as const) {
    it(`${code} during the copy: the partial copy named, stage copy, the record kept`, async () => {
      const fx = xdevFixture(FILES)
      const p = plan(fx, [modify('SKILL.md', '# v2\n')])
      const hit = failCopyCreate(fx, code)
      const run = await runSpied(p, ALL_DELETES)
      expect(hit.fired).toBe(1)
      stoppedAtPublish(fx, run.result)
      const kept = partials(areaOf(fx))
      expect(kept).toHaveLength(1)
      expect(sidecarOf(kept[0]!)).toMatchObject({ partialCause: 'enospc', sourceUnchanged: true })
      expect(markerOf(fx)).toEqual(markerFor(fx, code, 'copy'))
      expectDerived(fx, [`${OP_ID}.json`, `${OP_ID}.partial-copy`, `${OP_ID}.partial-copy.json`])
      expect(treeDeletesX(fx, run.events)).toEqual([])
    })

    it(`${code} at the area sync after the final rename: the complete copy at <area>/<opId> named (Sol round 3)`, async () => {
      const fx = xdevFixture(FILES)
      const p = plan(fx, [modify('SKILL.md', '# v2\n')])
      const f = failDirSync(
        (d) => d === areaOf(fx),
        () => fs.existsSync(dest(fx)),
        code
      )
      let run
      try {
        run = await runSpied(p, ALL_DELETES)
      } finally {
        f.restore()
      }
      expect(f.fired()).toBe(1)
      stoppedAtPublish(fx, run.result)
      expect(markerOf(fx)).toEqual(markerFor(fx, code, 'final-sync'))
      expectDerived(fx, [OP_ID, `${OP_ID}.json`])
      expect(fs.existsSync(temp(fx))).toBe(false)
    })
  }

  it('ENOSPC on the partial copy own sidecar: the copy temp named, left at its name, stage partial-keep', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const copy = failCopyCreate(fx, 'ENOSPC')
    const side = failCreate(path.join(areaOf(fx), `${OP_ID}.partial-copy.json.tmp`), 'ENOSPC')
    const run = await runSpied(p, ALL_DELETES)
    expect(copy.fired).toBe(1)
    expect(side.fired).toBe(1)
    stoppedAtPublish(fx, run.result)
    expect(markerOf(fx)).toEqual(markerFor(fx, 'ENOSPC', 'partial-keep'))
    expectDerived(fx, [`${OP_ID}.json`, `.tmp-${OP_ID}`])
  })

  it('a mismatch whose keep hits ENOSPC: the copy temp named, stage partial-keep', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const side = failCreate(path.join(areaOf(fx), `${OP_ID}.partial-copy.json.tmp`), 'ENOSPC')
    let n = 0
    const run = await runSpied(p, ALL_DELETES, {
      hooks: {
        afterBackupCopy: () => {
          if (n++ === 0) fs.appendFileSync(path.join(fx.opDir, 'old', 'a.txt'), 'late\n')
        },
      },
    })
    expect(side.fired).toBe(1)
    stoppedAtPublish(fx, run.result)
    expect(markerOf(fx)).toEqual(markerFor(fx, 'ENOSPC', 'partial-keep'))
    expectDerived(fx, [`${OP_ID}.json`, `.tmp-${OP_ID}`])
  })

  it('ENOSPC in the sidecar rewrite (the area sync after its temp): the copy temp and the sidecar temp named', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const sideTmp = `${dest(fx)}.json.tmp`
    const f = failDirSync(
      (d) => d === areaOf(fx),
      () => fs.existsSync(sideTmp) && fs.existsSync(temp(fx)),
      'ENOSPC'
    )
    let run
    try {
      run = await runSpied(p, ALL_DELETES, {
        hooks: {
          afterSidecar: () => fs.appendFileSync(path.join(fx.opDir, 'old', 'a.txt'), 'late\n'),
        },
      })
    } finally {
      f.restore()
    }
    expect(f.fired()).toBe(1)
    stoppedAtPublish(fx, run.result)
    expect(markerOf(fx)).toEqual(markerFor(fx, 'ENOSPC', 'sidecar-rewrite'))
    expectDerived(fx, [`${OP_ID}.json`, `${OP_ID}.json.tmp`, `.tmp-${OP_ID}`])
  })

  it('ENOSPC at the final rename: the verified copy temp named, stage final-rename', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const hit = counter()
    stub(fs.promises, 'rename', (orig) => async (...a: unknown[]) => {
      if (a[0] === temp(fx) && a[1] === dest(fx)) {
        hit.fired++
        throw errnoError('ENOSPC')
      }
      return orig(...a)
    })
    const run = await runSpied(p, ALL_DELETES)
    expect(hit.fired).toBe(1)
    stoppedAtPublish(fx, run.result)
    expect(markerOf(fx)).toEqual(markerFor(fx, 'ENOSPC', 'final-rename'))
    expectDerived(fx, [`${OP_ID}.json`, `.tmp-${OP_ID}`])
  })
})

describe('no marker where the device is not full, and a marker that cannot be written', () => {
  it('a source that changes during both copies (a mismatch stop): the record kept, no marker', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    let n = 0
    const run = await runSpied(p, ALL_DELETES, {
      hooks: {
        afterBackupCopy: () => fs.appendFileSync(path.join(fx.opDir, 'old', 'a.txt'), `e${++n}\n`),
      },
    })
    expect(n).toBe(2)
    stoppedAtPublish(fx, run.result)
    expect(partials(areaOf(fx))).toHaveLength(2)
    expect(recordOf(fx)).not.toHaveProperty('fullDevice')
  })

  it('the marker rewrite fails: the original stop stands, says so, and the old record is intact', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const copy = failCopyCreate(fx, 'ENOSPC')
    const recTmp = path.join(fx.opDir, 'record.json.tmp')
    // Only the rewrite's temp: the step-5 publish has already used this name and unlinked it.
    let armed = false
    const hit = counter()
    stub(fs.promises, 'open', (orig) => async (...a: unknown[]) => {
      if (a[0] === recTmp && armed) {
        hit.fired++
        throw errnoError('EIO')
      }
      return orig(...a)
    })
    const run = await runSpied(p, ALL_DELETES, {
      hooks: { afterSidecar: () => void (armed = true) },
    })
    expect(copy.fired).toBe(1)
    expect(hit.fired).toBe(1)
    const r = stoppedAtPublish(fx, run.result)
    expect(r.incomplete?.detail).toMatch(/^no space is left on /)
    expect(r.incomplete?.detail).toContain(
      '; the full-device marker was not recorded in record.json'
    )
    expect(recordOf(fx)).not.toHaveProperty('fullDevice')
  })
})

describe('the record that carries the marker is kept by every stop that can reach it', () => {
  it('the undo across devices: stopped with the record kept and marked', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    p.manifest.failCasOnCall = 2
    const undoneTemp = path.join(areaOf(fx), `.tmp-${OP_ID}.undone`)
    const hit = counter()
    let creates = 0
    stub(fs.promises, 'open', (orig) => async (...a: unknown[]) => {
      if (isCreateUnder(a, undoneTemp) && ++creates === 2) {
        hit.fired++
        throw errnoError('ENOSPC')
      }
      return orig(...a)
    })
    const run = await runSpied(p, ALL_DELETES)
    expect(hit.fired).toBe(1)
    expect(run.result).toMatchObject({
      status: 'stopped',
      reason: 'write-failed',
      recordPath: path.join(fx.opDir, 'record.json'),
    })
    expect(markerOf(fx)).toEqual(
      markerFor(fx, 'ENOSPC', 'copy', path.join(areaOf(fx), `${OP_ID}.undone`))
    )
  })

  it('abort cleanup after step 6 (a record published): staged left, the record kept and marked', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const N = path.join(fx.opDir, 'new')
    const t = abortAt(fx, 'step6', {
      afterBuild: () => fs.appendFileSync(path.join(N, 'a.txt'), 'edited in N\n'),
    })
    const editedTemp = path.join(areaOf(fx), `.tmp-${OP_ID}.edited-new`)
    const hit = counter()
    let creates = 0
    stub(fs.promises, 'open', (orig) => async (...a: unknown[]) => {
      if (isCreateUnder(a, editedTemp) && ++creates === 2) {
        hit.fired++
        throw errnoError('ENOSPC')
      }
      return orig(...a)
    })
    try {
      const run = await runSpied(p, ALL_DELETES, t.options)
      expect(hit.fired).toBe(1)
      expect(run.result).toMatchObject({ status: 'refused', staged: 'left' })
      expect(markerOf(fx)).toEqual(
        markerFor(fx, 'ENOSPC', 'copy', path.join(areaOf(fx), `${OP_ID}.edited-new`))
      )
    } finally {
      t.restore()
    }
  })
})

/**
 * Round 3 follow-up (coverage gaps QE1, QE2): the record rewrite's identity
 * check and its sync. The rewrite is the one exception to the metadata link
 * rule (owner decision): a synced temp is renamed over `record.json` only once
 * `record.json` is still the inode this run linked there, then OP is synced.
 */
describe('the marker rewrite: identity check and sync order', () => {
  it('record.json replaced before the identity check: the stop stands, says why, the replacement untouched, the temp kept', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const copy = failCopyCreate(fx, 'ENOSPC')
    const rec = path.join(fx.opDir, 'record.json')
    const recTmp = `${rec}.tmp`
    let armed = false
    const hit = counter()
    // Right before the rewrite's identity check (its lstat of record.json), another
    // writer replaces record.json with a different inode.
    stub(fs.promises, 'lstat', (orig) => async (...a: unknown[]) => {
      if (armed && a[0] === rec && hit.fired === 0 && fs.existsSync(recTmp)) {
        hit.fired++
        fs.writeFileSync(`${rec}.planted`, 'planted record\n')
        fs.renameSync(`${rec}.planted`, rec)
      }
      return orig(...a)
    })
    const run = await runSpied(p, ALL_DELETES, {
      hooks: { afterSidecar: () => void (armed = true) },
    })
    expect(copy.fired).toBe(1)
    expect(hit.fired).toBe(1)
    const r = stoppedAtPublish(fx, run.result)
    expect(r.incomplete?.detail).toMatch(/^no space is left on /)
    expect(r.incomplete?.detail).toContain(
      `; the full-device marker was not recorded in record.json (${rec} is not the record this run wrote)`
    )
    // The replacement is untouched: never renamed over, never unlinked.
    expect(fs.readFileSync(rec, 'utf8')).toBe('planted record\n')
    expect(run.events.filter((e) => 'op' in e && e.op === 'rename' && e.dest === rec)).toEqual([])
    // The temp stays: it is now the only copy of this run's record, with the
    // marker, so nothing removes it (doctor reads it as evidence).
    const kept = readRecord(recTmp)
    expect(kept.fullDevice).toEqual(markerFor(fx, 'ENOSPC', 'copy'))
    expect(kept.opId).toBe(OP_ID)
  })

  it('the order: the temp created and synced, renamed over record.json, then OP synced; never an unlink or a link of it', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    failCopyCreate(fx, 'ENOSPC')
    const run = await runSpied(p, ALL_DELETES)
    stoppedAtPublish(fx, run.result)
    const rec = path.join(fx.opDir, 'record.json')
    const recTmp = `${rec}.tmp`
    const trace = run.events.filter((e) => 'op' in e) as Array<Record<string, unknown>>
    const ren = trace.findIndex((t) => t.op === 'rename' && t.path === recTmp && t.dest === rec)
    // Presence: the rewrite's create, fsync, rename and OP sync, adjacent.
    expect(ren).toBeGreaterThan(1)
    expect(trace.slice(ren - 2, ren + 2)).toEqual([
      { op: 'create', path: recTmp },
      { op: 'fsync', path: recTmp },
      { op: 'rename', path: recTmp, dest: rec },
      { op: 'dirsync', path: fx.opDir },
    ])
    // Absence, paired: record.json is linked once (step 5's publish, before the
    // rewrite) and never unlinked, so it is never absent.
    const links = trace.filter((t) => t.op === 'link' && t.dest === rec)
    expect(links).toHaveLength(1)
    expect(trace.indexOf(links[0]!)).toBeLessThan(ren)
    expect(trace.filter((t) => t.op === 'unlink' && t.path === rec)).toEqual([])
    expect(markerOf(fx)).toMatchObject({ cause: 'ENOSPC' })
  })
})

describe('the marker rewrite is sealed like step 5', () => {
  async function fullStop(pad: number) {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    p.input = { ...p.input, preEntry: { pad: 'x'.repeat(pad) } }
    const copy = failCopyCreate(fx, 'ENOSPC')
    const run = await runSpied(p, ALL_DELETES)
    expect(copy.fired).toBe(1)
    return { fx, run, size: fs.statSync(path.join(fx.opDir, 'record.json')).size }
  }

  it('a marked record over the cap is not written: the stop stands, says so, and the step-5 record stays readable', async () => {
    // Measure the marker's byte overhead on a small record.
    const small = await fullStop(10)
    stoppedAtPublish(small.fx, small.run.result)
    const marked = recordOf(small.fx)
    expect(marked.fullDevice).toBeDefined()
    const { recordSha256: _h, fullDevice: _m, ...rest } = marked
    const unmarked = jsonBytes({ ...rest, recordSha256: computeRecordSha256(rest) }).length
    const overhead = small.size - unmarked
    expect(overhead).toBeGreaterThan(0)

    // Pad so the unmarked record is half the marker's size under the cap: it
    // fits and the marked one does not, with room for identity strings (inode
    // numbers) a digit longer or shorter than the small run's.
    const big = await fullStop(10 + (MAX_RECORD_BYTES - unmarked) - Math.floor(overhead / 2))
    // Same path lengths, so the runs differ only in the pad and their identities.
    expect(big.fx.skillsDir.length).toBe(small.fx.skillsDir.length)
    expect(big.fx.stateRoot.length).toBe(small.fx.stateRoot.length)
    expect(big.size).toBeLessThanOrEqual(MAX_RECORD_BYTES)
    expect(big.size + overhead).toBeGreaterThan(MAX_RECORD_BYTES)

    const r = stoppedAtPublish(big.fx, big.run.result)
    expect(r.incomplete?.detail).toContain(
      '; the full-device marker was not recorded in record.json'
    )
    expect(r.incomplete?.detail).toContain('(too-large)')
    expect(recordOf(big.fx)).not.toHaveProperty('fullDevice')
    expect(fs.existsSync(path.join(big.fx.opDir, 'record.json.tmp'))).toBe(false)
    const scan = await scanStagingRecords(fs.realpathSync(big.fx.skillsDir), big.fx.staging)
    expect(scan).toMatchObject({ ok: true, unreadable: [] })
    expect(scan.ok && scan.pending.map((x) => x.opId)).toEqual([OP_ID])
  })
})
