/**
 * SMI-5548: Tests for scripts/lib/check-dist-fresh.sh.
 *
 * Drives the detector against an isolated temp-dir fixture — NEVER the live
 * repo tree — to prevent any mutation of the shared dist/ sentinels (the
 * live-repo verification during implementation already showed this script
 * writes real files under packages/*\/dist/, so a real-tree test run would
 * leave litter behind).
 *
 * The script resolves DIST_ROOT via `git rev-parse --show-toplevel` /
 * `--git-common-dir` (mirroring check-node-modules-fresh.sh's
 * `_MAIN_CHECKOUT` logic), so each fixture is a real (minimal) git repo
 * containing:
 *   - a root tsconfig.json + packages/enterprise/.submodule-hash (the
 *     "global" build-input segment)
 *   - one package (packages/core) with src/, package.json, tsconfig.json
 *   - a packages/core/dist/ directory (representing already-built output)
 *
 * Only ONE package is populated in the fixture. The script loops over all
 * four packages (core mcp-server enterprise cli) but `continue`s for any
 * whose dist/ directory is absent — so leaving the other three unpopulated
 * exercises that skip path for free and keeps the fixture small.
 *
 * Cases covered (D- prefix, mirroring the sibling suite's P- convention):
 *   D-1 FRESH:            --write-sentinel, then default check → exit 0.
 *   D-2 DRIFT:             write sentinel, commit a source change → check →
 *                          exit 1; output names the stale package + `npm run
 *                          build`, does NOT contain `--no-verify`.
 *   D-3 MISSING SENTINEL: no sentinel → check → exit 1.
 *   D-4 ESCAPE HATCH:      SKILLSMITH_SKIP_DIST_FRESHNESS=1 on a drifted
 *                          fixture → exit 0 silently.
 *   D-5 NO-WRITE:          snapshot sentinel mtime/inode + dist/ listing
 *                          before a default CHECK; assert both unchanged
 *                          after (P-5 invariant, ported from the deps gate).
 *   D-6 FRESH CLONE:       no dist/ directories anywhere → exit 0 (nothing
 *                          built yet; existsSync guards elsewhere handle it).
 *   D-7 FAIL-SOFT:         `git hash-object` unusable → every package's hash
 *                          comes back empty → skip (never false-drift) →
 *                          exit 0 without writing a sentinel.
 *   D-8 WORKTREE ADVISORY (SMI-5564): same drift as D-2, but the check runs
 *                          from a LINKED WORKTREE of the fixture repo (not
 *                          the fixture root) → exit 0 (non-blocking), output
 *                          still names the stale package but is the
 *                          "WARNING (non-blocking" banner, not the blocking
 *                          "✗ Stale Build Output" one. Confirms the
 *                          main-checkout case (D-2) is unaffected by this
 *                          change — only pushes FROM a worktree stop blocking.
 *
 * SMI-4693: uses makeFixtureEnv (strips GIT_DISCOVERY_VARS) and
 * makeFixtureTempDir (realpath-canonical tmpdir) for git fixture isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  statSync,
  readdirSync,
  existsSync,
  chmodSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Absolute path to the script under test — must be stable regardless of cwd.
const SCRIPT = resolve(__dirname, '..', 'lib', 'check-dist-fresh.sh')

// Sentinel filename as declared in the script.
const SENTINEL_NAME = '.skillsmith-dist-hash'

// The single package populated in the fixture (see file header).
const PKG = 'core'

// ── Fixture helpers ────────────────────────────────────────────────────────────

/**
 * Build a minimal git repo fixture:
 *   root/
 *     tsconfig.json                    (stub — global build-input segment)
 *     packages/enterprise/.submodule-hash (stub — global build-input segment)
 *     packages/core/src/index.ts       (stub package source)
 *     packages/core/package.json
 *     packages/core/tsconfig.json
 *     packages/core/dist/              (empty dir — represents built output)
 *
 * The git init + commit ensures `git rev-parse --show-toplevel` resolves to
 * `root` when the script is invoked with `cwd: root`.
 */
