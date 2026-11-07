/**
 * SMI-6531 (A1 step 6c-i, F1 re-derived; owner decision 2026-11-06): prune
 * deletes only approved entries. These tests pin the approved inventory
 * (`prune.inventory.ts`) and the delete rule built on it:
 *  - the schema, the staging record, and the root's and sidecar's parent;
 *  - the write protocol: every durability step that fails deletes nothing;
 *  - the old Majors (M-a, M-b) re-run against the new rule;
 *  - R2: a resume never removes a directory, even an empty matching one;
 *  - the design's mutation set (§6) that no other file pins.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  STAGING_KEY,
  buildInventory,
  parseInventoryStrict,
  serializeInventory,
} from '../../../src/install/prune.inventory.js'
import type { PruneInventory } from '../../../src/install/prune.inventory.js'
import type { ResumeJob } from '../../../src/install/prune.job.js'
import { inspectLeftover } from '../../../src/install/prune.leftovers.js'
import type { StagedItem } from '../../../src/install/prune.leftovers.js'
import { SIDECAR_KEY, rowOf } from '../../../src/install/prune.walk.shared.js'
import type { Inventory } from '../../../src/install/prune.walk.shared.js'
import {
  exists,
  fired,
  jobFor,
  makeParent,
  parkCopy,
  read,
  removeFixture,
  resumeJobAt,
  runWalker,
  snapshotTree,
  stagedWithInventory,
  stagingDirs,
  statusOf,
} from './prune.walk.helpers.js'
import type { Hook, ParkedCopy, PruneFixture, WalkRun } from './prune.walk.helpers.js'

let f: PruneFixture | null = null
afterEach(() => {
  if (f !== null) removeFixture(f)
  f = null
})
const fixture = (prefix: string): PruneFixture => (f = makeParent(prefix))

const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex')
const kept = (run: WalkRun): { path: string; rel: string | null; why: string }[] =>
  (run.item?.kept ?? []) as { path: string; rel: string | null; why: string }[]

/** The resume job the listing's own item names. */
const jobOfItem = (item: StagedItem): ResumeJob => ({
  S: item.S,
  copyPath: item.copyPath,
  leaf: item.leaf,
  klass: 'held',
  authorization: 'per-item',
  stagingRoot: item.stagingRoot,
  opDir: item.opDir,
  inventorySha256: item.inventorySha256,
  inheritedMeta: item.inheritedMeta,
})

/** Every regular file under `abs`, as rel -> bytes. */
function filesUnder(abs: string): Record<string, string> {
  const out: Record<string, string> = {}
  const visit = (rel: string, p: string): void => {
    const st = fs.lstatSync(p)
    if (st.isDirectory()) {
      for (const n of fs.readdirSync(p).sort()) visit(rel ? `${rel}/${n}` : n, path.join(p, n))
    } else if (st.isFile()) out[rel] = fs.readFileSync(p, 'utf8')
  }
  visit('', abs)
  return out
}

