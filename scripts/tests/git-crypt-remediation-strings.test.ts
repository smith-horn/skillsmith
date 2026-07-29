/**
 * SMI-5702 T11 (required by the plan's review): assert that no remediation
 * string anywhere in the codebase still says `--unset` near
 * `filter.git-crypt` — this is the executable twin of `audit:standards`
 * Check 61 (scripts/audit-standards.mjs, via the same
 * findGitCryptUnsetRemediations() helper), so a green unit suite and a
 * green CI gate can never silently disagree. Also carries the two direct
 * string assertions the plan calls out by name: rebase-worktree.sh's exit-2
 * remediation must point at `worktree-crypt.sh fix`, and .husky/pre-commit's
 * manual-recovery block must not still print the old cat-sentinel /
 * unquoted-smudge sequence.
 *
 * See docs/internal/implementation/smi-5702-worktree-git-crypt-filter-deadlock.md.
 */

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error - .mjs helper has no typings
import { findGitCryptUnsetRemediations } from '../audit-git-crypt-remediation-helpers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')

// A full recursive repo-root walk + readFileSync of every non-excluded file
// legitimately exceeds the 15s vitest.preset.ts default under normal
// multi-worktree-container contention (this repo's default dev workflow,
// CLAUDE.md § Default Execution Model) -- 60s matches the E2E convention
// (vitest.e2e.config.ts) rather than widening the global preset for one
// inherently I/O-heavy test.
const REPO_WALK_TIMEOUT_MS = 60_000

describe('SMI-5702 T11: no `--unset filter.git-crypt` remediation text anywhere', () => {
  it(
    'finds zero occurrences repo-wide outside historical plan docs and self-exempt explanatory comments',
    () => {
      const findings = findGitCryptUnsetRemediations(REPO_ROOT)
      expect(findings).toEqual([])
    },
    REPO_WALK_TIMEOUT_MS
  )
})

describe('SMI-5702: direct string assertions on the two most operator-visible remediation sites', () => {
  it('rebase-worktree.sh exit-2 remediation calls print_git_crypt_filter_remediation, not --unset', () => {
    const content = readFileSync(resolve(REPO_ROOT, 'scripts', 'rebase-worktree.sh'), 'utf8')

    // Isolate the exit-2 conflict-remediation block (between "REBASE
    // CONFLICT" and the "exit 2" that ends it) rather than the whole file,
    // so this assertion is scoped to the site the plan names explicitly.
    const start = content.indexOf('REBASE CONFLICT')
    const end = content.indexOf('exit 2', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = content.slice(start, end)

    // The block calls the shared helper (scripts/_lib.sh) rather than
    // inlining the "./scripts/worktree-crypt.sh fix <path>" text itself —
    // confirmed separately below by actually running the helper.
    expect(block).toContain('print_git_crypt_filter_remediation')
    expect(block).not.toContain('--unset')
  })

  it('print_git_crypt_filter_remediation() (the function rebase-worktree.sh calls) prints the safe one-liner', () => {
    const libScript = resolve(REPO_ROOT, 'scripts', '_lib.sh')
    // Pass libScript via env rather than interpolating it into the -c string:
    // JSON.stringify() only produces JS-string-safe quoting, not shell-safe
    // quoting -- it doesn't escape `$`, so a checkout path containing `$(...)`
    // would be live for bash's double-quote command substitution (CodeQL
    // #113 finding, verified by direct reproduction during SMI-5887).
    const result = execFileSync(
      'bash',
      ['-c', 'source "$LIB_SCRIPT"; print_git_crypt_filter_remediation /some/worktree'],
      { encoding: 'utf8', env: { ...process.env, LIB_SCRIPT: libScript } }
    )
    expect(result).toContain('./scripts/worktree-crypt.sh fix /some/worktree')
    expect(result).not.toContain('--unset')
  })

  it('.husky/pre-commit manual-recovery block has neither a bare cat sentinel nor an unquoted git-crypt smudge restore', () => {
    const content = readFileSync(resolve(REPO_ROOT, '.husky', 'pre-commit'), 'utf8')

    const start = content.indexOf('Auto-restore failed. Manual recovery:')
    const end = content.indexOf('Emergency bypass', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = content.slice(start, end)

    expect(block).not.toMatch(/filter\.git-crypt\.(smudge|clean)\s+cat/)
    expect(block).not.toMatch(/'git-crypt smudge'/)
    expect(block).toContain('worktree-crypt.sh fix')
  })
})
