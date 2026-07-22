/**
 * SMI-5781: stabilize_encrypted_index_stats() (stash-mtime race) tests,
 * split out of `rebase-worktree.git-crypt-resmudge.test.ts` (same file
 * originally) once that file exceeded CLAUDE.md's 500-line file-length
 * guidance. Fixture helpers live in the shared `rebase-worktree.helpers.ts`
 * (same split convention as `prune-orphaned-docker-volumes.test.ts`/
 * `.helpers.ts`, SMI-5750/PR#1968).
 *
 * No actual Skillsmith repo or git-crypt encryption is used -- these tests
 * simulate git-crypt with a portable, reversible filter pair (see
 * `setupGitCryptFixture` in `rebase-worktree.helpers.ts`).
 *
 * Root cause under test: `git stash push` (Step 6, `step_stash()` in
 * `rebase-worktree.sh`) re-checks-out every previously-unstaged path back to
 * HEAD's content, leaving each a RACY mtime. If Step 7 then swaps the
 * git-crypt clean filter to identity (`cat`) before that raciness is
 * resolved, Step 9's `git rebase` pre-flight clean-tree check re-verifies a
 * racy entry's content under the WRONG (identity) clean filter instead of
 * git-crypt's real encrypting filter -- producing a spurious "You have
 * unstaged changes" rejection on a file that is genuinely clean.
 * `stabilize_encrypted_index_stats()` (`scripts/_rebase-git-crypt.sh`)
 * closes that window by backdating each tracked encrypted regular file's
 * mtime and refreshing the index before Step 7 runs. See
 * `docs/internal/implementation/smi-5781-rebase-worktree-stash-racy-mtime.md`
 * for the full root-cause writeup.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  git,
  sh,
  runScript,
  makeTempDir,
  setupGitCryptRepoWithWorktree,
  setupGitCryptFixture,
  sourceAndRun,
} from './rebase-worktree.helpers.js'

/** Age (in seconds) of a tracked file's current mtime, for backdate assertions. */
function mtimeAgeSeconds(absPath: string): number {
  return (Date.now() - statSync(absPath).mtimeMs) / 1000
}

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

