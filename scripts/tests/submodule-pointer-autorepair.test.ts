/**
 * SMI-6580 Wave 1 — scripts/ci/submodule-pointer-autorepair.sh test suite.
 *
 * This alerting path had ZERO coverage before this file (the only file
 * mentioning `open_or_skip_issue` was the script itself) and failed
 * silently in production: it correctly detected a real ADR-143 ancestry
 * violation, then failed to open the alert issue while still concluding
 * `success`, because `gh issue create --label submodule-pointer-regression`
 * failed on a label that had never been created — a failure the old code
 * swallowed into a `::warning::` and an unconditional `exit 0`.
 *
 * Two testing strategies, matching the two precedents named for this task:
 *  - `open_or_skip_issue` is unit-tested by `source`-ing the real script
 *    (the BASH_SOURCE guard at its bottom means main()'s side effects never
 *    run on a plain `source`) and calling the function directly, with a
 *    faked `gh` binary prepended to PATH — mirrors
 *    scripts/tests/needle-dispatch.test.sh's "fake the binaries on PATH"
 *    technique.
 *  - The exit-code-2-vs-1 distinction (and one full end-to-end replay of
 *    the real production defect) is tested by invoking the real script as
 *    a genuine child process against small real git fixtures — mirrors
 *    scripts/tests/check-submodule-pointer.test.ts's approach (and reuses
 *    its exact fixture shape for the R1 case, since check-submodule-
 *    pointer.sh's own exit/FAIL-line contract is what autorepair.sh reads).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'ci', 'submodule-pointer-autorepair.sh')

const FAKE_SHA_1 = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

// ---------------------------------------------------------------------------
// Fake `gh` — logs `<subcommand> <subcommand2>` (e.g. "issue create") to a
// file so tests can assert call ORDER, and behaves per env-var switches so
// each call site (dedupe query, label create, issue create) can be made to
// fail independently without touching the network.
// ---------------------------------------------------------------------------
const FAKE_GH_SCRIPT = `#!/usr/bin/env bash
set -u
{ printf '%s %s\\n' "\${1:-}" "\${2:-}" >> "\${SPA_TEST_GH_LOG}"; } 2>/dev/null || true
case "\${1:-} \${2:-}" in
  "label create")
    exit "\${SPA_TEST_GH_LABEL_EXIT:-0}"
    ;;
  "issue list")
    if [ "\${SPA_TEST_GH_ISSUE_LIST_EXIT:-0}" != "0" ]; then
      printf '%s\\n' "\${SPA_TEST_GH_ISSUE_LIST_STDERR:-gh: simulated issue-list failure}" >&2
      exit "\${SPA_TEST_GH_ISSUE_LIST_EXIT}"
    fi
    # Real \`gh\` writes advisory notices to stderr on SUCCESSFUL calls too
    # (new-release nags, auth/deprecation warnings). This knob reproduces
    # that, which is what the SMI-6580d-followup regression test needs.
    if [ -n "\${SPA_TEST_GH_ISSUE_LIST_STDERR_ON_SUCCESS:-}" ]; then
      printf '%s\\n' "\${SPA_TEST_GH_ISSUE_LIST_STDERR_ON_SUCCESS}" >&2
    fi
    printf '%s' "\${SPA_TEST_GH_ISSUE_LIST_OUT:-}"
    exit 0
    ;;
  "issue create")
    if [ "\${SPA_TEST_GH_ISSUE_CREATE_EXIT:-0}" != "0" ]; then
      printf '%s\\n' "\${SPA_TEST_GH_ISSUE_CREATE_STDERR:-gh: simulated issue-create failure}" >&2
      exit "\${SPA_TEST_GH_ISSUE_CREATE_EXIT}"
    fi
    printf 'https://github.com/smith-horn/skillsmith/issues/9999\\n'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`

const createdDirs: string[] = []

function makeFakeGhDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spa-fake-gh-'))
  createdDirs.push(dir)
  const ghPath = join(dir, 'gh')
  writeFileSync(ghPath, FAKE_GH_SCRIPT)
  chmodSync(ghPath, 0o755)
  return dir
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

/**
 * `source`s the real script (main()'s side effects never run — see the
 * BASH_SOURCE guard at its bottom) and calls `open_or_skip_issue`
 * directly, with GITHUB_REPOSITORY/GITHUB_SHA/FAIL_LINE/RULE supplied via
 * env, exactly as main() would set them as globals before dispatching.
 */
