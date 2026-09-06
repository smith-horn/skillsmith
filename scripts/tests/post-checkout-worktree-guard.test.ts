/**
 * SMI-5628: Tests for the linked-worktree guard in `.husky/post-checkout`.
 *
 * `.husky/post-checkout` (SMI-5343) runs `npm install` inside the
 * `skillsmith-dev-1` Docker container whenever a branch checkout changes
 * `package-lock.json` between the previous and new HEAD. In a linked
 * worktree created by `./scripts/create-worktree.sh`, that hardcoded
 * container name is MAIN's, not the worktree's own — the fix (mirroring the
 * already-shipped `.husky/post-merge` guard, SMI-5624) detects a linked
 * worktree via `git rev-parse --git-common-dir` vs `--git-dir` divergence
 * and skips-and-advises instead of installing. Unlike `post-merge`,
 * `post-checkout`'s host-install path was never auto-executed (advisory
 * only), so only the Docker block needed a behavioral guard — the host
 * advisory only needed its TEXT made worktree-aware.
 *
 * This suite builds a REAL git fixture with an ACTUAL linked worktree (`git
 * worktree add`), not a simulated one — the guard depends on genuine
 * git-dir/git-common-dir divergence. `npm` and `docker` are stubbed on a
 * fixture-local PATH (logging invocations, never doing a real install).
 * Unlike `post-merge` (which reads `ORIG_HEAD`/`HEAD` set by a real merge),
 * `post-checkout` takes its two SHAs as positional args ($1 prev_HEAD, $2
 * new_HEAD, $3 branch_flag) — this fixture builds a small commit chain once
 * and passes explicit SHA pairs to `runHook`, since a linked worktree shares
 * its main checkout's object database (any commit SHA is resolvable from
 * either cwd).
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
const POST_CHECKOUT_SCRIPT = resolve(__dirname, '..', '..', '.husky', 'post-checkout')

const ALL_ZEROS = '0000000000000000000000000000000000000000'

interface Fixture {
  root: string
  worktreeDir: string
  binDir: string
  npmLog: string
  dockerLog: string
  /** Commit before the lockfile bump. */
  beforeSha: string
  /** Commit that changes package-lock.json relative to beforeSha. */
  afterSha: string
  /** A further commit on top of afterSha that does NOT touch package-lock.json. */
  noLockfileDiffSha: string
}

/** Read a log file, returning '' if it was never created (nothing logged). */
function readLogSafe(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** Count non-overlapping occurrences of a literal substring in text. */
function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

/**
 * Write fake `npm` and `docker` executables to `binDir` on a fixture-local
 * PATH, plus a `git` wrapper that forwards every call to the REAL git except
 * `rev-parse --git-common-dir`, which it can be told (via env var) to return
 * a bogus, unresolvable path — simulating the `_MAIN_CHECKOUT` empty-fallback
 * branch (Case (e)) without breaking any other git operation the hook or
 * fixture setup depends on.
 */
function makeStubBin(binDir: string, npmLog: string, dockerLog: string, realGit: string): void {
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

  // Passthrough by default; only fakes --git-common-dir when
  // FAKE_UNRESOLVABLE_COMMON_DIR=1 is set in the hook's own invocation env.
  const gitShim = `#!/bin/sh
if [ "\${FAKE_UNRESOLVABLE_COMMON_DIR:-}" = "1" ] && [ "$1" = "rev-parse" ] && [ "$2" = "--git-common-dir" ]; then
  echo "/nonexistent-common-dir-for-smi-5628-test/.git"
  exit 0
fi
exec "${realGit}" "$@"
`
  writeFileSync(join(binDir, 'git'), gitShim, 'utf8')
  chmodSync(join(binDir, 'git'), 0o755)
}

/**
 * Build the fixture:
 *   root/       — main checkout, branch `main`, real node_modules/, a short
 *                 commit chain (init -> lockfile bump -> unrelated change)
 *   <root>-wt/  — linked worktree (git worktree add) on its own branch,
 *                 checked out at the lockfile-bump commit
 */
function makeFixture(): Fixture {
  const root = makeFixtureTempDir('post-checkout-guard-test')
  const env = makeFixtureEnv()
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()

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
  const beforeSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { env })
    .toString()
    .trim()

  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify(
      { lockfileVersion: 3, packages: { 'node_modules/foo': { version: '1.0.0' } } },
      null,
      2
    ),
    'utf8'
  )
  execFileSync('git', ['-C', root, 'add', 'package-lock.json'], { env })
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'bump lockfile'], { env })
  const afterSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { env }).toString().trim()

  writeFileSync(join(root, 'other.txt'), 'x', 'utf8')
  execFileSync('git', ['-C', root, 'add', 'other.txt'], { env })
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'unrelated change'], { env })
  const noLockfileDiffSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { env })
    .toString()
    .trim()

  const worktreeDir = `${root}-wt`
  execFileSync(
    'git',
    ['-C', root, 'worktree', 'add', '-q', '-b', 'wt-branch', worktreeDir, afterSha],
    {
      env,
    }
  )

  const binDir = join(root, '.test-bin')
  const npmLog = join(binDir, 'npm.log')
  const dockerLog = join(binDir, 'docker.log')
  makeStubBin(binDir, npmLog, dockerLog, realGit)

  return { root, worktreeDir, binDir, npmLog, dockerLog, beforeSha, afterSha, noLockfileDiffSha }
}

