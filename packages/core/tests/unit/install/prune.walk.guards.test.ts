/**
 * SMI-6531 (A1 step 6c-i, governance round): the walker's own guards. A
 * resumed run gets the staging trust checks a fresh one gets; the root's file
 * type is part of its identity; a job that does not decode is answered, never
 * walked; and a failing syscall at each step the review named ends in a shaped
 * result, never a crash, with nothing of the user's lost.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeJob } from '../../../src/install/prune.job.js'
import type { ResumeJob } from '../../../src/install/prune.job.js'
import { inspectLeftover } from '../../../src/install/prune.leftovers.js'
import { resumeStagingProblem } from '../../../src/install/prune.walk.shared.js'
import {
  exists,
  jobFor,
  makeParent,
  parkCopy,
  removeFixture,
  resumeJobAt,
  runWalker,
  snapshotTree,
  stagedWithInventory,
  stagingDirs,
  statusOf,
} from './prune.walk.helpers.js'
import type { ParkedCopy, PruneFixture } from './prune.walk.helpers.js'

let f: PruneFixture | null = null
const fixture = (prefix: string): PruneFixture => (f = makeParent(prefix))
afterEach(() => {
  if (f !== null) removeFixture(f)
  f = null
})

/** A resumable leftover (killed right after its inventory was written) and its resume job. */
function stagedLeftover(c: ParkedCopy): { S: string; job: ResumeJob; dev: bigint } {
  const S = stagedWithInventory(c)
  return { S, job: resumeJobAt(S), dev: fs.lstatSync(S, { bigint: true }).dev }
}

describe('M2: a resumed run checks its staging directory first', () => {
  it('a resumed S that is group- or world-accessible is kept, nothing moved or deleted', () => {
    const fx = fixture('prune-resume-mode-')
    const c = parkCopy(fx.parent, 't')
    const { S, job } = stagedLeftover(c)
    fs.chmodSync(S, 0o755)
    const before = snapshotTree(S)
    const run = runWalker(job)
    expect(statusOf(run)).toBe('kept/staging-unusable')
    // The staging check fires first; the inventory's staging record (mode included) is the second layer.
    expect(String(run.item?.detail)).toMatch(/group- or world-accessible/)
    expect(snapshotTree(S)).toBe(before)
  })

  for (const [label, move] of [
    ['foreign-named', (S: string) => path.join(path.dirname(S), '.prune-not-hex-at-all')],
    ['under another parent', (S: string, root: string) => path.join(root, path.basename(S))],
  ] as const) {
    it(`a resumed S ${label} is refused before any work, nothing moved or deleted`, () => {
      const fx = fixture('prune-resume-name-')
      const c = parkCopy(fx.parent, 't')
      const { S, job, dev } = stagedLeftover(c)
      const moved = move(S, fx.root)
      fs.renameSync(S, moved)
      const before = snapshotTree(moved)
      const leaf = path.basename(job.copyPath)
      const run = runWalker({ ...job, S: moved, copyPath: path.join(moved, leaf) })
      // decodeJob refuses the relation; the walker's own check (below) is the second layer.
      expect(statusOf(run)).toBe('kept/invalid-job')
      expect(snapshotTree(moved)).toBe(before)
      expect(resumeStagingProblem(moved, c.stagingRoot, dev)).not.toBeNull()
    })
  }

  it('resumeStagingProblem names each failure, and passes a good S', () => {
    const fx = fixture('prune-resume-unit-')
    const c = parkCopy(fx.parent, 't')
    const { S, dev } = stagedLeftover(c)
    expect(resumeStagingProblem(S, c.stagingRoot, dev)).toBeNull()
    expect(resumeStagingProblem(path.join(c.stagingRoot, '.prune-xyz'), c.stagingRoot, dev)).toBe(
      'not named .prune-<16 hex>'
    )
    expect(resumeStagingProblem(path.join(fx.root, path.basename(S)), c.stagingRoot, dev)).toBe(
      `not directly in ${c.stagingRoot}`
    )
    fs.chmodSync(S, 0o755)
    expect(resumeStagingProblem(S, c.stagingRoot, dev)).toMatch(/group- or world-accessible/)
  })
})

describe('(b) the root identity carries the file type', () => {
  it('a copy whose file type is not the classified one is kept before anything moves', () => {
    const fx = fixture('prune-fmt-')
    const c = parkCopy(fx.parent, 't')
    const job = jobFor(c)
    const before = snapshotTree(c.copyPath)
    const run = runWalker({ ...job, rootIdentity: { ...job.rootIdentity, fmt: 0o100000n } })
    expect(statusOf(run)).toBe('kept/class-worsened')
    expect(String(run.item?.detail)).toContain('file type')
    expect(snapshotTree(c.copyPath)).toBe(before)
    expect(stagingDirs(c.stagingRoot)).toEqual([])
  })
})

