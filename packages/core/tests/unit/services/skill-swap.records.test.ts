/**
 * SMI-6531 (A1 step 5): the record scan (plan §3.3 step 3, R1).
 *
 * A case table on a real temp directory. Every negative sits beside a valid
 * record in the same scan, so a scan that returned nothing at all (or threw
 * the entry away) cannot pass: the valid neighbour must come back pending.
 * Records are built here with `computeRecordSha256`, and one is written by the
 * real writer (a `swapInPlace` run that keeps its record) so the scan is
 * proven to accept what the writer writes.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeRecordSha256 } from '../../../src/services/skill-swap.js'
import type { SwapRecord } from '../../../src/services/skill-swap.js'
import {
  isSwapRecord,
  MAX_RECORD_BYTES,
  recordsNaming,
  scanStagingRecords,
} from '../../../src/services/skill-swap.records.js'
import type { PendingRecord, RecordScan } from '../../../src/services/skill-swap.records.js'
import { makeFixture, modify, OP_ID, plan, run, tmp, useTmpCleanup } from './skill-swap.helpers.js'

useTmpCleanup()

afterEach(() => {
  vi.restoreAllMocks()
})

const GOOD = 'a'.repeat(32)
const BAD = 'b'.repeat(32)

const identity = { dev: '1', ino: '2', birthtimeNs: '3', fmt: 'f' }

/** Layout of one temp skills root with its staging directory. */
function layout(): { root: string; st: string } {
  const root = tmp('skill-swap-records-')
  const st = path.join(root, '.skillsmith-staging')
  fs.mkdirSync(st)
  return { root, st }
}

type Body = Omit<SwapRecord, 'recordSha256'>

function bodyOf(root: string, opId: string, dirName = 'skill', over: Partial<Body> = {}): Body {
  const realDir = path.join(root, dirName)
  return {
    schema: 1,
    opId,
    pid: 1234,
    host: 'host-a',
    uid: 1000,
    target: {
      comparedPath: realDir,
      realDir,
      skillsDir: root,
      manifestPath: path.join(root, 'manifest.json'),
      manifestKey: dirName,
      client: 'claude-code',
    },
    rootIdentity: { ...identity },
    opDirIdentity: { ...identity },
    oldIdentity: { ...identity },
    newIdentity: { ...identity },
    preTree: 'pre',
    postTree: 'post',
    preEntry: { version: '1.0.0' },
    postEntry: { version: '2.0.0' },
    backupDest: path.join(root, 'backup', opId),
    ...over,
  }
}

/** The record text for `body`, hashed over `body` as it stands. */
function textOf(body: Body): string {
  return JSON.stringify({ ...body, recordSha256: computeRecordSha256(body) })
}

/** Writes `ST/<name>/record.json` with `text` (the op dir is created). */
function put(st: string, name: string, text: string): string {
  const dir = path.join(st, name)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'record.json')
  fs.writeFileSync(file, text)
  return file
}

/** A valid record of `root`, op dir `opId`, for the skill `dirName`. */
function putValid(root: string, st: string, opId: string, dirName = 'skill'): string {
  return put(st, opId, textOf(bodyOf(root, opId, dirName)))
}

function okScan(scan: RecordScan): Extract<RecordScan, { ok: true }> {
  if (!scan.ok) throw new Error(`scan failed: ${scan.errno} at ${scan.path}`)
  return scan
}

const pendingIds = (scan: RecordScan): string[] => okScan(scan).pending.map((r) => r.opId)

