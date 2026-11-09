/**
 * SMI-6531 (A1 step 6c-i, adversarial-review fixes, owner decisions 2026-11-07):
 *  - every entry directly in S that is not prune's own metadata is checked; an
 *    unapproved one is kept, with the sidecar and the inventory beside it;
 *  - an entry that appears in a directory after the walk read it is reported;
 *  - the inventory is bound to its run by the `deleting` marker (the run ID
 *    and the inventory's digest), and a resume is offered and accepted only
 *    when the intent, the marker and the inventory agree;
 *  - the sidecar is deleted only when it matches its row;
 *  - the listing's intent/inventory leaf check;
 *  - a real reused inode is kept, not taken for its approved row.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { parseInventoryStrict } from '../../../src/install/prune.inventory.js'
import type { ResumeJob } from '../../../src/install/prune.job.js'
import { inspectLeftover } from '../../../src/install/prune.leftovers.js'
import type { StagedItem } from '../../../src/install/prune.leftovers.js'
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
import type { PruneFixture, WalkRun } from './prune.walk.helpers.js'

let f: PruneFixture | null = null
afterEach(() => {
  if (f !== null) removeFixture(f)
  f = null
})
const fixture = (prefix: string): PruneFixture => (f = makeParent(prefix))
const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex')
const kept = (run: WalkRun): { path: string; rel: string | null; why: string }[] =>
  (run.item?.kept ?? []) as { path: string; rel: string | null; why: string }[]
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

/** Rewrites S's inventory without its top.txt row, and (optionally) the marker to match it. */
function replaceInventory(S: string, { fixMarker }: { fixMarker: boolean }): void {
  const o = JSON.parse(fs.readFileSync(path.join(S, 'inventory.json'), 'utf8')) as {
    rows: { rel: string }[]
    rowCount: number
  }
  o.rows = o.rows.filter((r) => r.rel !== 'top.txt')
  o.rowCount = o.rows.length
  const bytes = Buffer.from(JSON.stringify(o))
  if (parseInventoryStrict(bytes) === null) throw new Error('precondition: replacement invalid')
  fs.unlinkSync(path.join(S, 'inventory.json'))
  fs.writeFileSync(path.join(S, 'inventory.json'), bytes)
  if (fixMarker) rewriteMarker(S, { inventorySha256: sha(bytes) })
}

function rewriteMarker(S: string, over: Record<string, unknown>): void {
  const m = JSON.parse(fs.readFileSync(path.join(S, 'deleting'), 'utf8')) as Record<string, unknown>
  fs.unlinkSync(path.join(S, 'deleting'))
  fs.writeFileSync(path.join(S, 'deleting'), JSON.stringify({ ...m, ...over }))
}

