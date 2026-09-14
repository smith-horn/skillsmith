/**
 * SMI-5724: Tests for scripts/regen-lockfile.sh's worktree-vs-main-checkout
 * routing.
 *
 * Background: the script hardcoded CONTAINER="skillsmith-dev-1" and had no
 * concept of "am I in a worktree" — from a worktree, `--lockfile-only`
 * silently ran `docker exec skillsmith-dev-1 npm install --package-lock-only`
 * against MAIN's package.json (not the worktree's edited ones), then reported
 * "Lockfile already up to date" even when the worktree's manifests genuinely
 * changed. Full-sync mode was worse: a worktree's node_modules is
 * intentionally bind-mounted :ro from main (SMI-5560/5626), and the worktree
 * checkout's own node_modules is a symlink into main's REAL node_modules
 * (SMI-4377) — so a host `npm install` run from a worktree would corrupt
 * main's real tree.
 *
 * The fix (see docs/internal/implementation/smi-5724-regen-lockfile-worktree-routing.md):
 *   - Main checkout: unchanged behavior, both modes target skillsmith-dev-1,
 *     output states "(container: skillsmith-dev-1)".
 *   - Worktree + --lockfile-only: host `npm install --package-lock-only
 *     --ignore-scripts` (never docker exec), output states "(host, worktree)".
 *   - Worktree + full-sync (default, no flags): refuses via error() with a
 *     literal multi-line message pointing at the main checkout or
 *     --lockfile-only.
 *   - Worktree detection (git-dir vs git-common-dir) hard-errors on a failed
 *     `git rev-parse` rather than silently defaulting to "main checkout" —
 *     the plan-review C1 finding: a silent fallback there would reproduce
 *     the exact silent-misroute bug this script exists to fix.
 *
 * Follows two existing, working precedents (plan-review M2) rather than a
 * new fixture approach:
 *   - scripts/tests/check-dist-fresh.test.ts's `makeFixtureEnv`/
 *     `makeFixtureTempDir` + real `git worktree add` fixture pattern — the
 *     script runs unmodified against real git state, not a stubbed
 *     `git rev-parse`.
 *   - scripts/tests/repair-worktrees-docker-guard.test.ts's `writeDockerShim`
 *     PATH-shim pattern (copy the real script + `_lib.sh` into a fixture
 *     repo, restrict PATH to a shim dir + system dirs) — extended here with
 *     an analogous `writeNpmShim` for host-side npm-call assertions, and a
 *     git shim (mirroring check-dist-fresh.test.ts's D-7 FAIL-SOFT case) for
 *     the C1 failure-injection tests.
 *
 * No real Docker daemon or npm registry access is needed; no git-crypt
 * encryption.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  chmodSync,
  copyFileSync,
  readFileSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_SCRIPTS_DIR = join(__dirname, '..')
const SOURCE_REGEN_SH = join(REPO_SCRIPTS_DIR, 'regen-lockfile.sh')
const SOURCE_LIB_SH = join(REPO_SCRIPTS_DIR, '_lib.sh')
const SOURCE_RUNNING_SCRIPT_PIDS_SH = join(REPO_SCRIPTS_DIR, 'lib', 'running-script-pids.sh')
const SOURCE_NODE_MODULES_MOUNT_GATE_SH = join(
  REPO_SCRIPTS_DIR,
  'lib',
  'node-modules-mount-gate.sh'
)

const GIT_ENV = makeFixtureEnv()

// The exact literal refusal message from the plan (§1), as printed by
// error() ("Error: " prefix, no trailing newline in the source string).
const REFUSAL_MESSAGE = `Error: Full sync cannot run from a worktree: node_modules here is intentionally
read-only and derived from the main checkout (SMI-5560/5626) — a full \`npm
install\` here would either fail (container) or corrupt main's real node_modules
via the SMI-4377 symlink (host).

If this dependency change is already on main:
  cd <main-checkout-path> && ./scripts/regen-lockfile.sh

If you only need an updated lockfile (not synced node_modules) from THIS worktree:
  ./scripts/regen-lockfile.sh --lockfile-only

Note: a worktree-local, not-yet-merged dependency change has no supported path
to a synced node_modules today — see SMI-5724 follow-up (filed) for that gap.`

/** Strip ANSI color codes emitted by _lib.sh's error()/info()/warn()/success(). */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

/**
 * Set up a fixture repo:
 *   tempRoot/
 *     repo/
 *       scripts/regen-lockfile.sh   — copied from source (chmod +x)
 *       scripts/_lib.sh             — copied from source
 *       package.json / package-lock.json — minimal, committed
 *     bin/                          — PATH-shim dir for docker/npm/git
 *     docker.log / npm.log          — shim invocation logs
 */
