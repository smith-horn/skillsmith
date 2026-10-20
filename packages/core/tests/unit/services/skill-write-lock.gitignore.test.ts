/**
 * SMI-6531 (A1 step 2), T-N1 lock-level half: the `.gitignore` suggestion for
 * staging and parked areas. Real git repos; a spy `git` on PATH records every
 * invocation so "no git command other than check-ignore" and "the hint ran
 * git at all" are observed, not assumed (absence needs a presence proof).
 *
 * The C6 security cases live in skill-write-lock.gitignore.security.test.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withFileLock } from '../../../src/config/file-lock.js'
import { LockOrderError, setLockTrackerEnabledForTests } from '../../../src/config/lock-tracker.js'
import { PARKED_DIR_NAME } from '../../../src/install/park-tree.destination.js'
import {
  PARKED_GITIGNORE_HINT,
  STAGING_GITIGNORE_HINT,
  parkedAreaGitignoreHint,
  stagingGitignoreHint,
} from '../../../src/services/skill-write-lock.gitignore.js'
import {
  hasGitAtOrAbove,
  initRepo,
  installGitSpy,
  installStubGit,
  makeSandbox,
  put,
  removeGitFromPath,
  type Sandbox,
} from './skill-write-lock.gitignore.helpers.js'

// The plan's text (§3.2), spelled out so a drifted constant fails here.
const STAGING_LINE =
  "hint: to keep Skillsmith's temporary files out of git status, add .skillsmith-writes.lock* and .skillsmith-staging/ to .gitignore"
const PARKED_LINE =
  "hint: to keep Skillsmith's parked copies out of git status, add .skillsmith-parked/ to .gitignore"

let sb: Sandbox
let repo: string
let skillsRoot: string
let gitCalls: () => string[][]

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  sb = makeSandbox()
  gitCalls = installGitSpy(sb)
  repo = initRepo(path.join(sb.dir, 'repo'))
  skillsRoot = path.join(repo, '.claude', 'skills')
  fs.mkdirSync(skillsRoot, { recursive: true })
})

afterEach(() => {
  sb.cleanup()
})

/** Every recorded call must be `-c core.fsmonitor=false -C <root> check-ignore -q <path>`. */
function expectOnlyCheckIgnore(root: string): string[] {
  const calls = gitCalls()
  expect(calls.length).toBeGreaterThan(0) // presence: the spy saw git run
  return calls.map((args) => {
    expect(args.slice(0, 4)).toEqual(['-c', 'core.fsmonitor=false', '-C', root])
    expect(args.slice(4, 6)).toEqual(['check-ignore', '-q'])
    expect(args).toHaveLength(7)
    return args[6]
  })
}