describe('Major 1: every entry directly in S is checked', () => {
  it('a file and a directory placed in S after the inventory are kept, with the sidecar and inventory', () => {
    const fx = fixture('prune-top-')
    const c = parkCopy(fx.parent, 't')
    const after = { when: 'after' as const, fn: 'writeFileSync', a0Re: '/deleting$' }
    const run = runWalker(jobFor(c), {
      traceDir: fx.root,
      hooks: [
        { ...after, action: { kind: 'writeBeside', name: 'stray.txt', data: 'stray-bytes' } },
        { ...after, action: { kind: 'mkdirBeside', name: 'stray-dir', data: 'inside-bytes' } },
      ],
    })
    expect(fired(run, 'writeBeside') && fired(run, 'mkdirBeside')).toBe(true)
    expect(statusOf(run)).toBe('stopped/unapproved-kept')
    const S = String(run.item?.stagingPath)
    const stray = path.join(S, 'stray.txt')
    const dir = path.join(S, 'stray-dir')
    expect(kept(run).map((k) => [k.path, k.rel])).toEqual([
      [dir, null],
      [stray, null],
    ])
    expect([read(stray), read(path.join(dir, 'inside.txt'))]).toEqual([
      'stray-bytes',
      'inside-bytes',
    ])
    expect([exists(path.join(S, 'sidecar.json')), exists(path.join(S, 'inventory.json'))]).toEqual([
      true,
      true,
    ])
    expect(exists(path.join(S, c.name))).toBe(false)
  })

  it('the listing agrees, and a resume keeps them too', () => {
    const fx = fixture('prune-top2-')
    const c = parkCopy(fx.parent, 't')
    const S = stagedWithInventory(c)
    fs.writeFileSync(path.join(S, 'stray.txt'), 'stray-bytes')
    fs.mkdirSync(path.join(S, 'stray-dir'))
    const left = inspectLeftover({ S, stagingRoot: c.stagingRoot })
    const strays = [path.join(S, 'stray-dir'), path.join(S, 'stray.txt')]
    expect(left.unapproved.map((u) => u.path)).toEqual(strays)
    const run = runWalker(jobOfItem(left.item!))
    expect(statusOf(run)).toBe('stopped/unapproved-kept')
    expect(kept(run).map((k) => k.path)).toEqual(strays)
    expect([exists(path.join(S, 'sidecar.json')), exists(path.join(S, 'inventory.json'))]).toEqual([
      true,
      true,
    ])
  })

  it('a finished leftover with a stray in S keeps its inventory out of the cleanup', () => {
    const fx = fixture('prune-fin-')
    const c = parkCopy(fx.parent, 't')
    // Crash after the sidecar's unlink (the last delete), before P4g.
    const run0 = runWalker(jobFor(c), {
      hooks: [
        {
          when: 'after',
          fn: 'unlinkSync',
          a0Re: '^\\.d-',
          armedBy: { fn: 'renameSync', a0Re: '^sidecar\\.json$' },
          action: { kind: 'kill' },
        },
      ],
    })
    expect(run0.signal).toBe('SIGKILL')
    const [S] = stagingDirs(c.stagingRoot)
    expect(inspectLeftover({ S: S!, stagingRoot: c.stagingRoot }).cleanup).toEqual([
      'deleting',
      'intent.json',
      'inventory.json',
    ])
    fs.writeFileSync(path.join(S!, 'stray.txt'), 'stray-bytes')
    const left = inspectLeftover({ S: S!, stagingRoot: c.stagingRoot })
    expect([left.state, left.cleanup]).toEqual(['finished', ['deleting', 'intent.json']])
    expect(left.unapproved.map((u) => u.path)).toEqual([path.join(S!, 'stray.txt')])
  })

  it('an entry created in a directory after the walk read it is reported, and keeps the sidecar', () => {
    const fx = fixture('prune-late-')
    const c = parkCopy(fx.parent, 't', { extraDirs: 1 })
    // The first unlink is d000's f0.txt, at its random name, with d000 as the cwd.
    const run = runWalker(jobFor(c), {
      traceDir: fx.root,
      hooks: [
        {
          when: 'after',
          fn: 'unlinkSync',
          a0Re: '^\\.d-',
          nth: 1,
          action: { kind: 'writeRel', name: 'late.txt', data: 'late-bytes' },
        },
      ],
    })
    expect(fired(run, 'writeRel')).toBe(true)
    expect(statusOf(run)).toBe('stopped/unapproved-kept')
    const k = kept(run)
    expect(k.map((e) => [path.basename(e.path), e.rel, e.why])).toEqual([
      ['late.txt', null, 'appeared during the walk'],
    ])
    expect(read(k[0]!.path)).toBe('late-bytes')
    expect(exists(path.join(String(run.item?.stagingPath), 'sidecar.json'))).toBe(true)
  })
})

