/**
 * SMI-6531 (A1 step 4c): T-F1's swap half, a full state root during the
 * cross-device publish, never deleting (UD13).
 *
 * A real disk is not filled: the container's `/dev/shm` is shared, so `ENOSPC`
 * is forced at the copy's file creates (`fs.promises.open` under the copy
 * temp), at the backup sidecar's temp, and at the parked sidecar
 * (`fs.writeFileSync`); the space check's `statfs` is stubbed to report too
 * little room, and for the ratchet test a whole device is simulated (`statfs`
 * shrinks by what the area allocates, and a create that would not fit fails
 * `ENOSPC`). Each stub hits only its own path and records that it fired, so
 * a test that never reached it fails rather than passing on a run the stub
 * never touched.
 *
 * Doctor finishing once there is space, and its own `--apply` attempts, are
 * step 6's; these tests assert the state it reads.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SwapResult } from '../../../src/services/skill-swap.js'
import { ALL_DELETES, contentOf, runSpied } from './skill-swap.abort.helpers.js'
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
  areaNames,
  errnoError,
  isCreateUnder,
  parkedCopies,
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

type Committed = Extract<SwapResult, { status: 'committed' }>
function committedOf(r: SwapResult): Committed {
  expect(r.status).toBe('committed')
  if (r.status !== 'committed') throw new Error('unreachable')
  return r
}

/** The update committed with the record kept, the old folder intact in OP, nothing parked. */
function assertStoppedAtPublish(fx: Fixture, pre: string, r: Committed, reason: string) {
  expect(r).toMatchObject({
    incomplete: { step: 'publish', reason },
    recordPath: path.join(fx.opDir, 'record.json'),
  })
  readRecord(path.join(fx.opDir, 'record.json'))
  expect(fs.readFileSync(path.join(fx.realDir, 'SKILL.md'), 'utf8')).toBe('# v2\n')
  expect(hashOf(path.join(fx.opDir, 'old'))).toBe(pre)
  expect(parkedCopies(fx)).toEqual([])
  expect(r.extraCopy).toBeUndefined()
}

/** `ENOSPC` from the copy's second file create under the copy temp; returns how often it fired. */
function enospcAtCopy(fx: Fixture): { fired: number } {
  const hit = { fired: 0 }
  const temp = path.join(areaOf(fx), `.tmp-${OP_ID}`)
  let creates = 0
  stub(fs.promises, 'open', (orig) => async (...a: unknown[]) => {
    if (isCreateUnder(a, temp) && ++creates === 2) {
      hit.fired++
      throw errnoError('ENOSPC')
    }
    return orig(...a)
  })
  return hit
}

describe('T-F1: ENOSPC during the cross-device copy', () => {
  it('keeps the partial temp as partial-copy with sourceUnchanged: true, and stops write-failed naming the device', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const hit = enospcAtCopy(fx)
    const run = await runSpied(p, ALL_DELETES)
    expect(hit.fired).toBe(1)
    const r = committedOf(run.result)
    assertStoppedAtPublish(fx, p.input.preTree, r, 'write-failed')
    expect(r.incomplete?.detail).toMatch(/no space is left on .* \(device \d+\) \(ENOSPC at /)
    expect(r.incomplete?.detail).toContain(areaOf(fx))
    const kept = partials(areaOf(fx))
    expect(kept).toHaveLength(1)
    expect(Object.keys(contentOf(kept[0]!)).length).toBeGreaterThan(0)
    expect(sidecarOf(kept[0]!)).toMatchObject({ kind: 'partial-copy', sourceUnchanged: true })
    expect(areaNames(areaOf(fx)).filter((n) => n.startsWith('.tmp-'))).toEqual([])
    // The backup's own sidecar is published (P1/P2); dest itself does not exist.
    expect(fs.existsSync(path.join(areaOf(fx), `${OP_ID}.json`))).toBe(true)
    expect(fs.existsSync(path.join(areaOf(fx), OP_ID))).toBe(false)
    expect(treeDeletesX(fx, run.events)).toEqual([])
  })

  it('records sourceUnchanged: false when the source changed after its sidecar', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const hit = enospcAtCopy(fx)
    const run = await runSpied(p, ALL_DELETES, {
      hooks: { afterSidecar: () => fs.appendFileSync(path.join(fx.opDir, 'old', 'a.txt'), 'x\n') },
    })
    expect(hit.fired).toBe(1)
    assertStoppedAtPublish(
      fx,
      hashOf(path.join(fx.opDir, 'old')),
      committedOf(run.result),
      'write-failed'
    )
    const kept = partials(areaOf(fx))
    expect(kept).toHaveLength(1)
    expect(sidecarOf(kept[0]!)).toMatchObject({ kind: 'partial-copy', sourceUnchanged: false })
    expect(treeDeletesX(fx, run.events)).toEqual([])
  })
})

