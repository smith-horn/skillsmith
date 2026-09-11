/**
 * SMI-6515 Wave 2 Step 2: executable twin of `audit:standards` Check 69 --
 * flags a tracked file containing an absolute `--separate-git-dir`
 * invocation (`--separate-git-dir=/...` or `--separate-git-dir /...`).
 * See docs/internal/implementation/smi-6515-absolute-gitdir-detector.md.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error - .mjs helper has no typings
import { findAbsoluteSeparateGitDirWriters } from '../audit-gitdir-writer-helpers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

// A full recursive repo-root walk + readFileSync of every non-excluded
// file legitimately exceeds the 15s vitest.preset.ts default under normal
// multi-worktree-container contention (this repo's default dev workflow,
// CLAUDE.md's Default Execution Model) -- 60s matches the same convention
// git-crypt-remediation-strings.test.ts uses for the same reason.
const REPO_WALK_TIMEOUT_MS = 60_000

describe('findAbsoluteSeparateGitDirWriters (fixture cases)', () => {
  const roots: string[] = []

  function makeFixtureRepo(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'smi6515-gitdir-'))
    roots.push(root)
    for (const [relPath, content] of Object.entries(files)) {
      const full = join(root, relPath)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content, 'utf8')
    }
    return root
  }

  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true })
  })

  it('fires on --separate-git-dir=<absolute> (equals form) and reports a nonzero denominator', () => {
    const root = makeFixtureRepo({
      'some-doc.md': 'git clone --separate-git-dir=/Users/dev/repo/.git/modules/x -- url path\n',
    })
    const { filesChecked, findings } = findAbsoluteSeparateGitDirWriters(root)
    expect(findings).toHaveLength(1)
    expect(findings[0].file).toBe('some-doc.md')
    expect(filesChecked).toBe(1)
  })

  it('fires on --separate-git-dir /absolute (space form)', () => {
    const root = makeFixtureRepo({
      'recipe.sh':
        'git clone --no-checkout --separate-git-dir /Users/dev/repo/.git/modules/x -- url path\n',
    })
    const { findings } = findAbsoluteSeparateGitDirWriters(root)
    expect(findings).toHaveLength(1)
    expect(findings[0].file).toBe('recipe.sh')
  })

  it('does not fire on a relative --separate-git-dir, but still counts the file as checked', () => {
    const root = makeFixtureRepo({
      'recipe.sh': 'git clone --separate-git-dir=../../.git/modules/x -- url path\n',
    })
    const { filesChecked, findings } = findAbsoluteSeparateGitDirWriters(root)
    expect(findings).toEqual([])
    expect(filesChecked).toBe(1)
  })

  it('does not fire on a placeholder-style example with no real path character', () => {
    const root = makeFixtureRepo({
      'recipe.md': 'change `--separate-git-dir=<absolute>` to a relative path\n',
    })
    expect(findAbsoluteSeparateGitDirWriters(root).findings).toEqual([])
  })

  it('exempts docs/internal/implementation/** historical plan docs, and excludes them from the denominator', () => {
    const root = makeFixtureRepo({
      'docs/internal/implementation/smi-example.md':
        'git clone --separate-git-dir=/Users/dev/repo/.git/modules/x -- url path\n',
    })
    const { filesChecked, findings } = findAbsoluteSeparateGitDirWriters(root)
    expect(findings).toEqual([])
    expect(filesChecked).toBe(0)
  })

  it('exempts .claude/development/git-crypt-guide.md by exact path', () => {
    const root = makeFixtureRepo({
      '.claude/development/git-crypt-guide.md':
        'git clone --separate-git-dir=/Users/dev/repo/.git/modules/x -- url path\n',
    })
    const { filesChecked, findings } = findAbsoluteSeparateGitDirWriters(root)
    expect(findings).toEqual([])
    expect(filesChecked).toBe(0)
  })

  it('does not exempt a same-named file in a different directory', () => {
    const root = makeFixtureRepo({
      'somewhere-else/git-crypt-guide.md':
        'git clone --separate-git-dir=/Users/dev/repo/.git/modules/x -- url path\n',
    })
    expect(findAbsoluteSeparateGitDirWriters(root).findings).toHaveLength(1)
  })

  it('counts multiple non-matching files toward the denominator without producing findings', () => {
    const root = makeFixtureRepo({
      'a.md': 'nothing interesting here\n',
      'b.md': 'nor here\n',
      'c.sh': '#!/usr/bin/env bash\necho hi\n',
    })
    const { filesChecked, findings } = findAbsoluteSeparateGitDirWriters(root)
    expect(findings).toEqual([])
    expect(filesChecked).toBe(3)
  })
})

describe('SMI-6515 Wave 2: live repo has zero absolute --separate-git-dir writers', () => {
  it(
    'finds zero occurrences repo-wide outside the allow-listed recipe and historical plan docs, having actually scanned files',
    () => {
      const { filesChecked, findings } = findAbsoluteSeparateGitDirWriters(REPO_ROOT)
      expect(findings).toEqual([])
      // Anti-vacuous check: a PASS with a zero denominator would mean the
      // walk silently examined nothing, which is not a real PASS.
      expect(filesChecked).toBeGreaterThan(100)
    },
    REPO_WALK_TIMEOUT_MS
  )
})
