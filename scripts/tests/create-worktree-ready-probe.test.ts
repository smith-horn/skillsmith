/**
 * SMI-5596: Unit tests for create-worktree.sh's Step 8 container-view
 * readiness probe (`should_probe_container`, `probe_container_worktree_ready`)
 * and the shared `run_with_timeout` helper (`scripts/_lib.sh`).
 *
 * Per this repo's "never `skipIf(inDocker)`" rule (a real container isn't
 * available in every environment vitest runs in, including CI), every
 * scenario here drives the scripts through an INJECTED FAKE `docker` /
 * `uname` / `gtimeout` / `timeout` seam on a curated `PATH` (built by
 * scripts/tests/_lib/worktree-probe-shim.ts) — there is no dependency on a
 * real running `skillsmith-dev-1` container anywhere in this file. That is
 * a deliberate scope boundary (see the plan's Smoke vs CI section): this
 * file proves the probe's *branching logic* is correct; it does NOT (and
 * cannot) prove the real macOS Docker Desktop file-sharing propagation
 * race is closed — that is the separate, human-run post-ship smoke path.
 *
 * create-worktree.sh normally auto-runs `main "$@"` at import time; a
 * `[[ "${BASH_SOURCE[0]}" == "${0}" ]]` guard was added around that call
 * so this file can `source` it to unit-test `should_probe_container` /
 * `probe_container_worktree_ready` directly, without triggering a full
 * worktree-creation run. Executing the script directly is unaffected.
 *
 * Cases covered:
 *   G1-G8  should_probe_container: the "run" case plus all 6 skip gates
 *          (macOS gate is exercised via both G1's Darwin fake and G2's
 *          Linux fake, plus the explicit-disable gate checked first)
 *   P1-P2  probe_container_worktree_ready: settles immediately, and
 *          settles after transient failures reset the consecutive-pass
 *          counter (proves the "2 CONSECUTIVE passes" requirement)
 *   T1     probe_container_worktree_ready: timeout branch prints the
 *          actionable boxed warning (both causes named) and still exits 0
 *   R1-R3  run_with_timeout: gtimeout present / gtimeout absent + timeout
 *          present / neither present (unbounded fallback) — proves which
 *          binary it delegates to and that the wrapped exit code survives
 *
 * Also see scripts/tests/create-worktree-hooks.test.sh for the companion
 * idempotent-relink coverage of link_worktree_node_modules /
 * link_worktree_package_node_modules / repair_worktrees_node_modules
 * (SMI-5596 Scenarios 4b/4c, 6b-idem, 6d-idem).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'
import {
  buildBaseShim,
  fakeUname,
  fakeDocker,
  fakeTimeoutBinary,
} from './_lib/worktree-probe-shim.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const CREATE_WORKTREE_SCRIPT = resolve(__dirname, '..', 'create-worktree.sh')
const LIB_SCRIPT = resolve(__dirname, '..', '_lib.sh')

// Resolved once via the AMBIENT test environment (not the curated fake PATH
// below) so spawnSync is given bash's absolute path directly — none of the
// curated shims need to contain `bash` itself. Mirrors check-dist-fresh.test.ts.
const REAL_BASH = execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim()

/** Run a bash snippet and capture status + combined stdout/stderr. */
function run(
  script: string,
  opts: { cwd?: string; path: string; env?: Record<string, string>; args?: string[] }
): { status: number; output: string } {
  const result = spawnSync(REAL_BASH, ['-c', script, 'test', ...(opts.args ?? [])], {
    cwd: opts.cwd,
    encoding: 'utf8',
    env: { PATH: opts.path, ...opts.env },
    timeout: 20_000,
  })
  return { status: result.status ?? 1, output: (result.stdout ?? '') + (result.stderr ?? '') }
}

// ── Repo fixture (for should_probe_container / probe_container_worktree_ready) ──

function makeRepoFixture(): { repoRoot: string; worktreePath: string } {
  const repoRoot = makeFixtureTempDir('wt-ready-probe')
  const env = makeFixtureEnv()

  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', repoRoot], { env })

  // One package, so the expected_pkgs loop (mirroring
  // link_worktree_package_node_modules's own gate) has a realistic,
  // non-empty case to exercise rather than always short-circuiting empty.
  mkdirSync(join(repoRoot, 'packages', 'core', 'node_modules'), { recursive: true })
  writeFileSync(join(repoRoot, 'packages', 'core', 'package.json'), '{}\n', 'utf8')
  execFileSync('git', ['-C', repoRoot, 'add', '-A'], { env })
  execFileSync('git', ['-C', repoRoot, 'commit', '--quiet', '-m', 'init'], { env })

  const worktreePath = join(repoRoot, '.worktrees', 'wt1')
  mkdirSync(join(worktreePath, 'packages', 'core'), { recursive: true })

  return { repoRoot, worktreePath }
}

