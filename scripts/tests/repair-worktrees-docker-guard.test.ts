/**
 * SMI-4698: regression tests for repair-worktrees.sh's Docker-active guard.
 *
 * Asserts:
 *   1. With no `docker` CLI on PATH, the script proceeds (no guard fired).
 *   2. With a `docker` shim that returns nothing from `docker ps`, the
 *      script proceeds.
 *   3. With a shim that returns `skillsmith-dev-1`, the script aborts
 *      (exit 1) with the expected error naming the container, AND the
 *      native-rebuild step is NOT invoked.
 *   4. With `--force-with-active-docker` + the same shim, the script
 *      proceeds with a warning AND the rebuild step IS invoked.
 *   5. Symlink-repair phases run unconditionally — even when the guard
 *      fires, both symlink-repair functions are invoked before abort.
 *   6. Container regex matches `skillsmith-prod-dev-1` (S-1).
 *
 * SMI-4700 adds:
 *   7. With neither `gtimeout` nor a working `timeout` on PATH (macOS
 *      simulation), the guard still fires when an active container is
 *      detected — proving the capability-probe falls through to the
 *      unbounded `docker ps` path instead of silently skipping the guard
 *      on rc=127 from a missing binary.
 *
 * Tests copy `repair-worktrees.sh` and `_lib.sh` into a temp dir alongside
 * a stub `repair-host-native-deps.sh`. SCRIPT_DIR resolution makes the
 * stub the only `repair-host-native-deps.sh` in scope, so we can detect
 * whether it was invoked without running a real `npm rebuild`.
 *
 * No real Docker daemon is needed; no git-crypt encryption.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execSync, spawnSync } from 'child_process'
import { rmSync, existsSync, writeFileSync, chmodSync, mkdirSync, copyFileSync } from 'fs'
import { join } from 'path'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const REPO_SCRIPTS_DIR = join(__dirname, '..')
const SOURCE_REPAIR_SH = join(REPO_SCRIPTS_DIR, 'repair-worktrees.sh')
const SOURCE_LIB_SH = join(REPO_SCRIPTS_DIR, '_lib.sh')

const GIT_ENV = makeFixtureEnv()

function git(cwd: string, args: string): string {
  return execSync(`git -c init.defaultBranch=main -c protocol.file.allow=always ${args}`, {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
  }).trim()
}

/**
 * Set up a test workspace:
 *   tempRoot/
 *     repo/                       — real git repo with mocked node_modules/.bin/lint-staged
 *       scripts/
 *         repair-worktrees.sh     — copied from source
 *         _lib.sh                 — copied from source
 *         repair-host-native-deps.sh — stub that records invocation
 *     bin/                        — fake-shim PATH dir for `docker`
 *     docker.log                  — docker shim invocation log
 *     rebuild.log                 — repair-host-native-deps.sh stub invocation log
 */
function setupRepo(tempRoot: string): {
  repoDir: string
  binDir: string
  dockerLog: string
  rebuildLog: string
} {
  const repoDir = join(tempRoot, 'repo')
  const scriptsDir = join(repoDir, 'scripts')
  const binDir = join(tempRoot, 'bin')
  const dockerLog = join(tempRoot, 'docker.log')
  const rebuildLog = join(tempRoot, 'rebuild.log')

  mkdirSync(scriptsDir, { recursive: true })
  mkdirSync(binDir, { recursive: true })

  // Init git repo (script calls `git rev-parse --show-toplevel`)
  git(tempRoot, `init "${repoDir}"`)
  writeFileSync(join(repoDir, 'README.md'), '# test\n')
  git(repoDir, 'add README.md')
  git(repoDir, 'commit -m "initial"')

  // Mock host node_modules/.bin/lint-staged (assert_host_node_modules check)
  const binNm = join(repoDir, 'node_modules', '.bin')
  mkdirSync(binNm, { recursive: true })
  const lintStagedStub = join(binNm, 'lint-staged')
  writeFileSync(lintStagedStub, '#!/bin/sh\nexit 0\n')
  chmodSync(lintStagedStub, 0o755)

  // Copy real repair-worktrees.sh + _lib.sh
  copyFileSync(SOURCE_REPAIR_SH, join(scriptsDir, 'repair-worktrees.sh'))
  chmodSync(join(scriptsDir, 'repair-worktrees.sh'), 0o755)
  copyFileSync(SOURCE_LIB_SH, join(scriptsDir, '_lib.sh'))

  // Stub repair-host-native-deps.sh — records invocation, exits 0
  const stubRebuild = `#!/bin/sh
echo "called with $*" >> "${rebuildLog}"
exit 0
`
  writeFileSync(join(scriptsDir, 'repair-host-native-deps.sh'), stubRebuild)
  chmodSync(join(scriptsDir, 'repair-host-native-deps.sh'), 0o755)

  return { repoDir, binDir, dockerLog, rebuildLog }
}