function makeFixture(): {
  root: string
  distDir: string
  sentinel: string
  srcFile: string
} {
  const root = makeFixtureTempDir('dist-freshness-test')
  const env = makeFixtureEnv()

  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', root], { env })

  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: {} }, null, 2),
    'utf8'
  )

  mkdirSync(join(root, 'packages', 'enterprise'), { recursive: true })
  writeFileSync(join(root, 'packages', 'enterprise', '.submodule-hash'), 'stub-hash\n', 'utf8')

  const pkgDir = join(root, 'packages', PKG)
  mkdirSync(join(pkgDir, 'src'), { recursive: true })
  const srcFile = join(pkgDir, 'src', 'index.ts')
  writeFileSync(srcFile, 'export const x = 1\n', 'utf8')
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: `@skillsmith/${PKG}` }, null, 2),
    'utf8'
  )
  writeFileSync(
    join(pkgDir, 'tsconfig.json'),
    JSON.stringify({ extends: '../../tsconfig.json' }, null, 2),
    'utf8'
  )

  execFileSync('git', ['-C', root, 'add', '-A'], { env })
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'init'], { env })

  const distDir = join(pkgDir, 'dist')
  mkdirSync(distDir, { recursive: true })

  return { root, distDir, sentinel: join(distDir, SENTINEL_NAME), srcFile }
}

/** Commit a change to a fixture file so it moves HEAD (the script hashes
 * `git ls-tree HEAD`, so only committed content — not working-tree edits —
 * changes the resulting hash). */
function commitChange(root: string, message: string): void {
  const env = makeFixtureEnv()
  execFileSync('git', ['-C', root, 'add', '-A'], { env })
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', message], { env })
}