/** The regular files under `dir`, by absolute path. */
function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...filesUnder(p))
    else if (e.isFile()) out.push(p)
  }
  return out
}

describe('sourceUnchanged on the update path needs the temp to be a subset of the source (plan §3.5)', () => {
  /** ENOSPC at the copy's 2nd create; when `editTemp`, a file already in the temp is edited first. */
  async function enospcKeep(editTemp: boolean) {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const temp = path.join(areaOf(fx), `.tmp-${OP_ID}`)
    let creates = 0
    let edited: string | null = null
    stub(fs.promises, 'open', (orig) => async (...a: unknown[]) => {
      if (isCreateUnder(a, temp) && ++creates === 2) {
        if (editTemp) {
          edited = filesUnder(temp)[0] ?? null
          if (edited !== null) fs.appendFileSync(edited, 'written into the temp only\n')
        }
        throw errnoError('ENOSPC')
      }
      return orig(...a)
    })
    const run = await runSpied(p, ALL_DELETES)
    expect(creates).toBeGreaterThanOrEqual(2)
    assertStoppedAtPublish(fx, p.input.preTree, committedOf(run.result), 'write-failed')
    const kept = partials(areaOf(fx))
    expect(kept).toHaveLength(1)
    return { side: sidecarOf(kept[0]!), edited, kept: kept[0]! }
  }

  it('a temp edited before the ENOSPC stop: sourceUnchanged false, though the source is unchanged', async () => {
    const r = await enospcKeep(true)
    expect(r.edited).not.toBeNull()
    expect(filesUnder(r.kept).some((f) => fs.readFileSync(f, 'utf8').includes('temp only'))).toBe(
      true
    )
    expect(r.side).toMatchObject({ partialCause: 'enospc', sourceUnchanged: false })
  })

  it('the pair: the same stop with the temp unedited records true', async () => {
    const r = await enospcKeep(false)
    expect(r.side).toMatchObject({ partialCause: 'enospc', sourceUnchanged: true })
  })
})

describe('T-F1: ENOSPC at the partial copy own sidecar', () => {
  it('leaves the temp at its name, says so, and stops write-failed: nothing removed', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const hit = enospcAtCopy(fx)
    const side = path.join(areaOf(fx), `${OP_ID}.partial-copy.json.tmp`)
    let fired = 0
    stub(fs.promises, 'open', (orig) => async (...a: unknown[]) => {
      if (a[0] === side) {
        fired++
        throw errnoError('ENOSPC')
      }
      return orig(...a)
    })
    const run = await runSpied(p, ALL_DELETES)
    expect(hit.fired).toBe(1)
    expect(fired).toBe(1)
    const r = committedOf(run.result)
    assertStoppedAtPublish(fx, p.input.preTree, r, 'write-failed')
    const temp = path.join(areaOf(fx), `.tmp-${OP_ID}`)
    expect(r.incomplete?.detail).toContain(`the partial copy is left at ${temp}`)
    expect(partials(areaOf(fx))).toEqual([])
    expect(Object.keys(contentOf(temp)).length).toBeGreaterThan(0)
    expect(treeDeletesX(fx, run.events)).toEqual([])
  })
})

const BLOCK = 4096n
/**
 * `bfree` the stubs report: far more than any test needs. Only `bavail` is
 * the caller's to use (`bfree` counts root-reserved blocks too), so a check
 * that read `bfree` would see room where there is none and stop refusing.
 */
const RESERVED_ROOM = 1n << 40n

