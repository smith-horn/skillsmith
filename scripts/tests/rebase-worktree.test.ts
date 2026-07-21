/**
 * Integration tests for rebase-worktree.sh (SMI-3102, Wave 2).
 *
 * All tests create throwaway git repos in temp directories.
 *
 * SMI-5773 post-rebase git-crypt re-smudge tests live in the sibling
 * `rebase-worktree.git-crypt-resmudge.test.ts` (split by concern, not just
 * line count, once this file plus the new SMI-5773 suite together exceeded
 * CLAUDE.md's 500-line file-length guidance). Fixture helpers for both
 * files live in `rebase-worktree.helpers.ts` (same split convention as
 * `prune-orphaned-docker-volumes.test.ts`/`.helpers.ts`, SMI-5750/PR#1968).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'

import {
  git,
  sh,
  runScript,
  makeTempDir,
  setupRepoWithWorktree,
  setupSubmoduleRepoWithWorktree,
} from './rebase-worktree.helpers.js'

// Collect temp dirs for cleanup
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  tempDirs.length = 0
})

describe('SMI-3102: rebase-worktree.sh', () => {
  // Scenario 1: Happy path — worktree behind main, no submodule
  it('rebases a worktree that is behind main', () => {
    const tempRoot = makeTempDir('rw-test1')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupRepoWithWorktree(tempRoot)

    // Advance main by 1 commit (via clone, push to bare)
    git(cloneDir, 'checkout main')
    sh(`echo "new content" > "${join(cloneDir, 'file.txt')}"`)
    git(cloneDir, 'add file.txt')
    git(cloneDir, 'commit -m "advance main"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -') // back to whatever branch

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Rebase complete')

    // Verify the worktree has the new commit from main
    const log = git(worktreeDir, 'log --oneline')
    expect(log).toContain('advance main')
  })

  // Scenario 2: Happy path — worktree behind main, submodule pointer diverged
  it('rebases with submodule pointer update', () => {
    const tempRoot = makeTempDir('rw-test2')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupSubmoduleRepoWithWorktree(tempRoot)

    // Advance submodule in main: add a commit to submodule, update pointer in main
    const subInClone = join(cloneDir, 'docs', 'internal')
    git(cloneDir, 'checkout main')
    sh(`echo "updated" > "${join(subInClone, 'new.md')}"`)
    git(subInClone, 'add new.md')
    git(subInClone, 'commit -m "sub advance"')
    git(subInClone, 'push origin main')
    git(cloneDir, 'add docs/internal')
    git(cloneDir, 'commit -m "bump submodule"')
    git(cloneDir, 'push origin main')

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Rebase complete')

    // Verify worktree submodule is at the new pointer
    const subHead = git(join(worktreeDir, 'docs', 'internal'), 'rev-parse HEAD')
    const targetSubSha = git(cloneDir, 'ls-tree HEAD -- docs/internal').split(/\s+/)[2]
    expect(subHead).toBe(targetSubSha)
  })

  // Scenario 3: Already up-to-date
  it('exits 0 with up-to-date message when no rebase needed', () => {
    const tempRoot = makeTempDir('rw-test3')
    tempDirs.push(tempRoot)
    const { worktreeDir } = setupRepoWithWorktree(tempRoot)

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('up-to-date')
  })

  // Scenario 4: Non-submodule conflict
  it('exits 2 with conflict instructions on non-submodule conflict', () => {
    const tempRoot = makeTempDir('rw-test4')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupRepoWithWorktree(tempRoot)

    // Create conflicting changes: same file, different content
    // Commit on worktree branch
    sh(`echo "worktree content" > "${join(worktreeDir, 'conflict.txt')}"`)
    git(worktreeDir, 'add conflict.txt')
    git(worktreeDir, 'commit -m "worktree change"')

    // Commit on main (via clone), push
    git(cloneDir, 'checkout main')
    sh(`echo "main content" > "${join(cloneDir, 'conflict.txt')}"`)
    git(cloneDir, 'add conflict.txt')
    git(cloneDir, 'commit -m "main change"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(2)
    const combined = result.stdout + result.stderr
    expect(combined).toContain('REBASE CONFLICT')
    expect(combined).toContain('conflict.txt')

    // Clean up: abort the in-progress rebase so rmSync can remove the dir
    try {
      git(worktreeDir, 'rebase --abort')
    } catch {
      /* may already be clean */
    }
  })

  // Scenario 5: Invalid worktree path
  it('exits 1 for a non-existent path', () => {
    const result = runScript('/tmp/does-not-exist-ever-12345')
    expect(result.status).toBe(1)
    const combined = result.stdout + result.stderr
    expect(combined).toMatch(/does not exist|not a git repository/i)
  })

  // Scenario 6: --dry-run
  it('prints planned steps without mutations on --dry-run', () => {
    const tempRoot = makeTempDir('rw-test6')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupRepoWithWorktree(tempRoot)

    // Advance main so there is something to rebase
    git(cloneDir, 'checkout main')
    sh(`echo "dry-run content" > "${join(cloneDir, 'dry.txt')}"`)
    git(cloneDir, 'add dry.txt')
    git(cloneDir, 'commit -m "advance for dry-run"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    // Record HEAD before dry-run
    const headBefore = git(worktreeDir, 'rev-parse HEAD')

    const result = runScript(`--dry-run "${worktreeDir}"`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('dry-run')
    expect(result.stdout).toContain('Dry run complete')

    // Verify no mutation: HEAD unchanged
    const headAfter = git(worktreeDir, 'rev-parse HEAD')
    expect(headAfter).toBe(headBefore)
  })

  // SMI-4766: --dry-run honored regardless of position relative to positional args.
  // Pre-fix, `case ... *) break ;;` exited the flag loop on the first positional,
  // silently dropping any flag that appeared after it.
  it('honors --dry-run when passed AFTER positional args (SMI-4766)', () => {
    const tempRoot = makeTempDir('rw-test6b')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupRepoWithWorktree(tempRoot)

    git(cloneDir, 'checkout main')
    sh(`echo "after-positional" > "${join(cloneDir, 'after.txt')}"`)
    git(cloneDir, 'add after.txt')
    git(cloneDir, 'commit -m "advance for SMI-4766 after-positional"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    const headBefore = git(worktreeDir, 'rev-parse HEAD')

    const result = runScript(`"${worktreeDir}" origin/main --dry-run`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('dry-run')
    expect(result.stdout).toContain('Dry run complete')

    const headAfter = git(worktreeDir, 'rev-parse HEAD')
    expect(headAfter).toBe(headBefore)
  })

  it('honors --dry-run when interspersed with positional args (SMI-4766)', () => {
    const tempRoot = makeTempDir('rw-test6c')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupRepoWithWorktree(tempRoot)

    git(cloneDir, 'checkout main')
    sh(`echo "interspersed" > "${join(cloneDir, 'inter.txt')}"`)
    git(cloneDir, 'add inter.txt')
    git(cloneDir, 'commit -m "advance for SMI-4766 interspersed"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    const headBefore = git(worktreeDir, 'rev-parse HEAD')

    const result = runScript(`"${worktreeDir}" --dry-run origin/main`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('dry-run')
    expect(result.stdout).toContain('Dry run complete')

    const headAfter = git(worktreeDir, 'rev-parse HEAD')
    expect(headAfter).toBe(headBefore)
  })

  // Scenario 7: --no-submodule
  it('skips submodule steps when --no-submodule is passed', () => {
    const tempRoot = makeTempDir('rw-test7')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupSubmoduleRepoWithWorktree(tempRoot)

    // Advance main
    git(cloneDir, 'checkout main')
    sh(`echo "new" > "${join(cloneDir, 'extra.txt')}"`)
    git(cloneDir, 'add extra.txt')
    git(cloneDir, 'commit -m "advance main"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    const result = runScript(`--no-submodule "${worktreeDir}"`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--no-submodule')
    // The success report should NOT show submodule info
    expect(result.stdout).not.toContain('Submodule: docs/internal')
  })

  // Scenario 8: Staged changes
  it('exits 1 when worktree has staged changes', () => {
    const tempRoot = makeTempDir('rw-test8')
    tempDirs.push(tempRoot)
    const { worktreeDir } = setupRepoWithWorktree(tempRoot)

    // Stage a file
    sh(`echo "staged" > "${join(worktreeDir, 'staged.txt')}"`)
    git(worktreeDir, 'add staged.txt')

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(1)
    const combined = result.stdout + result.stderr
    expect(combined).toContain('staged changes')
  })

  // Scenario 9: Submodule ahead of target (directional guard)
  it('exits 1 when worktree submodule is ahead of target', () => {
    const tempRoot = makeTempDir('rw-test9')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupSubmoduleRepoWithWorktree(tempRoot)

    // Advance the worktree's submodule AHEAD of main's pointer
    const wtSub = join(worktreeDir, 'docs', 'internal')
    sh(`echo "ahead content" > "${join(wtSub, 'ahead.md')}"`)
    git(wtSub, 'add ahead.md')
    git(wtSub, 'commit -m "worktree sub ahead"')

    // Advance main (non-submodule change) so rebase is needed
    git(cloneDir, 'checkout main')
    sh(`echo "main advance" > "${join(cloneDir, 'main-file.txt')}"`)
    git(cloneDir, 'add main-file.txt')
    git(cloneDir, 'commit -m "advance main"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(1)
    const combined = result.stdout + result.stderr
    expect(combined).toContain('AHEAD')
  })

  // SMI-4773: Scenario 10 — strict-descendant submodule + --allow-submodule-ahead
  it('exits 0 with --allow-submodule-ahead when worktree submodule is a strict descendant', () => {
    const tempRoot = makeTempDir('rw-test10')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupSubmoduleRepoWithWorktree(tempRoot)

    // Advance worktree submodule strictly ahead (descendant) of main's pointer
    const wtSub = join(worktreeDir, 'docs', 'internal')
    sh(`echo "ahead content" > "${join(wtSub, 'ahead.md')}"`)
    git(wtSub, 'add ahead.md')
    git(wtSub, 'commit -m "worktree sub ahead"')
    const wtSubSha = git(wtSub, 'rev-parse HEAD')

    // Advance main parent (non-submodule change) so rebase is needed
    git(cloneDir, 'checkout main')
    sh(`echo "main advance" > "${join(cloneDir, 'main-file.txt')}"`)
    git(cloneDir, 'add main-file.txt')
    git(cloneDir, 'commit -m "advance main"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    const result = runScript(`--allow-submodule-ahead "${worktreeDir}"`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('strict descendant')

    // Worktree submodule SHA should be unchanged (still the descendant SHA)
    const wtSubShaAfter = git(wtSub, 'rev-parse HEAD')
    expect(wtSubShaAfter).toBe(wtSubSha)
  })

  // SMI-4773: Scenario 11 — divergent submodule + --allow-submodule-ahead must still error
  it('exits 1 with --allow-submodule-ahead when worktree submodule has DIVERGED', () => {
    const tempRoot = makeTempDir('rw-test11')
    tempDirs.push(tempRoot)
    const { subBareDir, cloneDir, worktreeDir } = setupSubmoduleRepoWithWorktree(tempRoot)

    // Worktree advances submodule to its own SHA (commit A)
    const wtSub = join(worktreeDir, 'docs', 'internal')
    sh(`echo "wt branch" > "${join(wtSub, 'wt.md')}"`)
    git(wtSub, 'add wt.md')
    git(wtSub, 'commit -m "wt commit A"')

    // Main also advances submodule to a DIFFERENT SHA (commit B) — divergence
    const mainSubClone = join(tempRoot, 'main-sub-clone')
    git(tempRoot, `clone "${subBareDir}" "${mainSubClone}"`)
    sh(`echo "main branch" > "${join(mainSubClone, 'main.md')}"`)
    git(mainSubClone, 'add main.md')
    git(mainSubClone, 'commit -m "main commit B"')
    git(mainSubClone, 'push origin main')

    git(cloneDir, 'checkout main')
    git(cloneDir, 'submodule update --remote docs/internal')
    git(cloneDir, 'add docs/internal')
    git(cloneDir, 'commit -m "main: bump submodule"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    const result = runScript(`--allow-submodule-ahead "${worktreeDir}"`)
    expect(result.status).toBe(1)
    const combined = result.stdout + result.stderr
    expect(combined).toContain('diverged')
  })
})
