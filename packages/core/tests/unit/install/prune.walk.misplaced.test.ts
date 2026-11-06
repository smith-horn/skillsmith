/**
 * SMI-6531 (A1 step 6c-i, pre-merge gate F1; owner decision 2026-11-06): a
 * misplaced entry is never deleted (ADR-166 D-11, R-misplace). While a
 * misplacement record names a path that still exists, the leftover offers no
 * resume and the walker refuses one; once the user moves the entry out by
 * hand, the leftover resumes and the moved entry is untouched. Each
 * misplacement has its own record, so two never collide, and a record that
 * cannot be written still blocks every resume.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectLeftover } from '../../../src/install/prune.leftovers.js'
import {
  exists,
  fired,
  jobFor,
  makeParent,
  misplacedRecords,
  parkCopy,
  read,
  removeFixture,
  resumeJobAt,
  runWalker,
  stagingDirs,
  statusOf,
} from './prune.walk.helpers.js'
import type { Hook, ParkedCopy, PruneFixture } from './prune.walk.helpers.js'

let f: PruneFixture | null = null
afterEach(() => {
  if (f !== null) removeFixture(f)
  f = null
})

/** P9's swap: the entry named `name` is replaced just before its rename to a random name. */
const swapHook = (name: string, data: string, recordFile: string, awayDir: string): Hook => ({
  when: 'before',
  fn: 'renameSync',
  a0Re: `^${name.replace('.', '\\.')}$`,
  a1Re: '^\\.d-',
  action: { kind: 'swap', awayDir, data, recordFile },
})

/** Runs P9 on a fresh copy; returns the copy, S and the misplaced path. */
function misplaceOnce(c: ParkedCopy, root: string, name = 'top.txt'): { S: string; at: string } {
  const run = runWalker(jobFor(c), {
    traceDir: root,
    hooks: [swapHook(name, 'replacement-bytes', path.join(root, 'swap1.json'), root)],
  })
  if (!fired(run, 'swap') || statusOf(run) !== 'stopped/entry-misplaced') {
    throw new Error(`precondition: ${statusOf(run)}`)
  }
  const m = run.item?.misplaced as { path: string }[]
  return { S: String(run.item?.stagingPath), at: m[0]!.path }
}