describe('staging hint (T-N1)', () => {
  it('constants carry the plan text', () => {
    expect(STAGING_GITIGNORE_HINT).toBe(STAGING_LINE)
    expect(PARKED_GITIGNORE_HINT).toBe(PARKED_LINE)
  })

  it('prints exactly one line, naming both entries, when nothing is ignored', async () => {
    const hint = await stagingGitignoreHint(skillsRoot)
    expect(hint).toBe(STAGING_LINE)
    expect(hint?.split('\n')).toHaveLength(1)
    expect(hint).toContain('.skillsmith-writes.lock')
    expect(hint).toContain('.skillsmith-staging/')
    expectOnlyCheckIgnore(skillsRoot)
  })

  it('is silent when both entries are in the repo .gitignore, checking each of the three paths with its own call', async () => {
    put(path.join(repo, '.gitignore'), '.skillsmith-writes.lock*\n.skillsmith-staging/\n')
    expect(await stagingGitignoreHint(skillsRoot)).toBeNull()
    expect(expectOnlyCheckIgnore(skillsRoot)).toEqual([
      '.skillsmith-writes.lock',
      '.skillsmith-writes.lock.reclaim',
      '.skillsmith-staging/owner.json',
    ])
  })

  it('hints when the lock file is ignored but its .reclaim lock is not, and is silent once `.lock*` covers both', async () => {
    put(path.join(repo, '.gitignore'), '.skillsmith-writes.lock\n.skillsmith-staging/\n')
    expect(await stagingGitignoreHint(skillsRoot)).toBe(STAGING_LINE)
    // the lock file was ignored, so the reclaim path was asked about next and settled it
    expect(expectOnlyCheckIgnore(skillsRoot)).toEqual([
      '.skillsmith-writes.lock',
      '.skillsmith-writes.lock.reclaim',
    ])
    put(path.join(repo, '.gitignore'), '.skillsmith-writes.lock*\n.skillsmith-staging/\n')
    expect(await stagingGitignoreHint(skillsRoot)).toBeNull()
    // the silence came from all three checks answering "ignored", not from a check that never ran
    expect(expectOnlyCheckIgnore(skillsRoot).slice(-3)).toEqual([
      '.skillsmith-writes.lock',
      '.skillsmith-writes.lock.reclaim',
      '.skillsmith-staging/owner.json',
    ])
  })

  it('is silent when both entries are in .git/info/exclude', async () => {
    put(
      path.join(repo, '.git', 'info', 'exclude'),
      '.skillsmith-writes.lock*\n.skillsmith-staging/\n'
    )
    expect(await stagingGitignoreHint(skillsRoot)).toBeNull()
    expectOnlyCheckIgnore(skillsRoot)
  })

  it('is silent when both entries are in the global excludes file; hints before it exists', async () => {
    expect(await stagingGitignoreHint(skillsRoot)).toBe(STAGING_LINE) // control: the file matters
    put(
      path.join(sb.home, '.config', 'git', 'ignore'),
      '.skillsmith-writes.lock*\n.skillsmith-staging/\n'
    )
    expect(await stagingGitignoreHint(skillsRoot)).toBeNull()
  })

  it('is silent when a parent .claude/ is ignored', async () => {
    put(path.join(repo, '.gitignore'), '.claude/\n')
    expect(await stagingGitignoreHint(skillsRoot)).toBeNull()
  })

  it('hints when only one of the two .gitignore entries is present, in either order', async () => {
    put(path.join(repo, '.gitignore'), '.skillsmith-writes.lock\n')
    expect(await stagingGitignoreHint(skillsRoot)).toBe(STAGING_LINE)
    put(path.join(repo, '.gitignore'), '.skillsmith-staging/\n')
    expect(await stagingGitignoreHint(skillsRoot)).toBe(STAGING_LINE)
  })

  it('is silent outside a work tree (exit 128), and the same call hints once inside one', async () => {
    const plain = path.join(sb.dir, 'plain', 'skills')
    fs.mkdirSync(plain, { recursive: true })
    expect(hasGitAtOrAbove(plain)).toBe(false) // the tmpdir must really be outside any work tree
    expect(await stagingGitignoreHint(plain)).toBeNull()
    expectOnlyCheckIgnore(plain)
  })

  it('is silent for a root that does not exist (git exits 128)', async () => {
    expect(await stagingGitignoreHint(path.join(sb.dir, 'no-such-root'))).toBeNull()
  })

  it('never edits a git file: bytes and mtimes of .gitignore, info/exclude and config are unchanged', async () => {
    put(path.join(repo, '.gitignore'), 'node_modules/\n')
    put(path.join(repo, '.git', 'info', 'exclude'), '# local\n')
    const files = ['.gitignore', '.git/info/exclude', '.git/config'].map((f) => path.join(repo, f))
    const snap = () =>
      files.map((f) => [fs.readFileSync(f, 'utf8'), fs.statSync(f).mtimeMs, fs.statSync(f).ino])
    const before = snap()
    expect(await stagingGitignoreHint(skillsRoot)).toBe(STAGING_LINE)
    await parkedAreaGitignoreHint(skillsRoot, 'op-1')
    expect(snap()).toEqual(before)
    expect(fs.existsSync(path.join(skillsRoot, '.skillsmith-staging'))).toBe(false)
    expectOnlyCheckIgnore(skillsRoot)
  })
})

describe('parked-area hint', () => {
  it('prints exactly one line when the path is not ignored, asking about the opId path', async () => {
    const hint = await parkedAreaGitignoreHint(skillsRoot, 'op-77')
    expect(hint).toBe(PARKED_LINE)
    expect(expectOnlyCheckIgnore(skillsRoot)).toEqual(['.skillsmith-parked/op-77'])
  })

  it('asks about a path under the directory name the parked area is really made with', async () => {
    await parkedAreaGitignoreHint(skillsRoot, 'op-77')
    expect(expectOnlyCheckIgnore(skillsRoot)).toEqual([`${PARKED_DIR_NAME}/op-77`])
  })

  it('is silent under a .skillsmith-parked/ rule, whether or not the area exists', async () => {
    put(path.join(repo, '.gitignore'), '.skillsmith-parked/\n')
    expect(await parkedAreaGitignoreHint(skillsRoot, 'op-77')).toBeNull()
    fs.mkdirSync(path.join(skillsRoot, '.skillsmith-parked', 'op-77'), { recursive: true })
    expect(await parkedAreaGitignoreHint(skillsRoot, 'op-77')).toBeNull()
  })

  it('is silent via .git/info/exclude and via the global excludes file', async () => {
    put(path.join(repo, '.git', 'info', 'exclude'), '.skillsmith-parked/\n')
    expect(await parkedAreaGitignoreHint(skillsRoot, 'op-1')).toBeNull()
    fs.rmSync(path.join(repo, '.git', 'info', 'exclude'))
    expect(await parkedAreaGitignoreHint(skillsRoot, 'op-1')).toBe(PARKED_LINE)
    put(path.join(sb.home, '.config', 'git', 'ignore'), '.skillsmith-parked/\n')
    expect(await parkedAreaGitignoreHint(skillsRoot, 'op-1')).toBeNull()
  })

  it('is silent outside a work tree', async () => {
    const plain = path.join(sb.dir, 'plain')
    fs.mkdirSync(plain, { recursive: true })
    expect(await parkedAreaGitignoreHint(plain, 'op-1')).toBeNull()
    expectOnlyCheckIgnore(plain)
  })
})

