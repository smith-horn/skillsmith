/**
 * SMI-5713: Tests for scripts/lib/preserve-gitlinks.sh.
 *
 * `.husky/pre-commit`'s post-lint-staged re-add (`git add <path>`) is safe for
 * regular files but wrong for a submodule gitlink (mode 160000): it stages the
 * submodule's currently-checked-out working-tree commit, not whatever SHA was
 * previously staged via `git update-index --cacheinfo`. This silently clobbers
 * a deliberately-staged pointer to a commit not locally checked out — exactly
 * the scenario a concurrent session sharing the same submodule checkout on a
 * different branch produces.
 *
 * The library exposes two pure shell functions (capture/restore), not a
 * standalone script — tests source it inside `sh -c` rather than spawning it
 * directly, mirroring how `.husky/pre-commit` itself sources it.
 *
 * Drives against an isolated temp-dir fixture (a real parent+submodule git
 * pair) — never the live repo tree.
 *
 * Cases (G- prefix):
 *   G-1 CLOBBER FIXED:    capture before blind re-add, restore after → staged
 *                         gitlink SHA is the pre-add value (SHA-B), not the
 *                         submodule's live checkout (SHA-A).
 *   G-2 NEGATIVE CONTROL: same fixture, WITHOUT calling capture/restore →
 *                         blind re-add wins → staged SHA reverts to SHA-A —
 *                         proves the fixture actually reproduces the bug.
 *   G-3 REGRESSION GUARD: a regular staged file, modified between staging and
 *                         the blind re-add, is still correctly re-added (the
 *                         original SMI-retro behavior is untouched).
 *   G-4 RESTORE FAILURE:  a malformed path in the snapshot causes
 *                         `git update-index --cacheinfo` to fail for that
 *                         entry — restore_staged_gitlinks writes an SMI-5713
 *                         diagnostic naming the path to stderr, and still
 *                         restores the remaining (valid) entries.
 *
 * SMI-4693: uses makeFixtureEnv (strips GIT_DISCOVERY_VARS) and
 * makeFixtureTempDir (realpath-canonical tmpdir) for git fixture isolation.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Absolute path to the sourced library under test.
const LIB = resolve(__dirname, '..', 'lib', 'preserve-gitlinks.sh')

/**
 * Build a minimal parent repo with a real submodule checked out at `sub/`.
 * Returns the parent repo root and the submodule's initial commit SHA (A).
 */
function makeFixture(): { root: string; shaA: string } {
  const subSource = makeFixtureTempDir('preserve-gitlinks-sub')
  const env = makeFixtureEnv()

  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', subSource], { env })
  writeFileSync(join(subSource, 'README.md'), 'sub\n', 'utf8')
  execFileSync('git', ['-C', subSource, 'add', '-A'], { env })
  execFileSync('git', ['-C', subSource, 'commit', '--quiet', '-m', 'sub init'], { env })
  const shaA = execFileSync('git', ['-C', subSource, 'rev-parse', 'HEAD'], { env })
    .toString()
    .trim()

  const root = makeFixtureTempDir('preserve-gitlinks-parent')
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', root], { env })
  writeFileSync(join(root, 'README.md'), 'parent\n', 'utf8')

  // Add `sub` as a real submodule entry (mode 160000) without requiring
  // network access — `git update-index --add --cacheinfo` creates the
  // gitlink index entry directly; the working-tree checkout at sub/ is a
  // plain clone (not a `git submodule add`), which is sufficient for
  // `git add sub` to read its HEAD when simulating the blind re-add.
  execFileSync('git', ['clone', '--quiet', subSource, join(root, 'sub')], { env })
  rmSync(join(root, 'sub', '.git'), { recursive: true, force: true })
  execFileSync(
    'git',
    ['-C', join(root, 'sub'), '-c', 'init.defaultBranch=main', 'init', '--quiet'],
    { env }
  )
  execFileSync('git', ['-C', join(root, 'sub'), 'add', '-A'], { env })
  execFileSync('git', ['-C', join(root, 'sub'), 'commit', '--quiet', '-m', 'sub init'], { env })
  execFileSync('git', ['-C', root, 'update-index', '--add', '--cacheinfo', '160000', shaA, 'sub'], {
    env,
  })
  execFileSync('git', ['-C', root, 'add', 'README.md'], { env })
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'init with submodule'], { env })

  return { root, shaA }
}

/** `git ls-files -s <path>` → staged SHA for that path (40-hex). */
function stagedSha(root: string, path: string, env: NodeJS.ProcessEnv): string {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-s', path], { env }).toString()
  const match = out.match(/^160000 ([0-9a-f]{40})/)
  if (!match) throw new Error(`no staged gitlink entry for ${path}: ${out}`)
  return match[1]!
}