describe('the inventory schema', () => {
  /** A one-entry inventory for a root of the given kind, as verification would measure it. */
  function rootInventory(kind: 'dir' | 'file' | 'symlink'): PruneInventory {
    const fx = fixture('prune-inv-schema-')
    const S = path.join(fx.root, '.prune-0123456789abcdef')
    fs.mkdirSync(S, { mode: 0o700 })
    const leaf = path.join(S, 'leaf')
    if (kind === 'dir') fs.mkdirSync(leaf)
    if (kind === 'file') fs.writeFileSync(leaf, 'root-bytes')
    if (kind === 'symlink') fs.symlinkSync('elsewhere', leaf)
    fs.writeFileSync(path.join(S, 'sidecar.json'), '{}')
    const verified: Inventory = new Map()
    verified.set('', {
      ...rowOf(fs.lstatSync(leaf, { bigint: true })),
      ...(kind === 'file' ? { sha256: sha(Buffer.from('root-bytes')) } : {}),
      ...(kind === 'symlink' ? { linkText: 'elsewhere' } : {}),
    })
    verified.set(SIDECAR_KEY, {
      ...rowOf(fs.lstatSync(path.join(S, 'sidecar.json'), { bigint: true })),
      sha256: sha(Buffer.from('{}')),
    })
    return buildInventory({
      pruneId: '0123456789abcdef',
      leaf: 'leaf',
      treeHash: 'a'.repeat(64),
      staging: fs.lstatSync(S, { bigint: true }),
      verified,
    })
  }

  for (const kind of ['dir', 'file', 'symlink'] as const) {
    it(`a ${kind} root round-trips; it and the sidecar are children of the staging record`, () => {
      const inv = rootInventory(kind)
      const back = parseInventoryStrict(serializeInventory(inv))
      expect(back).toEqual(inv)
      const root = back!.rows.find((r) => r.rel === '')!
      const side = back!.rows.find((r) => r.rel === SIDECAR_KEY)!
      expect([root.type, root.parent, side.type, side.parent]).toEqual([
        kind,
        STAGING_KEY,
        'file',
        STAGING_KEY,
      ])
    })
  }

  it('a staged run records S itself as the staging record, read by lstat', () => {
    const fx = fixture('prune-inv-staging-')
    const S = stagedWithInventory(parkCopy(fx.parent, 't'))
    const inv = parseInventoryStrict(fs.readFileSync(path.join(S, 'inventory.json')))!
    const s = fs.lstatSync(S, { bigint: true })
    expect(inv.staging).toEqual({
      dev: s.dev,
      ino: s.ino,
      birthtimeNs: s.birthtimeNs,
      fmt: s.mode & 0o170000n,
      mode: s.mode,
      uid: s.uid,
    })
    expect(inv.rows.filter((r) => r.parent === STAGING_KEY).map((r) => r.rel)).toEqual([
      '',
      SIDECAR_KEY,
    ])
  })

  it('refuses each malformed shape, each named', () => {
    const good = JSON.parse(serializeInventory(rootInventory('dir')).toString('utf8')) as {
      rows: Record<string, unknown>[]
      staging: Record<string, unknown>
      [k: string]: unknown
    }
    const root = good.rows[0]!
    const side = good.rows[1]!
    const sub = { ...root, rel: 'x', parent: '' }
    const fileRow = { ...side, rel: 'f', parent: '', type: 'file' }
    const rows = (rs: unknown[]): unknown => ({ ...good, rows: rs, rowCount: rs.length })
    for (const [bad, why] of [
      [rows([{ ...root, parent: '' }, side]), 'root parent is not S'],
      [rows([root, { ...side, parent: '' }]), 'sidecar parent is not S'],
      [rows([root, { ...side, type: 'dir' }]), 'sidecar not a file'],
      [rows([root, side, fileRow, { ...sub, rel: 'f/y', parent: 'f' }]), 'parent is a file row'],
      [rows([root, side, { ...sub, rel: 'q/y', parent: 'q' }]), 'parent row missing'],
      [rows([root, side, { ...sub, rel: 'a/b', parent: '' }]), 'rel not under parent'],
      [rows([root, side, sub, sub]), 'duplicate rel'],
      [rows([side]), 'no root row'],
      [{ ...good, rowCount: 5 }, 'rowCount mismatch'],
      [{ ...good, staging: { ...good.staging, uid: undefined } }, 'staging record incomplete'],
      [{ ...good, extra: 1 }, 'unknown top-level key'],
      [rows([{ ...root, fmt: String(0o100000) }, side]), 'fmt not the mode type'],
      [rows([root, { ...side, sha256: 'A'.repeat(64) }]), 'sha256 not lowercase hex'],
      [{ ...good, version: 'skillsmith-prune-inventory-0' }, 'unknown version'],
    ] as const) {
      expect(parseInventoryStrict(Buffer.from(JSON.stringify(bad))), why).toBeNull()
    }
  })

  it('a resume into a staging directory that is not the recorded one deletes nothing', () => {
    const fx = fixture('prune-inv-srec-')
    const c = parkCopy(fx.parent, 't')
    const S = stagedWithInventory(c)
    const job = resumeJobAt(S)
    // Same name, mode and owner, same contents and inventory bytes: only S's identity differs.
    const away = path.join(fx.root, 'S-away')
    fs.renameSync(S, away)
    fs.mkdirSync(S, { mode: 0o700 })
    for (const n of fs.readdirSync(away)) fs.renameSync(path.join(away, n), path.join(S, n))
    const before = snapshotTree(S)
    const run = runWalker(job)
    expect(statusOf(run)).toBe('kept/staging-unusable')
    expect(String(run.item?.detail)).toMatch(/not the staging directory the inventory recorded/)
    expect(snapshotTree(S)).toBe(before)
  })
})

