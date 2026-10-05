/**
 * SMI-6985 — first test harness for `.husky/post-commit`.
 *
 * Before this file, `grep -rl "husky/post-commit" scripts/tests/` returned
 * nothing: the hook's `set +e` (added for SMI-6967 H-3(b), its own header
 * comment honestly recording that the failure it guards against was never
 * reproduced) had no harness that could ever establish or disprove
 * reachability. This suite does two things:
 *
 *   1. Pins the `set +e` behavior itself (SMI-6967 H-3(b)): with a stub
 *      `git` that fails `rev-parse --show-toplevel` (the one git call made
 *      AFTER `set +e`, inside the background-reindex gate), the hook must
 *      still reach `exit 0` at the end rather than aborting mid-script.
 *      Deleting `set +e` and re-running the same scenario is this file's own
 *      red-test for that pin (see SMI-6985 for the recorded before/after:
 *      without the guard the hook aborts with the stub's own exit code).
 *   2. Exercises the hook's other documented purpose — the SMI-2536 branch
 *      integrity fallback guard — across its three reachable states: no
 *      marker file, marker matches the actual branch, and marker diverges
 *      from it (the actual "smudge filter switched branches mid-commit"
 *      case this guard exists to surface).
 *
 * Like scripts/tests/post-merge-worktree-guard.test.ts, the REAL hook file
 * is used (copied into each fixture, not reimplemented) and spawned via
 * `sh -e` — SMI-6967 (F1): Husky invokes every hook through `sh -e`
 * (.husky/_/h:17) regardless of the hook's own shebang, so a plain `sh`
 * spawn never reproduces that execution mode. The hook resolves
 * `scripts/linear-hook.mjs` relative to `$(dirname "$0")`, so (unlike
 * post-merge, which resolves its own side-effecting calls CWD-relative and
 * can run the real file in place against a fixture cwd) the hook itself
 * must be COPIED into each fixture's own `.husky/` so `$0` lands inside the
 * fixture tree and the fixture-local `scripts/linear-hook.mjs` stub is what
 * actually gets invoked, not this repo's real one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const POST_COMMIT_SRC = resolve(__dirname, '..', '..', '.husky', 'post-commit')

interface Fixture {
  root: string
  linearLog: string
  /** Set only by the test that calls `buildShowToplevelFailingGitPath` — the
   * stub-git PATH dir it creates (SMI-6985 L-5: this must be cleaned up
   * alongside `root`, or every run of this suite leaks one
   * `post-commit-git-stub-*` temp dir). */
  gitStubDir?: string
}

