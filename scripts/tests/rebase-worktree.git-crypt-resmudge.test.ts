/**
 * SMI-5773: post-rebase git-crypt re-smudge tests, split out of
 * `rebase-worktree.test.ts` (same file, same describe block originally) once
 * that file plus these tests together exceeded CLAUDE.md's 500-line
 * file-length guidance. Fixture helpers live in the shared
 * `rebase-worktree.helpers.ts` (same split convention as
 * `prune-orphaned-docker-volumes.test.ts`/`.helpers.ts`, SMI-5750/PR#1968).
 *
 * No actual Skillsmith repo or git-crypt encryption is used -- these tests
 * simulate git-crypt with a portable, reversible filter pair (see
 * `setupGitCryptFixture` in `rebase-worktree.helpers.ts`).
 *
 * Racy-git note (read before touching the regression/detector tests): a
 * fast, back-to-back "disable filters -> rebase -> restore filters ->
 * checkout" sequence does NOT reproduce the stat-clean-skip bug on its own.
 * Git's `checkout_entry_ca()` calls `ie_match_stat()` without
 * `CE_MATCH_RACY_IS_DIRTY`, so whenever the cache entry's mtime is "racy"
 * (not safely older than the index file's own last-write time -- true for
 * any fast synthetic sequence), git falls back to an actual content
 * re-verification instead of trusting the stat, and that re-check happens
 * to self-correct in this exact repro shape. `buildRebaseResidueFixture()`
 * backdates the rewritten file's mtime (then `git update-index --refresh`)
 * to deterministically reproduce the genuinely non-racy state a real
 * multi-second script run has in production -- this is what made SMI-5750
 * intermittent but is easy to lose if this fixture gets "simplified" later.
 *
 * The SAME racy-git mechanism has a second manifestation that surprised
 * this test suite during authoring: merely DISABLING git-crypt filters
 * (config-only, no file write) on a just-checked-out worktree makes git's
 * own pre-flight "clean working tree" check (run internally by `git
 * rebase`, and by `git stash push`'s own re-checkout of a stashed path)
 * force a content re-verification of any RACY pre-existing tracked file
 * under the encrypted-path glob -- and that re-check naturally mismatches
 * under the now-identity clean filter, producing a spurious "You have
 * unstaged changes" failure for a file the test never touched. See
 * `backdateTrackedPath()` in the helpers file, and its use both right after
 * worktree creation (`setupGitCryptRepoWithWorktree`,
 * `buildRebaseResidueFixture`) and, in the encrypted-path stash test below,
 * again right after `git stash push` (whose own internal checkout re-primes
 * the same raciness for the file it just restored to HEAD).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'

import {
  git,
  sh,
  runScript,
  makeTempDir,
  setupGitCryptRepoWithWorktree,
  preFixResmudge,
  hasCiphertextPrefix,
  sourceAndRun,
  buildRebaseResidueFixture,
  setupSubmoduleAheadGitCryptFixture,
  stashDisableRebaseRestore,
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

describe('SMI-5773: post-rebase git-crypt re-smudge', () => {
  // Regression test: proves the pre-fix mechanism AND the fix, driven by a
  // real `git rebase` (not a shortcut — see this file's header for why the
  // Step 4 "already up-to-date" early-exit makes shortcut tests risky here).
  it('force_resmudge clears ciphertext residue that a bare checkout leaves behind (regression)', () => {
    const tempRoot = makeTempDir('rw-5773-regress')
    tempDirs.push(tempRoot)
    const fx = buildRebaseResidueFixture(tempRoot)

    // (a) the target genuinely differs -- the rebase did not hit Step 4's
    // "already up-to-date" early-exit.
    expect(fx.mergeBase).not.toBe(fx.targetSha)

    // (b) immediately after the rebase-under-cat step, the file carries the
    // raw \0GITCRYPT prefix (smudge=cat left the ciphertext blob verbatim).
    expect(hasCiphertextPrefix(fx.filePath)).toBe(true)

    // (c) `git diff --quiet` reports the file clean at this point --
    // content is bit-identical to the stored blob under the identity `cat`
    // filter, which is the stat-clean precondition the bug depends on.
    expect(() => git(fx.worktreeDir, 'diff --quiet')).not.toThrow()

    // (d) on the pre-SMI-5773 sequence (config restore + a bare
    // `checkout HEAD -- <paths>`, no rm) the ciphertext prefix survives --
    // proves the existing checkout no-ops on exactly the file that needs
    // re-smudging (buildRebaseResidueFixture already forced the non-racy
    // state that makes this reproducible — see file header).
    preFixResmudge(fx.worktreeDir, 'enc')
    expect(hasCiphertextPrefix(fx.filePath)).toBe(true)

    // (e) on the fixed code (force_resmudge: rm then checkout) the prefix
    // is gone and the real content is restored.
    const result = sourceAndRun({ worktreeDir: fx.worktreeDir, call: 'force_resmudge' })
    expect(result.status).toBe(0)
    expect(hasCiphertextPrefix(fx.filePath)).toBe(false)
    expect(sh(`cat "${fx.filePath}"`)).toBe('v2 from main')
  })

  it('scan_ciphertext flags residue left by the pre-fix sequence and clears once force_resmudge runs (detector)', () => {
    const tempRoot = makeTempDir('rw-5773-detect')
    tempDirs.push(tempRoot)
    const fx = buildRebaseResidueFixture(tempRoot)

    // Reproduce the pre-fix residue state (same mechanism as the regression test).
    preFixResmudge(fx.worktreeDir, 'enc')
    expect(hasCiphertextPrefix(fx.filePath)).toBe(true)

    const dirty = sourceAndRun({
      worktreeDir: fx.worktreeDir,
      call: [
        'rc=0',
        'scan_ciphertext || rc=$?',
        'echo "RC:$rc"',
        `printf 'BAD:%s\\n' "\${SCAN_RESULT_BAD[@]:-}"`,
      ].join('\n'),
    })
    expect(dirty.stdout).toContain('RC:1')
    expect(dirty.stdout).toContain(`BAD:${fx.relPath}`)

    const clean = sourceAndRun({
      worktreeDir: fx.worktreeDir,
      call: ['force_resmudge', 'rc=0', 'scan_ciphertext || rc=$?', 'echo "RC:$rc"'].join('\n'),
    })
    expect(clean.stdout).toContain('RC:0')
    expect(clean.stdout).toContain('Ciphertext scan clean')
  })

  it('scan_ciphertext treats a missing tracked encrypted-path file as a failure, not a silent skip', () => {
    const tempRoot = makeTempDir('rw-5773-missing')
    tempDirs.push(tempRoot)
    const { worktreeDir } = setupGitCryptRepoWithWorktree(tempRoot)

    // Delete the tracked encrypted-path file WITHOUT checking it back out.
    rmSync(join(worktreeDir, 'enc', 'file.txt'))

    const result = sourceAndRun({
      worktreeDir,
      call: [
        'rc=0',
        'scan_ciphertext || rc=$?',
        'echo "RC:$rc"',
        `printf 'MISSING:%s\\n' "\${SCAN_RESULT_MISSING[@]:-}"`,
      ].join('\n'),
    })
    expect(result.stdout).toContain('RC:1')
    expect(result.stdout).toContain('MISSING:enc/file.txt')
  })

  it('force_resmudge does not touch an untracked file under the encrypted-path glob', () => {
    const tempRoot = makeTempDir('rw-5773-untracked')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupGitCryptRepoWithWorktree(tempRoot)

    // Untracked file under the encrypted-path glob -- must survive
    // force_resmudge, which only removes TRACKED files (`git ls-files -z`).
    sh(`echo "scratch, never added" > "${join(worktreeDir, 'enc', 'scratch.txt')}"`)

    git(cloneDir, 'checkout main')
    sh(`echo "v2 from main" > "${join(cloneDir, 'enc', 'file.txt')}"`)
    git(cloneDir, 'add enc/file.txt')
    git(cloneDir, 'commit -m "advance main"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Rebase complete')
    expect(result.stdout).toContain('Ciphertext scan clean')
    expect(sh(`cat "${join(worktreeDir, 'enc', 'scratch.txt')}"`)).toBe('scratch, never added')
  })

  it('stash interplay: a non-encrypted unstaged edit survives the resmudge/scan window', () => {
    const tempRoot = makeTempDir('rw-5773-stash-plain')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupGitCryptRepoWithWorktree(tempRoot, {
      'enc/file.txt': 'v1',
      'plain.txt': 'base',
    })

    // Unstaged edit to a NON-encrypted tracked file -- stashed at Step 6,
    // popped at Step 11, must survive the force_resmudge/scan window in between.
    sh(`echo "wip edit" > "${join(worktreeDir, 'plain.txt')}"`)

    git(cloneDir, 'checkout main')
    sh(`echo "v2 from main" > "${join(cloneDir, 'enc', 'file.txt')}"`)
    git(cloneDir, 'add enc/file.txt')
    git(cloneDir, 'commit -m "advance main"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Stash popped')
    expect(sh(`cat "${join(worktreeDir, 'plain.txt')}"`)).toBe('wip edit')
  })

  it('stash interplay: an encrypted-path unstaged edit survives the resmudge/scan window', () => {
    const tempRoot = makeTempDir('rw-5773-stash-enc')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupGitCryptRepoWithWorktree(tempRoot, {
      'enc/file.txt': 'v1',
      'enc/other.txt': 'v1',
    })

    // Unstaged edit to a DIFFERENT file under the encrypted-path glob than
    // the one main is about to change -- this is what gets stashed at
    // Step 6 and must survive force_resmudge's rm+checkout at Step 10
    // (which operates on the committed HEAD version while the edit is
    // stashed away) before being popped back on top at Step 11.
    sh(`echo "wip enc edit" > "${join(worktreeDir, 'enc', 'other.txt')}"`)

    git(cloneDir, 'checkout main')
    sh(`echo "v2 from main" > "${join(cloneDir, 'enc', 'file.txt')}"`)
    git(cloneDir, 'add enc/file.txt')
    git(cloneDir, 'commit -m "advance main"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')
    git(worktreeDir, 'fetch origin main')

    // Driven step-by-step (Steps 6/7/9/10/11) rather than via the full
    // black-box script: `git stash push` itself re-checks-out enc/other.txt
    // (fresh mtime), which would otherwise leave it RACY for the immediately
    // following filter-disable + `git rebase` pre-flight clean-tree check --
    // same mechanism as backdateTrackedPath()'s doc comment, just triggered
    // by the stash's own internal checkout instead of the worktree's
    // initial one, and therefore not something a pre-`runScript()` backdate
    // can reach (it happens INSIDE the script's single fast invocation).
    // See stashDisableRebaseRestore()'s doc comment for the full mechanism.
    //
    // NOTE (SMI-5781, found in SMI-5773's code review): this manual
    // step-driving is NOT a stand-in proving the real end-to-end script
    // succeeds on this input -- it doesn't. `runScript()` genuinely fails
    // here via `git rebase`'s own pre-flight check (Step 9, unmodified by
    // this PR), a distinct pre-existing bug filed as SMI-5781. This test
    // verifies ONLY that force_resmudge/scan_ciphertext (this PR's actual
    // fix, Step 10) behave correctly once that unrelated Step 9 failure is
    // sidestepped. See the adjacent `it.fails()` KNOWN ISSUE test below for
    // the real-script behavior.
    stashDisableRebaseRestore(worktreeDir)
    const restore = sourceAndRun({ worktreeDir, call: 'force_resmudge' })
    expect(restore.status).toBe(0)
    git(worktreeDir, 'stash pop')

    expect(sh(`cat "${join(worktreeDir, 'enc', 'other.txt')}"`)).toBe('wip enc edit')
    expect(sh(`cat "${join(worktreeDir, 'enc', 'file.txt')}"`)).toBe('v2 from main')
  })

  // KNOWN ISSUE (SMI-5781, found during SMI-5773's code review): the real
  // end-to-end script genuinely fails on this exact scenario -- NOT because
  // of anything force_resmudge/scan_ciphertext (this PR's fix) touches, but
  // because `git stash push`'s own internal re-checkout leaves a racy mtime
  // on the just-restored encrypted file, and `git rebase`'s pre-flight
  // clean-tree check (Step 9, unmodified by SMI-5773) then spuriously
  // rejects it as dirty once Step 7 disables filters. Same racy-git family
  // as SMI-5773's own root cause, but a different step/trigger, requiring
  // its own ADR-109 SPARC+plan-review before a fix lands -- see SMI-5781.
  // `it.fails()` documents this is a KNOWN, currently-failing case: if this
  // ever starts passing (SMI-5781 landing, or an unrelated git/environment
  // change), vitest will flag it so this gets promoted to a real assertion
  // instead of silently staying stale.
  it.fails(
    'KNOWN ISSUE (SMI-5781): full runScript() on the same encrypted-WIP-stash scenario currently fails',
    () => {
      const tempRoot = makeTempDir('rw-5773-stash-enc-e2e')
      tempDirs.push(tempRoot)
      const { cloneDir, worktreeDir } = setupGitCryptRepoWithWorktree(tempRoot, {
        'enc/file.txt': 'v1',
        'enc/other.txt': 'v1',
      })

      sh(`echo "wip enc edit" > "${join(worktreeDir, 'enc', 'other.txt')}"`)

      git(cloneDir, 'checkout main')
      sh(`echo "v2 from main" > "${join(cloneDir, 'enc', 'file.txt')}"`)
      git(cloneDir, 'add enc/file.txt')
      git(cloneDir, 'commit -m "advance main"')
      git(cloneDir, 'push origin main')
      git(cloneDir, 'checkout -')

      const result = runScript(`"${worktreeDir}"`)
      expect(result.status).toBe(0)
      expect(sh(`cat "${join(worktreeDir, 'enc', 'other.txt')}"`)).toBe('wip enc edit')
      expect(sh(`cat "${join(worktreeDir, 'enc', 'file.txt')}"`)).toBe('v2 from main')
    }
  )

  it('trap-safety: EXIT trap restores filter config on a Step 8 failure without touching tracked files or clobbering the exit code', () => {
    const tempRoot = makeTempDir('rw-5773-trap')
    tempDirs.push(tempRoot)
    const fx = setupSubmoduleAheadGitCryptFixture(tempRoot)

    const result = runScript(`"${fx.worktreeDir}"`)
    // Original exit code preserved -- force_resmudge/scan_ciphertext never
    // run from the trap (wired only into step_restore_filters()'s explicit
    // success path), so nothing downstream of the trap can clobber this.
    expect(result.status).toBe(1)
    const combined = result.stdout + result.stderr
    expect(combined).toContain('AHEAD')

    // The EXIT trap (restore_filter_config) fired even though the script
    // never reached Step 9/10 -- filter config is back to the real pair,
    // not left disabled as "cat".
    expect(git(fx.worktreeDir, 'config --local --get filter.git-crypt.smudge')).toBe('tail -c +10')
    expect(git(fx.worktreeDir, 'config --local --get filter.git-crypt.clean')).toBe(
      'printf "\\000GITCRYPT"; cat'
    )

    // force_resmudge (destructive) never ran from the trap -- the tracked
    // encrypted file is untouched.
    expect(existsSync(fx.encFilePath)).toBe(true)
  })
})
