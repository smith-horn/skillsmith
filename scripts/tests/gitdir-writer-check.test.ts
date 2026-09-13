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
import {
  evaluateAbsoluteSeparateGitDirWriters,
  findAbsoluteSeparateGitDirWriters,
  gitDirWriterReportLines,
} from '../audit-gitdir-writer-helpers.mjs'
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

// SMI-6575. The throw above is correct and stays. What was missing was any
// caller honouring the instruction to catch it: Check 69's call site in
// audit-standards.mjs did not, so in every worktree dev container -- where
// /app/.git names an unmounted host path and `git ls-files` exits 128 -- the
// unhandled throw killed the whole audit. Measured 2026-09-12: worktree
// container exit 1, 84 pass-marks, NO summary block; host exit 0, 89 passed /
// 7 warnings / 0 failed. Check 70, the summary and the exit verdict were lost.
//
// These tests pin the two properties that make the fix a fix rather than a
// mute button: it does not throw, and an unevaluated check is NOT a pass.
describe('evaluateAbsoluteSeparateGitDirWriters (SMI-6575 call-site degradation)', () => {
  const roots: string[] = []

  afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
  })

  function makeNonGitDir(): string {
    const root = makeFixtureTempDir('smi6575-nogit')
    roots.push(root)
    writeFileSync(join(root, 'some-doc.md'), 'nothing interesting here\n', 'utf8')
    return root
  }

  it('returns a verdict instead of throwing when git cannot enumerate tracked files', () => {
    const root = makeNonGitDir()
    // The regression itself: before the fix this expression threw, and the
    // throw propagated out of audit-standards.mjs and ended the process.
    expect(() => evaluateAbsoluteSeparateGitDirWriters(root)).not.toThrow()
    const verdict = evaluateAbsoluteSeparateGitDirWriters(root)
    expect(verdict.status).toBe('not_evaluated')
    expect(verdict.reason).toMatch(/ls-files.*failed/i)
  })

  it('never reports an unevaluated check as a pass', () => {
    const verdict = evaluateAbsoluteSeparateGitDirWriters(makeNonGitDir())
    // The SMI-6118 / SMI-6332 failure mode elsewhere in this audit is a check
    // that self-skips to pass. A caller reading `findings.length === 0` must
    // not be able to reach that branch, so the unevaluated verdict carries
    // neither a findings array nor a denominator to read as "scanned, clean".
    expect(verdict.status).not.toBe('evaluated')
    expect(verdict.findings).toBeUndefined()
    expect(verdict.filesChecked).toBeUndefined()
  })

  it('fails under CI and warns otherwise, because the two environments mean different things', () => {
    const root = makeNonGitDir()
    // A CI runner always has a working git, so an unevaluated Check 69 there
    // is a real breakage and must block.
    expect(evaluateAbsoluteSeparateGitDirWriters(root, { isCI: true }).severity).toBe('fail')
    // Locally it is the known, understood state of every worktree container.
    expect(evaluateAbsoluteSeparateGitDirWriters(root, { isCI: false }).severity).toBe('warn')
    expect(evaluateAbsoluteSeparateGitDirWriters(root).severity).toBe('warn')
  })

  it('passes the real result straight through when git does work', () => {
    const root = makeFixtureRepoForEvaluate({
      'clean.sh': 'git clone --separate-git-dir=../relative/path repo\n',
    })
    const verdict = evaluateAbsoluteSeparateGitDirWriters(root)
    expect(verdict.status).toBe('evaluated')
    expect(verdict.findings).toEqual([])
    expect(verdict.filesChecked).toBe(1)
  })

  it('passes real findings straight through without downgrading them', () => {
    const root = makeFixtureRepoForEvaluate({
      'bad.sh': 'git clone --separate-git-dir=/Users/someone/repo/.git/worktrees/x repo\n',
    })
    const verdict = evaluateAbsoluteSeparateGitDirWriters(root)
    expect(verdict.status).toBe('evaluated')
    expect(verdict.findings).toHaveLength(1)
    expect(verdict.findings[0].file).toBe('bad.sh')
  })

  // Local twin of the fixture builder above -- kept here rather than shared so
  // this block's repos are torn down by its own afterEach.
  function makeFixtureRepoForEvaluate(files: Record<string, string>): string {
    const root = makeFixtureTempDir('smi6575-gitdir')
    roots.push(root)
    // makeFixtureEnv() returns a bare ProcessEnv, so it must be passed AS
    // options.env -- handing it to execFileSync as the options object itself
    // silently discards the sanitization and inherits the real environment,
    // GIT_DIR included. That is not theoretical here: an inherited GIT_DIR is
    // exactly what makes `git -C <dir>` resolve against the wrong object store
    // (SMI-6569), which would make these fixtures read the parent repo.
    const env = makeFixtureEnv()
    execFileSync('git', ['-C', root, 'init', '-q'], { env })
    for (const [relPath, content] of Object.entries(files)) {
      const abs = join(root, relPath)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content, 'utf8')
      execFileSync('git', ['-C', root, 'add', '--', relPath], { env })
    }
    return root
  }
})