function readLogSafe(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** Resolve a real system binary via the ambient PATH (same idiom as
 * scripts/tests/_lib/worktree-probe-shim.ts's `passthrough()`), so a
 * conditional shim can delegate to it by absolute path without recursing
 * back into itself through a shim-prepended PATH. */
function resolveRealBin(name: string): string {
  return execFileSync('bash', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim()
}

/**
 * A PATH with a `git` shim prepended that fails ONLY `rev-parse
 * --show-toplevel` (with `exitCode`, a sentinel distinctive enough that a
 * test can confirm an abort happened for THIS reason and not some other
 * failure) and delegates every other invocation — including the `git
 * rev-parse --git-dir` / `git branch --show-current` / `git rev-parse
 * --short HEAD` calls earlier in the hook — to the real binary unchanged.
 *
 * SMI-6985 M-2: the shim logs its OWN argv to `logPath` as its first action,
 * before doing anything else — so a test can assert, in the same execution,
 * that `rev-parse --show-toplevel` was actually invoked through this PATH
 * injection. Without this, a test asserting only `status === 0` is
 * indistinguishable from the shim never having been reached at all (the
 * shipped hook under `sh -e` with no shim also exits 0).
 */
function buildShowToplevelFailingGitPath(exitCode: number): {
  pathEnv: string
  dir: string
  logPath: string
} {
  const dir = makeFixtureTempDir('post-commit-git-stub')
  const realGit = resolveRealBin('git')
  const logPath = join(dir, 'invocations.log')
  writeFileSync(
    join(dir, 'git'),
    [
      '#!/bin/sh',
      `echo "$@" >> ${JSON.stringify(logPath)}`,
      'if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then',
      `  exit ${exitCode}`,
      'fi',
      `exec "${realGit}" "$@"`,
      '',
    ].join('\n'),
    'utf8'
  )
  chmodSync(join(dir, 'git'), 0o755)
  return { pathEnv: `${dir}:${process.env.PATH ?? ''}`, dir, logPath }
}

/** Fixture-local stub for scripts/linear-hook.mjs, resolved by the hook
 * `$(dirname "$0")`-relative — since the hook itself is copied into each
 * fixture's own .husky/ (see module doc comment), this is what actually
 * runs, never this repo's real linear-hook.mjs. Logs its own argv so a test
 * can confirm the background call fired with the expected `post-commit`
 * argument, then exits immediately (the hook never waits on it). */
function writeLinearHookStub(root: string, logPath: string): void {
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(
    join(root, 'scripts', 'linear-hook.mjs'),
    [
      "import { appendFileSync } from 'node:fs'",
      `appendFileSync(${JSON.stringify(logPath)}, process.argv.slice(2).join(' ') + '\\n')`,
      '',
    ].join('\n'),
    'utf8'
  )
}

function makeFixture(): Fixture {
  const root = makeFixtureTempDir('post-commit-guard-test')
  const env = makeFixtureEnv()

  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', root], { env })
  writeFileSync(join(root, 'file.txt'), 'hello\n', 'utf8')
  execFileSync('git', ['-C', root, 'add', 'file.txt'], { env })

  mkdirSync(join(root, '.husky'), { recursive: true })
  execFileSync('cp', [POST_COMMIT_SRC, join(root, '.husky', 'post-commit')])
  chmodSync(join(root, '.husky', 'post-commit'), 0o755)

  const linearLog = join(root, 'scripts', 'linear-hook.log')
  writeLinearHookStub(root, linearLog)

  return { root, linearLog }
}

/** Commit whatever is currently staged in `root`, returning the short SHA
 * git itself assigns — never hardcoded, since the branch-drift message
 * quotes it verbatim. */
function commit(root: string, env: NodeJS.ProcessEnv, message: string): string {
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', message], { env })
  return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], {
    env,
    encoding: 'utf8',
  }).trim()
}

function runHook(
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {}
): { status: number; stdout: string; stderr: string } {
  // SMI-6967 (F1): see module doc comment — `-e` matches husky's real
  // invocation mode, not a plain `sh` spawn.
  const result = spawnSync('sh', ['-e', join(cwd, '.husky', 'post-commit')], {
    cwd,
    encoding: 'utf8',
    env: { ...makeFixtureEnv(), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** Poll for the backgrounded linear-hook stub's log — it's a detached
 * `node … &` the hook never waits on, so the log line can land after
 * spawnSync already returned. */
async function waitForLog(path: string, needle: string, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let content = readLogSafe(path)
  while (!content.includes(needle) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
    content = readLogSafe(path)
  }
  return content
}

describe('.husky/post-commit — branch-integrity guard (SMI-2536) + set +e pin (SMI-6967 H-3(b))', () => {
  let fixture: Fixture | null = null

  beforeEach(() => {
    fixture = makeFixture()
  })

  afterEach(() => {
    if (fixture && existsSync(fixture.root)) rmSync(fixture.root, { recursive: true, force: true })
    // SMI-6985 L-5: the git-stub PATH dir (test (d) only) is a SEPARATE temp
    // dir from `fixture.root` and was never cleaned up here before.
    if (fixture?.gitStubDir && existsSync(fixture.gitStubDir)) {
      rmSync(fixture.gitStubDir, { recursive: true, force: true })
    }
    fixture = null
  })

  it('(a) no expected-branch marker: completes quietly, still kicks the background Linear sync', async () => {
    const { root, linearLog } = fixture!
    const env = makeFixtureEnv()
    commit(root, env, 'initial commit')

    const result = runHook(root)
    expect(result.status).toBe(0)
    expect(result.stdout).not.toMatch(/BRANCH DRIFT DETECTED/)
    expect(result.stdout).not.toMatch(/Committed on branch/)

    const log = await waitForLog(linearLog, 'post-commit')
    expect(log).toContain('post-commit')
  })

  it('(b) expected-branch matches the actual branch: prints confirmation, removes the marker', () => {
    const { root } = fixture!
    const env = makeFixtureEnv()
    writeFileSync(join(root, '.git', 'expected-branch'), 'main', 'utf8')
    commit(root, env, 'no-drift commit')

    const result = runHook(root)
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/Committed on branch: main/)
    expect(result.stdout).not.toMatch(/BRANCH DRIFT DETECTED/)
    expect(existsSync(join(root, '.git', 'expected-branch'))).toBe(false)
  })

  it('(c) expected-branch diverges from the actual branch: prints the drift banner, removes the marker, exit 0 (non-blocking)', () => {
    const { root } = fixture!
    const env = makeFixtureEnv()
    writeFileSync(join(root, '.git', 'expected-branch'), 'feature/was-expected', 'utf8')
    const sha = commit(root, env, 'drift commit')

    const result = runHook(root)
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/BRANCH DRIFT DETECTED/)
    expect(result.stdout).toMatch(/Expected branch:.*feature\/was-expected/)
    expect(result.stdout).toMatch(/Actual branch:.*main/)
    expect(result.stdout).toContain(sha)
    expect(result.stdout).toContain('git checkout feature/was-expected')
    expect(result.stdout).toContain(`git cherry-pick ${sha}`)
    expect(existsSync(join(root, '.git', 'expected-branch'))).toBe(false)
  })

  it('(d) SMI-6967 H-3(b): a failing `git rev-parse --show-toplevel` does not abort the hook', () => {
    const f = fixture!
    const env = makeFixtureEnv()
    commit(f.root, env, 'set +e pin commit')

    // Distinctive sentinel (not 1) so a regression is unambiguous: if this
    // ever surfaces as the test's own failure status, it is PROOF the abort
    // happened at this specific stubbed call, not some unrelated one.
    const SENTINEL_EXIT_CODE = 47
    const { pathEnv, dir, logPath } = buildShowToplevelFailingGitPath(SENTINEL_EXIT_CODE)
    f.gitStubDir = dir

    const result = runHook(f.root, { PATH: pathEnv })
    expect(result.status).toBe(0)

    // SMI-6985 M-2: without this, `status === 0` is indistinguishable from
    // the PATH-injected shim never having been reached at all — the shipped
    // hook under `sh -e` with NO shim present also exits 0 (measured). This
    // asserts, in the same execution, that the hook actually called through
    // the shim and reached the stubbed `rev-parse --show-toplevel` call.
    const invocations = readLogSafe(logPath)
    expect(invocations).toContain('rev-parse --show-toplevel')
  })
})
