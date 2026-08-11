/**
 * SMI-5983: acquire_git_crypt_filter_lock()/release_git_crypt_filter_lock()
 * trap-composition tests. Split out of git-crypt-filter-lock-marker.test.ts
 * once that file plus this addition exceeded the 500-line file-length
 * guidance. Same harness (scripts/tests/_lib/git-crypt-lock-marker-helpers.ts):
 * source the real scripts/_lib.sh via `source`, exercise real functions
 * against plain `git init` temp-dir fixtures.
 *
 * First-round NEEDLE review finding: a reusable lock must never silently
 * clobber a caller's pre-existing EXIT/INT/TERM traps -- concretely,
 * rebase-worktree.sh's `trap restore_filter_config EXIT` is itself what
 * fires this lock (restore_filter_config() acquires it too) during a
 * crash-path restore, so overwriting that trap used to mean a crash while
 * this lock was held would release the mutex but never actually restore
 * the git-crypt filters. Fixed by capturing the caller's prior trap command
 * and composing it into the new trap body (release first, since the prior
 * handler may itself re-acquire this same non-reentrant lock).
 *
 * Second-round NEEDLE review finding (on the FIX itself): the fixed
 * "release...; ${prev}; exit N" INT/TERM template collapses to a genuine
 * bash syntax error (an empty statement between two semicolons) whenever
 * there is no prior INT/TERM handler -- confirmed via direct reproduction,
 * bash silently drops the ENTIRE trap body on that syntax error, leaking
 * the lock and swallowing the signal. Fixed by building each trap body
 * conditionally instead of via a fixed template.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  makeRepo,
  sourceAndRun,
  cleanupTrackedTempDirs,
} from './_lib/git-crypt-lock-marker-helpers.js'

afterEach(() => cleanupTrackedTempDirs())

describe('SMI-5983: acquire/release_git_crypt_filter_lock() composes with, never clobbers, a caller trap', () => {
  it('a pre-existing EXIT trap still fires exactly once after an acquire/release cycle', () => {
    const dir = makeRepo()
    const result = sourceAndRun(
      `my_cleanup() { echo PRIOR_HANDLER_RAN; }
       trap my_cleanup EXIT
       acquire_git_crypt_filter_lock ${JSON.stringify(dir)}
       release_git_crypt_filter_lock`
    )
    const occurrences = (result.stdout.match(/PRIOR_HANDLER_RAN/g) || []).length
    expect(occurrences).toBe(1)
  })

  it('a prior EXIT trap still runs even when the process exits WHILE the lock is held (crash-path)', () => {
    const dir = makeRepo()
    const result = sourceAndRun(
      `my_cleanup() { echo PRIOR_HANDLER_RAN; }
       trap my_cleanup EXIT
       acquire_git_crypt_filter_lock ${JSON.stringify(dir)}
       exit 1`
    )
    expect(result.stdout).toContain('PRIOR_HANDLER_RAN')
    // The lock itself must also have been released by the composed trap,
    // not left dangling because the caller's own handler ran instead.
    expect(existsSync(join(dir, '.git', 'skillsmith-git-crypt-filter.lock'))).toBe(false)
  })

  it('repeated acquire/release cycles in one process compose without hanging or infinite recursion', () => {
    const dir = makeRepo()
    const result = sourceAndRun(
      `for i in 1 2 3 4 5; do
         acquire_git_crypt_filter_lock ${JSON.stringify(dir)}
         release_git_crypt_filter_lock
       done
       echo DONE_5_CYCLES`
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('DONE_5_CYCLES')
  })

  // SMI-5983 second-round NEEDLE review finding: a fixed
  // "release...; ${prev}; exit N" template collapses to a genuine bash
  // syntax error (an empty statement between two semicolons) whenever
  // there is NO prior INT/TERM handler -- the whole trap body then
  // silently fails to run at all, leaking the lock and swallowing the
  // signal. The EXIT-only tests above didn't cover this because EXIT's
  // template has nothing AFTER ${prev_exit_cmd}, so an empty value there
  // only ever produces a harmless trailing semicolon, never a bare one
  // sandwiched between two statements. INT/TERM needed their own coverage.
  it('INT with no prior handler: releases the lock and exits 130 (not a syntax error)', () => {
    const dir = makeRepo()
    const result = sourceAndRun(
      `acquire_git_crypt_filter_lock ${JSON.stringify(dir)}
       kill -INT $$`
    )
    expect(result.status).toBe(130)
    expect(result.combined).not.toMatch(/syntax error/i)
    expect(existsSync(join(dir, '.git', 'skillsmith-git-crypt-filter.lock'))).toBe(false)
  })

  it('INT with a prior handler: runs it, releases the lock, and exits 130', () => {
    const dir = makeRepo()
    const result = sourceAndRun(
      `my_int_handler() { echo PRIOR_INT_RAN; }
       trap my_int_handler INT
       acquire_git_crypt_filter_lock ${JSON.stringify(dir)}
       kill -INT $$`
    )
    expect(result.status).toBe(130)
    expect(result.stdout).toContain('PRIOR_INT_RAN')
    expect(result.combined).not.toMatch(/syntax error/i)
    expect(existsSync(join(dir, '.git', 'skillsmith-git-crypt-filter.lock'))).toBe(false)
  })

  it('TERM with no prior handler: releases the lock and exits 143 (not a syntax error)', () => {
    const dir = makeRepo()
    const result = sourceAndRun(
      `acquire_git_crypt_filter_lock ${JSON.stringify(dir)}
       kill -TERM $$`
    )
    expect(result.status).toBe(143)
    expect(result.combined).not.toMatch(/syntax error/i)
    expect(existsSync(join(dir, '.git', 'skillsmith-git-crypt-filter.lock'))).toBe(false)
  })

  it('TERM with a prior handler: runs it, releases the lock, and exits 143', () => {
    const dir = makeRepo()
    const result = sourceAndRun(
      `my_term_handler() { echo PRIOR_TERM_RAN; }
       trap my_term_handler TERM
       acquire_git_crypt_filter_lock ${JSON.stringify(dir)}
       kill -TERM $$`
    )
    expect(result.status).toBe(143)
    expect(result.stdout).toContain('PRIOR_TERM_RAN')
    expect(result.combined).not.toMatch(/syntax error/i)
    expect(existsSync(join(dir, '.git', 'skillsmith-git-crypt-filter.lock'))).toBe(false)
  })
})
