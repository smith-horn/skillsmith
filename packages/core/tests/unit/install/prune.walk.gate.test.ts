/**
 * SMI-6531 (A1 step 6c-i, pre-merge gate): the rows that pin what no earlier
 * test pinned. Each one fails on a named mutation of the engine (the gate's
 * list), and the F3-F5 checks: a resumed staging directory on another device
 * or owned by another user, a job whose sidecar or op dir is not the intent's,
 * and P4g's reporting.
 *
 * Not here: the in-tree `st_dev` check in `verifyAtStaging` needs a mount to
 * exercise (SMI-7213); see P1 in `prune.walk.rows.test.ts`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resumeStagingProblem } from '../../../src/install/prune.walk.shared.js'
import {
  esc,
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
  statusOf,
} from './prune.walk.helpers.js'
import type { ResumeJob } from '../../../src/install/prune.job.js'
import type { ParkedCopy, PruneFixture } from './prune.walk.helpers.js'

let f: PruneFixture | null = null
afterEach(() => {
  if (f !== null) removeFixture(f)
  f = null
})

/** A resumable leftover: the walker killed right after it wrote the inventory. */
const staged = (c: ParkedCopy): string => stagedWithInventory(c)

describe('gate mutation 1: a batch yes never covers a copy that is not clean', () => {
  for (const klass of ['held', 'unverified', 'changed'] as const) {
    it(`a ${klass} copy approved by the batch yes is kept untouched`, () => {
      f = makeParent('prune-g1-')
      const c = parkCopy(f.parent, 't')
      const before = snapshotTree(c.copyPath)
      const run = runWalker(jobFor(c, { klass, authorization: 'batch' }))
      expect(statusOf(run)).toBe('kept/needs-allow-changed')
      expect(snapshotTree(c.copyPath)).toBe(before)
    })
  }
})

describe('gate mutation 2: a change between the pre-check and the post-rename lstat', () => {
  it('the changed entry is left at its random name, never unlinked', () => {
    f = makeParent('prune-g2-')
    const c = parkCopy(f.parent, 't')
    const run = runWalker(jobFor(c), {
      traceDir: f.root,
      hooks: [
        {
          when: 'after',
          fn: 'renameSync',
          a0Re: '^top\\.txt$',
          a1Re: '^\\.d-',
          action: { kind: 'appendA1', data: '-appended-after-the-check' },
        },
      ],
    })
    expect(fired(run, 'appendA1')).toBe(true)
    expect(statusOf(run)).toBe('stopped/unapproved-kept')
    const at = (run.item?.kept as { path: string }[])[0]!.path
    expect(read(at)).toBe('top-bytes-appended-after-the-check')
  })
})

describe('gate mutation 3: a sidecar that appears for a job that had none', () => {
  it('is refused before anything moves', () => {
    f = makeParent('prune-g3-')
    const c = parkCopy(f.parent, 't')
    const before = snapshotTree(c.copyPath)
    const run = runWalker(jobFor(c, { sidecarRead: null }))
    expect(statusOf(run)).toBe('kept/class-worsened')
    expect(String(run.item?.detail)).toBe('a sidecar appeared')
    expect(snapshotTree(c.copyPath)).toBe(before)
  })
})

describe('gate mutation 4: a staged sidecar with the approved bytes at a new inode', () => {
  it('is held, never deleted as the approved one', () => {
    f = makeParent('prune-g4-')
    const c = parkCopy(f.parent, 't')
    const run = runWalker(jobFor(c), {
      traceDir: f.root,
      hooks: [
        {
          when: 'before',
          fn: 'renameSync',
          a1Re: '/sidecar\\.json$',
          action: { kind: 'reinode' },
        },
      ],
    })
    expect(fired(run, 'reinode')).toBe(true)
    expect(statusOf(run)).toBe('held/sidecar-changed-in-staging')
    expect(exists(path.join(String(run.item?.stagingPath), 'sidecar.json'))).toBe(true)
  })
})

describe('gate mutation 5: the parent goes away mid-walk', () => {
  it('the walk stops at the next entry instead of deleting on', () => {
    f = makeParent('prune-g5-')
    const c = parkCopy(f.parent, 't', { extraDirs: 2 })
    const run = runWalker(jobFor(c), {
      traceDir: f.root,
      hooks: [
        {
          when: 'after',
          fn: 'unlinkSync',
          a0Re: '^\\.d-',
          nth: 1,
          action: { kind: 'fakeOrphan' },
        },
      ],
    })
    expect(fired(run, 'fakeOrphan')).toBe(true)
    expect(statusOf(run)).toBe('stopped/delete-failed')
    expect(String(run.item?.detail)).toBe('the parent process is gone')
    expect(run.item?.deleted).toBe(1)
  })
})