describe('Major 2: the inventory is bound to its run by the deleting marker', () => {
  it('the marker records the run ID the intent and inventory carry, and the inventory digest', () => {
    const fx = fixture('prune-mk-')
    const S = stagedWithInventory(parkCopy(fx.parent, 't'))
    const inv = fs.readFileSync(path.join(S, 'inventory.json'))
    const marker = JSON.parse(read(path.join(S, 'deleting'))) as Record<string, unknown>
    const intent = JSON.parse(read(path.join(S, 'intent.json'))) as { pruneId: string }
    expect(Object.keys(marker).sort()).toEqual(['inventorySha256', 'pid', 'pruneId'])
    expect(marker.inventorySha256).toBe(sha(inv))
    expect([marker.pruneId, intent.pruneId]).toEqual([
      parseInventoryStrict(inv)!.pruneId,
      parseInventoryStrict(inv)!.pruneId,
    ])
  })

  for (const [name, tamper, why] of [
    [
      'an inventory replaced with a different valid one',
      (S: string) => replaceInventory(S, { fixMarker: false }),
      'the inventory is not the one its deleting marker recorded',
    ],
    [
      'a marker whose digest disagrees',
      (S: string) => rewriteMarker(S, { inventorySha256: 'b'.repeat(64) }),
      'the inventory is not the one its deleting marker recorded',
    ],
    [
      'a marker from another run',
      (S: string) => rewriteMarker(S, { pruneId: 'fedcba9876543210' }),
      'the intent, the deleting marker and the inventory are not from one run',
    ],
    [
      'a marker whose pid is not the intent’s',
      (S: string) => {
        const intent = JSON.parse(read(path.join(S, 'intent.json'))) as { pid: number }
        rewriteMarker(S, { pid: intent.pid + 1 })
      },
      'the deleting marker was not written by the process that wrote the intent',
    ],
  ] as const) {
    it(`${name}: no resume offered, and a forced resume deletes nothing`, () => {
      const fx = fixture('prune-bind-')
      const c = parkCopy(fx.parent, 't')
      const S = stagedWithInventory(c)
      expect(inspectLeftover({ S, stagingRoot: c.stagingRoot }).item).toBeDefined()
      tamper(S)
      const left = inspectLeftover({ S, stagingRoot: c.stagingRoot })
      expect([left.state, left.item, left.detail]).toEqual([
        'unknown',
        undefined,
        `${why}; never touched`,
      ])
      const before = snapshotTree(S)
      const run = runWalker(resumeJobAt(S))
      expect(statusOf(run)).toBe('kept/inventory-unbound')
      expect(String(run.item?.detail)).toBe(`${S}: ${why}`)
      expect(snapshotTree(S)).toBe(before)
    })
  }

  it('a missing marker (the crash before it): listed staged, no resume, a forced one deletes nothing', () => {
    const fx = fixture('prune-nomk-')
    const c = parkCopy(fx.parent, 't')
    const run0 = runWalker(jobFor(c), {
      hooks: [
        { when: 'after', fn: 'renameSync', a1Re: '/inventory\\.json$', action: { kind: 'kill' } },
      ],
    })
    expect(run0.signal).toBe('SIGKILL')
    const [S] = stagingDirs(c.stagingRoot)
    expect(exists(path.join(S!, 'deleting'))).toBe(false)
    const left = inspectLeftover({ S: S!, stagingRoot: c.stagingRoot })
    expect([left.state, left.item]).toEqual(['staged', undefined])
    expect(left.detail).toMatch(/the delete never started \(no deleting marker\)/)
    const before = snapshotTree(S!)
    const run = runWalker(resumeJobAt(S!))
    expect(statusOf(run)).toBe('kept/inventory-unbound')
    expect(snapshotTree(S!)).toBe(before)
  })

  it('an inventory and marker replaced together after the job was built: kept/inventory-changed', () => {
    const fx = fixture('prune-jobdig-')
    const c = parkCopy(fx.parent, 't')
    const S = stagedWithInventory(c)
    const job = resumeJobAt(S)
    replaceInventory(S, { fixMarker: true })
    // The pair on disk agrees, so only the job's own digest tells them apart.
    expect(inspectLeftover({ S, stagingRoot: c.stagingRoot }).item).toBeDefined()
    const before = snapshotTree(S)
    const run = runWalker(job)
    expect(statusOf(run)).toBe('kept/inventory-changed')
    expect(snapshotTree(S)).toBe(before)
  })
})

describe('documented residual: ADR-166 D-11 "late staging entry"', () => {
  // An entry created directly in S after the walk's last top-level re-read and
  // before the sidecar's delete is not reported: the sidecar and the inventory
  // go. The entry itself is never deleted, and S is left non-empty and named.
  it('an entry created in S between the last re-read and the sidecar delete survives byte-identical', () => {
    const fx = fixture('prune-late-top-')
    const c = parkCopy(fx.parent, 't')
    // The sidecar's first lstat (cwd S) is its visit, after the top-level re-read.
    const run = runWalker(jobFor(c), {
      traceDir: fx.root,
      hooks: [
        {
          when: 'before',
          fn: 'lstatSync',
          a0Re: '^sidecar\\.json$',
          action: { kind: 'writeRel', name: 'late-top.txt', data: 'late-top-bytes' },
        },
      ],
    })
    expect(fired(run, 'writeRel')).toBe(true)
    expect(statusOf(run)).toBe('removed/null')
    const S = String(run.item?.stagingPath)
    expect(read(path.join(S, 'late-top.txt'))).toBe('late-top-bytes')
    expect(String(run.item?.detail)).toMatch(/staging directory left \(ENOTEMPTY\)/)
    expect(fs.readdirSync(S)).toEqual(['late-top.txt'])
  })
})