function setupRepo(tempRoot: string): {
  repoDir: string
  binDir: string
  dockerLog: string
  npmLog: string
  mountinfoPath: string
} {
  const repoDir = join(tempRoot, 'repo')
  const scriptsDir = join(repoDir, 'scripts')
  const binDir = join(tempRoot, 'bin')
  const dockerLog = join(tempRoot, 'docker.log')
  const npmLog = join(tempRoot, 'npm.log')
  // round-3: runScript()'s env below points NODE_MODULES_MOUNT_GATE_MOUNTINFO
  // at join(dirname(cwd), 'mountinfo') — cwd is always repoDir for every test
  // that reaches the mount gate, so this resolves to the same path.
  const mountinfoPath = join(tempRoot, 'mountinfo')

  const scriptsLibDir = join(scriptsDir, 'lib')
  mkdirSync(scriptsLibDir, { recursive: true })
  mkdirSync(binDir, { recursive: true })

  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', repoDir], {
    env: GIT_ENV,
  })

  copyFileSync(SOURCE_REGEN_SH, join(scriptsDir, 'regen-lockfile.sh'))
  chmodSync(join(scriptsDir, 'regen-lockfile.sh'), 0o755)
  copyFileSync(SOURCE_LIB_SH, join(scriptsDir, '_lib.sh'))
  copyFileSync(SOURCE_RUNNING_SCRIPT_PIDS_SH, join(scriptsLibDir, 'running-script-pids.sh'))
  // round-2b: regen-lockfile.sh's in-container gate now delegates to the
  // shared node-modules-mount-gate.sh helper (relative path, resolved
  // against the fake docker exec's cwd == repoDir via APP_ROOT=repoDir in
  // runScript()'s env below) instead of calling `mountpoint` directly.
  copyFileSync(SOURCE_NODE_MODULES_MOUNT_GATE_SH, join(scriptsLibDir, 'node-modules-mount-gate.sh'))
  chmodSync(join(scriptsLibDir, 'node-modules-mount-gate.sh'), 0o755)
  // The helper's root check needs a real directory to stat before it will
  // even search mountinfo (a missing dir counts as "not mounted") — every
  // test that doesn't care about the mount state gets a working default (a
  // real directory + a fixture mountinfo line reporting it as a genuine
  // volume-shaped root); tests that DO care overwrite the mountinfo fixture
  // (and, where relevant, add more directories) via their own setup.
  mkdirSync(join(repoDir, 'node_modules'), { recursive: true })
  writeMountinfoFixture(mountinfoPath, [
    mountedVolumeLine(100, join(repoDir, 'node_modules'), 'fixture_node_modules'),
  ])

  writeFileSync(
    join(repoDir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2) + '\n',
    'utf8'
  )
  writeFileSync(
    join(repoDir, 'package-lock.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3 }, null, 2) + '\n',
    'utf8'
  )

  execFileSync('git', ['-C', repoDir, 'add', '-A'], { env: GIT_ENV })
  execFileSync('git', ['-C', repoDir, 'commit', '--quiet', '-m', 'init'], { env: GIT_ENV })

  // round-2 code-review (Finding B): refuse_if_native_repair_running() now
  // fails CLOSED (error, refuses) when pgrep/ps can't be checked, rather
  // than warning and proceeding — so every test that doesn't care about that
  // check needs a default pgrep/ps pair that succeeds and finds nothing
  // (pgrep's own convention: no match -> exit 1), mirroring writePgrepPsStubs'
  // shape. A test that DOES care overwrites these (writePgrepPsStubs, or the
  // dedicated missing-tool tests below, which delete one or both).
  writeFileSync(join(binDir, 'pgrep'), '#!/bin/sh\nexit 1\n', 'utf8')
  chmodSync(join(binDir, 'pgrep'), 0o755)
  writeFileSync(join(binDir, 'ps'), '#!/bin/sh\nexit 1\n', 'utf8')
  chmodSync(join(binDir, 'ps'), 0o755)

  return { repoDir, binDir, dockerLog, npmLog, mountinfoPath }
}

/**
 * Write a `docker` shim that logs every invocation to `logPath` and, for
 * `docker ps ...`, prints `dockerPsOutput` (pass '' for "no containers
 * running"). Every other subcommand (exec, etc.) is logged and exits 0
 * without doing anything real — mirrors repair-worktrees-docker-guard.test.ts's
 * writeDockerShim.
 */