describe('F3: a resumed staging directory is checked like a fresh one', () => {
  it('owned by another user: refused', () => {
    f = makeParent('prune-f3-owner-')
    const c = parkCopy(f.parent, 't')
    const S = staged(c)
    const dev = fs.lstatSync(S, { bigint: true }).dev
    expect(resumeStagingProblem(S, c.stagingRoot, dev)).toBeNull()
    fs.chownSync(S, 1000, 1000)
    expect(resumeStagingProblem(S, c.stagingRoot, dev)).toBe(
      'staging directory is owned by another user'
    )
    expect(statusOf(runWalker(resumeJobAt(S)))).toBe('kept/staging-unusable')
  })

  it('on another device than the copy: refused', () => {
    f = makeParent('prune-f3-dev-')
    const c = parkCopy(f.parent, 't')
    const S = staged(c)
    const dev = fs.lstatSync(S, { bigint: true }).dev
    expect(resumeStagingProblem(S, c.stagingRoot, dev + 1n)).toBe('on another device')
  })

  it.skipIf(!fs.existsSync('/dev/shm'))(
    'on another device than its staging root (a symlinked root): refused',
    () => {
      f = makeParent('prune-f3-root-')
      const c = parkCopy(f.parent, 't')
      const S = staged(c)
      const dev = fs.lstatSync(S, { bigint: true }).dev
      const link = fs.mkdtempSync(path.join('/dev/shm', 'prune-f3-'))
      try {
        const root = path.join(link, 'root')
        fs.symlinkSync(c.stagingRoot, root)
        if (fs.lstatSync(root, { bigint: true }).dev === dev) {
          throw new Error('precondition: /dev/shm is on the same device as the fixture')
        }
        expect(resumeStagingProblem(path.join(root, path.basename(S)), root, dev)).toBe(
          'on another device than its staging root'
        )
      } finally {
        fs.rmSync(link, { recursive: true, force: true })
      }
    }
  )
})

describe('F4/F5: a resume must agree with the intent on disk', () => {
  it('a resume job carrying a sidecar path is refused: a resume approves nothing new', () => {
    f = makeParent('prune-f4-')
    const c = parkCopy(f.parent, 't')
    const S = staged(c)
    const before = snapshotTree(S)
    const job = { ...resumeJobAt(S), sidecarPath: path.join(os.tmpdir(), 'elsewhere.json') }
    const run = runWalker(job as unknown as ResumeJob)
    expect(statusOf(run)).toBe('kept/invalid-job')
    expect(snapshotTree(S)).toBe(before)
  })

  it('an opDir that is not the intent’s is refused', () => {
    f = makeParent('prune-f5-opdir-')
    const c = parkCopy(f.parent, 't')
    const S = staged(c)
    const run = runWalker({ ...resumeJobAt(S), opDir: c.stagingRoot })
    expect(statusOf(run)).toBe('kept/resume-mismatch')
    expect(String(run.item?.detail)).toBe('opDir is not the op dir the intent recorded')
  })
})

describe('F5: P4g reports what it could not do', () => {
  it('an op dir that cannot be removed for a reason other than ENOTEMPTY is named', () => {
    f = makeParent('prune-f5-rmdir-')
    const c = parkCopy(f.parent, 't')
    const run = runWalker(jobFor(c), {
      hooks: [
        {
          when: 'before',
          fn: 'rmdirSync',
          a0Re: `^${esc(c.opDir)}$`,
          action: { kind: 'throw', code: 'EACCES' },
        },
      ],
    })
    expect(statusOf(run)).toBe('removed/null')
    expect(run.item?.detail).toBe('op directory left (EACCES)')
  })

  it('an intent kept after a failed rename into staging is reported', () => {
    f = makeParent('prune-f5-kept-')
    const c = parkCopy(f.parent, 't')
    const run = runWalker(jobFor(c), {
      hooks: [
        {
          when: 'before',
          fn: 'renameSync',
          a0Re: `^${esc(c.copyPath)}$`,
          action: { kind: 'throw', code: 'EXDEV' },
        },
        {
          when: 'before',
          fn: 'renameSync',
          a1Re: '/\\.m-[0-9a-f]{16}$',
          action: { kind: 'throw', code: 'EIO' },
        },
      ],
    })
    expect(statusOf(run)).toBe('kept/stage-failed')
    const kept = run.item?.metadataKept as string[]
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatch(/intent\.json: rename to a random name failed \(EIO\)$/)
    expect(exists(c.copyPath)).toBe(true)
  })
})
