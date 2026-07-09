/**
 * SMI-5623: Tests for the linked-worktree guard in `.husky/post-merge`.
 *
 * `.husky/post-merge` (SMI-2552, extended SMI-5343) runs `npm install` twice
 * whenever `package-lock.json` changes between `ORIG_HEAD` and `HEAD`: once in
 * the `skillsmith-dev-1` Docker container (fixed path `/app`, immune to cwd),
 * once directly on the host in the hook's own cwd. In a linked worktree
 * created by `./scripts/create-worktree.sh`, `node_modules` (root + every
 * `packages/&#42;/node_modules`) is a SYMLINK into the main checkout's tree
 * (SMI-4377/SMI-4381) — running `npm install` there unlinks the symlink and
 * rebuilds a real directory in its place, corrupting the worktree's local
 * dependency state. The fix detects a linked worktree via `git rev-parse
 * --git-common-dir` vs `--git-dir` divergence (same idiom as
 * `scripts/lib/check-node-modules-fresh.sh`) and skips-and-advises instead of
 * installing.
 *
 * This suite builds a REAL git fixture with an ACTUAL linked worktree (`git
 * worktree add`, not a simulated one) — the guard condition depends on
 * genuine git-dir/git-common-dir divergence, which only a real linked
 * worktree produces. `npm` and `docker` are stubbed on a fixture-local PATH
 * (logging invocations, never doing a real install). A REAL merge that
 * changes `package-lock.json` is performed independently in both the main
 * checkout and the worktree (each worktree has its own `ORIG_HEAD` — it is
 * per-worktree state, not shared via the common git dir), so `ORIG_HEAD` is
 * set by git itself in both locations, not hand-set as an env var. The real
 * `.husky/post-merge` script is invoked in place via `sh <path>` with `cwd`
 * set to each fixture location — never against the live repo tree.
 *
 * Cases covered:
 *   (a) LINKED WORKTREE: cwd = the linked worktree's root. Host npm install
 *       is skipped (no "install" logged); stdout names "linked worktree" and
 *       the resolved main-checkout path; the Docker path is untouched (still
 *       invoked) — proves the guard is scoped to the host block only.
 *   (b) MAIN CHECKOUT (regression): cwd = the fixture's main repo root (NOT a
 *       linked worktree). Host npm install still runs normally — proves the
 *       guard doesn't break the common case.
 *
 * SMI-4693: uses makeFixtureEnv (strips GIT_DISCOVERY_VARS) and
 * makeFixtureTempDir (realpath-canonical tmpdir) for git fixture isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Absolute path to the real hook under test — stable regardless of cwd, and
// invoked directly via `sh`, never installed as a live git hook.
const POST_MERGE_SCRIPT = resolve(__dirname, '..', '..', '.husky', 'post-merge')

interface Fixture {
  root: string
  worktreeDir: string
  binDir: string
  npmLog: string
  dockerLog: string
}

/** Read a log file, returning '' if it was never created (nothing logged). */
function readLogSafe(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/**
 * Write fake `npm` and `docker` executables to `binDir` on a fixture-local
 * PATH. Both just append an invocation marker to a log file and exit 0 — no
 * real install, no real container access.
 *
 * The `docker` stub answers `docker ps --format '{{.Names}}'` with a line
 * containing `skillsmith-dev-1` (so the hook's `command -v docker` +
 * `docker ps | grep -q` gate passes and enters the Docker-install branch),
 * and handles `docker exec -w /app skillsmith-dev-1 npm install` (log + exit
 * 0) — both code paths the hook exercises need a response, not just the
 * install call.
 */
function makeStubBin(binDir: string, npmLog: string, dockerLog: string): void {
  mkdirSync(binDir, { recursive: true })

  const npmShim = `#!/bin/sh\necho "npm $*" >> "${npmLog}"\nexit 0\n`
  writeFileSync(join(binDir, 'npm'), npmShim, 'utf8')
  chmodSync(join(binDir, 'npm'), 0o755)

  const dockerShim = `#!/bin/sh
echo "docker $*" >> "${dockerLog}"
case "$1" in
  ps)
    echo "skillsmith-dev-1"
    ;;
esac
exit 0
`
  writeFileSync(join(binDir, 'docker'), dockerShim, 'utf8')
  chmodSync(join(binDir, 'docker'), 0o755)
}

/**
 * Commit a package-lock.json change on a throwaway topic branch, then merge
 * it (--no-ff) back into `targetBranch` in `dir` — a REAL merge, so git
 * itself sets ORIG_HEAD (to the pre-merge tip) and HEAD (to the merge
 * commit) exactly as a `git pull`/`git merge` would in practice. ORIG_HEAD is
 * per-worktree state (stored in each worktree's own git-dir, not the shared
 * common dir), so this must be run independently in the main checkout AND in
 * the linked worktree for each to get its own genuine ORIG_HEAD.
 */
function bumpLockfileViaMerge(
  dir: string,
  env: NodeJS.ProcessEnv,
  targetBranch: string,
  suffix: string
): void {
  const topicBranch = `lockfile-bump-${suffix}`
  execFileSync('git', ['-C', dir, 'checkout', '-q', '-b', topicBranch], { env })
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify(
      { lockfileVersion: 3, packages: { [`node_modules/${suffix}`]: { version: '1.0.0' } } },
      null,
      2
    ),
    'utf8'
  )
  execFileSync('git', ['-C', dir, 'add', 'package-lock.json'], { env })
  execFileSync('git', ['-C', dir, 'commit', '--quiet', '-m', `bump lockfile (${suffix})`], { env })
  execFileSync('git', ['-C', dir, 'checkout', '-q', targetBranch], { env })
  execFileSync('git', ['-C', dir, 'merge', '--no-ff', '--no-edit', '-q', topicBranch], { env })
}

