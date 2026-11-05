/**
 * SMI-6531 (A1 step 6c-i): the walker's rows from ADR-166 D-11's Wave 5 run,
 * ported from the SMI-6676 spike's `harness/w5-rows-p.mjs` and
 * `w5-rows-p2.mjs`, plus T-K1's "changed trees" and "races" cases at the
 * walker. Every run is the real walker child, on a copy the real park made,
 * with the interposer timing the attack to an exact call.
 *
 * A row whose attack did not land in its window fails on its precondition
 * (`fired`), never passes. Pswap, Pmswap and P2r are measured, not scored
 * (ADR-166 D-11 residuals): they assert only that the attack landed, and
 * report what happened.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { populate } from './park-tree.helpers.js'
import {
  canMount,
  esc,
  exists,
  findIno,
  fired,
  jobFor,
  makeParent,
  parkCopy,
  read,
  removeFixture,
  runWalker,
  snapshotTree,
  stagingDirs,
  statusOf,
} from './prune.walk.helpers.js'
import type { PruneFixture } from './prune.walk.helpers.js'

let f: PruneFixture | null = null
const fixture = (prefix: string): PruneFixture => (f = makeParent(prefix))
afterEach(() => {
  if (f !== null) removeFixture(f)
  f = null
})

describe('the walker removes a clean approved copy (control for every row)', () => {
  it('a clean parked copy and its sidecar are removed, and nothing is left behind', () => {
    const fx = fixture('prune-ok-')
    const c = parkCopy(fx.parent, 'tree')
    const run = runWalker(jobFor(c))
    expect(statusOf(run)).toBe('removed/null')
    expect(run.item?.deleted).toBe(6) // sidecar, link, target/orig-f1, target, top.txt, root
    expect(exists(c.copyPath)).toBe(false)
    expect(exists(c.sidecarPath)).toBe(false)
    expect(stagingDirs(c.stagingRoot)).toEqual([])
    expect(exists(c.opDir)).toBe(false)
  })

  it('a non-clean copy approved only by the batch yes is kept untouched', () => {
    const fx = fixture('prune-verdict-')
    const c = parkCopy(fx.parent, 'tree')
    const before = snapshotTree(c.copyPath)
    const run = runWalker(jobFor(c, { klass: 'changed', authorization: 'batch' }))
    expect(statusOf(run)).toBe('kept/needs-allow-changed')
    expect(snapshotTree(c.copyPath)).toBe(before)
    expect(stagingDirs(c.stagingRoot)).toEqual([])
    // Control: the same copy with a per-item yes is walked.
    const ok = runWalker(jobFor(c, { klass: 'changed', authorization: 'per-item' }))
    expect(statusOf(ok)).toBe('removed/null')
  })
})

describe('T-K1 at the walker: changed trees and swapped directories', () => {
  it('a file edited after listing is held at the staging path, never deleted', () => {
    const fx = fixture('prune-changed-')
    const c = parkCopy(fx.parent, 'tree')
    const job = jobFor(c)
    const edited = path.join(c.copyPath, 'target', 'orig-f1')
    fs.writeFileSync(edited, 'EDITED-after-the-listing')
    const run = runWalker(job)
    expect(statusOf(run)).toBe('held/changed-in-staging')
    const heldAt = String(run.item?.heldPath)
    expect(read(path.join(heldAt, 'target', 'orig-f1'))).toBe('EDITED-after-the-listing')
  })

  it('a copy swapped for a hash-identical directory after listing is kept, the substitute untouched', () => {
    const fx = fixture('prune-swapdir-')
    const c = parkCopy(fx.parent, 'tree')
    const job = jobFor(c)
    const away = path.join(fx.root, 'original-moved-away')
    fs.renameSync(c.copyPath, away)
    populate(c.copyPath) // hash-identical content at a new inode, so only identity can tell
    const sub = snapshotTree(c.copyPath)
    const run = runWalker(job)
    expect(statusOf(run)).toBe('kept/class-worsened')
    expect(exists(c.copyPath) && snapshotTree(c.copyPath)).toBe(sub)
    expect(read(path.join(away, 'top.txt'))).toBe('top-bytes')
  })
})

describe('P2: an fd holder writes before the pre-touch check', () => {
  it('the walk stops, and the fd-written file keeps its bytes', () => {
    const fx = fixture('prune-p2-')
    const c = parkCopy(fx.parent, 't')
    const victim = path.join(c.copyPath, 'target', 'orig-f1')
    const ino = fs.lstatSync(victim, { bigint: true }).ino
    const fd = fs.openSync(victim, 'r+')
    try {
      // Same size, so only the timestamps can tell; the write waits past the
      // verify's timestamp tick (1 ms on overlayfs), since a same-size write
      // inside that tick is the open-descriptor residual P2r measures.
      const data = 'ORIGINAL-CONTENT-F1'
      const run = runWalker(jobFor(c), {
        traceDir: fx.root,
        extraFds: [fd],
        hooks: [
          {
            when: 'before',
            fn: 'lstatSync',
            a0Re: '^orig-f1$',
            action: { kind: 'writeFd', fd: 3, data, pos: 0, waitMs: 3 },
          },
        ],
      })
      expect(fired(run, 'writeFd')).toBe(true)
      expect(statusOf(run)).toBe('stopped/changed-during-delete')
      const found = findIno(c.stagingRoot, ino)
      expect(found !== null && read(found)).toBe(data)
    } finally {
      fs.closeSync(fd)
    }
  })

  it('P2r (measured, not scored): a write after the post-rename lstat', () => {
    const fx = fixture('prune-p2r-')
    const c = parkCopy(fx.parent, 't')
    const victim = path.join(c.copyPath, 'target', 'orig-f1')
    const ino = fs.lstatSync(victim, { bigint: true }).ino
    const fd = fs.openSync(victim, 'r+')
    try {
      const run = runWalker(jobFor(c), {
        traceDir: fx.root,
        extraFds: [fd],
        hooks: [
          {
            when: 'after',
            fn: 'lstatSync',
            a0Re: '^\\.d-',
            a0IsFile: true,
            nth: 2,
            action: { kind: 'writeFd', fd: 3, data: 'ORIGINAL-CONTENT-F1', pos: 0 },
          },
        ],
      })
      expect(fired(run, 'writeFd')).toBe(true)
      const found = findIno(c.stagingRoot, ino)
      console.info(
        `[P2r measured] ${statusOf(run)}; the fd-written file ${found === null ? 'was unlinked (the open-descriptor residual)' : 'survived'}`
      )
    } finally {
      fs.closeSync(fd)
    }
  })
})

describe('P3: the copy path is recreated and written by path after staging', () => {
  it('the new bytes at the copy path survive, and the staged copy is removed', () => {
    const fx = fixture('prune-p3-')
    const c = parkCopy(fx.parent, 't')
    const data = 'new-bytes-written-by-path'
    const run = runWalker(jobFor(c), {
      traceDir: fx.root,
      hooks: [
        {
          when: 'after',
          fn: 'renameSync',
          a0Re: `^${esc(c.copyPath)}$`,
          action: { kind: 'recreate', path: c.copyPath, data },
        },
      ],
    })
    expect(fired(run, 'recreate')).toBe(true)
    expect(statusOf(run)).toBe('removed/null')
    expect(read(path.join(c.copyPath, 'new-user-file.txt'))).toBe(data)
  })
})

describe('P4: an in-tree writer adds a file mid-walk', () => {
  it('the walk stops entry-added-during-delete, and the intruder survives', () => {
    const fx = fixture('prune-p4-')
    const c = parkCopy(fx.parent, 't')
    const run = runWalker(jobFor(c), {
      traceDir: fx.root,
      hooks: [
        {
          when: 'before',
          fn: 'lstatSync',
          a0Re: '^link$',
          action: { kind: 'writeRel', name: 'target/intruder.txt', data: 'intruder-bytes' },
        },
      ],
    })
    expect(fired(run, 'writeRel')).toBe(true)
    expect(statusOf(run)).toBe('stopped/entry-added-during-delete')
    const all = fs.readdirSync(c.stagingRoot, { recursive: true }) as string[]
    const hits = all
      .filter((p) => path.basename(p) === 'intruder.txt')
      .map((p) => read(path.join(c.stagingRoot, p)))
    expect(hits).toEqual(['intruder-bytes'])
  })
})

describe('P7: links are never followed', () => {
  it('outward: a symlink to outside the copy is unlinked, its target untouched', () => {
    const fx = fixture('prune-p7o-')
    const outside = path.join(fx.root, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'sentinel-bytes')
    const c = parkCopy(fx.parent, 't', { outLink: outside })
    const run = runWalker(jobFor(c))
    expect(statusOf(run)).toBe('removed/null')
    expect(read(path.join(outside, 'sentinel.txt'))).toBe('sentinel-bytes')
  })

  it('swap: a directory replaced by a symlink before the walk enters it stops the walk', () => {
    const fx = fixture('prune-p7s-')
    const outside = path.join(fx.root, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'sentinel-bytes')
    const c = parkCopy(fx.parent, 't')
    const run = runWalker(jobFor(c), {
      traceDir: fx.root,
      hooks: [
        {
          when: 'before',
          fn: 'chdir',
          a0Re: '^\\.d-',
          nth: 1,
          action: { kind: 'symlinkSwap', outside, awayDir: fx.root },
        },
      ],
    })
    expect(fired(run, 'symlinkSwap')).toBe(true)
    expect(statusOf(run)).toBe('stopped/mount-appeared-during-delete')
    expect(read(path.join(outside, 'sentinel.txt'))).toBe('sentinel-bytes')
  })
})

describe('P8: the sidecar rewritten in place, same size', () => {
  for (const [variant, hook, want] of [
    [
      '(i) before it is staged',
      {
        when: 'before',
        fn: 'renameSync',
        a1Re: '/sidecar\\.json$',
        action: { kind: 'rewriteInPlace', path: '$a0' },
      },
      'held/sidecar-changed-in-staging',
    ],
    [
      '(ii) after verification',
      {
        when: 'before',
        fn: 'writeFileSync',
        a0Re: '^deleting$',
        action: { kind: 'rewriteInPlace', path: '$cwd/sidecar.json', waitMs: 3 },
      },
      'stopped/changed-during-delete',
    ],
  ] as const) {
    it(`${variant}: ${want}, and the rewritten sidecar survives`, () => {
      const fx = fixture('prune-p8-')
      const c = parkCopy(fx.parent, 't')
      const run = runWalker(jobFor(c), { traceDir: fx.root, hooks: [{ ...hook }] })
      expect(fired(run, 'rewriteInPlace')).toBe(true)
      expect(statusOf(run)).toBe(want)
      const S = String(run.item?.stagingPath)
      expect(read(path.join(S, 'sidecar.json'))).toMatch(/^Z+$/)
    })
  }
})

describe('P9 (R-misplace): an entry swapped between its pre-check and rename', () => {
  it('(i) the replacement is left at a named hidden path, recorded, and never unlinked', () => {
    const fx = fixture('prune-p9-')
    const c = parkCopy(fx.parent, 't')
    const rec = path.join(fx.root, 'hook.json')
    const run = runWalker(jobFor(c), {
      traceDir: fx.root,
      hooks: [
        {
          when: 'before',
          fn: 'renameSync',
          a0Re: '^top\\.txt$',
          a1Re: '^\\.d-',
          action: { kind: 'swap', awayDir: fx.root, data: 'replacement-bytes', recordFile: rec },
        },
      ],
    })
    expect(fired(run, 'swap')).toBe(true)
    const h = JSON.parse(fs.readFileSync(rec, 'utf8')) as { dev: string; ino: string }
    expect(statusOf(run)).toBe('stopped/entry-misplaced')
    const m = run.item?.misplaced as { path: string; originalRel: string; cause: string }[]
    expect(m).toHaveLength(1)
    const at = fs.lstatSync(m[0]!.path, { bigint: true })
    expect(`${at.dev}/${at.ino}`).toBe(`${h.dev}/${h.ino}`)
    expect(read(m[0]!.path)).toBe('replacement-bytes')
    expect([m[0]!.originalRel, m[0]!.cause]).toEqual(['top.txt', 'swapped'])
    const file = JSON.parse(
      fs.readFileSync(path.join(String(run.item?.stagingPath), 'misplaced.json'), 'utf8')
    ) as { path: string }
    expect(file.path).toBe(m[0]!.path)
    const trace = run.trace?.trace ?? []
    const i = trace.findIndex((e) => e.fn === 'renameSync' && e.a0 === 'top.txt')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(
      trace.slice(i + 1).filter((e) => e.fn === 'unlinkSync' && /^\.d-/.test(e.a0 ?? ''))
    ).toEqual([])
  })

  it.skip('(ii) a darwin mount covering the cwd: darwin only (hdiutil); Linux has no cwd-capturing cover', () => {})
})

describe('P1: a mount lands during the prune', () => {
  const MOUNTS = canMount()
  const FILES = { 'orig-f1': 'original-content-f1' }
  for (const [timing, hook, want] of [
    [
      'pre-verify',
      {
        when: 'after',
        fn: 'renameSync',
        a1Re: '/sidecar\\.json$',
        action: { kind: 'mount', baseFromA1Dir: true, files: FILES },
      },
      ['held/mount-in-staging'],
    ],
    [
      'post-verify',
      {
        when: 'before',
        fn: 'writeFileSync',
        a0Re: '^deleting$',
        action: { kind: 'mount', files: FILES },
      },
      ['stopped/mount-appeared-during-delete', 'stopped/entry-misplaced'],
    ],
  ] as const) {
    it.skipIf(!MOUNTS)(
      `tmpfs ${timing}: the mount is never traversed or deleted (needs a tmpfs mount; skipped where the process cannot mount)`,
      () => {
        const fx = fixture('prune-p1-')
        const c = parkCopy(fx.parent, 'm')
        const rec = path.join(fx.root, 'mount.json')
        const action = { ...hook.action, rel: path.join(c.name, 'target'), recordFile: rec }
        try {
          const run = runWalker(jobFor(c), { traceDir: fx.root, hooks: [{ ...hook, action }] })
          expect(fired(run, 'mount')).toBe(true)
          expect(want).toContain(statusOf(run))
          const target = (JSON.parse(fs.readFileSync(rec, 'utf8')) as { target: string }).target
          expect(read(path.join(target, 'orig-f1'))).toBe('original-content-f1')
        } finally {
          if (fs.existsSync(rec)) {
            const target = (JSON.parse(fs.readFileSync(rec, 'utf8')) as { target: string }).target
            execFileSync('umount', [target], { stdio: 'pipe' })
          }
        }
      }
    )
  }
})

describe('R-swap residuals (measured, not scored)', () => {
  it('Pswap: an unapproved file swapped in at the hidden name after the last check', () => {
    const fx = fixture('prune-pswap-')
    const c = parkCopy(fx.parent, 't')
    const rec = path.join(fx.root, 'swap.json')
    const run = runWalker(jobFor(c), {
      traceDir: fx.root,
      hooks: [
        {
          when: 'after',
          fn: 'lstatSync',
          a0Re: '^\\.d-',
          a0IsFile: true,
          nth: 2,
          action: { kind: 'swap', awayDir: fx.root, data: 'victim-bytes', recordFile: rec },
        },
      ],
    })
    expect(fired(run, 'swap')).toBe(true)
    const sw = JSON.parse(fs.readFileSync(rec, 'utf8')) as { replacement: string; away: string }
    console.info(
      `[Pswap measured] ${statusOf(run)}; victim ${read(sw.replacement) === 'victim-bytes' ? 'survived' : 'unlinked (R-swap)'}; approved bytes aside: ${read(sw.away) === 'original-content-f1'}`
    )
  })

  it('Pmswap: a victim swapped in at the random metadata name before its unlink', () => {
    const fx = fixture('prune-pmswap-')
    const c = parkCopy(fx.parent, 't')
    const rec = path.join(fx.root, 'mswap.json')
    const run = runWalker(jobFor(c), {
      traceDir: fx.root,
      hooks: [
        {
          when: 'before',
          fn: 'unlinkSync',
          a0Re: '/\\.m-[0-9a-f]{16}$',
          nth: 1,
          action: { kind: 'swap', awayDir: fx.root, data: 'victim-bytes', recordFile: rec },
        },
      ],
    })
    expect(fired(run, 'swap')).toBe(true)
    const sw = JSON.parse(fs.readFileSync(rec, 'utf8')) as { replacement: string }
    console.info(
      `[Pmswap measured] ${statusOf(run)}; victim ${read(sw.replacement) === 'victim-bytes' ? 'survived' : 'unlinked (R-swap class)'}`
    )
  })
})