describe('the sidecar and the listing leaf check', () => {
  it('a staged sidecar that is no longer its row (a new inode, same bytes) is kept, not deleted', () => {
    const fx = fixture('prune-side-')
    const c = parkCopy(fx.parent, 't')
    const S = stagedWithInventory(c)
    const side = path.join(S, 'sidecar.json')
    const bytes = fs.readFileSync(side)
    // Written beside it first, then renamed over it, so the new inode cannot be the old one.
    fs.writeFileSync(path.join(fx.root, 'side.tmp'), bytes)
    fs.renameSync(path.join(fx.root, 'side.tmp'), side)
    const run = runWalker(resumeJobAt(S))
    expect(statusOf(run)).toBe('stopped/unapproved-kept')
    expect(kept(run).map((k) => [k.path, k.why])).toEqual([[side, 'not the approved inode']])
    expect(fs.readFileSync(side).equals(bytes)).toBe(true)
  })

  it('a skeleton leftover whose intent names another leaf is unknown, never cleaned', () => {
    const fx = fixture('prune-leaf-')
    const c = parkCopy(fx.parent, 't')
    const S = stagedWithInventory(c)
    expect(statusOf(runWalker(resumeJobAt(S)))).toBe('stopped/skeleton-left')
    expect(inspectLeftover({ S, stagingRoot: c.stagingRoot }).state).toBe('skeleton')
    const p = path.join(S, 'intent.json')
    const intent = JSON.parse(read(p)) as { leaf: string; copyPath: string }
    fs.unlinkSync(p)
    fs.writeFileSync(
      p,
      JSON.stringify({ ...intent, leaf: 'other', copyPath: path.join(c.opDir, 'other') }, null, 2)
    )
    const left = inspectLeftover({ S, stagingRoot: c.stagingRoot })
    expect([left.state, left.detail]).toEqual(['unknown', 'the intent and the inventory disagree'])
  })
})

describe('a real reused inode', () => {
  it('a file recreated after a crash, on the deleted approved file’s inode, is kept', (ctx) => {
    const fx = fixture('prune-reuse-')
    const c = parkCopy(fx.parent, 't', { extraDirs: 1 })
    // Crash right after the first unlink: d000's f0.txt, deleted at its random name.
    const run0 = runWalker(jobFor(c), {
      hooks: [
        { when: 'after', fn: 'unlinkSync', a0Re: '^\\.d-', nth: 1, action: { kind: 'kill' } },
      ],
    })
    expect(run0.signal).toBe('SIGKILL')
    const [S] = stagingDirs(c.stagingRoot)
    const inv = parseInventoryStrict(fs.readFileSync(path.join(S!, 'inventory.json')))!
    const row = inv.rows.find((r) => r.rel === 'd000/f0.txt')!
    const rootAt = fs.readdirSync(S!).find((n) => /^\.d-/.test(n))!
    const d000 = fs.readdirSync(path.join(S!, rootAt)).find((n) => /^\.d-/.test(n))!
    const p = path.join(S!, rootAt, d000, 'f0.txt')
    expect(exists(p)).toBe(false)
    fs.writeFileSync(p, 'd0-f0')
    const st = fs.lstatSync(p, { bigint: true })
    if (st.dev !== row.dev || st.ino !== row.ino) {
      ctx.skip(`no inode reuse this run (row ${row.ino}, new ${st.ino})`)
      return
    }
    expect([st.size, read(p)]).toEqual([row.size, 'd0-f0'])
    const left = inspectLeftover({ S: S!, stagingRoot: c.stagingRoot })
    const run = runWalker(jobOfItem(left.item!))
    expect(statusOf(run)).toBe('stopped/unapproved-kept')
    // Which check refuses it depends on whether the birthtime was reused too: identity if not,
    // the metadata (mtime, ctime) if so. Content alone would pass: the bytes are the approved ones.
    const why =
      st.birthtimeNs === row.birthtimeNs
        ? 'changed since it was approved'
        : 'not the approved inode'
    expect(kept(run).map((k) => [k.path, k.rel, k.why])).toEqual([[p, 'd000/f0.txt', why]])
    expect(read(p)).toBe('d0-f0')
  })
})