describe('F1: a misplaced entry blocks every resume until it is moved out', () => {
  it('the leftover is misplaced-pending with no item, and a forced resume is refused', () => {
    f = makeParent('prune-f1-')
    const c = parkCopy(f.parent, 't')
    const { S, at } = misplaceOnce(c, f.root)
    expect(misplacedRecords(S)).toHaveLength(1)
    const left = inspectLeftover({ S, stagingRoot: c.stagingRoot })
    expect(left.state).toBe('misplaced-pending')
    expect(left.item).toBeUndefined()
    expect(left.detail).toContain(at)
    expect(left.detail).toContain('top.txt')
    expect(left.detail).toContain('move it out by hand')
    const forced = runWalker(resumeJobAt(S))
    expect(statusOf(forced)).toBe('kept/misplaced-pending')
    expect(read(at)).toBe('replacement-bytes')
  })

  it('once moved out by hand, the leftover resumes and the moved entry is untouched', () => {
    f = makeParent('prune-f1-moved-')
    const c = parkCopy(f.parent, 't')
    const { S, at } = misplaceOnce(c, f.root)
    const rescued = path.join(f.root, 'rescued.txt')
    fs.renameSync(at, rescued)
    const left = inspectLeftover({ S, stagingRoot: c.stagingRoot })
    expect(left.state).toBe('interrupted-delete')
    expect(left.item).toBeDefined()
    const run = runWalker(resumeJobAt(S))
    expect(statusOf(run)).toBe('removed/null')
    expect(read(rescued)).toBe('replacement-bytes')
    // The cleared record went with the rest of S's metadata.
    expect(exists(S)).toBe(false)
  })

  it('two misplacements across two runs both survive, each with its own record', () => {
    f = makeParent('prune-f1-two-')
    const c = parkCopy(f.parent, 't')
    // The walk goes link, target, top.txt: misplace the first, so the second run has entries left.
    const { S, at } = misplaceOnce(c, f.root, 'link')
    const rescued = path.join(f.root, 'rescued.txt')
    fs.renameSync(at, rescued)
    const second = runWalker(resumeJobAt(S), {
      traceDir: f.root,
      hooks: [swapHook('top.txt', 'second-replacement', path.join(f.root, 'swap2.json'), f.root)],
    })
    expect(fired(second, 'swap')).toBe(true)
    expect(statusOf(second)).toBe('stopped/entry-misplaced')
    // The second misplacement's own record was written: nothing collided with the first.
    expect(second.item?.misplacedRecordError).toBeUndefined()
    const at2 = (second.item?.misplaced as { path: string }[])[0]!.path
    expect(misplacedRecords(S)).toHaveLength(2)
    expect(read(rescued)).toBe('replacement-bytes')
    expect(read(at2)).toBe('second-replacement')
    const left = inspectLeftover({ S, stagingRoot: c.stagingRoot })
    expect(left.state).toBe('misplaced-pending')
    expect(left.misplaced.map((e) => e.path).sort()).toEqual([at, at2].sort())
  })

  it('a record that cannot be written still blocks: the deleting marker becomes misplaced-unrecorded', () => {
    f = makeParent('prune-f1-enospc-')
    const c = parkCopy(f.parent, 't')
    const run = runWalker(jobFor(c), {
      traceDir: f.root,
      hooks: [
        swapHook('top.txt', 'replacement-bytes', path.join(f.root, 'swap.json'), f.root),
        {
          when: 'before',
          fn: 'writeFileSync',
          a0Re: '/misplaced-[0-9a-f]{16}\\.json$',
          action: { kind: 'throw', code: 'ENOSPC' },
        },
      ],
    })
    expect(statusOf(run)).toBe('stopped/entry-misplaced')
    expect(run.item?.misplacedRecordError).toBe('ENOSPC')
    expect(run.item?.misplacedMarkerError).toBeUndefined()
    const S = String(run.item?.stagingPath)
    const at = (run.item?.misplaced as { path: string }[])[0]!.path
    expect(misplacedRecords(S)).toEqual([])
    expect(exists(path.join(S, 'misplaced-unrecorded'))).toBe(true)
    expect(inspectLeftover({ S, stagingRoot: c.stagingRoot }).state).toBe('misplaced-pending')
    const forced = runWalker(resumeJobAt(S))
    expect(statusOf(forced)).toBe('kept/misplaced-pending')
    expect(read(at)).toBe('replacement-bytes')
  })
})

describe('F1: a sidecar swapped in before staging is never treated as the approved one', () => {
  it('the listing offers no sidecar, a forced one is refused, and the swapped bytes survive', () => {
    f = makeParent('prune-f1-sidecar-')
    const c = parkCopy(f.parent, 't')
    const held = runWalker(jobFor(c), {
      traceDir: f.root,
      hooks: [
        {
          when: 'before',
          fn: 'renameSync',
          a1Re: '/sidecar\\.json$',
          action: { kind: 'rewriteInPlace', path: '$a0' },
        },
      ],
    })
    expect(statusOf(held)).toBe('held/sidecar-changed-in-staging')
    const S = stagingDirs(c.stagingRoot)[0] as string
    const staged = path.join(S, 'sidecar.json')
    const left = inspectLeftover({ S, stagingRoot: c.stagingRoot })
    expect(left.state).toBe('staged')
    expect(left.item?.sidecarPath).toBeNull()
    const forced = runWalker(resumeJobAt(S, { sidecarPath: staged }))
    expect(statusOf(forced)).toBe('kept/sidecar-not-approved')
    // Resumed as the listing offers it, the tree goes and the swapped sidecar stays.
    const run = runWalker(resumeJobAt(S, { sidecarPath: null }))
    expect(statusOf(run)).toBe('removed/null')
    expect(read(staged)).toMatch(/^Z+$/)
  })
})