/**
 * Write a docker shim that prints `dockerPsOutput` for `docker ps ...`
 * invocations, recording all calls to logPath. Pass empty string to
 * simulate "no containers running".
 */
function writeDockerShim(binDir: string, logPath: string, dockerPsOutput: string): void {
  // Quote the output for embedding in the shell shim
  const escaped = dockerPsOutput.replace(/'/g, `'\\''`)
  const shim = `#!/bin/sh
echo "$@" >> "${logPath}"
case "$1" in
  ps)
    printf '%s' '${escaped}'
    if [ -n '${escaped}' ]; then printf '\\n'; fi
    exit 0
    ;;
esac
exit 0
`
  const shimPath = join(binDir, 'docker')
  writeFileSync(shimPath, shim)
  chmodSync(shimPath, 0o755)
}

/**
 * Run repair-worktrees.sh inside the staged repo. PATH is restricted to
 * binDir + system dirs so a real `docker` on the host doesn't leak in.
 * If `binDir` is undefined, the test simulates "no docker CLI on PATH".
 */
function runScript(
  repoDir: string,
  args: string,
  binDir?: string
): { status: number; stdout: string; stderr: string } {
  // Minimal PATH so `docker` is not picked up from the host.
  // /usr/bin and /bin are needed for git, bash, basename, sed, etc.
  const restrictedPath = binDir ? `${binDir}:/usr/bin:/bin` : `/usr/bin:/bin`
  const env = { ...GIT_ENV, PATH: restrictedPath }
  const scriptPath = join(repoDir, 'scripts', 'repair-worktrees.sh')
  // spawnSync captures stdout + stderr regardless of exit status, unlike
  // execSync which only surfaces stderr on non-zero exit. The force-flag
  // test asserts on stderr-routed warn() output during a successful run.
  const argv = args.length > 0 ? args.split(/\s+/).filter(Boolean) : []
  const r = spawnSync('bash', [scriptPath, ...argv], {
    encoding: 'utf8',
    timeout: 30_000,
    env,
    cwd: repoDir,
  })
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  }
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
  tempDirs.length = 0
})

describe('SMI-4698: repair-worktrees.sh Docker-active guard', () => {
  it('proceeds when no `docker` CLI is on PATH (no guard fired)', () => {
    const tempRoot = makeFixtureTempDir('rw-guard-no-docker')
    tempDirs.push(tempRoot)
    const { repoDir, rebuildLog } = setupRepo(tempRoot)

    // No binDir → restricted PATH excludes any host `docker`
    const result = runScript(repoDir, '')

    expect(result.status).toBe(0)
    // Rebuild step ran (guard didn't fire because no docker CLI was found)
    expect(existsSync(rebuildLog)).toBe(true)
  })

  it('proceeds when `docker ps` returns no matching containers', () => {
    const tempRoot = makeFixtureTempDir('rw-guard-no-match')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, rebuildLog } = setupRepo(tempRoot)
    writeDockerShim(binDir, join(tempRoot, 'docker.log'), '')

    const result = runScript(repoDir, '', binDir)

    expect(result.status).toBe(0)
    expect(existsSync(rebuildLog)).toBe(true)
  })

  it('aborts when `skillsmith-dev-1` is running and skips the rebuild step', () => {
    const tempRoot = makeFixtureTempDir('rw-guard-active')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, rebuildLog } = setupRepo(tempRoot)
    writeDockerShim(binDir, join(tempRoot, 'docker.log'), 'skillsmith-dev-1')

    const result = runScript(repoDir, '', binDir)

    expect(result.status).not.toBe(0)
    const combined = result.stderr + result.stdout
    expect(combined).toMatch(/Active Docker container detected/)
    expect(combined).toMatch(/skillsmith-dev-1/)
    // Rebuild step was NOT invoked (guard fired and exited first)
    expect(existsSync(rebuildLog)).toBe(false)
  })

  it('--force-with-active-docker bypasses the guard and runs rebuild with a warning', () => {
    const tempRoot = makeFixtureTempDir('rw-guard-force')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, rebuildLog } = setupRepo(tempRoot)
    writeDockerShim(binDir, join(tempRoot, 'docker.log'), 'skillsmith-dev-1')

    const result = runScript(repoDir, '--force-with-active-docker', binDir)

    expect(result.status).toBe(0)
    expect(result.stderr + result.stdout).toMatch(/--force-with-active-docker set/)
    // Rebuild step DID run despite active container
    expect(existsSync(rebuildLog)).toBe(true)
  })

  it('symlink-repair phases run unconditionally even when the guard aborts', () => {
    // The symlink-repair functions iterate `git worktree list` and do nothing
    // if no worktrees exist beyond the main repo — but they MUST be called
    // before the guard. We verify by checking the script's own info-line
    // output, which is emitted right before each phase invocation.
    const tempRoot = makeFixtureTempDir('rw-guard-symlinks-first')
    tempDirs.push(tempRoot)
    const { repoDir, binDir } = setupRepo(tempRoot)
    writeDockerShim(binDir, join(tempRoot, 'docker.log'), 'skillsmith-dev-1')

    const result = runScript(repoDir, '', binDir)

    expect(result.status).not.toBe(0)
    const combined = result.stderr + result.stdout
    // Both symlink-repair info banners must appear BEFORE the guard's error
    expect(combined).toMatch(/Repairing worktrees missing node_modules symlink/)
    expect(combined).toMatch(/Backfilling per-package node_modules symlinks/)
    // And the guard error must appear too
    expect(combined).toMatch(/Active Docker container detected/)
  })

  it('container regex matches `skillsmith-prod-dev-1` (S-1: COMPOSE_PROJECT_NAME variant)', () => {
    const tempRoot = makeFixtureTempDir('rw-guard-prod-variant')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, rebuildLog } = setupRepo(tempRoot)
    writeDockerShim(binDir, join(tempRoot, 'docker.log'), 'skillsmith-prod-dev-1')

    const result = runScript(repoDir, '', binDir)

    expect(result.status).not.toBe(0)
    expect(result.stderr + result.stdout).toMatch(/skillsmith-prod-dev-1/)
    expect(existsSync(rebuildLog)).toBe(false)
  })

  it('SMI-4700: guard still fires on macOS-style host with no `timeout`/`gtimeout` on PATH', () => {
    // macOS does not ship GNU `timeout` by default, and Homebrew
    // coreutils (`gtimeout`) is opt-in. Simulate that environment by
    // shadowing both binaries in binDir with stubs that exit 127.
    // Crucially these stubs are PATH-shadows: they match `command -v`
    // (so the probe sees them), but `<bin> --kill-after=0 0 true`
    // returns 127 (failing the validation) — matching what would happen
    // if `command -v` had actually returned nothing. The probe must
    // fall through to the unbounded `docker ps` path; the guard must
    // still fire when an active container is detected.
    const tempRoot = makeFixtureTempDir('rw-guard-macos-no-timeout')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, rebuildLog } = setupRepo(tempRoot)
    writeDockerShim(binDir, join(tempRoot, 'docker.log'), 'skillsmith-dev-1')

    // Shadow `timeout` and `gtimeout` so the probe's validation
    // (`<bin> --kill-after=0 0 true`) returns 127. binDir is first on
    // PATH (see runScript) so these shadow any /usr/bin/timeout that
    // ships with the Linux test runner.
    const failingStub = `#!/bin/sh\nexit 127\n`
    for (const name of ['timeout', 'gtimeout']) {
      const stubPath = join(binDir, name)
      writeFileSync(stubPath, failingStub)
      chmodSync(stubPath, 0o755)
    }

    const result = runScript(repoDir, '', binDir)

    expect(result.status).not.toBe(0)
    const combined = result.stderr + result.stdout
    expect(combined).toMatch(/Active Docker container detected/)
    expect(combined).toMatch(/skillsmith-dev-1/)
    // Rebuild step must NOT have run — guard fired even without
    // `timeout` available, proving the unbounded fallback executed.
    expect(existsSync(rebuildLog)).toBe(false)
  })
})