describe('the write protocol: a failed durability step deletes nothing', () => {
  const INV_TMP = 'inventory\\.json\\.tmp$'
  // writeFileSync calls writeSync itself, so these count from the inventory temp's open.
  const ARM = { fn: 'openSync', a0Re: INV_TMP }
  const steps: [string, Hook, string, string][] = [
    [
      'open',
      { when: 'before', fn: 'openSync', a0Re: INV_TMP, action: { kind: 'throw', code: 'EACCES' } },
      'open failed (EACCES)',
      'staged',
    ],
    [
      'write',
      {
        when: 'before',
        fn: 'writeSync',
        nth: 1,
        armedBy: ARM,
        action: { kind: 'throw', code: 'ENOSPC' },
      },
      'write failed (ENOSPC)',
      'inventory-partial',
    ],
    [
      'fsync',
      {
        when: 'before',
        fn: 'fsyncSync',
        nth: 1,
        armedBy: ARM,
        action: { kind: 'throw', code: 'EIO' },
      },
      'fsync failed (EIO)',
      'inventory-partial',
    ],
    [
      'rename',
      {
        when: 'before',
        fn: 'renameSync',
        a1Re: '/inventory\\.json$',
        action: { kind: 'throw', code: 'EXDEV' },
      },
      'rename failed (EXDEV)',
      'inventory-partial',
    ],
    [
      'dir-fsync',
      {
        when: 'before',
        fn: 'fsyncSync',
        nth: 2,
        armedBy: ARM,
        action: { kind: 'throw', code: 'EIO' },
      },
      'dir-fsync failed (EIO)',
      'staged',
    ],
  ]
  for (const [step, hook, detail, listed] of steps) {
    it(`${step}: held/inventory-unwritten, the copy and sidecar whole, listed ${listed}`, () => {
      const fx = fixture(`prune-inv-${step}-`)
      const c = parkCopy(fx.parent, 't')
      const tree = filesUnder(c.copyPath)
      const sidecar = fs.readFileSync(c.sidecarPath)
      const run = runWalker(jobFor(c), { hooks: [hook], traceDir: fx.root })
      expect(fired(run, 'throw')).toBe(true)
      expect(statusOf(run)).toBe('held/inventory-unwritten')
      expect(String(run.item?.detail)).toBe(`${detail}; nothing was deleted`)
      const S = String(run.item?.stagingPath)
      expect(filesUnder(path.join(S, c.name))).toEqual(tree)
      expect(fs.readFileSync(path.join(S, 'sidecar.json')).equals(sidecar)).toBe(true)
      const trace = run.trace?.trace ?? []
      expect(trace.filter((e) => e.fn === 'unlinkSync' || e.fn === 'rmdirSync')).toEqual([])
      const left = inspectLeftover({ S, stagingRoot: c.stagingRoot })
      expect(left.state).toBe(listed)
      expect(left.item).toBeUndefined()
    })
  }

  // R4 is superseded by the run binding (owner decision 2026-11-07): a complete
  // inventory with no deleting marker is never resumed; the copy is restored instead.
  it('dir-fsync: the complete inventory has no marker, so no resume, and a forced one deletes nothing', () => {
    const fx = fixture('prune-inv-r4-')
    const c = parkCopy(fx.parent, 't')
    const hook = steps[4]![1]
    const first = runWalker(jobFor(c), { hooks: [hook] })
    expect(statusOf(first)).toBe('held/inventory-unwritten')
    const S = String(first.item?.stagingPath)
    expect(parseInventoryStrict(fs.readFileSync(path.join(S, 'inventory.json')))).not.toBeNull()
    const left = inspectLeftover({ S, stagingRoot: c.stagingRoot })
    expect([left.state, left.item]).toEqual(['staged', undefined])
    const before = snapshotTree(S)
    const run = runWalker(resumeJobAt(S))
    expect(statusOf(run)).toBe('kept/inventory-unbound')
    expect(snapshotTree(S)).toBe(before)
  })

  for (const [name, hook] of [
    ['after the temp open', { when: 'after', fn: 'openSync', a0Re: INV_TMP }],
    ['after the write', { when: 'after', fn: 'writeSync', nth: 1, armedBy: ARM }],
    ['after the fsync', { when: 'after', fn: 'fsyncSync', nth: 1, armedBy: ARM }],
  ] as const) {
    it(`a crash ${name} leaves inventory-partial, never resumable, nothing deleted`, () => {
      const fx = fixture('prune-inv-crash-')
      const c = parkCopy(fx.parent, 't')
      const tree = filesUnder(c.copyPath)
      const run = runWalker(jobFor(c), { hooks: [{ ...hook, action: { kind: 'kill' } } as Hook] })
      expect(run.signal).toBe('SIGKILL')
      const [S] = stagingDirs(c.stagingRoot)
      expect(filesUnder(path.join(S!, c.name))).toEqual(tree)
      const left = inspectLeftover({ S: S!, stagingRoot: c.stagingRoot })
      expect([left.state, left.item]).toEqual(['inventory-partial', undefined])
    })
  }

  it('the rename never replaces an inventory.json already there: held, the planted file intact', () => {
    const fx = fixture('prune-inv-noreplace-')
    const c = parkCopy(fx.parent, 't')
    const tree = filesUnder(c.copyPath)
    const run = runWalker(jobFor(c), {
      traceDir: fx.root,
      hooks: [
        {
          when: 'after',
          fn: 'openSync',
          a0Re: INV_TMP,
          action: { kind: 'writeBeside', name: 'inventory.json', data: 'planted' },
        },
      ],
    })
    expect(fired(run, 'writeBeside')).toBe(true)
    expect(statusOf(run)).toBe('held/inventory-unwritten')
    expect(String(run.item?.detail)).toBe('rename failed (EEXIST); nothing was deleted')
    const S = String(run.item?.stagingPath)
    expect(read(path.join(S, 'inventory.json'))).toBe('planted')
    expect(filesUnder(path.join(S, c.name))).toEqual(tree)
  })
})