describe('scanStagingRecords: what is not a record', () => {
  it('no ST: ok, nothing pending, nothing unreadable', async () => {
    const root = tmp('skill-swap-records-')
    const scan = await scanStagingRecords(root, path.join(root, '.skillsmith-staging'))
    expect(scan).toEqual({ ok: true, pending: [], unreadable: [] })
  })

  it('an op dir with no record is ignored, and so is one holding only record.json.tmp', async () => {
    const { root, st } = layout()
    putValid(root, st, GOOD)
    fs.mkdirSync(path.join(st, 'crashed-before-step-5'))
    fs.mkdirSync(path.join(st, 'tmp-only'))
    fs.writeFileSync(path.join(st, 'tmp-only', 'record.json.tmp'), 'not even json')
    const scan = okScan(await scanStagingRecords(root, st))
    expect(scan.pending.map((r) => r.opId)).toEqual([GOOD])
    expect(scan.unreadable).toEqual([])
  })

  it('a dot-named entry holding a valid record is skipped', async () => {
    const { root, st } = layout()
    putValid(root, st, GOOD)
    // Would be pending if it were read: its opId equals its dir's name.
    putValid(root, st, '.parked')
    const scan = okScan(await scanStagingRecords(root, st))
    expect(scan.pending.map((r) => r.opId)).toEqual([GOOD])
    expect(scan.unreadable).toEqual([])
  })

  it('a non-directory entry is skipped', async () => {
    const { root, st } = layout()
    putValid(root, st, GOOD)
    fs.writeFileSync(path.join(st, 'stray-file'), 'x')
    const scan = okScan(await scanStagingRecords(root, st))
    expect(scan.pending.map((r) => r.opId)).toEqual([GOOD])
    expect(scan.unreadable).toEqual([])
  })

  it('a symlink to a directory holding a valid record is skipped, never followed', async () => {
    const { root, st } = layout()
    putValid(root, st, GOOD)
    const elsewhere = tmp('skill-swap-records-elsewhere-')
    // Would be pending if followed: the record names the link's own name.
    put(elsewhere, 'linked', textOf(bodyOf(root, 'linked')))
    fs.symlinkSync(path.join(elsewhere, 'linked'), path.join(st, 'linked'), 'dir')
    expect(fs.lstatSync(path.join(st, 'linked')).isSymbolicLink()).toBe(true)
    const scan = okScan(await scanStagingRecords(root, st))
    expect(scan.pending.map((r) => r.opId)).toEqual([GOOD])
    expect(scan.unreadable).toEqual([])
  })
})

