/**
 * SMI-6531 (A1 step 6c-i): crash recovery (ADR-166 D-11, spike row P5). The
 * walker child is SIGKILLed at each step, the leftover it leaves is inspected
 * read-only (`inspectLeftover`), and a confirmed re-run re-verifies before it
 * deletes anything. Ported from the SMI-6676 spike's `harness/w5-rows-r.mjs`
 * P5, at the engine: the listing and confirmation around it are 6c-iii's.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computePathTreeHash } from '../../../src/install/park-tree.js'
import { inspectLeftover } from '../../../src/install/prune.leftovers.js'
import type { Leftover } from '../../../src/install/prune.leftovers.js'
import { removeIfIdentical } from '../../../src/install/prune.metadata.js'
import { readStable } from '../../../src/install/prune.sidecar.js'
import type { PruneJob } from '../../../src/install/prune.job.js'
import {
  esc,
  exists,
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
import type { Hook, ParkedCopy, PruneFixture } from './prune.walk.helpers.js'

let f: PruneFixture | null = null
afterEach(() => {
  if (f !== null) removeFixture(f)
  f = null
})

type Point = Omit<Hook, 'action'> & { expect: Leftover['state']; leafRe?: true }
const POINTS: Record<string, Point> = {
  'after-P4b': { when: 'after', fn: 'mkdirSync', a0Re: '\\.prune-[0-9a-f]{16}$', expect: 'empty' },
  // The intent is written as a temp and renamed into place.
  'after-P4c-temp': {
    when: 'after',
    fn: 'writeFileSync',
    a0Re: 'intent\\.json\\.tmp$',
    expect: 'partial-intent',
  },
  'after-P4c': {
    when: 'after',
    fn: 'renameSync',
    a1Re: '/intent\\.json$',
    expect: 'intent-only',
  },
  'after-P4d': {
    when: 'after',
    fn: 'renameSync',
    a0Re: '/op-',
    a1Re: '\\.prune-[0-9a-f]{16}/[^/]+$',
    expect: 'staged',
  },
  "after-P4d'": { when: 'after', fn: 'renameSync', a1Re: '/sidecar\\.json$', expect: 'staged' },
  'during-P4f': {
    when: 'after',
    fn: 'unlinkSync',
    a0Re: '^\\.d-',
    nth: 4,
    expect: 'interrupted-delete',
  },
  // The tree is gone; the sidecar, deleted last, is not yet.
  'after-P4f': { when: 'after', fn: 'rmdirSync', leafRe: true, expect: 'finished' },
  // 11 file entries (populate's 3 plus 2 dirs of 4), then the sidecar: the 12th unlink.
  'after-sidecar': {
    when: 'after',
    fn: 'unlinkSync',
    a0Re: '^\\.d-',
    nth: 12,
    expect: 'finished',
  },
}

/** Kills the walker at `point`; returns the copy and its one leftover. */
function crashAt(point: Point): { c: ParkedCopy; S: string; left: Leftover } {
  f = makeParent('prune-p5-')
  const c = parkCopy(f.parent, 'k', { extraDirs: 2 })
  const { expect: _e, leafRe, ...h } = point
  void _e
  const hook: Hook = {
    ...h,
    ...(leafRe ? { a0Re: `^${esc(c.name)}$` } : {}),
    action: { kind: 'kill' },
  }
  const run = runWalker(jobFor(c), { hooks: [hook] })
  if (run.signal !== 'SIGKILL') throw new Error(`precondition: no crash (${statusOf(run)})`)
  const dirs = stagingDirs(c.stagingRoot)
  if (dirs.length !== 1) throw new Error(`precondition: ${dirs.length} staging dirs`)
  const S = dirs[0] as string
  const snap = snapshotTree(S)
  const left = inspectLeftover({ S, stagingRoot: c.stagingRoot })
  if (snapshotTree(S) !== snap) throw new Error('inspectLeftover changed the leftover')
  return { c, S, left }
}

/** The per-item job a confirmed re-run hands the walker for a staged leftover. */
function resumeJob(left: Leftover, approvedHash: string): PruneJob {
  const item = left.item
  if (item === undefined) throw new Error('no staged item')
  const st = fs.lstatSync(item.copyPath, { bigint: true })
  const rs = item.sidecarPath === null ? null : readStable(item.sidecarPath)
  if (rs !== null && !rs.ok) throw new Error('the staged sidecar is unreadable')
  return {
    copyPath: item.copyPath,
    sidecarPath: item.sidecarPath,
    sidecarRead:
      rs === null
        ? null
        : { bytes: rs.bytes, ino: rs.ino, size: rs.size, mtimeNs: rs.mtimeNs, ctimeNs: rs.ctimeNs },
    leaf: item.name,
    rootIdentity: {
      dev: st.dev,
      ino: st.ino,
      birthtimeNs: st.birthtimeNs,
      fmt: st.mode & 0o170000n,
    },
    approvedHash,
    klass: 'held',
    authorization: 'per-item',
    stagingRoot: item.stagingRoot,
    opDir: item.opDir,
    S: item.S,
    resume: item.interruptedDelete,
    inheritedMeta: item.inheritedMeta,
  }
}

const freshHash = (p: string): string => {
  const h = computePathTreeHash(p)
  if (!h.ok) throw new Error(`hash failed at ${p}`)
  return h.treeHash
}

describe('P5: a SIGKILL at each step leaves a leftover that is listed, then resumed', () => {
  for (const [name, point] of Object.entries(POINTS)) {
    it(`${name}: the leftover reads ${point.expect}, and a confirmed re-run finishes it`, () => {
      const { c, S, left } = crashAt(point)
      expect(left.state).toBe(point.expect)
      if (name === 'after-P4f')
        expect(left.cleanup).toEqual(['sidecar.json', 'intent.json', 'deleting'])
      if (name === 'after-sidecar') expect(left.cleanup).toEqual(['intent.json', 'deleting'])
      if (left.item !== undefined) {
        const run = runWalker(resumeJob(left, freshHash(left.item.copyPath)))
        expect(statusOf(run)).toBe('removed/null')
        expect(exists(S)).toBe(false)
      } else {
        // No tree: only Skillsmith's own metadata is left, removed by its record.
        for (const m of left.cleanup ?? []) {
          expect(removeIfIdentical(path.join(S, m), left.meta?.[m])).toEqual({ removed: true })
        }
        fs.rmdirSync(S)
      }
      if (['empty', 'intent-only', 'partial-intent'].includes(point.expect)) {
        // The copy was never staged: it is still whole where it was parked.
        expect(read(path.join(c.copyPath, 'top.txt'))).toBe('top-bytes')
      } else {
        expect(exists(c.copyPath)).toBe(false)
      }
      expect(stagingDirs(c.stagingRoot)).toEqual([])
    })
  }

  it('an interrupted delete whose staged content changed after approval is held, never deleted', () => {
    const { S, left } = crashAt(POINTS['during-P4f'] as Point)
    expect(left.state).toBe('interrupted-delete')
    const item = left.item
    if (item === undefined) throw new Error('no staged item')
    const job = resumeJob(left, freshHash(item.copyPath))
    const edited = path.join(item.copyPath, 'top.txt')
    expect(exists(edited)).toBe(true)
    fs.writeFileSync(edited, 'EDITED-after-the-crash')
    const run = runWalker(job)
    expect(statusOf(run)).toBe('held/changed-in-staging')
    expect(read(edited)).toBe('EDITED-after-the-crash')
    expect(exists(path.join(S, 'deleting'))).toBe(true)
  })
})