/** The P9 swap: top.txt replaced between its check and its rename; the replacement is kept at a `.d-` name. */
function p9(c: ParkedCopy, root: string): { run: WalkRun; S: string; R: string } {
  const run = runWalker(jobFor(c), {
    traceDir: root,
    hooks: [
      {
        when: 'before',
        fn: 'renameSync',
        a0Re: '^top\\.txt$',
        a1Re: '^\\.d-',
        action: { kind: 'swap', awayDir: root, data: 'replacement-bytes' },
      },
    ],
  })
  if (!fired(run, 'swap') || statusOf(run) !== 'stopped/unapproved-kept') {
    throw new Error(`precondition: P9 did not keep the replacement (${statusOf(run)})`)
  }
  return { run, S: String(run.item?.stagingPath), R: kept(run)[0]!.path }
}

describe('the old Majors, against the approved inventory', () => {
  it('M-a: a replacement moved out and back into the tree, at its old name, is kept by a resume', () => {
    const fx = fixture('prune-ma-')
    const c = parkCopy(fx.parent, 't')
    const { S, R } = p9(c, fx.root)
    const out = path.join(fx.root, 'R-out')
    fs.renameSync(R, out)
    const back = path.join(path.dirname(R), 'top.txt')
    fs.renameSync(out, back)
    const left = inspectLeftover({ S, stagingRoot: c.stagingRoot })
    expect(left.unapproved.map((u) => [u.path, u.why])).toEqual([[back, 'not the approved inode']])
    const run = runWalker(jobOfItem(left.item!))
    expect(statusOf(run)).toBe('stopped/unapproved-kept')
    expect(kept(run).map((k) => [k.path, k.rel])).toEqual([[back, 'top.txt']])
    expect(read(back)).toBe('replacement-bytes')
  })

  it('M-a: moved back at its random name instead, it is still kept', () => {
    const fx = fixture('prune-ma2-')
    const c = parkCopy(fx.parent, 't')
    const { S, R } = p9(c, fx.root)
    const out = path.join(fx.root, 'R-out')
    fs.renameSync(R, out)
    fs.renameSync(out, R)
    const run = runWalker(resumeJobAt(S))
    expect(statusOf(run)).toBe('stopped/unapproved-kept')
    expect(kept(run).map((k) => k.path)).toEqual([R])
    expect(read(R)).toBe('replacement-bytes')
  })

  it('M-b: nothing is written about the swapped entry, so no failed write can lose it', () => {
    const fx = fixture('prune-mb-')
    const c = parkCopy(fx.parent, 't')
    const { run, S, R } = p9(c, fx.root)
    const trace = run.trace?.trace ?? []
    const i = trace.findIndex((e) => e.fn === 'renameSync' && e.a0 === 'top.txt')
    const writes = trace
      .slice(i + 1)
      .filter((e) => /^(writeFileSync|openSync|writeSync|appendFileSync)$/.test(e.fn))
    expect(writes).toEqual([])
    const again = runWalker(resumeJobAt(S))
    expect(statusOf(again)).toBe('stopped/unapproved-kept')
    expect(read(R)).toBe('replacement-bytes')
  })
})