/** `statfs` of the backup area with `bsize` 4096, `free` bytes and `ffree` inodes; counts the calls. */
function stubStatfs(
  fx: Fixture,
  free: bigint,
  inodes: { files: bigint; ffree: bigint } = { files: 1_000_000n, ffree: 1_000_000n }
): { asked: number } {
  const hit = { asked: 0 }
  stub(fs.promises, 'statfs', (orig) => async (...a: unknown[]) => {
    const s = (await orig(...a)) as fs.BigIntStatsFs
    if (a[0] !== areaOf(fx)) return s
    hit.asked++
    return { ...s, bsize: BLOCK, bavail: free / BLOCK, bfree: RESERVED_ROOM, ...inodes }
  })
  return hit
}

/**
 * FILES allocates, by the plan-review rule written out here independently of
 * the code: 4 files at one 4096-byte block each, 2 directories (the root and
 * `sub`) at one block each, 2 blocks for sidecars, plus 64 KiB.
 */
const FILES_NEED = (4n + 2n + 2n) * BLOCK + 65536n

describe('T-F1: the space check (block-rounded allocation, inodes)', () => {
  it('refuses state-root-full with the free-space remedy, before any copy temp exists', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const hit = stubStatfs(fx, 16n * BLOCK)
    const run = await runSpied(p, ALL_DELETES)
    expect(hit.asked).toBe(1)
    const r = committedOf(run.result)
    assertStoppedAtPublish(fx, p.input.preTree, r, 'state-root-full')
    const detail = r.incomplete?.detail
    expect(detail).toContain('free space on the device that holds the Skillsmith state directory')
    expect(detail).toContain('not available yet')
    expect(detail).toContain('skillsmith doctor recovery --apply')
    expect(detail).not.toContain('run the same command again')
    expect(detail).not.toContain('run this command again')
    expect(detail).not.toContain('run `skillsmith doctor backups --prune`')
    expect(areaNames(areaOf(fx))).toEqual([`${OP_ID}.json`])
    expect(treeDeletesX(fx, run.events)).toEqual([])
  })

  it('passes at exactly the block-rounded need', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const hit = stubStatfs(fx, FILES_NEED)
    const run = await runSpied(p, ALL_DELETES)
    expect(hit.asked).toBe(1)
    expect(committedOf(run.result).incomplete).toBeUndefined()
  })

  it('one block less refuses', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    stubStatfs(fx, FILES_NEED - BLOCK)
    const run = await runSpied(p, ALL_DELETES)
    expect(committedOf(run.result).incomplete?.reason).toBe('state-root-full')
  })

  it('many small files: free space above the logical bytes but below the blocks they allocate is refused', async () => {
    const files: Record<string, string> = { 'SKILL.md': '#\n' }
    for (let i = 0; i < 199; i++) files[`d${i % 4}/f${i}`] = 'x'
    const fx = xdevFixture(files)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const logical = 200n + 65536n
    const blocks = (200n + 5n + 2n) * BLOCK + 65536n
    const free = 200n * BLOCK
    expect(free > logical && free < blocks).toBe(true)
    stubStatfs(fx, free)
    const run = await runSpied(p, ALL_DELETES)
    const r = committedOf(run.result)
    assertStoppedAtPublish(fx, p.input.preTree, r, 'state-root-full')
    expect(r.incomplete?.detail).toContain('200 files and links, 5 directories')
    expect(areaNames(areaOf(fx)).filter((n) => n.startsWith('.tmp-'))).toEqual([])
  })

  it('inodes short: refuses state-root-full though the bytes suffice', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    stubStatfs(fx, FILES_NEED * 10n, { files: 1000n, ffree: 5n })
    const run = await runSpied(p, ALL_DELETES)
    const r = committedOf(run.result)
    assertStoppedAtPublish(fx, p.input.preTree, r, 'state-root-full')
    expect(r.incomplete?.detail).toMatch(/has 5 inodes free and the backup of .* needs \d+/)
  })

  it('a filesystem reporting no inode table (files 0) skips only the inode check', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    stubStatfs(fx, FILES_NEED, { files: 0n, ffree: 0n })
    const run = await runSpied(p, ALL_DELETES)
    expect(committedOf(run.result).incomplete).toBeUndefined()
  })

  it('a tree that cannot be measured stops write-failed, never sized at 0', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const bad = path.join(fx.opDir, 'new', 'a.txt')
    let fired = 0
    stub(fs, 'lstatSync', (orig) => (...a: unknown[]) => {
      if (a[0] === bad) {
        fired++
        throw errnoError('EIO')
      }
      return orig(...a)
    })
    // A failed build is kept even when it cannot be hashed: its record is null,
    // so the space check must walk it, and the walk fails.
    const run = await runSpied(p, ALL_DELETES, {
      hooks: {
        afterCopy: () => {
          throw new Error('forced build failure')
        },
      },
    })
    expect(fired).toBeGreaterThan(0)
    expect(run.result.status).toBe('refused')
    if (run.result.status !== 'refused') return
    expect(run.result.staged).toBe('left')
    expect(run.result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'removal-not-done',
        status: 'stopped',
        reason: 'write-failed',
      })
    )
    const w = run.result.warnings.find((x) => x.code === 'removal-not-done')
    expect(w && 'detail' in w ? w.detail : '').toContain(
      'could not be measured for the space check'
    )
    expect(areaNames(areaOf(fx)).filter((n) => n.startsWith('.tmp-'))).toEqual([])
  })
})

