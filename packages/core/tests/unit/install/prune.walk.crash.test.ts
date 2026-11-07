/**
 * SMI-6531 (A1 step 6c-i): crash recovery (ADR-166 D-11, spike row P5), under
 * the approved-inventory rule (F1, owner decision 2026-11-06). The walker
 * child is SIGKILLed at each step, the leftover it leaves is inspected
 * read-only (`inspectLeftover`), and only a leftover holding the inventory is
 * resumed. A resume deletes only approved entries and never removes a
 * directory (R2), so a crash before the walk finished its directories leaves
 * empty skeletons, which the listing reports.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectLeftover } from '../../../src/install/prune.leftovers.js'
import type { Leftover } from '../../../src/install/prune.leftovers.js'
import { removeIfIdentical } from '../../../src/install/prune.metadata.js'
import {
  exists,
  jobFor,
  makeParent,
  parkCopy,
  read,
  removeFixture,
  resumeJobAt,
  runWalker,
  snapshotTree,
  stagingDirs,
  statusOf,
} from './prune.walk.helpers.js'
import type { Hook, ParkedCopy, PruneFixture } from './prune.walk.helpers.js'

let f: PruneFixture | null = null
afterEach(() => {
  if (f !== null) removeFixture(f)
  f = null
})

/** After the crash: what the listing says, and what a confirmed resume (if offered) ends as. */
type Point = Omit<Hook, 'action'> & {
  expect: Leftover['state']
  resumed?: string
  cleanup?: (string | RegExp)[]
}
// The fixture walks in this order: root (renamed), d000 (4 files, rmdir 1),
// d001 (4 files, rmdir 2), link, target (orig-f1, rmdir 3), top.txt, root
// rmdir (4); then the sidecar (unlink 12); then P4g: deleting, intent, inventory.
const POINTS: Record<string, Point> = {
  'after-P4b': {
    when: 'after',
    fn: 'mkdirSync',
    a0Re: '\\.prune-[0-9a-f]{16}$',
    expect: 'empty',
    cleanup: [],
  },
  'after-P4c-temp': {
    when: 'after',
    fn: 'writeFileSync',
    a0Re: 'intent\\.json\\.tmp$',
    expect: 'partial-intent',
    cleanup: ['intent.json.tmp'],
  },
  'after-P4c': {
    when: 'after',
    fn: 'renameSync',
    a1Re: '/intent\\.json$',
    expect: 'intent-only',
    cleanup: ['intent.json'],
  },
  // No inventory yet: never resumed as a delete.
  'after-P4d': {
    when: 'after',
    fn: 'renameSync',
    a0Re: '/op-',
    a1Re: '\\.prune-[0-9a-f]{16}/[^/]+$',
    expect: 'staged',
  },
  "after-P4d'": { when: 'after', fn: 'renameSync', a1Re: '/sidecar\\.json$', expect: 'staged' },
  // Inventory written, nothing deleted: the resume deletes every file, and leaves every directory (R2).
  'after-inventory': {
    when: 'after',
    fn: 'renameSync',
    a1Re: '/inventory\\.json$',
    expect: 'staged',
    resumed: 'stopped/skeleton-left',
  },
  'during-P4f': {
    when: 'after',
    fn: 'unlinkSync',
    a0Re: '^\\.d-',
    nth: 4,
    expect: 'interrupted-delete',
    resumed: 'stopped/skeleton-left',
  },
  // The tree is gone; the sidecar, deleted last, is not yet.
  'after-P4f': {
    when: 'after',
    fn: 'rmdirSync',
    a0Re: '^\\.d-',
    nth: 4,
    expect: 'interrupted-delete',
    resumed: 'removed/null',
  },
  'mid-sidecar-delete': {
    when: 'after',
    fn: 'renameSync',
    a0Re: '^sidecar\\.json$',
    a1Re: '^\\.d-',
    expect: 'interrupted-delete',
    resumed: 'removed/null',
  },
  'after-sidecar': {
    when: 'after',
    fn: 'unlinkSync',
    a0Re: '^\\.d-',
    nth: 12,
    expect: 'finished',
    cleanup: ['deleting', 'intent.json', 'inventory.json'],
  },
  'mid-P4g-rename': {
    when: 'after',
    fn: 'renameSync',
    a1Re: '/\\.m-[0-9a-f]{16}$',
    nth: 1,
    expect: 'finished',
    cleanup: [/^\.m-[0-9a-f]{16}$/, 'intent.json', 'inventory.json'],
  },
  'after-P4g-deleting': {
    when: 'after',
    fn: 'unlinkSync',
    a0Re: '/\\.m-[0-9a-f]{16}$',
    nth: 1,
    expect: 'finished',
    cleanup: ['intent.json', 'inventory.json'],
  },
  'after-P4g-intent': {
    when: 'after',
    fn: 'unlinkSync',
    a0Re: '/\\.m-[0-9a-f]{16}$',
    nth: 2,
    expect: 'finished',
    cleanup: ['inventory.json'],
  },
}