/**
 * Build the fixture:
 *   root/               — main checkout, branch `main`, real node_modules/
 *     package-lock.json
 *     node_modules/
 *   <root>-wt/           — linked worktree (git worktree add), branch `wt-branch`
 *
 * Both `root` (on `main`) and the worktree (on `wt-branch`) then get their
 * own independent real merge that changes package-lock.json, so each has its
 * own genuine ORIG_HEAD pointing at its own pre-merge tip.
 */
function makeFixture(): Fixture {
  const root = makeFixtureTempDir('post-merge-guard-test')
  const env = makeFixtureEnv()

  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', root], { env })
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({ lockfileVersion: 3, packages: {} }, null, 2),
    'utf8'
  )
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  writeFileSync(join(root, 'node_modules', '.gitkeep'), '', 'utf8')
  execFileSync('git', ['-C', root, 'add', 'package-lock.json', 'node_modules/.gitkeep'], { env })
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'init'], { env })

  // Real linked worktree off the initial commit, on its own branch.
  const worktreeDir = `${root}-wt`
  execFileSync(
    'git',
    ['-C', root, 'worktree', 'add', '-q', '-b', 'wt-branch', worktreeDir, 'main'],
    {
      env,
    }
  )

  // Independent real merges: each location gets its own genuine ORIG_HEAD.
  bumpLockfileViaMerge(root, env, 'main', 'main')
  bumpLockfileViaMerge(worktreeDir, env, 'wt-branch', 'wt')

  const binDir = join(root, '.test-bin')
  const npmLog = join(binDir, 'npm.log')
  const dockerLog = join(binDir, 'docker.log')
  makeStubBin(binDir, npmLog, dockerLog)

  return { root, worktreeDir, binDir, npmLog, dockerLog }
}

/** Run the real post-merge hook with the fixture's stubbed PATH prepended. */
function runHook(cwd: string, binDir: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('sh', [POST_MERGE_SCRIPT], {
    cwd,
    encoding: 'utf8',
    env: {
      ...makeFixtureEnv(),
      // Prepend the stub bin dir so it shadows any real npm/docker further
      // down PATH; keep the rest of PATH so git/sh/grep/etc. still resolve.
      PATH: `${binDir}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

describe('.husky/post-merge — linked-worktree host-install guard (SMI-5623)', () => {
  let fixture: Fixture | null = null

  beforeEach(() => {
    fixture = makeFixture()
  })

  afterEach(() => {
    if (fixture) {
      const { root, worktreeDir } = fixture
      try {
        execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', worktreeDir], {
          env: makeFixtureEnv(),
        })
      } catch {
        // best-effort — fall through to directory removal below regardless
      }
      if (existsSync(worktreeDir)) rmSync(worktreeDir, { recursive: true, force: true })
      if (existsSync(root)) rmSync(root, { recursive: true, force: true })
    }
    fixture = null
  })

  it('(a) linked worktree: skips host npm install, advises the main-checkout path, leaves the Docker path untouched', () => {
    const { root, worktreeDir, binDir, npmLog, dockerLog } = fixture!

    const result = runHook(worktreeDir, binDir)
    expect(result.status).toBe(0)

    // Host npm install must be skipped entirely — no "install" invocation logged.
    const npmLogContent = readLogSafe(npmLog)
    expect(npmLogContent).not.toMatch(/install/)

    // The advisory names the linked-worktree condition and the resolved
    // main-checkout path (git-common-dir's parent).
    expect(result.stdout).toMatch(/linked worktree/i)
    expect(result.stdout).toContain(root)

    // The Docker path targets the fixed /app path regardless of cwd and is
    // untouched by this guard — it must still have been invoked, proving the
    // guard is scoped to the host install block only.
    const dockerLogContent = readLogSafe(dockerLog)
    expect(dockerLogContent).toMatch(/exec/)
  })

  it('(b) main checkout (regression): host npm install still runs when cwd is not a linked worktree', () => {
    const { root, binDir, npmLog } = fixture!

    const result = runHook(root, binDir)
    expect(result.status).toBe(0)

    const npmLogContent = readLogSafe(npmLog)
    expect(npmLogContent).toMatch(/install/)

    // No linked-worktree advisory should appear for the main checkout.
    expect(result.stdout).not.toMatch(/linked worktree/i)
  })
})