/** Run a shell snippet with the library sourced, mirroring how the hook sources it. */
function runSourced(
  root: string,
  snippet: string,
  env: NodeJS.ProcessEnv
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('sh', ['-c', `. "${LIB}" && ${snippet}`], {
    cwd: root,
    encoding: 'utf8',
    env,
    timeout: 15_000,
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

describe('scripts/lib/preserve-gitlinks.sh', () => {
  it('G-1: capture + restore preserves a staged gitlink SHA across a blind re-add', () => {
    const { root, shaA } = makeFixture()
    const env = { ...makeFixtureEnv(), PATH: process.env['PATH'] ?? '/usr/bin:/bin' }

    // A well-formed but non-existent 40-hex SHA — gitlinks are never
    // dereferenced by git itself, so this is accepted for staging purposes.
    const shaB = 'b'.repeat(40)
    execFileSync('git', ['-C', root, 'update-index', '--cacheinfo', '160000', shaB, 'sub'], {
      env,
    })
    expect(stagedSha(root, 'sub', env)).toBe(shaB)

    const capture = runSourced(root, 'capture_staged_gitlinks', env)
    expect(capture.status).toBe(0)
    expect(capture.stdout.trim()).toBe(`${shaB} sub`)

    // Simulate the hook's blind re-add — this is the clobber.
    execFileSync('git', ['-C', root, 'add', 'sub'], { env })
    expect(stagedSha(root, 'sub', env)).toBe(shaA) // clobbered back to the live checkout

    const restore = runSourced(
      root,
      `restore_staged_gitlinks "$(printf '%s\\n' '${shaB} sub')"`,
      env
    )
    expect(restore.status).toBe(0)
    expect(restore.stderr).toBe('')
    expect(stagedSha(root, 'sub', env)).toBe(shaB) // restored
  })

  it('G-2: negative control — without capture/restore, the blind re-add clobbers the staged SHA', () => {
    const { root, shaA } = makeFixture()
    const env = { ...makeFixtureEnv(), PATH: process.env['PATH'] ?? '/usr/bin:/bin' }

    const shaB = 'c'.repeat(40)
    execFileSync('git', ['-C', root, 'update-index', '--cacheinfo', '160000', shaB, 'sub'], {
      env,
    })
    expect(stagedSha(root, 'sub', env)).toBe(shaB)

    // No capture/restore this time — just the blind re-add.
    execFileSync('git', ['-C', root, 'add', 'sub'], { env })

    expect(stagedSha(root, 'sub', env)).toBe(shaA)
    expect(stagedSha(root, 'sub', env)).not.toBe(shaB)
  })

  it('G-3: a regular staged file modified before the re-add is still correctly re-staged', () => {
    const { root } = makeFixture()
    const env = { ...makeFixtureEnv(), PATH: process.env['PATH'] ?? '/usr/bin:/bin' }

    writeFileSync(join(root, 'README.md'), 'parent v2\n', 'utf8')
    execFileSync('git', ['-C', root, 'add', 'README.md'], { env })

    const capture = runSourced(root, 'capture_staged_gitlinks', env)
    // No gitlinks staged in this scenario — capture is empty.
    expect(capture.stdout.trim()).toBe('')

    // Simulate lint-staged further modifying the file before the re-add.
    writeFileSync(join(root, 'README.md'), 'parent v3 (formatted)\n', 'utf8')
    execFileSync('git', ['-C', root, 'add', 'README.md'], { env })
    runSourced(root, 'restore_staged_gitlinks ""', env)

    // Plain `git diff` (no --cached) compares the working tree against the
    // index — empty means the index already reflects the latest working-tree
    // content (v3), i.e. the re-add correctly picked up the post-capture edit.
    const diff = execFileSync('git', ['-C', root, 'diff', 'README.md'], {
      env,
    }).toString()
    expect(diff).toBe('') // index matches working tree — re-add picked up the latest edit
    const content = execFileSync('git', ['-C', root, 'show', ':README.md'], {
      env,
    }).toString()
    expect(content).toBe('parent v3 (formatted)\n')
  })

  it('G-4: a restore failure for one entry is diagnosed on stderr without aborting the rest', () => {
    const { root, shaA } = makeFixture()
    const env = { ...makeFixtureEnv(), PATH: process.env['PATH'] ?? '/usr/bin:/bin' }
    void shaA

    const shaB = 'd'.repeat(40)
    const snapshot = `deadbeef sub-does-not-exist\n${shaB} sub`

    const restore = runSourced(
      root,
      `restore_staged_gitlinks "$(printf '%s\\n' '${snapshot}')"`,
      env
    )
    expect(restore.status).toBe(0) // no set -e in the caller's philosophy — soft failure
    expect(restore.stderr).toContain('SMI-5713')
    expect(restore.stderr).toContain('sub-does-not-exist')
    // The valid entry after the bad one still gets restored.
    expect(stagedSha(root, 'sub', env)).toBe(shaB)
  })
})