// SMI-6575, second round. The cross-family pre-merge gate (ADR-128) blocked the
// first fix on exactly this gap: the five tests above pin the HELPER verdict,
// while the branch that actually crashed -- the reporting loop over findings --
// was still reachable only through audit-standards.mjs and therefore untested.
// Its stated failure scenario: someone moves a binding back into the clean
// branch's scope, all five helper tests still pass, and a repo containing a
// finding crashes before Check 70 and the summary. That is the first-draft
// regression exactly.
//
// gitDirWriterReportLines() is that branching, extracted so it can be executed
// here. The audit script is now a flat dispatch with no branch-local bindings.
describe('gitDirWriterReportLines (SMI-6575 reporting branches)', () => {
  it('renders a findings verdict as one warn line per finding, each carrying the denominator', () => {
    const lines = gitDirWriterReportLines({
      status: 'evaluated',
      filesChecked: 5400,
      findings: [
        { file: 'a.sh', line: 1, text: 'git clone --separate-git-dir=/abs a' },
        { file: 'b/c.md', line: 42, text: 'git clone --separate-git-dir /abs b' },
      ],
    })
    // The branch that used to throw ReferenceError. Executing it at all is the
    // point; the assertions pin what it must say.
    expect(lines).toHaveLength(2)
    expect(lines.every((l: { severity: string }) => l.severity === 'warn')).toBe(true)
    expect(lines[0].message).toContain('a.sh:1')
    expect(lines[1].message).toContain('b/c.md:42')
    // Both names that were out of scope in the first draft must appear.
    for (const l of lines) {
      expect(l.message).toContain('5400 scanned file(s)')
      expect(l.fix).toMatch(/rewrite-to-relative/)
    }
  })

  it('renders a clean verdict as exactly one pass line reporting its denominator', () => {
    const lines = gitDirWriterReportLines({
      status: 'evaluated',
      filesChecked: 5399,
      findings: [],
    })
    expect(lines).toHaveLength(1)
    expect(lines[0].severity).toBe('pass')
    expect(lines[0].message).toContain('5399 tracked file(s) scanned')
  })

  it('renders an unevaluated verdict as warn or fail, never pass, and says nothing was scanned', () => {
    const warnLines = gitDirWriterReportLines({
      status: 'not_evaluated',
      reason: 'git -C . ls-files failed (boom)',
      severity: 'warn',
    })
    const failLines = gitDirWriterReportLines({
      status: 'not_evaluated',
      reason: 'git -C . ls-files failed (boom)',
      severity: 'fail',
    })
    expect(warnLines).toHaveLength(1)
    expect(failLines).toHaveLength(1)
    expect(warnLines[0].severity).toBe('warn')
    expect(failLines[0].severity).toBe('fail')
    for (const l of [...warnLines, ...failLines]) {
      expect(l.severity).not.toBe('pass')
      expect(l.message).toContain('NOT EVALUATED')
      expect(l.message).toContain('nothing was scanned')
      expect(l.message).toContain('boom')
    }
    // The two severities must give different remediation -- a CI runner with a
    // broken git is a real breakage, a worktree container is the known state.
    expect(failLines[0].fix).not.toBe(warnLines[0].fix)
    expect(warnLines[0].fix).toContain('SMI-6524')
  })

  it('emits a severity the audit actually has a reporter for, on every branch', () => {
    // audit-standards.mjs dispatches via `reporters[line.severity]`. An unknown
    // severity would be a TypeError at runtime, in the branch that produced it.
    const verdicts = [
      { status: 'evaluated', filesChecked: 1, findings: [] },
      { status: 'evaluated', filesChecked: 1, findings: [{ file: 'a', line: 1, text: 't' }] },
      { status: 'not_evaluated', reason: 'r', severity: 'warn' },
      { status: 'not_evaluated', reason: 'r', severity: 'fail' },
    ]
    for (const v of verdicts) {
      const lines = gitDirWriterReportLines(v)
      expect(lines.length).toBeGreaterThan(0)
      for (const l of lines) {
        expect(['pass', 'warn', 'fail']).toContain(l.severity)
        expect(typeof l.message).toBe('string')
        expect(l.message.length).toBeGreaterThan(0)
      }
    }
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
    // `env:`, not a spread. makeFixtureEnv() returns a bare ProcessEnv, so
    // spreading it here set PATH/HOME/GIT_AUTHOR_NAME as execFileSync OPTIONS
    // keys, which Node ignores, and left options.env unset -- so this probe
    // inherited the real environment, GIT_DIR included, and its answer gates
    // whether the live-repo scan below runs or skips. Pre-existing; found by
    // the SMI-6575 cross-family pre-merge gate alongside the same mistake in
    // the fixture builder above.
    execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z', '--recurse-submodules'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: makeFixtureEnv(),
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