describe('the entry answers a job it cannot decode', () => {
  it('a malformed job is kept/invalid-job, and nothing is touched', () => {
    const fx = fixture('prune-badjob-')
    const c = parkCopy(fx.parent, 't')
    const before = snapshotTree(c.copyPath)
    const run = runWalker({ ...jobFor(c), approvedHash: 'not-a-hash' })
    expect(statusOf(run)).toBe('kept/invalid-job')
    expect(snapshotTree(c.copyPath)).toBe(before)
    const enc = encodeJob(jobFor(c))
    expect('rootIdentity' in enc && enc.rootIdentity.fmt).toBe(String(0o040000))
  })
})

describe('m2: a failing syscall at each named step ends in a shaped result', () => {
  const thrower = (when: 'before' | 'after', fn: string, a0Re: string, code: string, nth = 1) => ({
    when,
    fn,
    a0Re,
    nth,
    action: { kind: 'throw', code },
  })

  it('the lstat right after the staging mkdir: kept/staging-unusable, the copy untouched', () => {
    const fx = fixture('prune-m2-lstat-')
    const c = parkCopy(fx.parent, 't')
    const before = snapshotTree(c.copyPath)
    const run = runWalker(jobFor(c), {
      hooks: [thrower('before', 'lstatSync', '\\.prune-[0-9a-f]{16}$', 'EIO')],
    })
    expect(statusOf(run)).toBe('kept/staging-unusable')
    expect(String(run.item?.detail)).toMatch(/^lstat .*: EIO$/)
    expect(snapshotTree(c.copyPath)).toBe(before)
  })

  it('the intent write (ENOSPC before anything is written): kept/stage-failed, S removed', () => {
    const fx = fixture('prune-m2-intent-')
    const c = parkCopy(fx.parent, 't')
    const before = snapshotTree(c.copyPath)
    const run = runWalker(jobFor(c), {
      hooks: [thrower('before', 'writeFileSync', 'intent\\.json\\.tmp$', 'ENOSPC')],
    })
    expect(statusOf(run)).toBe('kept/stage-failed')
    expect(run.item?.errno).toBe('ENOSPC')
    expect(snapshotTree(c.copyPath)).toBe(before)
    expect(stagingDirs(c.stagingRoot)).toEqual([])
  })

  it('a failure after the intent temp is written leaves a partial-intent leftover, never unknown', () => {
    const fx = fixture('prune-m2-tmp-')
    const c = parkCopy(fx.parent, 't')
    const run = runWalker(jobFor(c), {
      hooks: [thrower('after', 'writeFileSync', 'intent\\.json\\.tmp$', 'ENOSPC')],
    })
    expect(statusOf(run)).toBe('kept/stage-failed')
    const S = stagingDirs(c.stagingRoot)[0] as string
    const left = inspectLeftover({ S, stagingRoot: c.stagingRoot })
    expect([left.state, left.cleanup]).toEqual(['partial-intent', ['intent.json.tmp']])
    expect(exists(c.copyPath)).toBe(true)
  })

  it("recordOf's lstat of the intent: kept/stage-failed, the copy untouched", () => {
    const fx = fixture('prune-m2-record-')
    const c = parkCopy(fx.parent, 't')
    const before = snapshotTree(c.copyPath)
    const run = runWalker(jobFor(c), {
      // The 1st lstat of intent.json is the no-replace rename's check; the 2nd is recordOf's.
      hooks: [thrower('before', 'lstatSync', '/intent\\.json$', 'EIO', 2)],
    })
    expect(statusOf(run)).toBe('kept/stage-failed')
    expect(String(run.item?.detail)).toBe('intent write failed (EIO)')
    expect(snapshotTree(c.copyPath)).toBe(before)
    // The renamed intent is complete, so the leftover is the ordinary intent-only one.
    const S = stagingDirs(c.stagingRoot)[0] as string
    expect(inspectLeftover({ S, stagingRoot: c.stagingRoot }).state).toBe('intent-only')
  })

  it('the metadata unlink after a complete delete: still removed, with the kept file named', () => {
    const fx = fixture('prune-m2-unlink-')
    const c = parkCopy(fx.parent, 't')
    const run = runWalker(jobFor(c), {
      hooks: [thrower('before', 'unlinkSync', '/\\.m-[0-9a-f]{16}$', 'EIO')],
    })
    expect(statusOf(run)).toBe('removed/null')
    expect(exists(c.copyPath)).toBe(false)
    const kept = run.item?.metadataKept as string[]
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatch(/unlink failed \(EIO\)$/)
  })
})