/**
 * A simulated device of `size` bytes under the backup area: `statfs` reports
 * what is left after the blocks the area's entries allocate (each file and
 * directory rounded up to a block), and any file create under the area that
 * would not fit fails `ENOSPC`. So every attempt consumes what it writes.
 * Returns the bytes the area allocates now.
 */
function simulatedDevice(fx: Fixture, size: bigint): () => bigint {
  const area = areaOf(fx)
  const used = (): bigint => {
    let n = 0n
    const walk = (p: string): void => {
      for (const name of fs.readdirSync(p)) {
        const c = path.join(p, name)
        const s = fs.lstatSync(c)
        if (s.isDirectory()) {
          n += BLOCK
          walk(c)
        } else {
          const b = (BigInt(s.size) + BLOCK - 1n) / BLOCK
          n += (b > 0n ? b : 1n) * BLOCK
        }
      }
    }
    if (fs.existsSync(area)) walk(area)
    return n
  }
  stub(fs.promises, 'statfs', (orig) => async (...a: unknown[]) => {
    const s = (await orig(...a)) as fs.BigIntStatsFs
    if (a[0] !== area) return s
    const left = size > used() ? size - used() : 0n
    return {
      ...s,
      bsize: BLOCK,
      bavail: left / BLOCK,
      bfree: RESERVED_ROOM,
      files: 1_000_000n,
      ffree: 1_000_000n,
    }
  })
  stub(fs.promises, 'open', (orig) => async (...a: unknown[]) => {
    const creates = (Number(a[1]) & fs.constants.O_CREAT) !== 0
    if (creates && String(a[0]).startsWith(`${area}/`) && used() + BLOCK > size) {
      throw errnoError('ENOSPC')
    }
    return orig(...a)
  })
  return used
}

/**
 * The plan's T-F1 row: the first attempt's kept record refuses every later
 * attempt through step 3's record scan (implementation-order step 5), so a
 * device too small for the copy is never filled by retries.
 */
describe('T-F1: no ratchet', () => {
  it('on a simulated full device, the kept record refuses later attempts, which add nothing', async () => {
    const files: Record<string, string> = { 'SKILL.md': '# v1\n' }
    for (let i = 0; i < 24; i++) files[`d${i % 3}/f${i}.txt`] = `file ${i}\n`
    const fx = xdevFixture(files)
    // Room for the first attempt's sidecar (only it writes one), far less than one copy.
    const used = simulatedDevice(fx, 10n * BLOCK)
    const firstOp = '1'.repeat(32)
    const first = await runSpied(plan(fx, [modify('SKILL.md', '# v2\n')]), ALL_DELETES, {
      opId: firstOp,
    })
    const kept = committedOf(first.result)
    expect(kept.incomplete?.reason).toBe('state-root-full')
    const recordPath = kept.recordPath ?? ''
    const names = areaNames(areaOf(fx))
    expect(names.filter((n) => n.startsWith('.tmp-') || n.includes('.partial-copy'))).toEqual([])
    const bytes = used()
    for (const [i, version] of ['# v3\n', '# v4\n'].entries()) {
      const p = plan(fx, [modify('SKILL.md', version)])
      const run = await runSpied(p, ALL_DELETES, { opId: String(i + 2).repeat(32) })
      expect(run.result).toMatchObject({
        status: 'refused',
        reason: 'recovery-pending',
        blockedBy: [firstOp],
      })
      expect(areaNames(areaOf(fx))).toEqual(names)
      expect(used()).toBe(bytes)
      expect(readRecord(recordPath).opId).toBe(firstOp)
    }
  })
})