/** Run the real post-checkout hook with the fixture's stubbed PATH prepended. */
function runHook(
  cwd: string,
  binDir: string,
  prevHead: string,
  newHead: string,
  branchFlag: string,
  extraEnv: NodeJS.ProcessEnv = {}
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('sh', [POST_CHECKOUT_SCRIPT, prevHead, newHead, branchFlag], {
    cwd,
    encoding: 'utf8',
    env: {
      ...makeFixtureEnv(),
      PATH: `${binDir}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
      ...extraEnv,
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

describe('.husky/post-checkout — linked-worktree Docker-install guard (SMI-5628)', () => {
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

  it('(a) linked worktree: skips Docker entirely (docker never invoked), advises the main-checkout path for both Docker and host', () => {
    const { root, worktreeDir, binDir, beforeSha, afterSha, dockerLog } = fixture!

    const result = runHook(worktreeDir, binDir, beforeSha, afterSha, '1')
    expect(result.status).toBe(0)

    // The if/elif structure means docker is never even PROBED (docker ps),
    // let alone execed into — not just "no exec logged".
    expect(readLogSafe(dockerLog)).toBe('')

    expect(result.stdout).toMatch(/linked worktree/i)
    expect(result.stdout).toContain('Skipping Docker npm install')

    // Each advisory asserted independently — a path-substring check alone
    // can't tell the Docker and host advisories apart from one another.
    expect(countOccurrences(result.stdout, 'Run instead:')).toBe(2)
    expect(result.stdout).toContain(
      `Run instead: ( cd "${root}" && docker exec -w /app skillsmith-dev-1 npm install )`
    )
    expect(result.stdout).toContain(`Run instead: ( cd "${root}" && npm install )`)

    // No bare, cwd-blind "npm install" line should survive — that would mean
    // the host advisory regressed to its pre-fix wording while the Docker
    // advisory still looked correct.
    expect(result.stdout).not.toMatch(/^\s*npm install\s*$/m)
  })

  it('(b) main checkout (regression): installs into skillsmith-dev-1 exactly as before', () => {
    const { root, binDir, beforeSha, afterSha, dockerLog } = fixture!

    const result = runHook(root, binDir, beforeSha, afterSha, '1')
    expect(result.status).toBe(0)

    expect(readLogSafe(dockerLog)).toContain('docker exec -w /app skillsmith-dev-1 npm install')
    expect(result.stdout).not.toMatch(/linked worktree/i)
    expect(result.stdout).toMatch(/^\s*npm install\s*$/m)
  })

  it.each([
    ['(i) file checkout (branch_flag=0)', 'beforeSha', 'afterSha', '0'],
    ['(ii) orphan/initial checkout (prev_HEAD all-zeros)', 'ALL_ZEROS', 'afterSha', '1'],
    ['(iii) no-op checkout (prev_HEAD === new_HEAD)', 'afterSha', 'afterSha', '1'],
    ['(iv) no package-lock.json diff between the two SHAs', 'afterSha', 'noLockfileDiffSha', '1'],
  ])(
    '(c) %s: hook exits 0 with no output, from both main and worktree cwd',
    (_label, prevKey, newKey, branchFlag) => {
      const f = fixture!
      const shaFor = (key: string): string =>
        key === 'ALL_ZEROS' ? ALL_ZEROS : (f as unknown as Record<string, string>)[key]
      const prevHead = shaFor(prevKey)
      const newHead = shaFor(newKey)

      for (const cwd of [f.root, f.worktreeDir]) {
        const result = runHook(cwd, f.binDir, prevHead, newHead, branchFlag)
        expect(result.status).toBe(0)
        expect(result.stdout).toBe('')
      }
    }
  )

  it('(d) advisory formatting exactly matches post-merge (SMI-5624) — no drift between the two hooks', () => {
    const { root, worktreeDir, binDir, beforeSha, afterSha } = fixture!

    const result = runHook(worktreeDir, binDir, beforeSha, afterSha, '1')

    const dockerLine = result.stdout
      .split('\n')
      .find((l) => l.includes('docker exec -w /app skillsmith-dev-1 npm install'))
    const hostLine = result.stdout
      .split('\n')
      .find((l) => l.trim().startsWith('Run instead: ( cd') && !l.includes('docker exec'))

    expect(dockerLine?.trim()).toBe(
      `Run instead: ( cd "${root}" && docker exec -w /app skillsmith-dev-1 npm install )`
    )
    expect(hostLine?.trim()).toBe(`Run instead: ( cd "${root}" && npm install )`)
  })

  it('(e) _MAIN_CHECKOUT empty-fallback: falls back to the non-path-qualified advisory, never a broken cd ""', () => {
    const { worktreeDir, binDir, beforeSha, afterSha } = fixture!

    const result = runHook(worktreeDir, binDir, beforeSha, afterSha, '1', {
      FAKE_UNRESOLVABLE_COMMON_DIR: '1',
    })
    expect(result.status).toBe(0)

    expect(result.stdout).toMatch(/linked worktree/i)
    expect(result.stdout).toContain('Run instead: docker exec -w /app skillsmith-dev-1 npm install')
    expect(result.stdout).toContain('Run npm install in the main checkout instead.')
    expect(result.stdout).not.toContain('cd ""')
  })
})