function runGate(opts: {
  repoRoot: string
  worktreePath: string
  path: string
  env?: Record<string, string>
  mainGitDir?: string
}): { status: number; output: string } {
  const mainGitDir = opts.mainGitDir ?? join(opts.repoRoot, '.git')
  const script = [
    'set -euo pipefail',
    `source ${JSON.stringify(CREATE_WORKTREE_SCRIPT)}`,
    `MAIN_GIT_DIR=${JSON.stringify(mainGitDir)}`,
    'if should_probe_container "$1"; then echo "GATE=RUN"; else echo "GATE=SKIP"; fi',
  ].join('\n')
  return run(script, {
    cwd: opts.repoRoot,
    path: opts.path,
    env: opts.env,
    args: [opts.worktreePath],
  })
}

function runProbe(opts: {
  repoRoot: string
  worktreePath: string
  path: string
  env?: Record<string, string>
}): { status: number; output: string } {
  const script = [
    'set -euo pipefail',
    `source ${JSON.stringify(CREATE_WORKTREE_SCRIPT)}`,
    'MAIN_GIT_DIR="$REPO_ROOT/.git"',
    'probe_container_worktree_ready "$1"',
  ].join('\n')
  return run(script, {
    cwd: opts.repoRoot,
    path: opts.path,
    env: opts.env,
    args: [opts.worktreePath],
  })
}

// ── Suite: should_probe_container + probe_container_worktree_ready ──────────