describe('R2: a resume never removes a directory', () => {
  it('directories at their original names stay, each reported; every approved file goes', () => {
    const fx = fixture('prune-r2-')
    const c = parkCopy(fx.parent, 't', { extraDirs: 2 })
    const S = stagedWithInventory(c)
    const run = runWalker(resumeJobAt(S), { traceDir: fx.root })
    expect(statusOf(run)).toBe('stopped/skeleton-left')
    const root = path.join(S, c.name)
    const dirs = ['d000', 'd001', 'target'].map((d) => path.join(root, d))
    expect([...(run.item?.skeletons as string[])].sort()).toEqual([root, ...dirs].sort())
    expect(fs.readdirSync(root).sort()).toEqual(['d000', 'd001', 'target'])
    for (const d of dirs) expect(fs.readdirSync(d)).toEqual([])
    expect((run.trace?.trace ?? []).filter((e) => e.fn === 'rmdirSync')).toEqual([])
    const left = inspectLeftover({ S, stagingRoot: c.stagingRoot })
    expect([left.state, left.item, left.skeletons?.length]).toEqual(['skeleton', undefined, 4])
  })

  it('an empty directory whose row matches is not removed by a forced resume', () => {
    const fx = fixture('prune-r2e-')
    const c = parkCopy(fx.parent, 't')
    const S = stagedWithInventory(c)
    expect(statusOf(runWalker(resumeJobAt(S)))).toBe('stopped/skeleton-left')
    const run = runWalker(resumeJobAt(S), { traceDir: fx.root })
    expect(statusOf(run)).toBe('stopped/skeleton-left')
    expect((run.trace?.trace ?? []).filter((e) => e.fn === 'rmdirSync')).toEqual([])
    expect(exists(path.join(S, c.name, 'target'))).toBe(true)
  })
})