describe('SMI-5781: stabilize_encrypted_index_stats() (stash-mtime race)', () => {
  it('backdates every currently tracked encrypted path in a single run', () => {
    const tempRoot = makeTempDir('rw-5781-multi')
    tempDirs.push(tempRoot)
    const { worktreeDir } = setupGitCryptRepoWithWorktree(tempRoot, {
      'enc/file.txt': 'v1',
      'enc/other.txt': 'v1',
      'enc/nested/deep.txt': 'v1',
    })

    const result = sourceAndRun({
      worktreeDir,
      call: [
        'stabilize_encrypted_index_stats',
        // SMI-5781 code-review followup: prove the index REFRESH itself
        // took effect (git cached a trustworthy "clean" stat while the
        // CORRECT git-crypt clean filter was still active), not merely
        // that touch ran. Mirror Step 7's filter swap to the identity
        // `cat` clean filter, then check `git diff --quiet`: if the
        // refresh cached a trustworthy stat beforehand, git never re-reads
        // the paths' content through the now-wrong filter at all, so they
        // still report clean despite the swap. Without a successful
        // refresh, `git diff --quiet` would fall through to a real content
        // comparison under the wrong filter and report them dirty.
        'git -C "$WORKTREE_PATH" config --local filter.git-crypt.clean cat',
        'rc=0',
        'git -C "$WORKTREE_PATH" diff --quiet -- enc/file.txt enc/other.txt enc/nested/deep.txt || rc=$?',
        'echo "DIFFQUIET:$rc"',
      ].join('\n'),
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('DIFFQUIET:0')

    for (const rel of ['enc/file.txt', 'enc/other.txt', 'enc/nested/deep.txt']) {
      const age = mtimeAgeSeconds(join(worktreeDir, rel))
      expect(age).toBeGreaterThan(3000)
      expect(age).toBeLessThan(4200)
    }
  })

  it('touches only the encrypted file, leaving a plaintext file mtime untouched (scoping)', () => {
    const tempRoot = makeTempDir('rw-5781-mixed')
    tempDirs.push(tempRoot)
    const { worktreeDir } = setupGitCryptRepoWithWorktree(tempRoot, {
      'enc/file.txt': 'v1',
      'plain.txt': 'base',
    })

    const plainMtimeBefore = statSync(join(worktreeDir, 'plain.txt')).mtimeMs

    const result = sourceAndRun({ worktreeDir, call: 'stabilize_encrypted_index_stats' })
    expect(result.status).toBe(0)

    // Plaintext file: not a filter=git-crypt path, so check-attr never
    // matches it -- mtime must be bit-for-bit unchanged.
    expect(statSync(join(worktreeDir, 'plain.txt')).mtimeMs).toBe(plainMtimeBefore)

    // Encrypted file: backdated (proves the scoping is real, not accidental).
    expect(mtimeAgeSeconds(join(worktreeDir, 'enc', 'file.txt'))).toBeGreaterThan(3000)
  })

  it('never runs and logs nothing under --dry-run', () => {
    const tempRoot = makeTempDir('rw-5781-dryrun')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupGitCryptRepoWithWorktree(tempRoot)

    // Unstaged edit to the encrypted file -- ensures step_stash() doesn't
    // hit its OTHER early return ("nothing to stash") before reaching the
    // --dry-run check.
    sh(`echo "wip edit" > "${join(worktreeDir, 'enc', 'file.txt')}"`)
    const mtimeBefore = statSync(join(worktreeDir, 'enc', 'file.txt')).mtimeMs

    git(cloneDir, 'checkout main')
    sh(`echo "advance" > "${join(cloneDir, 'other.txt')}"`)
    git(cloneDir, 'add other.txt')
    git(cloneDir, 'commit -m "advance main"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    const result = runScript(`--dry-run "${worktreeDir}"`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Would stash unstaged changes')
    expect(result.stdout).not.toContain('Stabilizing encrypted-file index timestamps')

    // The function never ran -- mtime is exactly what the unstaged edit left it at.
    expect(statSync(join(worktreeDir, 'enc', 'file.txt')).mtimeMs).toBe(mtimeBefore)
  })

  it('never runs and logs nothing when there is nothing to stash (no-op)', () => {
    const tempRoot = makeTempDir('rw-5781-noop')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupGitCryptRepoWithWorktree(tempRoot)

    // No unstaged changes in the worktree at all -- only main advances
    // (via a non-encrypted file, keeping the rebase itself uninteresting).
    git(cloneDir, 'checkout main')
    sh(`echo "advance" > "${join(cloneDir, 'other.txt')}"`)
    git(cloneDir, 'add other.txt')
    git(cloneDir, 'commit -m "advance main"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('No unstaged changes to stash')
    expect(result.stdout).not.toContain('Stabilizing encrypted-file index timestamps')
  })

  it('warns but continues (non-fatal) when touch fails on an encrypted path', () => {
    const tempRoot = makeTempDir('rw-5781-touch-fail')
    tempDirs.push(tempRoot)
    const { worktreeDir } = setupGitCryptRepoWithWorktree(tempRoot)

    const result = sourceAndRun({
      worktreeDir,
      setup: ['touch() { return 1; }'],
      call: 'stabilize_encrypted_index_stats; echo "EXIT:$?"',
    })
    // Non-fatal: the function still returns 0, no new exit code introduced.
    expect(result.stdout).toContain('EXIT:0')
    const combined = result.stdout + result.stderr
    expect(combined).toContain('could not stabilize index stats')
    expect(combined).toContain('stat-cache race')
  })

  it('warns but continues (non-fatal) when git update-index --refresh fails', () => {
    const tempRoot = makeTempDir('rw-5781-refresh-fail')
    tempDirs.push(tempRoot)
    const { worktreeDir } = setupGitCryptRepoWithWorktree(tempRoot)

    const result = sourceAndRun({
      worktreeDir,
      setup: [
        // Fail only the specific `git -C <path> update-index ...` call this
        // function makes -- every other git invocation (ls-files,
        // check-attr, etc.) must still delegate to the real binary.
        'git() { if [ "$1" = "-C" ] && [ "$3" = "update-index" ]; then return 1; fi; command git "$@"; }',
      ],
      call: 'stabilize_encrypted_index_stats; echo "EXIT:$?"',
    })
    expect(result.stdout).toContain('EXIT:0')
    const combined = result.stdout + result.stderr
    expect(combined).toContain('update-index --refresh failed')
    expect(combined).toContain('stat-cache race')
  })

  it('warns but continues (non-fatal) when the ls-files/check-attr enumeration pipeline fails', () => {
    const tempRoot = makeTempDir('rw-5781-enum-fail')
    tempDirs.push(tempRoot)
    const { worktreeDir } = setupGitCryptRepoWithWorktree(tempRoot)

    const result = sourceAndRun({
      worktreeDir,
      setup: [
        // Fail only the `check-attr` half of the enumeration pipe -- proves
        // a failure anywhere in `ls-files -z | check-attr -z filter --stdin`
        // is detected (not silently swallowed by the process-substitution
        // form this replaced), since pipefail surfaces the rightmost
        // failing command's status through the `if !` check.
        'git() { if [ "$1" = "-C" ] && [ "$3" = "check-attr" ]; then return 1; fi; command git "$@"; }',
      ],
      call: 'stabilize_encrypted_index_stats; echo "EXIT:$?"',
    })
    // Non-fatal: the function still returns 0, no new exit code introduced.
    expect(result.stdout).toContain('EXIT:0')
    const combined = result.stdout + result.stderr
    expect(combined).toContain('could not enumerate git-crypt-encrypted paths')
  })

  it('warns but continues (non-fatal) when the ls-files -s index-entry lookup fails', () => {
    const tempRoot = makeTempDir('rw-5781-lsfiles-s-fail')
    tempDirs.push(tempRoot)
    const { worktreeDir } = setupGitCryptRepoWithWorktree(tempRoot)

    const result = sourceAndRun({
      worktreeDir,
      setup: [
        // Fail only the second enumeration call (`ls-files -s -z -- ...`),
        // distinguished from the first pipeline's plain `ls-files -z` by
        // its `-s` flag in $4 -- the first `ls-files -z | check-attr` call
        // must still succeed so this test reaches the second enumeration.
        'git() { if [ "$1" = "-C" ] && [ "$3" = "ls-files" ] && [ "$4" = "-s" ]; then return 1; fi; command git "$@"; }',
      ],
      call: 'stabilize_encrypted_index_stats; echo "EXIT:$?"',
    })
    expect(result.stdout).toContain('EXIT:0')
    const combined = result.stdout + result.stderr
    expect(combined).toContain('could not resolve encrypted-path index entries')
  })

  it('excludes a tracked symlink under the encrypted-path glob from stabilization', () => {
    const tempRoot = makeTempDir('rw-5781-symlink')
    tempDirs.push(tempRoot)
    const { worktreeDir } = setupGitCryptRepoWithWorktree(tempRoot)

    // A symlink whose target lives OUTSIDE the encrypted-path glob (and
    // could just as well live outside the worktree entirely) -- portable
    // `touch` follows symlinks by default, so if this were mistakenly
    // touched, the TARGET's mtime (not the symlink dirent's own) would move.
    writeFileSync(join(worktreeDir, 'outside-target.txt'), 'target content\n')
    symlinkSync('../outside-target.txt', join(worktreeDir, 'enc', 'link.txt'))
    git(worktreeDir, 'add outside-target.txt enc/link.txt')
    git(worktreeDir, 'commit -m "add symlink under encrypted glob"')

    const targetMtimeBefore = statSync(join(worktreeDir, 'outside-target.txt')).mtimeMs

    const result = sourceAndRun({ worktreeDir, call: 'stabilize_encrypted_index_stats' })
    expect(result.status).toBe(0)

    expect(statSync(join(worktreeDir, 'outside-target.txt')).mtimeMs).toBe(targetMtimeBefore)

    // The symlink's own index mode is still 120000 -- confirms enumeration
    // excluded it via the mode check rather than merely "happening" not to
    // touch its target.
    const mode = git(worktreeDir, 'ls-files -s -- enc/link.txt').split(' ')[0]
    expect(mode).toBe('120000')
  })

  it('excludes an initialized submodule gitlink under the encrypted-path glob from stabilization', () => {
    const tempRoot = makeTempDir('rw-5781-submodule')
    tempDirs.push(tempRoot)
    const bareDir = join(tempRoot, 'bare.git')
    const subBareDir = join(tempRoot, 'sub-bare.git')
    const cloneDir = join(tempRoot, 'clone')
    const worktreeDir = join(tempRoot, 'wt')

    git(tempRoot, `init --bare "${bareDir}"`)
    git(tempRoot, `init --bare "${subBareDir}"`)

    const subSeedDir = join(tempRoot, 'sub-seed')
    git(tempRoot, `clone "${subBareDir}" "${subSeedDir}"`)
    sh(`touch "${join(subSeedDir, 'doc.md')}"`)
    git(subSeedDir, 'add doc.md')
    git(subSeedDir, 'commit -m "sub initial"')
    git(subSeedDir, 'push origin main')

    git(tempRoot, `clone "${bareDir}" "${cloneDir}"`)
    setupGitCryptFixture(cloneDir, 'enc')
    sh(`echo "v1" > "${join(cloneDir, 'enc', 'file.txt')}"`)
    git(cloneDir, 'add .gitattributes enc/file.txt')
    git(cloneDir, 'commit -m "initial"')
    // Submodule path deliberately falls UNDER the encrypted-path glob, so
    // check-attr's filter=git-crypt resolution matches the gitlink entry too.
    git(cloneDir, `submodule add "${subBareDir}" enc/sub`)
    git(cloneDir, 'commit -m "add submodule under encrypted glob"')
    git(cloneDir, 'push origin main')

    git(cloneDir, `worktree add -b feature "${worktreeDir}"`)
    git(worktreeDir, 'submodule update --init')

    // Make the submodule's own working tree dirty -- this must not change
    // the gitlink entry recorded in the parent index (still 160000, still
    // the initially committed SHA) and must not be treated as a regular
    // file by mode-based exclusion.
    const wtSub = join(worktreeDir, 'enc', 'sub')
    sh(`echo "dirty" >> "${join(wtSub, 'doc.md')}"`)

    const gitlinkBefore = git(worktreeDir, 'ls-files -s -- enc/sub')

    const result = sourceAndRun({ worktreeDir, call: 'stabilize_encrypted_index_stats' })
    expect(result.status).toBe(0)

    const gitlinkAfter = git(worktreeDir, 'ls-files -s -- enc/sub')
    expect(gitlinkAfter).toBe(gitlinkBefore)
    expect(gitlinkAfter.split(' ')[0]).toBe('160000')

    // The regular encrypted file in the same run is still correctly backdated.
    expect(mtimeAgeSeconds(join(worktreeDir, 'enc', 'file.txt'))).toBeGreaterThan(3000)
  })
})