describe('create-worktree.sh Step 8 readiness probe (SMI-5596)', () => {
  let fixture: ReturnType<typeof makeRepoFixture> | null = null
  let shimDirs: string[] = []

  beforeEach(() => {
    fixture = makeRepoFixture()
    shimDirs = []
  })

  afterEach(() => {
    if (fixture && existsSync(fixture.repoRoot)) {
      rmSync(fixture.repoRoot, { recursive: true, force: true })
    }
    for (const d of shimDirs) {
      if (existsSync(d)) rmSync(d, { recursive: true, force: true })
    }
    fixture = null
    shimDirs = []
  })

  function shim(): string {
    const dir = buildBaseShim()
    shimDirs.push(dir)
    return dir
  }

  // ── Gate matrix ──────────────────────────────────────────────────────────

  it('G1: runs when every condition is satisfied (macOS, container up, in-tree, no opt-outs)', () => {
    const dir = shim()
    fakeUname(dir, 'Darwin')
    fakeDocker(dir)
    const result = runGate({
      repoRoot: fixture!.repoRoot,
      worktreePath: fixture!.worktreePath,
      path: dir,
    })
    expect(result.output).toMatch(/GATE=RUN/)
  })

  it('G2: skips on non-macOS', () => {
    const dir = shim()
    fakeUname(dir, 'Linux')
    fakeDocker(dir)
    const result = runGate({
      repoRoot: fixture!.repoRoot,
      worktreePath: fixture!.worktreePath,
      path: dir,
    })
    expect(result.output).toMatch(/GATE=SKIP/)
    expect(result.output).toMatch(/Non-macOS/)
  })

  it('G3: skips when the docker CLI is absent', () => {
    const dir = shim()
    fakeUname(dir, 'Darwin')
    // Deliberately no `docker` fake/passthrough at all.
    const result = runGate({
      repoRoot: fixture!.repoRoot,
      worktreePath: fixture!.worktreePath,
      path: dir,
    })
    expect(result.output).toMatch(/GATE=SKIP/)
    expect(result.output).toMatch(/Docker CLI not found/)
  })

  it('G4: skips when the shared container is not running', () => {
    const dir = shim()
    fakeUname(dir, 'Darwin')
    fakeDocker(dir)
    const result = runGate({
      repoRoot: fixture!.repoRoot,
      worktreePath: fixture!.worktreePath,
      path: dir,
      env: { FAKE_DOCKER_CONTAINER_UP: '0' },
    })
    expect(result.output).toMatch(/GATE=SKIP/)
    expect(result.output).toMatch(/not running/)
  })

  it('G5: skips for an off-tree worktree', () => {
    const dir = shim()
    fakeUname(dir, 'Darwin')
    fakeDocker(dir)
    const offtree = makeFixtureTempDir('wt-ready-probe-offtree')
    try {
      const result = runGate({
        repoRoot: fixture!.repoRoot,
        worktreePath: offtree,
        path: dir,
      })
      expect(result.output).toMatch(/GATE=SKIP/)
      expect(result.output).toMatch(/outside repo root/)
    } finally {
      rmSync(offtree, { recursive: true, force: true })
    }
  })

  it('G6: skips on explicit host opt-out (SKILLSMITH_PRE_PUSH_HOST=1)', () => {
    const dir = shim()
    fakeUname(dir, 'Darwin')
    fakeDocker(dir)
    const result = runGate({
      repoRoot: fixture!.repoRoot,
      worktreePath: fixture!.worktreePath,
      path: dir,
      env: { SKILLSMITH_PRE_PUSH_HOST: '1' },
    })
    expect(result.output).toMatch(/GATE=SKIP/)
    expect(result.output).toMatch(/SKILLSMITH_PRE_PUSH_HOST/)
  })

  it('G7: skips for a nested-worktree invocation (REPO_ROOT itself is a worktree)', () => {
    const dir = shim()
    fakeUname(dir, 'Darwin')
    fakeDocker(dir)
    const result = runGate({
      repoRoot: fixture!.repoRoot,
      worktreePath: fixture!.worktreePath,
      path: dir,
      mainGitDir: '/tmp/some-other-main-checkout/.git',
    })
    expect(result.output).toMatch(/GATE=SKIP/)
    expect(result.output).toMatch(/nested worktree/)
  })

  it('G8: skips on explicit disable (SKILLSMITH_WORKTREE_READY_PROBE_DISABLE=1)', () => {
    const dir = shim()
    fakeUname(dir, 'Darwin')
    fakeDocker(dir)
    const result = runGate({
      repoRoot: fixture!.repoRoot,
      worktreePath: fixture!.worktreePath,
      path: dir,
      env: { SKILLSMITH_WORKTREE_READY_PROBE_DISABLE: '1' },
    })
    expect(result.output).toMatch(/GATE=SKIP/)
    expect(result.output).toMatch(/disabled/)
  })

  // ── Poll-until-ready ─────────────────────────────────────────────────────

  it('P1: settles immediately when the container is always ready', () => {
    const dir = shim()
    fakeDocker(dir)
    const result = runProbe({
      repoRoot: fixture!.repoRoot,
      worktreePath: fixture!.worktreePath,
      path: dir,
      env: { FAKE_DOCKER_EXEC_MODE: 'ok' },
    })
    expect(result.status).toBe(0)
    expect(result.output).toMatch(/Container view settled/)
    expect(result.output).not.toMatch(/WARNING \(non-blocking/)
  }, 20_000)

  it('P2: settles after transient failures reset the consecutive-pass counter', () => {
    const dir = shim()
    fakeDocker(dir)
    const counterFile = join(dir, 'counter.txt')
    const result = runProbe({
      repoRoot: fixture!.repoRoot,
      worktreePath: fixture!.worktreePath,
      path: dir,
      env: {
        FAKE_DOCKER_EXEC_MODE: 'ready-after',
        FAKE_DOCKER_READY_AFTER: '3',
        FAKE_DOCKER_COUNTER_FILE: counterFile,
      },
    })
    expect(result.status).toBe(0)
    expect(result.output).toMatch(/Container view settled/)
  }, 20_000)

  // ── Timeout branch ───────────────────────────────────────────────────────

  it('T1: prints the actionable boxed warning (both causes named) and still exits 0 on timeout', () => {
    const dir = shim()
    fakeDocker(dir)
    const result = runProbe({
      repoRoot: fixture!.repoRoot,
      worktreePath: fixture!.worktreePath,
      path: dir,
      env: {
        FAKE_DOCKER_EXEC_MODE: 'fail',
        SKILLSMITH_WORKTREE_READY_PROBE_TIMEOUT: '2',
      },
    })
    expect(result.status).toBe(0)
    expect(result.output).toMatch(/WARNING \(non-blocking — worktree created successfully\)/)
    expect(result.output).toMatch(/Docker Desktop's macOS file-sharing/)
    expect(result.output).toMatch(/node_modules named volume is not built/)
    expect(result.output).toMatch(/timed out after 2s/)
  }, 20_000)
})

// ── Suite: run_with_timeout capability-detection branches (scripts/_lib.sh) ──

describe('run_with_timeout capability detection (SMI-5596 / SMI-4700)', () => {
  let shimDirs: string[] = []

  beforeEach(() => {
    shimDirs = []
  })

  afterEach(() => {
    for (const d of shimDirs) {
      if (existsSync(d)) rmSync(d, { recursive: true, force: true })
    }
    shimDirs = []
  })

  function shim(): string {
    const dir = buildBaseShim()
    shimDirs.push(dir)
    return dir
  }

  function runRunWithTimeout(path: string): { status: number; output: string } {
    const script = [
      'set -euo pipefail',
      `source ${JSON.stringify(LIB_SCRIPT)}`,
      'run_with_timeout 5 -- sh -c "exit 7"',
    ].join('\n')
    return run(script, { path })
  }

  it('R1: delegates to gtimeout when it is present and working', () => {
    const dir = shim()
    const marker = join(dir, 'marker-gtimeout.txt')
    fakeTimeoutBinary(dir, 'gtimeout', marker)
    const result = runRunWithTimeout(dir)
    expect(result.status).toBe(7)
    expect(existsSync(marker)).toBe(true)
  })

  it('R2: falls back to timeout when gtimeout is absent but timeout works', () => {
    const dir = shim()
    const marker = join(dir, 'marker-timeout.txt')
    fakeTimeoutBinary(dir, 'timeout', marker)
    const result = runRunWithTimeout(dir)
    expect(result.status).toBe(7)
    expect(existsSync(marker)).toBe(true)
  })

  it('R3: runs the command unbounded when neither gtimeout nor timeout is available', () => {
    const dir = shim()
    // Deliberately no gtimeout/timeout fakes — the unbounded fallback path.
    const result = runRunWithTimeout(dir)
    expect(result.status).toBe(7)
    expect(existsSync(join(dir, 'marker-gtimeout.txt'))).toBe(false)
    expect(existsSync(join(dir, 'marker-timeout.txt'))).toBe(false)
  })
})