function callOpenOrSkipIssue(
  env: NodeJS.ProcessEnv,
  remediation = 'Run `./scripts/bump-docs-pointer.sh`.'
): RunResult {
  const result = spawnSync(
    'bash',
    ['-c', `source "${SCRIPT}"; open_or_skip_issue "$1"`, 'test-harness', remediation],
    { encoding: 'utf8', env }
  )
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function baseEnv(overrides: NodeJS.ProcessEnv, fakeGhDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${fakeGhDir}:${process.env.PATH ?? ''}`,
    GITHUB_REPOSITORY: 'smith-horn/skillsmith',
    GITHUB_SHA: 'abc123def4567890abc123def4567890abc123d',
    FAIL_LINE: 'FAIL [docs/internal]: R1: `deadbeef` was never pushed',
    RULE: 'R1',
    ...overrides,
  }
}

function readLog(logFile: string): string[] {
  try {
    return readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Unit tests: open_or_skip_issue, via source + faked gh on PATH
// ---------------------------------------------------------------------------

describe('submodule-pointer-autorepair.sh — open_or_skip_issue (SMI-6580)', () => {
  it('label create precedes issue create (the SMI-6580 root-cause ordering fix)', () => {
    const fakeGhDir = makeFakeGhDir()
    const logFile = join(fakeGhDir, 'calls.log')

    const r = callOpenOrSkipIssue(
      baseEnv(
        {
          SPA_TEST_GH_LOG: logFile,
          SPA_TEST_GH_ISSUE_LIST_OUT: '',
        },
        fakeGhDir
      )
    )

    expect(r.status).toBe(0)
    const calls = readLog(logFile)
    const labelIdx = calls.indexOf('label create')
    const createIdx = calls.indexOf('issue create')
    expect(labelIdx).toBeGreaterThanOrEqual(0)
    expect(createIdx).toBeGreaterThanOrEqual(0)
    expect(labelIdx).toBeLessThan(createIdx)
  })

  it('a failed issue create exits non-zero and names the real cause (SMI-6580b)', () => {
    const fakeGhDir = makeFakeGhDir()
    const logFile = join(fakeGhDir, 'calls.log')
    const distinctiveCause =
      "could not add label: 'submodule-pointer-regression' not found (HTTP 422: Validation Failed)"

    const r = callOpenOrSkipIssue(
      baseEnv(
        {
          SPA_TEST_GH_LOG: logFile,
          SPA_TEST_GH_ISSUE_LIST_OUT: '',
          SPA_TEST_GH_ISSUE_CREATE_EXIT: '1',
          SPA_TEST_GH_ISSUE_CREATE_STDERR: distinctiveCause,
        },
        fakeGhDir
      )
    )

    // The function's own return code IS the -c script's exit status (it is
    // the last command run) -- this is the non-zero-exit half of the
    // regression: before the fix, this returned 0 unconditionally.
    expect(r.status).not.toBe(0)
    expect(r.stdout).toContain('::error::')
    expect(r.stdout).toContain(distinctiveCause)
    // The old behavior discarded the cause into a generic ::warning::  --
    // confirm that shape is gone, not just that ::error:: is present.
    expect(r.stdout).not.toMatch(/::warning::gh issue create failed/)
  })

  it('a failed dedupe query does not silently proceed (SMI-6580d)', () => {
    const fakeGhDir = makeFakeGhDir()
    const logFile = join(fakeGhDir, 'calls.log')
    const distinctiveCause = 'gh: API rate limit exceeded for installation ID 12345 (HTTP 403)'

    const r = callOpenOrSkipIssue(
      baseEnv(
        {
          SPA_TEST_GH_LOG: logFile,
          SPA_TEST_GH_ISSUE_LIST_EXIT: '1',
          SPA_TEST_GH_ISSUE_LIST_STDERR: distinctiveCause,
        },
        fakeGhDir
      )
    )

    expect(r.status).not.toBe(0)
    expect(r.stdout).toContain('::error::')
    expect(r.stdout).toContain(distinctiveCause)
    expect(r.stdout).toContain('dedupe query failed')

    // The real proof that it didn't "silently proceed": neither the label
    // nor the issue was ever created after the dedupe query blew up.
    const calls = readLog(logFile)
    expect(calls).not.toContain('label create')
    expect(calls).not.toContain('issue create')
  })

  it('a SUCCESSFUL dedupe query that prints a stderr notice still alerts (SMI-6580d follow-up)', () => {
    // Regression test for a defect introduced by SMI-6580d's own first fix.
    // That fix captured the dedupe query as `$(gh issue list … 2>&1)`, which
    // merges stderr into the captured value. Real `gh` writes advisory
    // notices to stderr on successful calls, so on a run where NO issue
    // existed the capture came back non-empty ("gh: A new release of gh is
    // available") and the function read it as "already reported #<notice>"
    // and skipped alerting — reintroducing the exact SMI-6580 silent miss
    // the change was written to remove. stderr now goes to a file instead.
    const fakeGhDir = makeFakeGhDir()
    const logFile = join(fakeGhDir, 'calls.log')

    const r = callOpenOrSkipIssue(
      baseEnv(
        {
          SPA_TEST_GH_LOG: logFile,
          // Query SUCCEEDS (exit 0) and finds nothing (empty stdout) — but
          // is noisy on stderr, exactly as the real binary can be.
          SPA_TEST_GH_ISSUE_LIST_OUT: '',
          SPA_TEST_GH_ISSUE_LIST_STDERR_ON_SUCCESS:
            'gh: A new release of gh is available: 2.40.0 → 2.41.0',
        },
        fakeGhDir
      )
    )

    expect(r.status).toBe(0)
    // The alert must actually be delivered. Before the fix this asserted
    // false: no issue create happened at all.
    const calls = readLog(logFile)
    expect(calls).toContain('issue create')
    // And it must not have been mistaken for an already-reported issue.
    expect(r.stdout).not.toContain('already reported')
  })

  it('an existing issue for this commit is skipped without creating a duplicate', () => {
    const fakeGhDir = makeFakeGhDir()
    const logFile = join(fakeGhDir, 'calls.log')

    const r = callOpenOrSkipIssue(
      baseEnv(
        {
          SPA_TEST_GH_LOG: logFile,
          SPA_TEST_GH_ISSUE_LIST_OUT: '4242',
        },
        fakeGhDir
      )
    )

    expect(r.status).toBe(0)
    expect(r.stdout).toContain('already reported as issue #4242')
    const calls = readLog(logFile)
    expect(calls).not.toContain('label create')
    expect(calls).not.toContain('issue create')
  })
})

// ---------------------------------------------------------------------------
// Fixture plumbing for the two end-to-end (real subprocess, real git)
// tests below -- mirrors check-submodule-pointer.test.ts's fixture shape,
// since it's that script's own exit-code/FAIL-line contract being exercised.
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: makeFixtureEnv() }).trim()
}

function initRepo(dir: string, branch: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', branch)
  git(dir, 'config', 'commit.gpgsign', 'false')
}

function commitFile(dir: string, relPath: string, content: string, message: string): string {
  writeFileSync(join(dir, relPath), content)
  git(dir, 'add', relPath)
  git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

function commitGitlink(parentDir: string, sha: string, message: string): string {
  git(parentDir, 'update-index', '--add', '--cacheinfo', `160000,${sha},docs/internal`)
  git(parentDir, 'commit', '-q', '-m', message)
  return git(parentDir, 'rev-parse', 'HEAD')
}

const createdRoots: string[] = []
afterEach(() => {
  while (createdRoots.length > 0) {
    const dir = createdRoots.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function runAutorepair(cwd: string, env: NodeJS.ProcessEnv): RunResult {
  const result = spawnSync('bash', [SCRIPT], { cwd, encoding: 'utf8', env })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

describe('submodule-pointer-autorepair.sh — exit-code-2-vs-1 distinction (SMI-6580e)', () => {
  it('a broken invocation (check-submodule-pointer.sh exit 2) fails loudly, never reaches gh', () => {
    const root = makeFixtureTempDir('spa-exit2-fixture')
    createdRoots.push(root)
    initRepo(root, 'main')
    writeFileSync(
      join(root, '.gitmodules'),
      '[submodule "docs/internal"]\n\tpath = docs/internal\n\turl = https://example.invalid/x.git\n'
    )
    git(root, 'add', '.gitmodules')
    git(root, 'commit', '-q', '-m', 'init')
    const head = git(root, 'rev-parse', 'HEAD')

    const fakeGhDir = makeFakeGhDir()
    const logFile = join(fakeGhDir, 'calls.log')

    const r = runAutorepair(
      root,
      makeFixtureEnv({
        PATH: `${fakeGhDir}:${process.env.PATH ?? ''}`,
        GITHUB_SHA: FAKE_SHA_1, // unresolvable -> check-submodule-pointer.sh exits 2
        BEFORE_SHA: head,
        GITHUB_REPOSITORY: 'smith-horn/skillsmith',
        SHADOW: '1',
        MAIN_PUSH_PAT: '',
        SPA_TEST_GH_LOG: logFile,
      })
    )

    expect(r.status).toBe(1)
    expect(r.stdout).toContain('::error::')
    expect(r.stdout).toContain('exited 2')
    expect(r.stdout).toContain('broken invocation')
    // Confirms this is NOT the pre-existing "nothing actionable" exit-0 path.
    expect(r.stdout).not.toContain('nothing actionable')
    expect(r.stdout).not.toContain('matched rule:')
    // And confirms it never even reached the alerting path.
    expect(readLog(logFile)).toHaveLength(0)
  })

  it('a real R1 content violation (exit 1) reaches the alert path end-to-end, distinct from exit 2', () => {
    // Replays the real production defect shape: a genuine ADR-143 violation
    // detected correctly, then alerted correctly (label before create,
    // real gh calls observed in order) -- the exact path that silently
    // failed before SMI-6580.
    const root = makeFixtureTempDir('spa-r1-fixture')
    createdRoots.push(root)
    const subRemoteDir = join(root, 'sub-remote.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', subRemoteDir], {
      env: makeFixtureEnv(),
    })
    const seedDir = join(root, 'seed')
    initRepo(seedDir, 'main')
    const base = commitFile(seedDir, 'f0.txt', 'base\n', 'base commit')
    git(seedDir, 'remote', 'add', 'origin', subRemoteDir)
    git(seedDir, 'push', '-q', 'origin', 'main')

    const parentDir = join(root, 'parent')
    initRepo(parentDir, 'main')
    writeFileSync(
      join(parentDir, '.gitmodules'),
      `[submodule "docs/internal"]\n\tpath = docs/internal\n\turl = ${subRemoteDir}\n\tbranch = main\n`
    )
    git(parentDir, 'add', '.gitmodules')
    git(parentDir, 'commit', '-q', '-m', 'init (no gitlink yet)')
    const mountDir = join(parentDir, 'docs', 'internal')
    execFileSync('git', ['clone', '-q', subRemoteDir, mountDir], { env: makeFixtureEnv() })

    // c1 registers a resolvable pointer (the diff base / "before" state);
    // the HEAD commit then bumps to a never-pushed SHA -- a real R1.
    const c1 = commitGitlink(parentDir, base, 'base bump (target)')
    const headSha = commitGitlink(parentDir, FAKE_SHA_1, 'S = never-pushed SHA')

    const fakeGhDir = makeFakeGhDir()
    const logFile = join(fakeGhDir, 'calls.log')

    const r = runAutorepair(
      parentDir,
      makeFixtureEnv({
        PATH: `${fakeGhDir}:${process.env.PATH ?? ''}`,
        GITHUB_SHA: headSha,
        BEFORE_SHA: c1,
        GITHUB_REPOSITORY: 'smith-horn/skillsmith',
        SHADOW: '1',
        MAIN_PUSH_PAT: '',
        SPA_TEST_GH_LOG: logFile,
        SPA_TEST_GH_ISSUE_LIST_OUT: '',
      })
    )

    expect(r.status).toBe(0)
    expect(r.stdout).toContain('matched rule: R1')
    expect(r.stdout).not.toContain('exited 2')

    const calls = readLog(logFile)
    expect(calls).toEqual(['issue list', 'label create', 'issue create'])
  })
})
