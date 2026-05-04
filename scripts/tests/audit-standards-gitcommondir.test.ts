/**
 * Companion to audit-standards.test.ts (SMI-3986 / Check 23 worktree
 * integration). Extracted to a sibling file to keep audit-standards.test.ts
 * under the 500-line CI gate (SMI-3493) after the SMI-4693 helper migration
 * pushed it to 506. This file's `describe` name is unchanged so the suite
 * structure in vitest output stays identical.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

describe('audit-standards Check 23: gitCommonDir worktree integration', () => {
  let tmpRoot: string | null = null

  beforeAll(() => {
    // Sanity check: git is installed in the test environment
    try {
      execSync('git --version', { stdio: 'ignore' })
    } catch {
      throw new Error('git is required for the worktree integration test')
    }
  })

  afterEach(() => {
    if (tmpRoot && existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
    tmpRoot = null
  })

  it('SMI-3986: git rev-parse --git-common-dir resolves to main .git from inside a worktree', () => {
    tmpRoot = makeFixtureTempDir('audit-standards-worktree')
    const main = join(tmpRoot, 'main')
    const wt = join(tmpRoot, 'wt')
    // SMI-4693: makeFixtureEnv strips GIT_DISCOVERY_VARS.
    const env = makeFixtureEnv({
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@example.com',
    })
    execSync(`git init --quiet "${main}"`, { env })
    execSync(`git -C "${main}" commit --allow-empty -m init --quiet`, { env })
    execSync(`git -C "${main}" worktree add --quiet "${wt}"`, { env })

    // Inside the worktree, .git is a FILE (not a directory)
    expect(existsSync(join(wt, '.git'))).toBe(true)
    const dotGitContent = readFileSync(join(wt, '.git'), 'utf-8')
    expect(dotGitContent).toMatch(/^gitdir:/)

    // The fix: git rev-parse --git-common-dir resolves to main's .git (SMI-4693: sanitised env).
    const commonDir = execSync('git rev-parse --git-common-dir', {
      cwd: wt,
      encoding: 'utf-8',
      env,
    }).trim()

    // Normalize: --git-common-dir may be relative (to wt) OR absolute. Use
    // path.resolve, which honors absolute paths and otherwise resolves
    // relative to wt. realpathSync collapses any /private/var <-> /var
    // symlinks (macOS tmpdir).
    const resolved = realpathSync(resolve(wt, commonDir))
    const expected = realpathSync(join(main, '.git'))
    expect(resolved).toBe(expected)

    // The shallow file is what the audit-standards Check 23 actually checks for
    expect(existsSync(join(resolved, 'shallow'))).toBe(false)
  })
})