describe('never under lock 1', () => {
  const holdLock1 = <T>(fn: () => Promise<T>): Promise<T> =>
    withFileLock(path.join(sb.dir, 'writes'), 'test lock 1', fn, { rank: '1' })

  it('staging hint throws held-while-planning before running git', async () => {
    const outcome = await holdLock1(() =>
      stagingGitignoreHint(skillsRoot).then(
        () => 'resolved' as const,
        (error: unknown) => error
      )
    )
    expect(outcome).toBeInstanceOf(LockOrderError)
    expect((outcome as LockOrderError).kind).toBe('held-while-planning')
    expect(gitCalls()).toEqual([])
    // control: the same call outside the lock does run git
    expect(await stagingGitignoreHint(skillsRoot)).toBe(STAGING_LINE)
    expect(gitCalls().length).toBeGreaterThan(0)
  })

  it('parked hint throws held-while-planning before running git', async () => {
    const outcome = await holdLock1(() =>
      parkedAreaGitignoreHint(skillsRoot, 'op-1').then(
        () => 'resolved' as const,
        (error: unknown) => error
      )
    )
    expect(outcome).toBeInstanceOf(LockOrderError)
    expect((outcome as LockOrderError).kind).toBe('held-while-planning')
    expect(gitCalls()).toEqual([])
  })

  it('runs again once the lock is released', async () => {
    await holdLock1(async () => undefined)
    expect(await parkedAreaGitignoreHint(skillsRoot, 'op-1')).toBe(PARKED_LINE)
  })
})

describe('other git outcomes print nothing (C8)', () => {
  it('exit 129 gives no hint, for both helpers; the stub was consulted', async () => {
    const log = path.join(sb.dir, 'stub.log')
    installStubGit(sb, `#!/bin/sh\necho called >> '${log}'\nexit 129\n`)
    expect(await stagingGitignoreHint(skillsRoot)).toBeNull()
    expect(await parkedAreaGitignoreHint(skillsRoot, 'op-1')).toBeNull()
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('a git killed by a signal gives no hint', async () => {
    installStubGit(sb, '#!/bin/sh\nkill -9 $$\n')
    expect(await stagingGitignoreHint(skillsRoot)).toBeNull()
  })

  it('a git that hangs is cut off at the timeout and gives no hint', async () => {
    const started = Date.now()
    installStubGit(sb, '#!/bin/sh\nexec sleep 30\n')
    const outcome = await Promise.race([
      stagingGitignoreHint(skillsRoot, { timeoutMs: 300 }),
      new Promise<string>((resolve) => setTimeout(() => resolve('UNBOUNDED'), 4000)),
    ])
    expect(outcome).toBeNull()
    expect(Date.now() - started).toBeLessThan(4000)
  })
})

describe('git missing from PATH: the .git walk (C9)', () => {
  it('hints when a .git directory is above the root', async () => {
    removeGitFromPath(sb)
    expect(await stagingGitignoreHint(skillsRoot)).toBe(STAGING_LINE)
    expect(await parkedAreaGitignoreHint(skillsRoot, 'op-1')).toBe(PARKED_LINE)
  })

  it('hints when the root itself holds the .git entry, and when it is a gitfile', async () => {
    removeGitFromPath(sb)
    expect(await stagingGitignoreHint(repo)).toBe(STAGING_LINE)
    const linked = path.join(sb.dir, 'linked', 'skills')
    put(path.join(sb.dir, 'linked', '.git'), 'gitdir: /elsewhere\n')
    fs.mkdirSync(linked, { recursive: true })
    expect(await stagingGitignoreHint(linked)).toBe(STAGING_LINE)
  })

  it('prints nothing when no .git exists at or above the root', async () => {
    const plain = path.join(sb.dir, 'plain', 'skills')
    fs.mkdirSync(plain, { recursive: true })
    expect(hasGitAtOrAbove(plain)).toBe(false)
    removeGitFromPath(sb)
    expect(await stagingGitignoreHint(plain)).toBeNull()
    expect(await parkedAreaGitignoreHint(plain, 'op-1')).toBeNull()
  })

  it('ignores git config and ignore files: the walk reads existence only', async () => {
    put(
      path.join(repo, '.gitignore'),
      '.skillsmith-writes.lock\n.skillsmith-staging/\n.skillsmith-parked/\n'
    )
    removeGitFromPath(sb)
    expect(await stagingGitignoreHint(skillsRoot)).toBe(STAGING_LINE)
  })
})