describe('scanStagingRecords: a record that cannot be trusted is unreadable', () => {
  /** One bad op dir beside a good one: the bad one is the only unreadable entry, the good one still pends. */
  async function scanBeside(setup: (root: string, st: string) => void) {
    const { root, st } = layout()
    putValid(root, st, GOOD)
    setup(root, st)
    const scan = okScan(await scanStagingRecords(root, st))
    expect(scan.pending.map((r) => r.opId)).toEqual([GOOD])
    return { scan, st }
  }

  it('record.json a symlink: open-failed, ELOOP, even to a valid record', async () => {
    const { scan, st } = await scanBeside((root, st) => {
      // The target of the link is a valid record of this root, held outside ST.
      const real = put(tmp('skill-swap-records-elsewhere-'), 'real-copy', textOf(bodyOf(root, BAD)))
      fs.mkdirSync(path.join(st, BAD))
      fs.symlinkSync(real, path.join(st, BAD, 'record.json'))
    })
    expect(scan.unreadable).toEqual([
      { opId: BAD, path: path.join(st, BAD, 'record.json'), why: 'open-failed', errno: 'ELOOP' },
    ])
  })

  it('record.json a directory: not-a-file', async () => {
    const { scan, st } = await scanBeside((_root, st) => {
      fs.mkdirSync(path.join(st, BAD, 'record.json'), { recursive: true })
    })
    expect(scan.unreadable).toEqual([
      { opId: BAD, path: path.join(st, BAD, 'record.json'), why: 'not-a-file' },
    ])
  })

  it('record.json a FIFO: not-a-file, and the scan returns promptly (no wait for a writer)', async () => {
    const { scan, st } = await scanBeside((_root, st) => {
      fs.mkdirSync(path.join(st, BAD))
      execFileSync('mkfifo', [path.join(st, BAD, 'record.json')])
    })
    expect(scan.unreadable).toEqual([
      { opId: BAD, path: path.join(st, BAD, 'record.json'), why: 'not-a-file' },
    ])
  }, 5000)

  it('a record file over MAX_RECORD_BYTES: too-large, though its JSON is valid', async () => {
    const { scan, st } = await scanBeside((root, st) => {
      const text = textOf(bodyOf(root, BAD))
      // Valid JSON padded past the cap with trailing whitespace.
      put(st, BAD, text + ' '.repeat(MAX_RECORD_BYTES + 1 - text.length))
      expect(fs.statSync(path.join(st, BAD, 'record.json')).size).toBeGreaterThan(MAX_RECORD_BYTES)
      expect(() =>
        JSON.parse(fs.readFileSync(path.join(st, BAD, 'record.json'), 'utf8'))
      ).not.toThrow()
    })
    expect(scan.unreadable).toEqual([
      { opId: BAD, path: path.join(st, BAD, 'record.json'), why: 'too-large' },
    ])
  })

  it('a record that grew after its size was taken is still too-large (the read itself is bounded)', async () => {
    const { root, st } = layout()
    const text = textOf(bodyOf(root, BAD))
    put(st, BAD, text + ' '.repeat(MAX_RECORD_BYTES + 1 - text.length))
    put(st, GOOD, textOf(bodyOf(root, GOOD)))
    // Every handle's stat reports the size the file had before it grew.
    const probe = await fs.promises.open(path.join(st, GOOD, 'record.json'), 'r')
    const proto = Object.getPrototypeOf(probe) as { stat: (...a: unknown[]) => Promise<fs.Stats> }
    await probe.close()
    const orig = proto.stat
    let fired = 0
    vi.spyOn(proto, 'stat').mockImplementation(async function (this: unknown, ...a: unknown[]) {
      const s = await orig.apply(this, a)
      if (s.size > MAX_RECORD_BYTES) fired++
      return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { size: text.length })
    })
    const scan = await scanStagingRecords(root, st)
    expect(scan).toMatchObject({
      ok: true,
      unreadable: [{ opId: BAD, path: path.join(st, BAD, 'record.json'), why: 'too-large' }],
    })
    expect(pendingIds(scan)).toEqual([GOOD])
    // Paired: the stub did hide BAD's real size from the scan.
    expect(fired).toBeGreaterThanOrEqual(1)
  })

  it('a valid record padded to exactly MAX_RECORD_BYTES is still read (the cap is inclusive)', async () => {
    const { root, st } = layout()
    const text = textOf(bodyOf(root, GOOD))
    put(st, GOOD, text + ' '.repeat(MAX_RECORD_BYTES - text.length))
    expect(fs.statSync(path.join(st, GOOD, 'record.json')).size).toBe(MAX_RECORD_BYTES)
    expect(pendingIds(await scanStagingRecords(root, st))).toEqual([GOOD])
  })

  it.each([
    ['not JSON', '{ not json'],
    ['a 0-byte file', ''],
  ])('%s: not-json', async (_label, text) => {
    const { scan, st } = await scanBeside((_root, st) => {
      put(st, BAD, text)
    })
    expect(scan.unreadable).toEqual([
      { opId: BAD, path: path.join(st, BAD, 'record.json'), why: 'not-json' },
    ])
  })

  /** Each is a defect of shape alone: the hash is recomputed over the damaged body. */
  const SHAPES: Array<[string, (b: Record<string, unknown>) => void]> = [
    ['a missing key', (b) => delete b.uid],
    ['an extra key', (b) => (b.extra = 'x')],
    ['an extra key in target', (b) => ((b.target as Record<string, unknown>).extra = 'x')],
    ['schema 2', (b) => (b.schema = 2)],
    ['a non-integer pid', (b) => (b.pid = 1.5)],
    ['a non-string preTree', (b) => (b.preTree = 7)],
    ['an identity missing a field', (b) => delete (b.oldIdentity as Record<string, unknown>).fmt],
    [
      'a fullDevice with a bad cause',
      (b) => (b.fullDevice = { cause: 'EIO', stage: 'copy', area: 'a', opId: BAD, dest: 'd' }),
    ],
    [
      'a fullDevice with a bad stage',
      (b) => (b.fullDevice = { cause: 'ENOSPC', stage: 'nope', area: 'a', opId: BAD, dest: 'd' }),
    ],
  ]
  it.each(SHAPES)('%s: malformed', async (_label, damage) => {
    const { scan, st } = await scanBeside((root, st) => {
      const b = { ...bodyOf(root, BAD) } as Record<string, unknown>
      b.target = { ...(b.target as object) }
      damage(b)
      put(st, BAD, JSON.stringify({ ...b, recordSha256: computeRecordSha256(b as Body) }))
    })
    expect(scan.unreadable).toEqual([
      { opId: BAD, path: path.join(st, BAD, 'record.json'), why: 'malformed' },
    ])
  })

  it('one byte of the body changed: hash-mismatch (the shape is still valid)', async () => {
    const { scan, st } = await scanBeside((root, st) => {
      const text = textOf(bodyOf(root, BAD))
      expect(text).toContain('host-a')
      put(st, BAD, text.replace('host-a', 'host-b'))
    })
    expect(scan.unreadable).toEqual([
      { opId: BAD, path: path.join(st, BAD, 'record.json'), why: 'hash-mismatch' },
    ])
  })

  it('opId different from its dir name: foreign-op-dir (a record copied between op dirs)', async () => {
    const { scan, st } = await scanBeside((root, st) => {
      put(st, BAD, textOf(bodyOf(root, 'c'.repeat(32))))
    })
    expect(scan.unreadable).toEqual([
      { opId: BAD, path: path.join(st, BAD, 'record.json'), why: 'foreign-op-dir' },
    ])
  })

  it('target.skillsDir different from the root: foreign-root', async () => {
    const { scan, st } = await scanBeside((root, st) => {
      const b = bodyOf(root, BAD)
      put(st, BAD, textOf({ ...b, target: { ...b.target, skillsDir: `${root}-moved` } }))
    })
    expect(scan.unreadable).toEqual([
      { opId: BAD, path: path.join(st, BAD, 'record.json'), why: 'foreign-root' },
    ])
  })

  it('a valid record with a valid fullDevice marker is pending, not unreadable', async () => {
    const { root, st } = layout()
    const marker = { cause: 'ENOSPC', stage: 'partial-keep', area: 'a', opId: GOOD, dest: 'd' }
    put(st, GOOD, textOf(bodyOf(root, GOOD, 'skill', { fullDevice: marker as never })))
    const scan = okScan(await scanStagingRecords(root, st))
    expect(scan.pending.map((r) => r.opId)).toEqual([GOOD])
    expect(scan.unreadable).toEqual([])
  })
})

