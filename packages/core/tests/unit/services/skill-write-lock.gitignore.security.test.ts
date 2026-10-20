/**
 * SMI-6531 (A1 step 2), owner decision C6: the hint must not run a program a
 * repository's config names, and must not answer for another repository because
 * of an inherited GIT_DIR / GIT_CONFIG* variable. Every case pairs the
 * protected call with a positive control proving the trap is live.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLockTrackerEnabledForTests } from '../../../src/config/lock-tracker.js'
import {
  childGitEnv,
  parkedAreaGitignoreHint,
  stagingGitignoreHint,
} from '../../../src/services/skill-write-lock.gitignore.js'
import {
  initRepo,
  makeSandbox,
  put,
  rawGit,
  stubExecutable,
  type Sandbox,
} from './skill-write-lock.gitignore.helpers.js'

const STAGING_LINE =
  "hint: to keep Skillsmith's temporary files out of git status, add .skillsmith-writes.lock and .skillsmith-staging/ to .gitignore"
const PARKED_LINE =
  "hint: to keep Skillsmith's parked copies out of git status, add .skillsmith-parked/ to .gitignore"

let sb: Sandbox
let repo: string
let skillsRoot: string
let marker: string
let hook: string

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  sb = makeSandbox()
  repo = initRepo(path.join(sb.dir, 'repo'))
  skillsRoot = path.join(repo, '.claude', 'skills')
  fs.mkdirSync(skillsRoot, { recursive: true })
  marker = path.join(sb.dir, 'MARKER')
  hook = stubExecutable(
    path.join(sb.dir, 'hooks'),
    'fsmonitor.sh',
    `#!/bin/sh\ntouch '${marker}'\nexit 0\n`
  )
})

afterEach(() => {
  sb.cleanup()
})

describe('repository-configured programs (core.fsmonitor)', () => {
  it('does not run the fsmonitor program; git status in the same repo does', async () => {
    rawGit(['-C', repo, 'config', 'core.fsmonitor', hook])

    // positive control: the trap is live for an ordinary git command
    rawGit(['-C', repo, 'status'])
    expect(fs.existsSync(marker)).toBe(true)
    fs.rmSync(marker)

    // the hint ran git and got its answer (presence), without running the program
    expect(await stagingGitignoreHint(skillsRoot)).toBe(STAGING_LINE)
    expect(await parkedAreaGitignoreHint(skillsRoot, 'op-1')).toBe(PARKED_LINE)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('does not run an fsmonitor program reached through include.path; unhardened check-ignore does', async () => {
    const included = path.join(sb.dir, 'included.cfg')
    put(included, `[core]\n\tfsmonitor = ${hook}\n`)
    rawGit(['-C', repo, 'config', 'include.path', included])

    // positive control: check-ignore without the flag runs it
    rawGit(['-C', skillsRoot, 'check-ignore', '-q', '.skillsmith-writes.lock'])
    expect(fs.existsSync(marker)).toBe(true)
    fs.rmSync(marker)

    expect(await stagingGitignoreHint(skillsRoot)).toBe(STAGING_LINE)
    expect(fs.existsSync(marker)).toBe(false)
  })
})

describe('inherited git environment', () => {
  /** Another repository whose rules ignore everything. */
  function ignoreEverythingRepo(): string {
    const other = initRepo(path.join(sb.dir, 'other'))
    put(path.join(other, '.git', 'info', 'exclude'), '*\n')
    return path.join(other, '.git')
  }

  it('GIT_DIR naming another repo does not change the answer for a root inside a work tree', async () => {
    const otherGitDir = ignoreEverythingRepo()
    // positive control: with GIT_DIR passed through, git answers "ignored" (0) for the same path
    const polluted = rawGit(['-C', skillsRoot, 'check-ignore', '-q', '.skillsmith-writes.lock'], {
      GIT_DIR: otherGitDir,
    })
    expect(polluted.status).toBe(0)
    const clean = rawGit(['-C', skillsRoot, 'check-ignore', '-q', '.skillsmith-writes.lock'])
    expect(clean.status).toBe(1)

    process.env.GIT_DIR = otherGitDir
    expect(await stagingGitignoreHint(skillsRoot)).toBe(STAGING_LINE)
    expect(await parkedAreaGitignoreHint(skillsRoot, 'op-1')).toBe(PARKED_LINE)
  })

  it('GIT_DIR naming another repo does not turn a root outside any work tree into "ignored"', async () => {
    const otherGitDir = path.join(initRepo(path.join(sb.dir, 'other')), '.git')
    const plain = path.join(sb.dir, 'plain', 'skills')
    fs.mkdirSync(plain, { recursive: true })
    const polluted = rawGit(['-C', plain, 'check-ignore', '-q', '.skillsmith-writes.lock'], {
      GIT_DIR: otherGitDir,
    })
    const clean = rawGit(['-C', plain, 'check-ignore', '-q', '.skillsmith-writes.lock'])
    expect(clean.status).toBe(128)
    // control: the variable makes git answer "not ignored" (1), which would print a hint
    expect(polluted.status).toBe(1)

    process.env.GIT_DIR = otherGitDir
    expect(await stagingGitignoreHint(plain)).toBeNull()
    expect(await parkedAreaGitignoreHint(plain, 'op-1')).toBeNull()
  })

  it('GIT_CONFIG_COUNT injecting core.excludesFile does not change the answer', async () => {
    const excludes = path.join(sb.dir, 'injected-excludes')
    put(excludes, '.skillsmith-writes.lock\n.skillsmith-staging/\n.skillsmith-parked/\n')
    const injected = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.excludesFile',
      GIT_CONFIG_VALUE_0: excludes,
    }
    // positive control: passed through, the injected config hides the paths
    expect(
      rawGit(['-C', skillsRoot, 'check-ignore', '-q', '.skillsmith-writes.lock'], injected).status
    ).toBe(0)

    Object.assign(process.env, injected)
    expect(await stagingGitignoreHint(skillsRoot)).toBe(STAGING_LINE)
    expect(await parkedAreaGitignoreHint(skillsRoot, 'op-1')).toBe(PARKED_LINE)
  })

  it('childGitEnv drops exactly the redirecting variables and keeps the rest', () => {
    const scrubbed = childGitEnv({
      PATH: '/bin',
      HOME: '/h',
      XDG_CONFIG_HOME: '/x',
      GIT_DIR: 'a',
      GIT_WORK_TREE: 'b',
      GIT_INDEX_FILE: 'c',
      GIT_COMMON_DIR: 'd',
      GIT_OBJECT_DIRECTORY: 'e',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'k',
      GIT_CONFIG_GLOBAL: '/g',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'kept',
    })
    expect(scrubbed).toEqual({
      PATH: '/bin',
      HOME: '/h',
      XDG_CONFIG_HOME: '/x',
      GIT_AUTHOR_NAME: 'kept',
    })
  })
})
