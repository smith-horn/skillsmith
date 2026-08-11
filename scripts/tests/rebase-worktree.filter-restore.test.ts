/**
 * SMI-5979: regression tests for step_rebase_parent()'s conflict
 * classification. Split into its own file (not folded into
 * rebase-worktree.test.ts or the git-crypt-resmudge suite, both already
 * near CLAUDE.md's 500-line guidance) — same `.test.ts`/`.helpers.ts` split
 * convention as the sibling files, reusing their existing exported helpers
 * rather than adding new ones.
 *
 * Background: Step 7 disables git-crypt filters and registers an EXIT trap
 * to restore them. Step 9 (step_rebase_parent) deliberately clears that trap
 * before running `git rebase`, on the theory that a real merge conflict
 * needs filters left off for manual resolution. The bug: when `git rebase`'s
 * own pre-flight rejects the tree as dirty and NO rebase ever starts, there
 * are zero conflicted files -- but the pre-fix classification logic only had
 * two outcomes (all-submodule auto-resolve, or manual-conflict), and the
 * zero-conflict case silently fell into manual-conflict by default, exiting
 * without ever restoring the trap. This left git-crypt filters disabled
 * repo-wide with nothing to justify it (the SMI-5979 incident).
 *
 * The fix requires BOTH conflict_count==0 AND no active rebase-merge/
 * rebase-apply state before treating a failure as "nothing to resolve" --
 * per NEEDLE plan review, conflict_count==0 alone isn't proof no rebase
 * started (a sequencer failure mid-rebase, distinct from a merge conflict,
 * can leave zero unmerged files with rebase state still on disk). Case A
 * below drives step_rebase_parent() through a REAL pre-flight rejection (a
 * genuine unstaged change, not a racy-mtime timing trick -- deterministic,
 * no backdating needed). Case B manufactures a `rebase-merge` directory
 * directly, since the code under test only inspects its existence -- see
 * that test's own comment for why a synthesized directory is a faithful
 * unit test of the actual branch condition without needing to reproduce a
 * rare real interrupted-sequencer state end-to-end.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  git,
  sh,
  makeTempDir,
  setupRepoWithWorktree,
  sourceAndRun,
} from './rebase-worktree.helpers.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  tempDirs.length = 0
})

describe('SMI-5979: step_rebase_parent() conflict classification', () => {
  // Case A: pre-flight rejects, zero conflicts, no active rebase state ->
  // filters restored, exit 1, honest "nothing to resolve" message.
  it('restores filters and exits 1 when the rebase pre-flight rejects with nothing to resolve', () => {
    const tempRoot = makeTempDir('rw-smi5979-a')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupRepoWithWorktree(tempRoot)

    // Advance origin/main so a real rebase attempt (not a no-op) is needed.
    git(cloneDir, 'checkout main')
    sh(`echo "main advance" >> "${join(cloneDir, 'README.md')}"`)
    git(cloneDir, 'add README.md')
    git(cloneDir, 'commit -m "advance main"')
    git(cloneDir, 'push origin main')
    git(worktreeDir, 'fetch origin main')

    // A genuine unstaged change -- git's own pre-flight clean-tree check
    // rejects this deterministically, no racy-mtime timing needed (this
    // function is invoked directly, bypassing Steps 1-8, so nothing stashes
    // it first).
    sh(`echo "uncommitted local edit" > "${join(worktreeDir, 'README.md')}"`)

    // Simulate Step 7 having already disabled filters, exactly as the real
    // script would leave things right before step_rebase_parent() runs.
    git(worktreeDir, `config filter.git-crypt.smudge cat`)
    git(worktreeDir, `config filter.git-crypt.clean cat`)

    const result = sourceAndRun({
      worktreeDir,
      setup: [
        'TARGET_REF="origin/main"',
        'DRY_RUN=false',
        'SUBMODULES=()',
        'HAS_GIT_CRYPT=true',
        'FILTERS_DISABLED=true',
        `ORIG_SMUDGE='tail -c +10'`,
        `ORIG_CLEAN='printf "\\000GITCRYPT"; cat'`,
      ],
      call: 'step_rebase_parent',
    })

    expect(result.status).toBe(1)
    const combined = result.stdout + result.stderr
    expect(combined).toMatch(/nothing to resolve/i)
    expect(combined).not.toContain('REBASE CONFLICT')

    // Filters actually restored, not left disabled (the SMI-5979 bug).
    expect(git(worktreeDir, 'config --get filter.git-crypt.smudge')).toBe('tail -c +10')
    expect(git(worktreeDir, 'config --get filter.git-crypt.clean')).toContain('GITCRYPT')
  })

  // Case B: pre-flight rejects, zero conflicts, but active rebase-merge
  // state IS present -- must NOT be treated as "nothing to resolve". A
  // synthesized (mkdir-only) rebase-merge directory is sufficient here: the
  // code under test only checks `[ -d "$(git rev-parse --git-path
  // rebase-merge)" ]`, so this is a faithful unit test of that exact branch
  // condition without needing to reproduce a full, rare real
  // interrupted-sequencer state (e.g. an empty-after-rebase commit stop).
  // It also matches a real, plausible scenario on its own: a leftover
  // rebase-merge directory from an earlier, unrelated interrupted rebase
  // that a human still needs to `git rebase --abort`/`--continue` -- exactly
  // the case where silently restoring filters and telling the user "nothing
  // to resolve, retry" would be actively wrong.
  it('leaves filters disabled and exits 2 when active rebase state exists despite zero conflicts', () => {
    const tempRoot = makeTempDir('rw-smi5979-b')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupRepoWithWorktree(tempRoot)

    git(cloneDir, 'checkout main')
    sh(`echo "main advance" >> "${join(cloneDir, 'README.md')}"`)
    git(cloneDir, 'add README.md')
    git(cloneDir, 'commit -m "advance main"')
    git(cloneDir, 'push origin main')
    git(worktreeDir, 'fetch origin main')

    const rebaseMergePath = git(worktreeDir, 'rev-parse --git-path rebase-merge')
    mkdirSync(rebaseMergePath, { recursive: true })
    // Minimal contents so `git rebase` recognizes this as a real in-progress
    // rebase (and refuses to start a new one) rather than an empty/ignored dir.
    writeFileSync(join(rebaseMergePath, 'head-name'), 'refs/heads/feature\n')
    writeFileSync(join(rebaseMergePath, 'onto'), git(worktreeDir, 'rev-parse origin/main') + '\n')

    git(worktreeDir, `config filter.git-crypt.smudge cat`)
    git(worktreeDir, `config filter.git-crypt.clean cat`)

    const result = sourceAndRun({
      worktreeDir,
      setup: [
        'TARGET_REF="origin/main"',
        'DRY_RUN=false',
        'SUBMODULES=()',
        'HAS_GIT_CRYPT=true',
        'FILTERS_DISABLED=true',
        `ORIG_SMUDGE='tail -c +10'`,
        `ORIG_CLEAN='printf "\\000GITCRYPT"; cat'`,
      ],
      call: 'step_rebase_parent',
    })

    expect(result.status).toBe(2)
    const combined = result.stdout + result.stderr
    expect(combined).toContain('REBASE CONFLICT')
    expect(combined).not.toMatch(/nothing to resolve/i)

    // Filters must stay disabled -- a real conflict/in-progress rebase needs
    // them off for manual resolution, unchanged from pre-SMI-5979 behavior.
    expect(git(worktreeDir, 'config --get filter.git-crypt.smudge')).toBe('cat')
    expect(git(worktreeDir, 'config --get filter.git-crypt.clean')).toBe('cat')
  })
})