describe('scanStagingRecords: ST cannot be inspected', () => {
  it('a listing failure of ST is { ok: false } with the errno, and only that path is stubbed', async () => {
    const { root, st } = layout()
    putValid(root, st, GOOD)
    // Control: unstubbed, the same directory scans fine and the record pends.
    expect(pendingIds(await scanStagingRecords(root, st))).toEqual([GOOD])

    const real = fs.promises.readdir.bind(fs.promises)
    let fired = 0
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: unknown, ...rest: unknown[]) => {
      if (p === st) {
        fired++
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      }
      return (real as (...a: unknown[]) => unknown)(p, ...rest)
    }) as never)
    const scan = await scanStagingRecords(root, st)
    expect(fired).toBe(1)
    expect(scan).toEqual({ ok: false, path: st, errno: 'EACCES' })
  })

  it('an entry that disappears between the listing and the lstat (ENOENT) is skipped', async () => {
    const { root, st } = layout()
    putValid(root, st, GOOD)
    const real = fs.promises.readdir.bind(fs.promises)
    let fired = 0
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: unknown, ...rest: unknown[]) => {
      const names = (await (real as (...a: unknown[]) => Promise<string[]>)(p, ...rest)) as string[]
      if (p === st) {
        fired++
        return [...names, 'vanished']
      }
      return names
    }) as never)
    const scan = okScan(await scanStagingRecords(root, st))
    expect(fired).toBe(1)
    expect(fs.existsSync(path.join(st, 'vanished'))).toBe(false)
    expect(scan.pending.map((r) => r.opId)).toEqual([GOOD])
    expect(scan.unreadable).toEqual([])
  })

  it('an lstat failure other than ENOENT is { ok: false } naming that entry', async () => {
    const { root, st } = layout()
    putValid(root, st, GOOD)
    putValid(root, st, 'd'.repeat(32))
    const target = path.join(st, 'd'.repeat(32))
    const real = fs.promises.lstat.bind(fs.promises)
    let fired = 0
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: unknown, ...rest: unknown[]) => {
      if (p === target) {
        fired++
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      }
      return (real as (...a: unknown[]) => unknown)(p, ...rest)
    }) as never)
    const scan = await scanStagingRecords(root, st)
    expect(fired).toBe(1)
    expect(scan).toEqual({ ok: false, path: target, errno: 'EACCES' })
  })
})