describe('the mutation set (§6)', () => {
  it('3: a resume compares content; an in-place rewrite with mtime restored is kept', () => {
    const fx = fixture('prune-m3-')
    const c = parkCopy(fx.parent, 't')
    const S = stagedWithInventory(c)
    const job = resumeJobAt(S)
    // A crash left top.txt at a random name, where ctime is not compared (our own rename moved it).
    const at = path.join(S, c.name, '.d-0123456789abcdef')
    fs.renameSync(path.join(S, c.name, 'top.txt'), at)
    const ref = path.join(fx.root, 'ref')
    execFileSync('cp', ['--preserve=timestamps', at, ref])
    const before = fs.lstatSync(at, { bigint: true })
    const fd = fs.openSync(at, 'r+')
    fs.writeSync(fd, Buffer.from('TOP-BYTES'), 0, 9, 0)
    fs.closeSync(fd)
    execFileSync('touch', ['-m', '-r', ref, at])
    const after = fs.lstatSync(at, { bigint: true })
    expect([after.size, after.mtimeNs]).toEqual([before.size, before.mtimeNs])
    const run = runWalker(job)
    expect(statusOf(run)).toBe('stopped/unapproved-kept')
    expect(kept(run).map((k) => [k.path, k.why])).toEqual([
      [at, 'its content is not the approved content'],
    ])
    expect(read(at)).toBe('TOP-BYTES')
  })

  it('6: a row matches one entry per run; a second link to its inode is kept', () => {
    const fx = fixture('prune-m6-')
    const c = parkCopy(fx.parent, 't')
    const S = stagedWithInventory(c)
    const dir = path.join(S, c.name, 'target')
    const a = path.join(dir, '.d-aaaaaaaaaaaaaaaa')
    const b = path.join(dir, '.d-bbbbbbbbbbbbbbbb')
    fs.renameSync(path.join(dir, 'orig-f1'), a)
    fs.linkSync(a, b)
    const ino = fs.lstatSync(a, { bigint: true }).ino
    const run = runWalker(resumeJobAt(S))
    expect(statusOf(run)).toBe('stopped/unapproved-kept')
    expect(exists(a)).toBe(false)
    expect(kept(run).map((k) => [k.path, k.why])).toEqual([[b, 'not in the approved inventory']])
    expect([read(b), fs.lstatSync(b, { bigint: true }).ino]).toEqual(['original-content-f1', ino])
  })

  it('7: an approved file moved into another approved directory, at a random name, is kept', () => {
    const fx = fixture('prune-m7-')
    const c = parkCopy(fx.parent, 't', { extraDirs: 2 })
    const S = stagedWithInventory(c)
    const to = path.join(S, c.name, 'd001', '.d-0123456789abcdef')
    fs.renameSync(path.join(S, c.name, 'd000', 'f0.txt'), to)
    const run = runWalker(resumeJobAt(S))
    expect(statusOf(run)).toBe('stopped/unapproved-kept')
    expect(kept(run).map((k) => [k.path, k.why])).toEqual([[to, 'not in the approved inventory']])
    expect(read(to)).toBe('d0-f0')
  })

  it('2: a directory swapped for a look-alike on a resume stops the walk before entering it', () => {
    const fx = fixture('prune-m2-')
    const c = parkCopy(fx.parent, 't')
    const S = stagedWithInventory(c)
    const target = path.join(S, c.name, 'target')
    fs.renameSync(target, path.join(fx.root, 'target-away'))
    fs.mkdirSync(target)
    execFileSync('cp', ['-p', path.join(fx.root, 'target-away', 'orig-f1'), target])
    const run = runWalker(resumeJobAt(S), { traceDir: fx.root })
    expect(statusOf(run)).toBe('stopped/mount-appeared-during-delete')
    expect(String(run.item?.detail)).toBe('target: directory identity changed')
    expect((run.trace?.trace ?? []).filter((e) => e.fn === 'chdir' && e.a0 === 'target')).toEqual(
      []
    )
    expect(read(path.join(target, 'orig-f1'))).toBe('original-content-f1')
  })
})