function writeDockerShim(binDir: string, logPath: string, dockerPsOutput: string): void {
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

/** Write an `npm` shim that logs every invocation to `logPath` and exits 0. */
function writeNpmShim(binDir: string, logPath: string): void {
  writeNpmShimWithRc(binDir, logPath, 0)
}

/** Same as writeNpmShim, but exits `rc` (for R3-1's "npm itself exits 97"
 * case) instead of always 0. */
function writeNpmShimWithRc(binDir: string, logPath: string, rc: number): void {
  const shim = `#!/bin/sh
echo "$@" >> "${logPath}"
exit ${rc}
`
  const shimPath = join(binDir, 'npm')
  writeFileSync(shimPath, shim)
  chmodSync(shimPath, 0o755)
}

/**
 * round-3: node-modules-mount-gate.sh no longer shells out to `mountpoint`
 * at all — it parses /proc/self/mountinfo directly (mountpoint follows
 * symlinks and can't tell a real mount from anything else
 * mounted wherever a symlink resolves to; see that file's own header). The
 * `mountpoint` PATH-shims this file used to write are dead code now — the
 * helper never calls that binary, so shimming it would silently test
 * nothing (the exact SMI-6598 trap: a test that used to exercise a real
 * code path, still green, but for the wrong reason). Every mount-state test
 * below instead writes a fixture mountinfo file and points the helper's own
 * NODE_MODULES_MOUNT_GATE_MOUNTINFO seam at it.
 */

/** One mountinfo line for `mountPoint` as a genuine Docker/Podman named-
 * volume mount (root ending in `.../volumes/<volumeName>/_data`) — the
 * "properly mounted" case node-modules-mount-gate.sh accepts. */
function mountedVolumeLine(id: number, mountPoint: string, volumeName: string): string {
  return `${id} 1 254:1 /docker/volumes/${volumeName}/_data ${mountPoint} rw,relatime master:1 - ext4 /dev/vda1 rw,discard`
}

/** Write `lines` (mountinfo-format strings) to `path`, one per line. */
function writeMountinfoFixture(path: string, lines: string[]): void {
  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
}

/**
 * Write a `docker` shim that, for `exec CONTAINER sh -c '<payload>' […]`
 * specifically, ACTUALLY RUNS the trailing `sh -c` command — so a stubbed
 * `npm` on the SAME PATH genuinely gets invoked, exercising the mount-gate
 * logic for real (SMI-6614 change 5b's T-E scenarios). Any OTHER `exec`
 * payload (e.g. the unrelated `node -e …` native-verify call) is logged and
 * no-op'd, exactly like the passive writeDockerShim above — only the
 * mount-gated `sh -c` form needs real execution. `ps` also behaves
 * identically to the passive shim.
 */
function writeExecutingDockerShim(binDir: string, logPath: string, dockerPsOutput: string): void {
  const escaped = dockerPsOutput.replace(/'/g, `'\\''`)
  const shim = `#!/bin/sh
echo "$@" >> "${logPath}"
case "$1" in
  ps)
    printf '%s' '${escaped}'
    if [ -n '${escaped}' ]; then printf '\\n'; fi
    exit 0
    ;;
  exec)
    shift
    if [ "\${1:-}" = "-w" ]; then
      shift 2
    fi
    shift
    if [ "\${1:-}" = "sh" ]; then
      "$@"
      exit $?
    fi
    ;;
esac
exit 0
`
  const shimPath = join(binDir, 'docker')
  writeFileSync(shimPath, shim)
  chmodSync(shimPath, 0o755)
}

/** Write a `retrieval-autoheal.sh` stub at `<binDir>/../repo/scripts/` that
 * logs its own invocation — used to assert regen-lockfile.sh's post-refresh
 * kick (change 5c/3). */
function writeAutohealStub(scriptsDir: string, logPath: string): void {
  const shim = `#!/bin/sh
echo "kicked $*" >> "${logPath}"
exit 0
`
  const shimPath = join(scriptsDir, 'retrieval-autoheal.sh')
  writeFileSync(shimPath, shim)
  chmodSync(shimPath, 0o755)
}

/**
 * Write `pgrep`/`ps` stubs on `binDir` that make running_script_pids()
 * (scripts/lib/running-script-pids.sh) see exactly ONE fake process, with
 * PID `fakePid`, whose `ps -o args=` output is `fakeArgs` — but ONLY when
 * `pgrep -f` is called with `matchName`; any other name reports nothing.
 * `pgrep` itself is not reliably present in every environment this suite
 * runs in (measured absent inside this repo's dev container image, present
 * on macOS host) — stubbing both `pgrep` and `ps` makes the test
 * deterministic regardless.
 */
function writePgrepPsStubs(
  binDir: string,
  matchName: string,
  fakePid: number,
  fakeArgs: string
): void {
  const pgrepShim = `#!/bin/sh
case "$*" in
  *${matchName}*) echo ${fakePid} ;;
esac
exit 0
`
  writeFileSync(join(binDir, 'pgrep'), pgrepShim)
  chmodSync(join(binDir, 'pgrep'), 0o755)

  const psShim = `#!/bin/sh
if [ "$4" = "${fakePid}" ]; then
  echo "${fakeArgs}"
fi
exit 0
`
  writeFileSync(join(binDir, 'ps'), psShim)
  chmodSync(join(binDir, 'ps'), 0o755)
}

/**
 * Write a `git` shim that fails ONLY `git rev-parse <failingFlag>` and
 * passes every other invocation through to the real git — mirrors
 * check-dist-fresh.test.ts's D-7 FAIL-SOFT shim. Used for the C1
 * failure-injection tests (plan-review C1): a failed `rev-parse` must
 * hard-error, never silently fall through to IS_WORKTREE=false.
 */
function writeFailingGitShim(binDir: string, failingFlag: string): void {
  const realGit = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const shim = [
    '#!/bin/sh',
    `if [ "$1" = "rev-parse" ] && [ "$2" = "${failingFlag}" ]; then exit 1; fi`,
    `exec "${realGit}" "$@"`,
    '',
  ].join('\n')
  writeFileSync(join(binDir, 'git'), shim, 'utf8')
  chmodSync(join(binDir, 'git'), 0o755)
}

/**
 * Run the fixture's copy of regen-lockfile.sh with PATH restricted to
 * `binDir:/usr/bin:/bin` so shims (or their absence) fully control what the
 * script sees — no real `docker`/`npm` on the host can leak in.
 */
function runScript(
  cwd: string,
  args: string[],
  binDir: string,
  extraPathDirs: string[] = ['/usr/bin', '/bin']
): { status: number; stdout: string; stderr: string } {
  const scriptPath = join(cwd, 'scripts', 'regen-lockfile.sh')
  const r = spawnSync('bash', [scriptPath, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    // APP_ROOT: round-2b's node-modules-mount-gate.sh test seam — points
    // the helper's root/packages/* checks at this fixture repo (standing in
    // for the container's /app) instead of its own default. Inherited by
    // the fake docker exec subprocess and everything IT spawns (normal
    // subprocess env inheritance), never forwarded via any real `docker
    // exec -e` in production code (SMI-6614 round-2 Finding A).
    //
    // NODE_MODULES_MOUNT_GATE_MOUNTINFO (round-3): same test-seam status as
    // APP_ROOT above — points the helper's mountinfo parsing at this
    // fixture repo's own mountinfo file (setupRepo()'s mountinfoPath,
    // always tempRoot/mountinfo — cwd here is always repoDir, i.e.
    // tempRoot/repo, so dirname(cwd) resolves back to tempRoot) instead of
    // the real /proc/self/mountinfo.
    //
    // extraPathDirs defaults to the real system dirs (needed for git/sed/
    // mktemp/etc).
    env: {
      ...GIT_ENV,
      PATH: [binDir, ...extraPathDirs].join(':'),
      APP_ROOT: cwd,
      NODE_MODULES_MOUNT_GATE_MOUNTINFO: join(dirname(cwd), 'mountinfo'),
    },
    cwd,
  })
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
  tempDirs.length = 0
})