describe('scanStagingRecords: a record written by the real writer', () => {
  it('a stopped run keeps a record the scan returns as pending, beside a corrupt one', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    p.manifest.preCommitError = new Error('manifest lock lost')
    const { result } = await run(p)
    expect(result).toMatchObject({ status: 'stopped', opId: OP_ID })
    const recordPath = path.join(fx.opDir, 'record.json')
    expect(fs.existsSync(recordPath)).toBe(true)
    // A corrupt record next to it must not hide it.
    put(fx.staging, BAD, '{ corrupt')

    const scan = okScan(await scanStagingRecords(fx.skillsDir, fx.staging))
    expect(scan.pending).toEqual([
      { opId: OP_ID, path: recordPath, comparedPath: fx.realDir, realDir: fx.realDir },
    ])
    expect(scan.unreadable.map((u) => u.opId)).toEqual([BAD])
    expect(isSwapRecord(JSON.parse(fs.readFileSync(recordPath, 'utf8')))).toBe(true)
  })

  it('a committed run left incomplete keeps a record the scan returns as pending', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const { result } = await run(p, {
      hooks: { afterCommit: () => fs.writeFileSync(path.join(fx.opDir, 'stray.txt'), 'stray') },
    })
    expect(result).toMatchObject({ status: 'committed', incomplete: { step: 'cleanup' } })
    const neighbour = 'f'.repeat(32)
    putValid(fx.skillsDir, fx.staging, neighbour, 'another-skill')

    const scan = okScan(await scanStagingRecords(fx.skillsDir, fx.staging))
    expect(scan.pending.map((r) => r.opId).sort()).toEqual([neighbour, OP_ID].sort())
    const mine = scan.pending.find((r) => r.opId === OP_ID)
    expect(mine).toMatchObject({ realDir: fx.realDir, comparedPath: fx.realDir })
    expect(scan.unreadable).toEqual([])
  })
})

describe('recordsNaming', () => {
  const rec = (opId: string, realDir: string, comparedPath: string): PendingRecord => ({
    opId,
    path: `/st/${opId}/record.json`,
    realDir,
    comparedPath,
  })
  const pending = [
    rec('r', '/r/skill', '/r/skill'),
    rec('x', '/other/real', '/r/linked'),
    rec('y', '/r/skill2', '/r/skill2'),
  ]

  it("matches a record's realDir against the target's realDir", () => {
    expect(
      recordsNaming(pending, { realDir: '/r/skill', comparedPath: '/r/nothing' }).map((r) => r.opId)
    ).toEqual(['r'])
  })

  it("matches a record's comparedPath against the target's comparedPath", () => {
    expect(
      recordsNaming(pending, { realDir: '/r/nothing', comparedPath: '/r/linked' }).map(
        (r) => r.opId
      )
    ).toEqual(['x'])
  })

  it("matches across fields: the target's comparedPath against a record's realDir", () => {
    expect(
      recordsNaming(pending, { realDir: '/r/nothing', comparedPath: '/other/real' }).map(
        (r) => r.opId
      )
    ).toEqual(['x'])
  })

  it("matches across fields: the target's realDir against a record's comparedPath", () => {
    expect(
      recordsNaming(pending, { realDir: '/r/linked', comparedPath: '/r/nothing' }).map(
        (r) => r.opId
      )
    ).toEqual(['x'])
  })

  it('names nothing for a different folder', () => {
    expect(recordsNaming(pending, { realDir: '/r/else', comparedPath: '/r/else' })).toEqual([])
  })

  it('does not match a path that merely shares a prefix', () => {
    const only = [rec('r', '/r/skill', '/r/skill')]
    expect(recordsNaming(only, { realDir: '/r/skill2', comparedPath: '/r/skill2' })).toEqual([])
    expect(recordsNaming(only, { realDir: '/r/skil', comparedPath: '/r/skil' })).toEqual([])
    // Control: the same call with the exact name does match.
    expect(
      recordsNaming(only, { realDir: '/r/skill', comparedPath: '/r/skill' }).map((r) => r.opId)
    ).toEqual(['r'])
  })
})