/** Run the script and capture both exit status and combined stdout+stderr. */
function runScript(
  root: string,
  args: string[] = [],
  extraEnv: Record<string, string> = {}
): { status: number; output: string } {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...makeFixtureEnv(),
      // Keep PATH so git is reachable (unless a test overrides it).
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      ...extraEnv,
    },
    // Capture both streams; the script writes to stdout only.
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  })
  const output = (result.stdout ?? '') + (result.stderr ?? '')
  return { status: result.status ?? 1, output }
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('check-dist-fresh.sh (SMI-5548)', () => {
  let fixture: ReturnType<typeof makeFixture> | null = null

  beforeEach(() => {
    fixture = makeFixture()
  })

  afterEach(() => {
    if (fixture && existsSync(fixture.root)) {
      rmSync(fixture.root, { recursive: true, force: true })
    }
    fixture = null
  })

  // ── D-1 FRESH ───────────────────────────────────────────────────────────────

  it('D-1 FRESH: write-sentinel then default check exits 0', () => {
    const { root, sentinel } = fixture!

    const write = runScript(root, ['--write-sentinel'])
    expect(write.status).toBe(0)
    expect(existsSync(sentinel)).toBe(true)

    const check = runScript(root)
    expect(check.status).toBe(0)
    expect(check.output).toBe('')
  })

  // ── D-2 DRIFT ───────────────────────────────────────────────────────────────

  it('D-2 DRIFT: a committed source change exits 1 naming the stale package and npm run build, but not --no-verify', () => {
    const { root, srcFile } = fixture!

    const write = runScript(root, ['--write-sentinel'])
    expect(write.status).toBe(0)

    writeFileSync(srcFile, 'export const x = 2\n', 'utf8')
    commitChange(root, 'change src')

    const check = runScript(root)
    expect(check.status).toBe(1)
    expect(check.output).toMatch(new RegExp(`packages/${PKG}/dist`))
    expect(check.output).toMatch(/npm run build/)
    expect(check.output).not.toMatch(/--no-verify/)
  })

  // ── D-3 MISSING SENTINEL ────────────────────────────────────────────────────

  it('D-3 MISSING SENTINEL: no sentinel written yet exits 1', () => {
    const { root, sentinel } = fixture!

    expect(existsSync(sentinel)).toBe(false)

    const check = runScript(root)
    expect(check.status).toBe(1)
    expect(check.output).toMatch(new RegExp(`packages/${PKG}/dist`))
  })

  // ── D-4 ESCAPE HATCH ────────────────────────────────────────────────────────

  it('D-4 ESCAPE HATCH: SKILLSMITH_SKIP_DIST_FRESHNESS=1 bypasses check even when drifted', () => {
    const { root, srcFile } = fixture!

    runScript(root, ['--write-sentinel'])
    writeFileSync(srcFile, 'export const x = 3\n', 'utf8')
    commitChange(root, 'change src again')

    const checkWithoutEscape = runScript(root)
    expect(checkWithoutEscape.status).toBe(1)

    const checkWithEscape = runScript(root, [], {
      SKILLSMITH_SKIP_DIST_FRESHNESS: '1',
    })
    expect(checkWithEscape.status).toBe(0)
    expect(checkWithEscape.output).toBe('')
  })

  // ── D-5 NO-WRITE ────────────────────────────────────────────────────────────

  it('D-5 NO-WRITE: default check does not mutate sentinel or dist/ listing', () => {
    const { root, sentinel, distDir, srcFile } = fixture!

    runScript(root, ['--write-sentinel'])
    // Drift the fixture so the check mode has maximum opportunity to write.
    writeFileSync(srcFile, 'export const x = 4\n', 'utf8')
    commitChange(root, 'drift for no-write check')

    const statBefore = statSync(sentinel)
    const inodeBefore = statBefore.ino
    const mtimeBefore = statBefore.mtimeMs
    const listBefore = readdirSync(distDir).sort()

    const check = runScript(root)
    expect(check.status).toBe(1) // confirms the drift path was taken

    const statAfter = statSync(sentinel)
    expect(statAfter.ino).toBe(inodeBefore)
    expect(statAfter.mtimeMs).toBe(mtimeBefore)

    const listAfter = readdirSync(distDir).sort()
    expect(listAfter).toEqual(listBefore)
  })

  // ── D-6 FRESH CLONE ─────────────────────────────────────────────────────────

  it('D-6 FRESH CLONE: no dist/ directories anywhere exits 0 (nothing built yet)', () => {
    const { root, distDir } = fixture!

    rmSync(distDir, { recursive: true, force: true })

    const check = runScript(root)
    expect(check.status).toBe(0)
    expect(check.output).toBe('')
  })

  // ── D-7 FAIL-SOFT ────────────────────────────────────────────────────────────

  it('D-7 FAIL-SOFT: git hash-object unusable exits 0 without writing a sentinel', () => {
    const { root, sentinel } = fixture!

    // Shim PATH containing only `bash` (needed to spawn the script) and a
    // `git` wrapper that passes every subcommand through to the real git
    // EXCEPT `hash-object`, which it fails outright — simulating a
    // corrupt/unusable git-hash tool without needing to strip git (and its
    // transitive coreutils dependents like `dirname`) from PATH entirely.
    const binDir = join(root, '_isobin')
    mkdirSync(binDir, { recursive: true })

    const realBash = execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim()
    writeFileSync(join(binDir, 'bash'), `#!/bin/sh\nexec "${realBash}" "$@"\n`, 'utf8')
    chmodSync(join(binDir, 'bash'), 0o755)

    const realGit = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    const gitShim = [
      '#!/bin/sh',
      'for _a in "$@"; do',
      '  if [ "$_a" = "hash-object" ]; then exit 1; fi',
      'done',
      `exec "${realGit}" "$@"`,
      '',
    ].join('\n')
    writeFileSync(join(binDir, 'git'), gitShim, 'utf8')
    chmodSync(join(binDir, 'git'), 0o755)

    const check = runScript(root, [], { PATH: binDir })
    // Fail-soft: hash-object unusable → every package's hash comes back
    // empty → the script must skip (never manufacture a false drift) and
    // exit 0 silently.
    expect(check.status).toBe(0)
    expect(check.output).toBe('')
    // Check mode must never create the sentinel (D-5 invariant).
    expect(existsSync(sentinel)).toBe(false)
  })

  // ── D-8 WORKTREE ADVISORY (SMI-5564) ────────────────────────────────────────

  it('D-8 WORKTREE ADVISORY: drift from a linked worktree is a non-blocking warning, not a hard block', () => {
    const { root, srcFile } = fixture!
    const env = makeFixtureEnv()

    const write = runScript(root, ['--write-sentinel'])
    expect(write.status).toBe(0)

    writeFileSync(srcFile, 'export const x = 5\n', 'utf8')
    commitChange(root, 'drift for worktree-advisory check')

    // Create a linked worktree of the fixture repo. dist/ is untracked (per
    // the script's own design — worktrees never have their own dist/), so
    // the worktree's checkout doesn't need one; the script always resolves
    // DIST_ROOT back to `root` regardless of which of the two `cwd:` is used.
    const worktreeDir = join(root, '..', 'dist-freshness-test-wt')
    execFileSync('git', ['-C', root, 'worktree', 'add', worktreeDir, '-b', 'wt-branch'], { env })

    try {
      const checkFromWorktree = runScript(worktreeDir)
      expect(checkFromWorktree.status).toBe(0)
      expect(checkFromWorktree.output).toMatch(/WARNING \(non-blocking/)
      expect(checkFromWorktree.output).toMatch(new RegExp(`packages/${PKG}/dist`))
      expect(checkFromWorktree.output).not.toMatch(/✗ Stale Build Output/)

      // Same drifted state, run from the fixture root itself (not a linked
      // worktree) — must still hard-block. Confirms D-2's behavior is
      // unaffected by this change; only the worktree case became advisory.
      const checkFromRoot = runScript(root)
      expect(checkFromRoot.status).toBe(1)
      expect(checkFromRoot.output).toMatch(/✗ Stale Build Output/)
    } finally {
      execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', worktreeDir], {
        env,
      })
    }
  })
})