/** Poll for `path` to exist and be non-empty, bounded — used for
 * regen-lockfile.sh's detached post-refresh auto-heal kick (nohup … &),
 * which returns before the background process is guaranteed to have run. */
async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf8')
      if (content.length > 0) return content
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

describe('regen-lockfile.sh worktree routing (SMI-5724)', () => {
  it('main checkout --lockfile-only routes through docker exec and states the container target', () => {
    const tempRoot = makeFixtureTempDir('regen-main-lockfile-only')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, dockerLog } = setupRepo(tempRoot)
    writeDockerShim(binDir, dockerLog, 'skillsmith-dev-1')

    const result = runScript(repoDir, ['--lockfile-only'], binDir)

    expect(result.status).toBe(0)
    const combined = stripAnsi(result.stdout + result.stderr)
    expect(combined).toContain('(container: skillsmith-dev-1)')
    expect(existsSync(dockerLog)).toBe(true)
    expect(readFileSync(dockerLog, 'utf8')).toMatch(
      /exec skillsmith-dev-1 npm install --package-lock-only --ignore-scripts/
    )
  })

  it('main checkout full-sync routes every npm/rebuild call through a mount-gated docker exec and states the container target', () => {
    const tempRoot = makeFixtureTempDir('regen-main-full-sync')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, dockerLog, npmLog } = setupRepo(tempRoot)
    // SMI-6614 change 5b: install/rebuild now run via `docker exec … sh -c
    // 'sh scripts/lib/node-modules-mount-gate.sh && exec npm …'` — an
    // EXECUTING shim (real sh -c payload, rc=0) is needed so the mount-gate
    // logic runs for real and reaches the stubbed npm, matching "today's
    // call sequence" (T-E).
    writeExecutingDockerShim(binDir, dockerLog, 'skillsmith-dev-1')
    writeNpmShim(binDir, npmLog)

    const result = runScript(repoDir, [], binDir)

    expect(result.status).toBe(0)
    const combined = stripAnsi(result.stdout + result.stderr)
    expect(combined).toContain('(container: skillsmith-dev-1)')

    const dockerCalls = readFileSync(dockerLog, 'utf8')
    // Atomicity (T-E): every mutating docker exec's payload carries the
    // shared node-modules-mount-gate.sh check AND the npm call in the SAME
    // argv — no bare `docker exec … npm install`/`npm rebuild` remains.
    // round-2b: -w /app is now required (the helper resolves as a relative
    // path against cwd).
    expect(dockerCalls).toMatch(
      /exec -w \/app skillsmith-dev-1 sh -c .*node-modules-mount-gate\.sh.*exec npm install/
    )
    expect(dockerCalls).toMatch(
      /exec -w \/app skillsmith-dev-1 sh -c .*node-modules-mount-gate\.sh.*exec npm rebuild/
    )
    expect(dockerCalls).toMatch(/exec skillsmith-dev-1 node -e/)

    // The stubbed npm was actually invoked (through the executing shim) for
    // both the container install/rebuild AND the pre-existing host
    // `npm install --ignore-scripts` full-sync step (unchanged by this fix).
    expect(existsSync(npmLog)).toBe(true)
    const npmCalls = readFileSync(npmLog, 'utf8')
    expect(npmCalls).toMatch(/^install\s*$/m)
    expect(npmCalls).toMatch(/^rebuild .*--ignore-scripts=false\s*$/m)
    expect(npmCalls).toMatch(/install --ignore-scripts/)
  })

  // ── T-E: mount gate (SMI-6614 change 5b/5c) ──────────────────────────────

  it('mount detached (rc32): script exits non-zero, stubbed npm inside the payload never ran, no host npm install', () => {
    const tempRoot = makeFixtureTempDir('regen-mount-32')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, dockerLog, npmLog, mountinfoPath } = setupRepo(tempRoot)
    writeExecutingDockerShim(binDir, dockerLog, 'skillsmith-dev-1')
    // No mountinfo entry at all for root's node_modules -> MOUNT_DETACHED
    // (overwrites setupRepo()'s own default "mounted" fixture).
    writeMountinfoFixture(mountinfoPath, [])
    writeNpmShim(binDir, npmLog)

    const result = runScript(repoDir, [], binDir)

    expect(result.status).not.toBe(0)
    const combined = stripAnsi(result.stdout + result.stderr)
    // round-4: "has a node_modules mount problem" + the actual affected
    // path(s) — renamed from round-2b/3's "detached node_modules mount" /
    // "Detached path(s):" since round-4 widened this same message to also
    // cover MOUNT_NOT_VOLUME and MOUNT_AMBIGUOUS, neither of which is
    // literally "detached".
    expect(combined).toMatch(/has a node_modules mount problem/)
    expect(combined).toMatch(/Affected path\(s\):/)
    expect(existsSync(npmLog)).toBe(false)
  })

  // round-2b: SMI-6516 detached nine of ten declared node_modules mounts
  // INDIVIDUALLY — a root-only check misses exactly this shape.
  it('mount PARTIALLY detached: root attached, one packages/*/node_modules detached -> refuses, no install', () => {
    const tempRoot = makeFixtureTempDir('regen-mount-partial')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, dockerLog, npmLog, mountinfoPath } = setupRepo(tempRoot)
    writeExecutingDockerShim(binDir, dockerLog, 'skillsmith-dev-1')
    mkdirSync(join(repoDir, 'packages', 'doc-retrieval-mcp', 'node_modules'), { recursive: true })
    // The gate only checks directories holding a package.json (npm workspaces).
    writeFileSync(join(repoDir, 'packages', 'doc-retrieval-mcp', 'package.json'), '{}\n')
    // Root keeps its own mounted-volume entry (re-asserted here since this
    // overwrites setupRepo()'s default fixture); the workspace package gets
    // NO entry at all -> MOUNT_DETACHED for it alone.
    writeMountinfoFixture(mountinfoPath, [
      mountedVolumeLine(100, join(repoDir, 'node_modules'), 'fixture_node_modules'),
    ])
    writeNpmShim(binDir, npmLog)

    const result = runScript(repoDir, [], binDir)

    expect(result.status).not.toBe(0)
    const combined = stripAnsi(result.stdout + result.stderr)
    expect(combined).toMatch(/has a node_modules mount problem/)
    expect(combined).toContain('packages/doc-retrieval-mcp/node_modules')
    expect(existsSync(npmLog)).toBe(false)
  })

  it('mount check unavailable (rc127): same refusal shape, "cannot verify" text', () => {
    const tempRoot = makeFixtureTempDir('regen-mount-127')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, dockerLog, npmLog, mountinfoPath } = setupRepo(tempRoot)
    writeExecutingDockerShim(binDir, dockerLog, 'skillsmith-dev-1')
    writeNpmShim(binDir, npmLog)
    // round-3: 127 means /proc/self/mountinfo (or its
    // NODE_MODULES_MOUNT_GATE_MOUNTINFO override) cannot be READ — simulate
    // by removing setupRepo()'s own default fixture file entirely, rather
    // than the old "mountpoint binary genuinely absent from PATH" mechanism
    // (obsolete: the helper no longer calls `mountpoint` at all).
    rmSync(mountinfoPath, { force: true })

    const result = runScript(repoDir, [], binDir)

    expect(result.status).not.toBe(0)
    const combined = stripAnsi(result.stdout + result.stderr)
    expect(combined).toMatch(/[Cc]annot verify/)
    expect(existsSync(npmLog)).toBe(false)
  })

  it("mount bound (rc0): today's call sequence — install then rebuild, both succeed", () => {
    const tempRoot = makeFixtureTempDir('regen-mount-0')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, dockerLog, npmLog } = setupRepo(tempRoot)
    writeExecutingDockerShim(binDir, dockerLog, 'skillsmith-dev-1')
    writeNpmShim(binDir, npmLog)

    const result = runScript(repoDir, [], binDir)

    expect(result.status).toBe(0)
    const npmCalls = readFileSync(npmLog, 'utf8')
    expect(npmCalls).toMatch(/^install\s*$/m)
    expect(npmCalls).toMatch(/^rebuild /m)
  })

  it('atomicity: every mutating docker exec payload carries the mount gate check in the SAME argv — no bare install/rebuild remains', () => {
    const tempRoot = makeFixtureTempDir('regen-mount-atomicity')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, dockerLog, npmLog } = setupRepo(tempRoot)
    writeExecutingDockerShim(binDir, dockerLog, 'skillsmith-dev-1')
    writeNpmShim(binDir, npmLog)

    const result = runScript(repoDir, [], binDir)
    expect(result.status).toBe(0)

    const lines = readFileSync(dockerLog, 'utf8').split('\n').filter(Boolean)
    const mutatingLines = lines.filter(
      (l) => l.startsWith('exec ') && (l.includes('npm install') || l.includes('npm rebuild'))
    )
    expect(mutatingLines.length).toBeGreaterThan(0)
    for (const line of mutatingLines) {
      // round-2b: the gate is now the shared node-modules-mount-gate.sh
      // helper (checks every node_modules path), not a root-only
      // `mountpoint -q /app/node_modules` one-liner.
      expect(line).toContain('sh scripts/lib/node-modules-mount-gate.sh')
    }
    // No bare (un-mount-gated) docker exec … npm install/rebuild remains.
    const bareLines = lines.filter(
      (l) =>
        /^exec .*skillsmith-dev-1 npm (install|rebuild)\b/.test(l) &&
        !l.includes('node-modules-mount-gate.sh')
    )
    expect(bareLines).toEqual([])
  })

  it('--lockfile-only never invokes the mount gate', () => {
    const tempRoot = makeFixtureTempDir('regen-mount-lockfile-only')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, dockerLog, npmLog } = setupRepo(tempRoot)
    writeExecutingDockerShim(binDir, dockerLog, 'skillsmith-dev-1')
    writeNpmShim(binDir, npmLog)

    const result = runScript(repoDir, ['--lockfile-only'], binDir)
    expect(result.status).toBe(0)
    // round-3 (SMI-6598 trap): a literal `.not.toContain('mountpoint')`
    // assertion here would be VACUOUS — the docker log can never contain
    // that string post-rewrite regardless of whether --lockfile-only
    // correctly skips the gate, since the gate itself is now
    // node-modules-mount-gate.sh and never prints/execs the word
    // "mountpoint" at all. The only assertion that actually proves the gate
    // was never invoked in lockfile-only mode is checking for ITS filename.
    const dockerLogContent = readFileSync(dockerLog, 'utf8')
    expect(dockerLogContent).not.toContain('node-modules-mount-gate.sh')
  })

  it('R3-1: stderr has no MOUNT_GATE line but the payload exits 97 (npm itself) → reported as an npm failure, not a mount failure', () => {
    const tempRoot = makeFixtureTempDir('regen-mount-r3-1')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, dockerLog, npmLog } = setupRepo(tempRoot)
    writeExecutingDockerShim(binDir, dockerLog, 'skillsmith-dev-1')
    // npm itself exits 97 (e.g. its own lifecycle-script exit code) with no
    // MOUNT_GATE token anywhere in its output.
    writeNpmShimWithRc(binDir, npmLog, 97)

    const result = runScript(repoDir, [], binDir)

    expect(result.status).not.toBe(0)
    const combined = stripAnsi(result.stdout + result.stderr)
    // round-4: regen-lockfile.sh's actual phrasing is "has a node_modules
    // mount problem" (MOUNT_DETACHED/MOUNT_NOT_VOLUME/MOUNT_AMBIGUOUS) or
    // "Cannot verify" (MOUNT_CHECK_UNAVAILABLE) — a stale check against an
    // EARLIER round's wording would assert against text the script no
    // longer emits, so it would prove nothing about this scenario.
    expect(combined).not.toMatch(/has a node_modules mount problem/)
    expect(combined).not.toMatch(/[Cc]annot verify/)
    expect(combined).toMatch(/npm install failed inside/)
  })

  it('pgrep stub matching retrieval-autoheal.sh refuses before any docker exec', () => {
    const tempRoot = makeFixtureTempDir('regen-refuse-running-repair')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, dockerLog, npmLog } = setupRepo(tempRoot)
    writeExecutingDockerShim(binDir, dockerLog, 'skillsmith-dev-1')
    writeNpmShim(binDir, npmLog)
    writePgrepPsStubs(binDir, 'retrieval-autoheal.sh', 424242, 'sh scripts/retrieval-autoheal.sh')

    const result = runScript(repoDir, [], binDir)
    expect(result.status).not.toBe(0)
    const combined = stripAnsi(result.stdout + result.stderr)
    expect(combined).toMatch(/already running/)
    // The container-liveness check (`docker ps`) legitimately runs before
    // the refuse check — asserting no `exec` call (an actual mutation) is
    // the meaningful claim here.
    const dockerCalls = existsSync(dockerLog) ? readFileSync(dockerLog, 'utf8') : ''
    expect(dockerCalls).not.toContain('exec')
  })

  // round-2 code-review (Finding B): "cannot tell whether a repair is
  // running" must now REFUSE, not proceed with a warning — the two tests
  // below cover each missing-tool direction inside running_script_pids
  // (pgrep vs ps), deleting the default working stubs setupRepo() writes.
  it('refuse_if_native_repair_running: pgrep unavailable -> refuses, does not proceed (round-2 Finding B)', () => {
    const tempRoot = makeFixtureTempDir('regen-refuse-missing-pgrep')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, dockerLog, npmLog } = setupRepo(tempRoot)
    writeExecutingDockerShim(binDir, dockerLog, 'skillsmith-dev-1')
    writeNpmShim(binDir, npmLog)
    // Remove ONLY the default pgrep stub — ps stays present, isolating this
    // test to the "pgrep specifically missing" cause (running_script_pids'
    // FIRST missing-tool check).
    rmSync(join(binDir, 'pgrep'))

    const result = runScript(repoDir, [], binDir)
    expect(result.status).not.toBe(0)
    const combined = stripAnsi(result.stdout + result.stderr)
    expect(combined).toMatch(/[Cc]annot verify no host native repair is currently running/)
    expect(combined).toMatch(/pgrep unavailable/i)
    const dockerCalls = existsSync(dockerLog) ? readFileSync(dockerLog, 'utf8') : ''
    expect(dockerCalls).not.toContain('exec')
  })

  it('refuse_if_native_repair_running: ps unavailable (pgrep present) -> refuses, does not proceed (round-2 Finding B)', () => {
    const tempRoot = makeFixtureTempDir('regen-refuse-missing-ps')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, dockerLog, npmLog } = setupRepo(tempRoot)
    writeExecutingDockerShim(binDir, dockerLog, 'skillsmith-dev-1')
    writeNpmShim(binDir, npmLog)
    // Remove ONLY the default ps stub — pgrep stays present, isolating this
    // test to the "ps specifically missing" cause (running_script_pids'
    // SECOND missing-tool check).
    rmSync(join(binDir, 'ps'))

    const result = runScript(repoDir, [], binDir)
    expect(result.status).not.toBe(0)
    const combined = stripAnsi(result.stdout + result.stderr)
    expect(combined).toMatch(/[Cc]annot verify no host native repair is currently running/)
    expect(combined).toMatch(/ps unavailable/i)
    const dockerCalls = existsSync(dockerLog) ? readFileSync(dockerLog, 'utf8') : ''
    expect(dockerCalls).not.toContain('exec')
  })

  it('successful full sync kicks the auto-heal once, after the sentinel write', async () => {
    const tempRoot = makeFixtureTempDir('regen-kick-autoheal')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, dockerLog, npmLog } = setupRepo(tempRoot)
    writeExecutingDockerShim(binDir, dockerLog, 'skillsmith-dev-1')
    writeNpmShim(binDir, npmLog)
    const kickLog = join(tempRoot, 'kick.log')
    writeAutohealStub(join(repoDir, 'scripts'), kickLog)

    const result = runScript(repoDir, [], binDir)
    expect(result.status).toBe(0)

    const log = await waitForFile(kickLog, 3000)
    expect(log).toContain('kicked')
    expect((log.match(/kicked/g) ?? []).length).toBe(1)
  })

  it('running_script_pids: a decoy process mentioning the script path but not sh/bash-running-it is not matched (R3-2)', () => {
    const tempRoot = makeFixtureTempDir('regen-decoy-not-matched')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, dockerLog, npmLog } = setupRepo(tempRoot)
    writeExecutingDockerShim(binDir, dockerLog, 'skillsmith-dev-1')
    writeNpmShim(binDir, npmLog)
    // pgrep -f WOULD find this (a decoy whose argv mentions the script
    // path) — but its argv[0] is `perl`, not `sh`/`bash`, so
    // running_script_pids()'s own ps-based validation must exclude it.
    writePgrepPsStubs(
      binDir,
      'retrieval-autoheal.sh',
      424243,
      'perl -e $0=vim scripts/retrieval-autoheal.sh; sleep 30'
    )

    const result = runScript(repoDir, [], binDir)
    // The decoy must NOT be mistaken for a running retrieval-autoheal.sh —
    // the sync proceeds normally.
    expect(result.status).toBe(0)
    const combined = stripAnsi(result.stdout + result.stderr)
    expect(combined).not.toMatch(/already running/)
  })

  it('running_script_pids: a real sh …/regen-lockfile.sh sleeper IS matched (R3-2, sanity)', () => {
    const tempRoot = makeFixtureTempDir('regen-real-sleeper-matched')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, dockerLog, npmLog } = setupRepo(tempRoot)
    writeExecutingDockerShim(binDir, dockerLog, 'skillsmith-dev-1')
    writeNpmShim(binDir, npmLog)
    writePgrepPsStubs(binDir, 'retrieval-autoheal.sh', 424244, 'bash scripts/retrieval-autoheal.sh')

    const result = runScript(repoDir, [], binDir)
    expect(result.status).not.toBe(0)
    const combined = stripAnsi(result.stdout + result.stderr)
    expect(combined).toMatch(/already running/)
  })

  it('running_script_pids: a script path containing spaces still matches (code review finding 5)', () => {
    const tempRoot = makeFixtureTempDir('regen-rsp-path-with-spaces')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, dockerLog, npmLog } = setupRepo(tempRoot)
    writeExecutingDockerShim(binDir, dockerLog, 'skillsmith-dev-1')
    writeNpmShim(binDir, npmLog)
    // A whitespace-split predicate would misparse this into "/Users/test",
    // "user/scripts/retrieval-autoheal.sh" and wrongly reject it.
    writePgrepPsStubs(
      binDir,
      'retrieval-autoheal.sh',
      424245,
      'bash /Users/test user/scripts/retrieval-autoheal.sh'
    )

    const result = runScript(repoDir, [], binDir)
    expect(result.status).not.toBe(0)
    const combined = stripAnsi(result.stdout + result.stderr)
    expect(combined).toMatch(/already running/)
  })

  // Title note (round-2 Finding B): this exercises running_script_pids() in
  // isolation only — its own contract (warn + return failure on a missing
  // tool) is unchanged and correct. The OLD title's "…real mountpoint path
  // runs" implied the CALLER then proceeds past that failure — true for
  // regen-lockfile.sh's refuse_if_native_repair_running() before this round,
  // false now (see the two dedicated refuse_if_native_repair_running tests
  // above): a failure here now makes both callers refuse/defer, not proceed.
  it('running_script_pids: missing ps warns (stderr) and returns failure, rc=1 (code review finding 5)', () => {
    const tempRoot = makeFixtureTempDir('regen-rsp-missing-ps')
    tempDirs.push(tempRoot)
    const isoBin = join(tempRoot, 'iso-bin')
    mkdirSync(isoBin, { recursive: true })
    // pgrep IS present (would find a candidate) but ps is NOT on PATH at
    // all — command -v ps must fail, not just return an unhelpful result.
    writeFileSync(join(isoBin, 'pgrep'), '#!/bin/sh\necho 999999\nexit 0\n')
    chmodSync(join(isoBin, 'pgrep'), 0o755)

    const wrapper = join(tempRoot, 'wrapper.sh')
    writeFileSync(
      wrapper,
      [
        '#!/bin/sh',
        `. "${SOURCE_RUNNING_SCRIPT_PIDS_SH}"`,
        'running_script_pids retrieval-autoheal.sh',
        'echo "rc=$?"',
        '',
      ].join('\n')
    )
    chmodSync(wrapper, 0o755)

    // Absolute path for the command itself (Node resolves `sh` via the
    // GIVEN env's PATH too, and that env is deliberately restricted to
    // isoBin so no real system `ps` leaks in from elsewhere).
    const r = spawnSync('/bin/sh', [wrapper], {
      encoding: 'utf8',
      env: { PATH: isoBin },
    })
    expect(r.stdout).toContain('rc=1')
    expect(r.stdout).not.toContain('999999')
    expect(r.stderr).toMatch(/ps unavailable/i)
  })

  it('worktree --lockfile-only routes to host npm (never docker exec) and states the host target', () => {
    const tempRoot = makeFixtureTempDir('regen-worktree-lockfile-only')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, dockerLog, npmLog } = setupRepo(tempRoot)
    writeDockerShim(binDir, dockerLog, 'skillsmith-dev-1')
    writeNpmShim(binDir, npmLog)

    const worktreeDir = join(tempRoot, 'repo-wt-lockfile-only')
    execFileSync('git', ['-C', repoDir, 'worktree', 'add', worktreeDir, '-b', 'wt-lockfile-only'], {
      env: GIT_ENV,
    })

    try {
      const result = runScript(worktreeDir, ['--lockfile-only'], binDir)

      expect(result.status).toBe(0)
      const combined = stripAnsi(result.stdout + result.stderr)
      expect(combined).toContain('(host, worktree)')
      expect(combined).not.toContain('(container: skillsmith-dev-1)')

      expect(existsSync(npmLog)).toBe(true)
      expect(readFileSync(npmLog, 'utf8')).toMatch(/install --package-lock-only --ignore-scripts/)

      // Docker was never touched — the whole point of this fix.
      expect(existsSync(dockerLog)).toBe(false)
    } finally {
      execFileSync('git', ['-C', repoDir, 'worktree', 'remove', '--force', worktreeDir], {
        env: GIT_ENV,
      })
    }
  })

  it('worktree full-sync refuses with the literal SMI-5724 message and touches neither docker nor node_modules', () => {
    const tempRoot = makeFixtureTempDir('regen-worktree-full-sync')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, dockerLog, npmLog } = setupRepo(tempRoot)
    writeDockerShim(binDir, dockerLog, 'skillsmith-dev-1')
    writeNpmShim(binDir, npmLog)

    const worktreeDir = join(tempRoot, 'repo-wt-full-sync')
    execFileSync('git', ['-C', repoDir, 'worktree', 'add', worktreeDir, '-b', 'wt-full-sync'], {
      env: GIT_ENV,
    })

    try {
      const result = runScript(worktreeDir, [], binDir)

      expect(result.status).not.toBe(0)
      const combined = stripAnsi(result.stdout + result.stderr)
      expect(combined).toContain(REFUSAL_MESSAGE)

      // Neither Docker nor host npm were ever invoked, and node_modules was
      // never created/touched in the worktree.
      expect(existsSync(dockerLog)).toBe(false)
      expect(existsSync(npmLog)).toBe(false)
      expect(existsSync(join(worktreeDir, 'node_modules'))).toBe(false)
    } finally {
      execFileSync('git', ['-C', repoDir, 'worktree', 'remove', '--force', worktreeDir], {
        env: GIT_ENV,
      })
    }
  })

  it('container-liveness check (docker ps) runs only for the main-checkout path, never for either worktree path', () => {
    const tempRoot = makeFixtureTempDir('regen-liveness-scope')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, dockerLog, npmLog } = setupRepo(tempRoot)
    writeDockerShim(binDir, dockerLog, 'skillsmith-dev-1')
    writeNpmShim(binDir, npmLog)

    // Main checkout: the liveness check (docker ps) runs.
    const mainResult = runScript(repoDir, ['--lockfile-only'], binDir)
    expect(mainResult.status).toBe(0)
    expect(readFileSync(dockerLog, 'utf8')).toMatch(/^ps /m)
    rmSync(dockerLog, { force: true })

    // Worktree, either mode: the liveness check never runs — dockerLog
    // (and thus the `ps` call) stays absent in both cases.
    const worktreeDir = join(tempRoot, 'repo-wt-liveness')
    execFileSync('git', ['-C', repoDir, 'worktree', 'add', worktreeDir, '-b', 'wt-liveness'], {
      env: GIT_ENV,
    })

    try {
      const wtLockfileOnly = runScript(worktreeDir, ['--lockfile-only'], binDir)
      expect(wtLockfileOnly.status).toBe(0)
      expect(existsSync(dockerLog)).toBe(false)

      const wtFullSync = runScript(worktreeDir, [], binDir)
      expect(wtFullSync.status).not.toBe(0)
      expect(existsSync(dockerLog)).toBe(false)
    } finally {
      execFileSync('git', ['-C', repoDir, 'worktree', 'remove', '--force', worktreeDir], {
        env: GIT_ENV,
      })
    }
  })

  it('C1: a git rev-parse --git-dir failure hard-errors instead of silently defaulting to main-checkout routing', () => {
    const tempRoot = makeFixtureTempDir('regen-c1-git-dir-fail')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, dockerLog, npmLog } = setupRepo(tempRoot)
    writeDockerShim(binDir, dockerLog, 'skillsmith-dev-1')
    writeNpmShim(binDir, npmLog)
    writeFailingGitShim(binDir, '--git-dir')

    const result = runScript(repoDir, [], binDir)

    expect(result.status).not.toBe(0)
    const combined = stripAnsi(result.stdout + result.stderr)
    expect(combined).toContain(
      'Error: Not inside a git checkout — cannot determine worktree vs main checkout.'
    )

    // Must never reach EITHER downstream branch: no docker calls (the
    // main-checkout liveness/exec path) and no refusal-message output (the
    // worktree path) — a silent IS_WORKTREE=false fallback would show up as
    // one of these running anyway.
    expect(existsSync(dockerLog)).toBe(false)
    expect(existsSync(npmLog)).toBe(false)
    expect(combined).not.toContain('Full sync cannot run from a worktree')
  })

  it('C1: a git rev-parse --git-common-dir failure also hard-errors', () => {
    const tempRoot = makeFixtureTempDir('regen-c1-git-common-dir-fail')
    tempDirs.push(tempRoot)
    const { repoDir, binDir, dockerLog, npmLog } = setupRepo(tempRoot)
    writeDockerShim(binDir, dockerLog, 'skillsmith-dev-1')
    writeNpmShim(binDir, npmLog)
    writeFailingGitShim(binDir, '--git-common-dir')

    const result = runScript(repoDir, [], binDir)

    expect(result.status).not.toBe(0)
    const combined = stripAnsi(result.stdout + result.stderr)
    expect(combined).toContain(
      'Error: Not inside a git checkout — cannot determine worktree vs main checkout.'
    )
    expect(existsSync(dockerLog)).toBe(false)
    expect(existsSync(npmLog)).toBe(false)
  })
})