describe('T-F1: ENOSPC at the backup sidecar', () => {
  it('stops write-failed with the record kept and the old folder in OP, nothing copied', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const tmp = path.join(areaOf(fx), `${OP_ID}.json.tmp`)
    let fired = 0
    stub(fs.promises, 'open', (orig) => async (...a: unknown[]) => {
      if (a[0] === tmp) {
        fired++
        throw errnoError('ENOSPC')
      }
      return orig(...a)
    })
    const run = await runSpied(p, ALL_DELETES)
    expect(fired).toBe(1)
    assertStoppedAtPublish(fx, p.input.preTree, committedOf(run.result), 'write-failed')
    expect(areaNames(areaOf(fx))).toEqual([])
    expect(treeDeletesX(fx, run.events)).toEqual([])
  })
})

describe('T-F1: ENOSPC at the park sidecar', () => {
  it('parked with sidecarError, the status unchanged, the tree whole in the parked area', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    let fired = 0
    stub(fs, 'writeFileSync', (orig) => (...a: unknown[]) => {
      const f = String(a[0])
      if (f.includes('.skillsmith-parked') && f.endsWith('.json')) {
        fired++
        throw errnoError('ENOSPC')
      }
      return orig(...a)
    })
    const run = await runSpied(p, ALL_DELETES)
    expect(fired).toBe(1)
    const r = committedOf(run.result)
    expect(r.incomplete).toBeUndefined()
    const copies = parkedCopies(fx)
    expect(copies).toHaveLength(1)
    expect(r.extraCopy).toBe(copies[0])
    expect(r.warnings).toContainEqual({
      code: 'park-metadata-failed',
      path: copies[0],
      sidecarError: 'ENOSPC',
    })
    expect(r.warnings.filter((w) => w.code === 'removal-not-done')).toEqual([])
    expect(fs.existsSync(`${copies[0]}.json`)).toBe(false)
    expect(hashOf(path.join(copies[0]!, 'old'))).toBe(p.input.preTree)
    expect(treeDeletesX(fx, run.events)).toEqual([])
  })
})

/** Round 2 (governance minor 2): the estimate's two margins pinned at their boundaries. */
describe('T-F1: the estimate margins, pinned', () => {
  // Three 0-byte files still take a block each, the root directory one, the sidecars two.
  const EMPTY = { 'SKILL.md': '', 'e1.txt': '', 'e2.txt': '' }
  const EMPTY_NEED = (3n + 1n + 2n) * BLOCK + 65536n

  it('0-byte files: one block less than the need refuses', async () => {
    const fx = xdevFixture(EMPTY)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    stubStatfs(fx, EMPTY_NEED - BLOCK)
    const run = await runSpied(p, ALL_DELETES)
    expect(committedOf(run.result).incomplete?.reason).toBe('state-root-full')
  })

  it('0-byte files: exactly the need passes', async () => {
    const fx = xdevFixture(EMPTY)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    stubStatfs(fx, EMPTY_NEED)
    const run = await runSpied(p, ALL_DELETES)
    expect(committedOf(run.result).incomplete).toBeUndefined()
  })

  // FILES: 4 files and 2 directories, plus 2 sidecars and a margin of 16 inodes.
  const ENTRIES = 6n
  it('inodes: entries + 17 free refuses', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    stubStatfs(fx, FILES_NEED * 10n, { files: 1000n, ffree: ENTRIES + 17n })
    const run = await runSpied(p, ALL_DELETES)
    const r = committedOf(run.result)
    expect(r.incomplete?.reason).toBe('state-root-full')
    expect(r.incomplete?.detail).toContain(`has ${ENTRIES + 17n} inodes free`)
  })

  it('inodes: entries + 18 free passes', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    stubStatfs(fx, FILES_NEED * 10n, { files: 1000n, ffree: ENTRIES + 18n })
    const run = await runSpied(p, ALL_DELETES)
    expect(committedOf(run.result).incomplete).toBeUndefined()
  })
})