/** Kills the walker at `point`; returns the copy and its one leftover. */
function crashAt(point: Point): { c: ParkedCopy; S: string; left: Leftover } {
  f = makeParent('prune-p5-')
  const c = parkCopy(f.parent, 'k', { extraDirs: 2 })
  const { expect: _e, resumed: _r, cleanup: _c, ...h } = point
  void _e
  void _r
  void _c
  const run = runWalker(jobFor(c), { hooks: [{ ...h, action: { kind: 'kill' } }] })
  if (run.signal !== 'SIGKILL') throw new Error(`precondition: no crash (${statusOf(run)})`)
  const dirs = stagingDirs(c.stagingRoot)
  if (dirs.length !== 1) throw new Error(`precondition: ${dirs.length} staging dirs`)
  const S = dirs[0] as string
  const snap = snapshotTree(S)
  const left = inspectLeftover({ S, stagingRoot: c.stagingRoot })
  if (snapshotTree(S) !== snap) throw new Error('inspectLeftover changed the leftover')
  return { c, S, left }
}

describe('P5: a SIGKILL at each step leaves a leftover the listing classifies, and only an inventory resumes', () => {
  for (const [name, point] of Object.entries(POINTS)) {
    it(`${name}: reads ${point.expect}${point.resumed ? `, and resumes to ${point.resumed}` : ''}`, () => {
      const { c, S, left } = crashAt(point)
      expect(left.state).toBe(point.expect)
      expect(left.unapproved).toEqual([])
      if (point.resumed === undefined) {
        expect(left.item).toBeUndefined()
      } else {
        expect(left.item?.inventorySha256).toMatch(/^[0-9a-f]{64}$/)
        const run = runWalker(resumeJobAt(S))
        expect(statusOf(run)).toBe(point.resumed)
        if (point.resumed === 'removed/null') expect(exists(S)).toBe(false)
        else {
          // Every file is gone; only directories are left, and the listing names them.
          const after = inspectLeftover({ S, stagingRoot: c.stagingRoot })
          expect(after.state).toBe('skeleton')
          expect(after.skeletons?.length).toBeGreaterThan(0)
          expect(after.remaining ?? []).toEqual([])
          for (const d of after.skeletons ?? [])
            expect(
              fs.readdirSync(d).every((n) => fs.lstatSync(path.join(d, n)).isDirectory())
            ).toBe(true)
        }
      }
      if (point.cleanup !== undefined) {
        const got = left.cleanup ?? []
        expect(got).toHaveLength(point.cleanup.length)
        point.cleanup.forEach((w, i) =>
          typeof w === 'string' ? expect(got[i]).toBe(w) : expect(got[i]).toMatch(w)
        )
        for (const m of got) {
          expect(removeIfIdentical(path.join(S, m), left.meta?.[m])).toEqual({ removed: true })
        }
        fs.rmdirSync(S)
        expect(stagingDirs(c.stagingRoot)).toEqual([])
      }
      if (['empty', 'intent-only', 'partial-intent'].includes(point.expect)) {
        // The copy was never staged: it is still whole where it was parked.
        expect(read(path.join(c.copyPath, 'top.txt'))).toBe('top-bytes')
      } else {
        expect(exists(c.copyPath)).toBe(false)
      }
      if (point.expect === 'staged' && point.resumed === undefined) {
        // Staged before the inventory: whole in S, and not offered for a delete.
        expect(read(path.join(S, c.name, 'top.txt'))).toBe('top-bytes')
      }
    })
  }

  it('a file changed after the crash is kept by the resume, which deletes the rest', () => {
    const { S, left } = crashAt(POINTS['during-P4f'] as Point)
    expect(left.state).toBe('interrupted-delete')
    const job = resumeJobAt(S)
    const top = (left.remaining ?? []).find((e) => e.rel === 'top.txt')
    expect(top).toBeDefined()
    fs.writeFileSync(top!.path, 'EDITED-after-the-crash')
    const run = runWalker(job)
    expect(statusOf(run)).toBe('stopped/unapproved-kept')
    expect(read(top!.path)).toBe('EDITED-after-the-crash')
    const kept = run.item?.kept as { path: string; rel: string }[]
    expect(kept.map((k) => k.rel)).toEqual(['top.txt'])
  })

  it('a leftover whose inventory is removed is not resumed as a delete', () => {
    const { S, left } = crashAt(POINTS['during-P4f'] as Point)
    const job = resumeJobAt(S)
    expect(left.state).toBe('interrupted-delete')
    fs.unlinkSync(path.join(S, 'inventory.json'))
    const before = snapshotTree(S)
    const run = runWalker(job)
    expect(statusOf(run)).toBe('kept/no-inventory')
    expect(snapshotTree(S)).toBe(before)
    expect(inspectLeftover({ S, stagingRoot: path.dirname(S) }).state).toBe('unknown')
  })
})
