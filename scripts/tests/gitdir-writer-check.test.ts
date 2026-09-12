/**
 * SMI-6515 Wave 2 Step 2: executable twin of `audit:standards` Check 69 --
 * flags a tracked file containing an absolute `--separate-git-dir`
 * invocation (`--separate-git-dir=/...` or `--separate-git-dir /...`).
 * See docs/internal/implementation/smi-6515-absolute-gitdir-detector.md.
 *
 * The helper enumerates `git ls-files`, not a filesystem walk (fixed
 * post-review: the prior filesystem-walk implementation reported its
 * denominator as "tracked file(s) scanned" while never actually consulting
 * git, so the count included gitignored/untracked files and was off by
 * 1000+ against the real tracked count). Every fixture here is therefore a
 * real (if minimal) git repo, not a bare temp directory -- `git ls-files`
 * has nothing to enumerate otherwise.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error - .mjs helper has no typings
import { findAbsoluteSeparateGitDirWriters } from '../audit-gitdir-writer-helpers.mjs'
// SMI-4693: every fixture `git` spawn below must route through
// makeFixtureEnv/makeFixtureTempDir -- see scripts/tests/_lib/git-fixture-env.ts.
import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

// A full `git ls-files` enumeration + readFileSync of every tracked file
// legitimately exceeds the 15s vitest.preset.ts default under normal
// multi-worktree-container contention (this repo's default dev workflow,
// CLAUDE.md's Default Execution Model) -- 60s matches the same convention
// git-crypt-remediation-strings.test.ts uses for the same reason.
const REPO_WALK_TIMEOUT_MS = 60_000

describe('findAbsoluteSeparateGitDirWriters (fixture cases)', () => {
  const roots: string[] = []

  // Builds a real, minimal git repo and STAGES every given file (`git add`,
  // no commit needed -- `git ls-files` reads the index) so the helper's
  // `git ls-files` call has a real tracked set to enumerate.
  function makeFixtureRepo(files: Record<string, string>): string {
    const root = makeFixtureTempDir('smi6515-gitdir')
    roots.push(root)
    const env = makeFixtureEnv()
    execFileSync('git', ['init', '--quiet'], { cwd: root, env })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root, env })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root, env })
    for (const [relPath, content] of Object.entries(files)) {
      const full = join(root, relPath)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content, 'utf8')
    }
    execFileSync('git', ['add', '-A'], { cwd: root, env })
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

  // Regression case for the finding that motivated the git-ls-files
  // rewrite: an untracked file present on disk must NOT move the
  // "tracked file(s) scanned" denominator, since it was never tracked.
  it('does not count an untracked file toward the denominator', () => {
    const root = makeFixtureRepo({
      'tracked.md': 'nothing interesting here\n',
    })
    // Written AFTER makeFixtureRepo's `git add -A`, so deliberately never
    // staged/tracked -- the exact shape of "an untracked local note".
    writeFileSync(join(root, 'untracked-note.md'), 'a local scratch note\n', 'utf8')
    const { filesChecked, findings } = findAbsoluteSeparateGitDirWriters(root)
    expect(findings).toEqual([])
    expect(filesChecked).toBe(1)
  })

  // The prior filesystem-walk implementation degraded silently: no git,
  // no problem, it just walked disk under a "tracked" label that was no
  // longer true. The fix must fail loudly instead of relabeling a
  // different measurement as "tracked".
  it('throws rather than silently falling back to a filesystem walk when the target is not a git repo', () => {
    const root = makeFixtureTempDir('smi6515-nogit')
    roots.push(root)
    writeFileSync(join(root, 'some-doc.md'), 'nothing interesting here\n', 'utf8')
    expect(() => findAbsoluteSeparateGitDirWriters(root)).toThrow(/ls-files.*failed/i)
  })
})

// Whether `git ls-files` can run against this checkout AT ALL. It cannot
// inside a worktree's own container: `git worktree add` writes an absolute
// gitdir into the worktree's `.git`, pointing into the main checkout, and
// that host path does not exist in the container (SMI-6549). Pre-push runs
// exactly there, so this is not a hypothetical.
//
// The helper THROWING in that situation is correct and deliberate -- it
// refuses to relabel a filesystem walk as "tracked". So the environment
// check belongs here in the test, not as a softening of the helper.
function gitLsFilesWorksHere(): { ok: boolean; reason: string } {
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z', '--recurse-submodules'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      ...makeFixtureEnv(),
    })
    return { ok: true, reason: '' }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message.split('\n')[0] : String(err) }
  }
}

const GIT_LS_FILES = gitLsFilesWorksHere()

describe(`SMI-6515 Wave 2: live repo scan (git ls-files usable here: ${GIT_LS_FILES.ok})`, () => {
  it(
    'finds zero occurrences repo-wide outside the allow-listed recipe and historical plan docs, having actually scanned files',
    (ctx) => {
      // A skip must announce what it skipped and why -- a silent skip here
      // would report green while asserting nothing about the live repo,
      // which is the exact class ADR-151 exists for.
      if (!GIT_LS_FILES.ok) {
        ctx.skip(
          `git ls-files cannot run against ${REPO_ROOT} in this environment, so the live-repo scan cannot be performed. ` +
            `This is expected inside a worktree container (SMI-6549) and the host run does cover it. Reason: ${GIT_LS_FILES.reason}`
        )
        return
      }
      const { filesChecked, findings } = findAbsoluteSeparateGitDirWriters(REPO_ROOT)
      expect(findings).toEqual([])
      // Anti-vacuous check: a PASS with a zero denominator would mean the
      // scan silently examined nothing, which is not a real PASS.
      expect(filesChecked).toBeGreaterThan(100)
    },
    REPO_WALK_TIMEOUT_MS
  )
})
