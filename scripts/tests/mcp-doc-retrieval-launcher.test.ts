/**
 * Tests for the skillsmith-doc-retrieval MCP launcher (SMI-5718, SMI-6453).
 *
 * The harness models the two filesystems the launcher intentionally sees:
 *
 * - The HOST tree is `makeRoot()`'s temporary repository. It contains the
 *   copied launcher and represents the bind-mounted repository. Host-side
 *   checks, including container liveness and Check 2's dist entry, see it.
 * - The CONTAINER tree is a separate temporary directory representing /app
 *   inside the running container. Its node_modules directories are independent
 *   named-volume contents. Checks 1 and 3 must inspect this tree exclusively.
 *
 * The generated `docker` stub remaps container `/app` arguments, workdirs, and
 * environment values to the CONTAINER tree. Unlike the old swallow-everything
 * stub, it genuinely re-executes non-server `docker exec` commands with the
 * test runner's real `sh` and `node`. Only the final server invocation is
 * replaced by a marker touch.
 *
 * Environment note (mirrors the sibling suite's SMI-5570/SMI-5074 comment):
 * this worktree's dev container has a documented root-node_modules resolution
 * leak. `import.meta.resolve()` for a real hoisted dependency can succeed from
 * an isolated temporary fixture because of a Docker mount-destination quirk
 * (see docs/internal/implementation/
 * smi-5570-5074-worktree-native-module-resolution-plan.md). Every negative
 * dependency case therefore uses a clearly fixture-only package name so an
 * unrelated real package cannot mask the intended failure.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LAUNCHER_SRC = resolve(__dirname, '..', 'mcp-doc-retrieval-launcher.sh')

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

function runLauncher(root: string, extraPath?: string): RunResult {
  const launcher = join(root, 'scripts', 'mcp-doc-retrieval-launcher.sh')
  const env = { ...process.env }

  if (extraPath) {
    env.PATH = `${extraPath}:${env.PATH ?? ''}`
  }

  const result = spawnSync('bash', [launcher], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function makeRoot(): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const root = mkdtempSync(join(tmpdir(), `mcp-doc-retrieval-launcher-${suffix}-`))

  mkdirSync(join(root, 'scripts'), { recursive: true })
  copyFileSync(LAUNCHER_SRC, join(root, 'scripts', 'mcp-doc-retrieval-launcher.sh'))
  chmodSync(join(root, 'scripts', 'mcp-doc-retrieval-launcher.sh'), 0o755)

  return root
}

/**
 * Every container tree has the probe workdir. Without it, the docker stub's
 * natural `cd` failure would turn an intended dependency assertion into a
 * generic fail-open infrastructure warning.
 */
function makeContainerRoot(): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const root = mkdtempSync(join(tmpdir(), `mcp-doc-retrieval-container-${suffix}-`))

  mkdirSync(join(root, 'packages', 'doc-retrieval-mcp', 'dist', 'src'), {
    recursive: true,
  })

  return root
}

function addNodeModules(root: string): void {
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}', 'utf8')
}

function addDist(root: string): void {
  const distDir = join(root, 'packages', 'doc-retrieval-mcp', 'dist', 'src')
  mkdirSync(distDir, { recursive: true })
  writeFileSync(join(distDir, 'server.js'), '// stub entry\n', 'utf8')
}

function addDocRetrievalPackageJson(root: string, dependencies: Record<string, string>): void {
  const pkgDir = join(root, 'packages', 'doc-retrieval-mcp')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: '@skillsmith/doc-retrieval-mcp',
      version: '0.0.0',
      dependencies,
    }),
    'utf8'
  )
}

function writeMinimalPackage(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0', main: 'index.js' }),
    'utf8'
  )
  writeFileSync(join(dir, 'index.js'), 'module.exports = {}\n', 'utf8')
}

function addHoistedDep(root: string, name: string): void {
  writeMinimalPackage(join(root, 'node_modules', name), name)
}

function addNestedDep(root: string, name: string, opts: { empty?: boolean } = {}): void {
  const dir = join(root, 'packages', 'doc-retrieval-mcp', 'node_modules', name)

  if (opts.empty) {
    mkdirSync(dir, { recursive: true })
    return
  }

  writeMinimalPackage(dir, name)
}

/**
 * A healthy host now needs only the bind-mounted dist entry. Checks 1 and 3
 * run inside the container and must not be encouraged to depend on host-side
 * package or node_modules fixtures.
 */
function makeHealthyHost(): string {
  const root = makeRoot()
  addDist(root)
  return root
}

/**
 * A healthy container has the root sentinel, package metadata, a resolvable
 * declared dependency, and zod-to-json-schema. The latter is checked
 * explicitly by the launcher but is not declared by doc-retrieval-mcp.
 */
function makeHealthyContainer(): string {
  const root = makeContainerRoot()
  addNodeModules(root)
  addDocRetrievalPackageJson(root, { '__smi-6453-fixture-healthy-dep__': '1.0.0' })
  addHoistedDep(root, '__smi-6453-fixture-healthy-dep__')
  addHoistedDep(root, 'zod-to-json-schema')
  return root
}

interface DockerStubOptions {
  running: boolean
  containerRoot: string
  execFailureStatus?: number
}

function makeDockerStub(opts: DockerStubOptions): {
  binDir: string
  execMarker: string
  invocationsLog: string
} {
  const binDir = mkdtempSync(join(tmpdir(), `dockerstub-${Date.now()}-`))
  const execMarker = join(binDir, 'exec-invoked')
  const invocationsLog = join(binDir, 'invocations.log')
  const stub = join(binDir, 'docker')
  const failureStatus = opts.execFailureStatus ?? 0

  writeFileSync(
    stub,
    `#!/usr/bin/env bash

{
  printf '%s ' "$@"
  printf '\\n'
} | tr '\\n' ' ' >> "${invocationsLog}"
printf '\\n' >> "${invocationsLog}"

if [ "$1" = "ps" ]; then
  ${opts.running ? 'echo "fakecontainerid0123"' : ''}
  exit 0
fi

if [ "$1" = "exec" ]; then
  shift
  workdir=""
  declare -a exec_env=()

  while [ "$#" -gt 0 ] && [[ "$1" == -* ]]; do
    case "$1" in
      -i|-t|-d)
        shift
        ;;
      -w|--workdir)
        if [ "$#" -lt 2 ]; then
          echo "docker stub: $1 requires a value" >&2
          exit 125
        fi
        workdir="$2"
        shift 2
        ;;
      -e|--env)
        if [ "$#" -lt 2 ]; then
          echo "docker stub: $1 requires a value" >&2
          exit 125
        fi
        exec_env+=("$2")
        shift 2
        ;;
      *)
        echo "docker stub: unsupported docker exec option: $1" >&2
        exit 125
        ;;
    esac
  done

  if [ "$#" -eq 0 ]; then
    echo "docker stub: missing container name" >&2
    exit 125
  fi

  shift

  remap_app_path() {
    case "$1" in
      /app)
        printf '%s\\n' "${opts.containerRoot}"
        ;;
      /app/*)
        printf '%s/%s\\n' "${opts.containerRoot}" "\${1#/app/}"
        ;;
      *)
        printf '%s\\n' "$1"
        ;;
    esac
  }

  if [ -n "$workdir" ]; then
    workdir="$(remap_app_path "$workdir")"
  fi

  declare -a remapped_env=()
  for assignment in "\${exec_env[@]}"; do
    key="\${assignment%%=*}"
    value="\${assignment#*=}"
    remapped_env+=("$key=$(remap_app_path "$value")")
  done

  declare -a command_args=()
  for argument in "$@"; do
    command_args+=("$(remap_app_path "$argument")")
  done

  if [ "\${#command_args[@]}" -ge 2 ] &&
     [ "\${command_args[0]}" = "node" ] &&
     [[ "\${command_args[1]}" == */dist/src/server.js ]]; then
    touch "${execMarker}"
    exit 0
  fi

  if [ "${failureStatus}" -ne 0 ]; then
    exit "${failureStatus}"
  fi

  if [ "\${#command_args[@]}" -eq 0 ]; then
    echo "docker stub: missing exec command" >&2
    exit 125
  fi

  if [ -n "$workdir" ]; then
    cd "$workdir" || exit 127
  fi

  for assignment in "\${remapped_env[@]}"; do
    export "$assignment"
  done

  exec "\${command_args[@]}"
fi

exit 1
`,
    'utf8'
  )

  chmodSync(stub, 0o755)
  return { binDir, execMarker, invocationsLog }
}

function warningCount(stderr: string): number {
  return stderr.match(/preflight warning/g)?.length ?? 0
}

describe('mcp-doc-retrieval-launcher.sh', () => {
  const roots: string[] = []
  const stubs: string[] = []

  beforeEach(() => {
    roots.length = 0
    stubs.length = 0
  })

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true })
    }
    for (const stub of stubs) {
      rmSync(stub, { recursive: true, force: true })
    }
  })

  it('exits 1 with actionable stderr when the container is not running', () => {
    const host = makeHealthyHost()
    const container = makeHealthyContainer()
    roots.push(host, container)

    const { binDir } = makeDockerStub({ running: false, containerRoot: container })
    stubs.push(binDir)

    const result = runLauncher(host, binDir)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('[doc-retrieval]')
    expect(result.stderr).toContain('container is not running')
    expect(result.stderr).toContain('docker compose --profile dev up -d')
    // SMI-6507/SMI-6496 plan §4: `host` here is a plain tmpdir, not a git
    // checkout, so MAIN_CHECKOUT falls back to REPO_ROOT itself (fail-soft) —
    // the printed command must still be explicitly `cd`-qualified, never a
    // bare `docker compose ...` with no directory context at all.
    expect(result.stderr).toContain(`cd "${host}"`)
    // The old ambiguous "in the repo root" framing must be gone — a worktree
    // is also, in git's own terms, "a repo root" (the exact ambiguity this
    // fix exists to remove).
    expect(result.stderr).not.toContain('in the repo root')
  })

  it('main-checkout qualifier resolves to the actual main checkout, not the worktree, when run from a linked worktree', () => {
    // Real git-worktree fixture (not `makeRoot()`'s bare tmpdir) — the one
    // scenario this fix targets: a human sitting in a WORKTREE terminal
    // reads a remediation command that must `cd` into MAIN, never their own
    // worktree, or they risk the exact SMI-4298 port collision.
    // Realpath-canonical (makeFixtureTempDir, not plain mkdtempSync(tmpdir()))
    // is load-bearing here, not cosmetic: this test compares `mainRepo` as a
    // JS string against a path the LAUNCHER SCRIPT resolves itself via
    // `cd ... && pwd`, which canonicalizes macOS's /var -> /private/var
    // symlink. A non-canonical `mainRepo` would make that string comparison
    // fail even though the launcher resolved the right directory.
    const mainRepo = makeFixtureTempDir('mcp-doc-retrieval-main')
    const worktree = makeFixtureTempDir('mcp-doc-retrieval-wt')
    rmSync(worktree, { recursive: true, force: true }) // git worktree add must create this path itself

    const runGit = (args: string[], cwd: string) => {
      const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: makeFixtureEnv() })
      if (res.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
      }
    }

    mkdirSync(join(mainRepo, 'scripts'), { recursive: true })
    copyFileSync(LAUNCHER_SRC, join(mainRepo, 'scripts', 'mcp-doc-retrieval-launcher.sh'))
    chmodSync(join(mainRepo, 'scripts', 'mcp-doc-retrieval-launcher.sh'), 0o755)
    addDist(mainRepo)

    runGit(['-c', 'init.defaultBranch=main', 'init', '--quiet', '.'], mainRepo)
    runGit(['config', 'user.email', 'test@test.com'], mainRepo)
    runGit(['config', 'user.name', 'test'], mainRepo)
    runGit(['add', '-A'], mainRepo)
    runGit(['commit', '--quiet', '-m', 'init'], mainRepo)
    runGit(['worktree', 'add', '--quiet', '-b', 'feature', worktree], mainRepo)

    roots.push(mainRepo, worktree)

    const container = makeHealthyContainer()
    roots.push(container)
    const { binDir } = makeDockerStub({ running: false, containerRoot: container })
    stubs.push(binDir)

    const result = runLauncher(worktree, binDir)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`cd "${mainRepo}"`)
    expect(result.stderr).not.toContain(`cd "${worktree}"`)

    runGit(['worktree', 'remove', '--force', worktree], mainRepo)
  })

  it('checks container liveness before node_modules and dist', () => {
    const host = makeRoot()
    const container = makeContainerRoot()
    roots.push(host, container)

    const { binDir } = makeDockerStub({ running: false, containerRoot: container })
    stubs.push(binDir)

    const result = runLauncher(host, binDir)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('container is not running')
    expect(result.stderr).not.toContain('node_modules missing')
    expect(result.stderr).not.toContain('dist/ missing')
  })

  it('exits 1 when container node_modules is absent', () => {
    const host = makeHealthyHost()
    const container = makeContainerRoot()
    roots.push(host, container)

    const { binDir } = makeDockerStub({ running: true, containerRoot: container })
    stubs.push(binDir)

    const result = runLauncher(host, binDir)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('[doc-retrieval]')
    expect(result.stderr).toContain('node_modules missing')
    expect(result.stderr).toContain('npm install')
  })

  it('reads Check 1 sentinel from the container when host node_modules is absent', () => {
    const host = makeHealthyHost()
    const container = makeHealthyContainer()
    roots.push(host, container)

    const { binDir, execMarker } = makeDockerStub({
      running: true,
      containerRoot: container,
    })
    stubs.push(binDir)

    const result = runLauncher(host, binDir)

    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain('node_modules missing')
    expect(existsSync(join(host, 'node_modules'))).toBe(false)
    expect(existsSync(execMarker)).toBe(true)
  })

  it('exits 1 with actionable stderr when host dist is absent', () => {
    const host = makeRoot()
    const container = makeHealthyContainer()
    roots.push(host, container)

    const { binDir } = makeDockerStub({ running: true, containerRoot: container })
    stubs.push(binDir)

    const result = runLauncher(host, binDir)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('[doc-retrieval]')
    expect(result.stderr).toContain('dist/ missing')
  })

  it('uses the new container-side preflights and final server invocation when healthy', () => {
    const host = makeHealthyHost()
    const container = makeHealthyContainer()
    roots.push(host, container)

    const { binDir, execMarker, invocationsLog } = makeDockerStub({
      running: true,
      containerRoot: container,
    })
    stubs.push(binDir)

    const result = runLauncher(host, binDir)

    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain('cannot start')
    expect(existsSync(execMarker)).toBe(true)

    const invocations = readFileSync(invocationsLog, 'utf8').trim().split('\n')

    const sentinelInvocation = invocations.find((line) => line.includes('SMI6453_PRESENT'))
    expect(sentinelInvocation).toBeDefined()
    expect(sentinelInvocation).toContain('exec skillsmith-dev-1 sh -c')
    expect(sentinelInvocation).toContain('SMI6453_PRESENT')
    expect(sentinelInvocation).toContain('SMI6453_ABSENT')
    expect(sentinelInvocation).toContain('/app/node_modules/.package-lock.json')

    const probeInvocation = invocations.find((line) =>
      line.includes('SKILLSMITH_LAUNCHER_REPO_ROOT=/app')
    )
    expect(probeInvocation).toBeDefined()
    expect(probeInvocation).toContain('exec -w /app/packages/doc-retrieval-mcp/dist/src')
    expect(probeInvocation).toContain('-e SKILLSMITH_LAUNCHER_REPO_ROOT=/app')
    expect(probeInvocation).toContain('skillsmith-dev-1 node --input-type=module -e')
    expect(probeInvocation).not.toContain('exec -i')

    const finalInvocation = invocations.at(-1)
    expect(finalInvocation).toContain('exec -i skillsmith-dev-1 node')
    expect(finalInvocation).toContain('/app/packages/doc-retrieval-mcp/dist/src/server.js')
  })

  it('ignores host-only stale native-module corruption when container is healthy', () => {
    const staleDep = '__smi-6453-stale-linux-x64-native__'
    const host = makeHealthyHost()
    const container = makeHealthyContainer()
    roots.push(host, container)

    // This recreates the 2026-09-07 failure shape exclusively on the host.
    // The original host-side probe sees it; the corrected probe must not.
    addNodeModules(host)
    addDocRetrievalPackageJson(host, { [staleDep]: '1.0.0' })
    addNestedDep(host, staleDep, { empty: true })
    addHoistedDep(host, 'zod-to-json-schema')

    const { binDir, execMarker } = makeDockerStub({
      running: true,
      containerRoot: container,
    })
    stubs.push(binDir)

    const result = runLauncher(host, binDir)

    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain('nested-corrupt')
    expect(result.stderr).not.toContain(staleDep)
    expect(existsSync(execMarker)).toBe(true)
  })

  it('detects container-only nested corruption without host node_modules', () => {
    const corruptDep = '__smi-6453-fixture-container-corrupt__'
    const host = makeHealthyHost()
    const container = makeContainerRoot()
    roots.push(host, container)

    addNodeModules(container)
    addDocRetrievalPackageJson(container, { [corruptDep]: '1.0.0' })
    addNestedDep(container, corruptDep, { empty: true })
    addHoistedDep(container, 'zod-to-json-schema')

    const { binDir } = makeDockerStub({ running: true, containerRoot: container })
    stubs.push(binDir)

    const result = runLauncher(host, binDir)

    expect(result.status).toBe(1)
    expect(existsSync(join(host, 'node_modules'))).toBe(false)
    expect(result.stderr).toContain(
      `${corruptDep} dependency corrupt at packages/doc-retrieval-mcp/node_modules/${corruptDep} (container-side, not host)`
    )
    expect(result.stderr).toContain(
      `docker exec skillsmith-dev-1 rm -rf /app/packages/doc-retrieval-mcp/node_modules/${corruptDep}`
    )
  })

  it('empty container nested dir fails despite a healthy container-hoisted copy', () => {
    const corruptDep = '__smi-6453-fixture-shadowed-dep__'
    const host = makeHealthyHost()
    const container = makeContainerRoot()
    roots.push(host, container)

    addNodeModules(container)
    addDocRetrievalPackageJson(container, { [corruptDep]: '1.0.0' })
    addHoistedDep(container, corruptDep)
    addNestedDep(container, corruptDep, { empty: true })
    addHoistedDep(container, 'zod-to-json-schema')

    const { binDir } = makeDockerStub({ running: true, containerRoot: container })
    stubs.push(binDir)

    const result = runLauncher(host, binDir)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      `${corruptDep} dependency corrupt at packages/doc-retrieval-mcp/node_modules/${corruptDep} (container-side, not host)`
    )
  })

  it('passes when a declared container dependency is hoisted only', () => {
    const dep = '__smi-6453-fixture-hoisted-dep__'
    const host = makeHealthyHost()
    const container = makeContainerRoot()
    roots.push(host, container)

    addNodeModules(container)
    addDocRetrievalPackageJson(container, { [dep]: '1.0.0' })
    addHoistedDep(container, dep)
    addHoistedDep(container, 'zod-to-json-schema')

    const { binDir, execMarker } = makeDockerStub({
      running: true,
      containerRoot: container,
    })
    stubs.push(binDir)

    const result = runLauncher(host, binDir)

    expect(result.status).toBe(0)
    expect(existsSync(execMarker)).toBe(true)
  })

  it('passes when a declared container dependency is nested and valid', () => {
    const dep = '__smi-6453-fixture-nested-dep__'
    const host = makeHealthyHost()
    const container = makeContainerRoot()
    roots.push(host, container)

    addNodeModules(container)
    addDocRetrievalPackageJson(container, { [dep]: '1.0.0' })
    addNestedDep(container, dep)
    addHoistedDep(container, 'zod-to-json-schema')

    const { binDir, execMarker } = makeDockerStub({
      running: true,
      containerRoot: container,
    })
    stubs.push(binDir)

    const result = runLauncher(host, binDir)

    expect(result.status).toBe(0)
    expect(existsSync(execMarker)).toBe(true)
  })

  it('exits 1 when a container dependency is absent everywhere', () => {
    const missingDep = '__smi-6453-fixture-absent-dep__'
    const host = makeHealthyHost()
    const container = makeContainerRoot()
    roots.push(host, container)

    addNodeModules(container)
    addDocRetrievalPackageJson(container, { [missingDep]: '1.0.0' })
    addHoistedDep(container, 'zod-to-json-schema')

    const { binDir } = makeDockerStub({ running: true, containerRoot: container })
    stubs.push(binDir)

    const result = runLauncher(host, binDir)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`${missingDep} dependency missing`)
    expect(result.stderr).toContain('npm install')
  })

  it('fails open when the container-side probe package.json is invalid', () => {
    const host = makeHealthyHost()
    const container = makeContainerRoot()
    roots.push(host, container)

    addNodeModules(container)
    const pkgDir = join(container, 'packages', 'doc-retrieval-mcp')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), '{ this is not JSON', 'utf8')

    const { binDir, execMarker } = makeDockerStub({
      running: true,
      containerRoot: container,
    })
    stubs.push(binDir)

    const result = runLauncher(host, binDir)

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('preflight warning')
    expect(result.stderr).not.toContain('cannot start')
    expect(existsSync(execMarker)).toBe(true)
  })

  it('never suggests rm -rf for unresolved @skillsmith/* workspace deps', () => {
    const workspaceDep = '@skillsmith/__smi-6453-fixture-workspace__'
    const host = makeHealthyHost()
    const container = makeContainerRoot()
    roots.push(host, container)

    addNodeModules(container)
    addDocRetrievalPackageJson(container, { [workspaceDep]: '^0.8.0' })
    addHoistedDep(container, 'zod-to-json-schema')

    const { binDir } = makeDockerStub({ running: true, containerRoot: container })
    stubs.push(binDir)

    const result = runLauncher(host, binDir)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(workspaceDep)
    expect(result.stderr).not.toContain('rm -rf')
    expect(result.stderr).toContain('npm run build')
  })

  it('fails open twice when both preflight docker exec calls exit 127', () => {
    const host = makeHealthyHost()
    const container = makeHealthyContainer()
    roots.push(host, container)

    const { binDir, execMarker } = makeDockerStub({
      running: true,
      containerRoot: container,
      execFailureStatus: 127,
    })
    stubs.push(binDir)

    const result = runLauncher(host, binDir)

    expect(result.status).toBe(0)
    expect(warningCount(result.stderr)).toBe(2)
    expect(result.stderr).not.toContain('cannot start')
    expect(existsSync(execMarker)).toBe(true)
  })

  it('does not mistake docker exec status 1 for a genuinely absent sentinel', () => {
    const host = makeHealthyHost()
    const container = makeHealthyContainer()
    roots.push(host, container)

    const { binDir, execMarker } = makeDockerStub({
      running: true,
      containerRoot: container,
      execFailureStatus: 1,
    })
    stubs.push(binDir)

    const result = runLauncher(host, binDir)

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('preflight warning')
    expect(result.stderr).not.toContain('node_modules missing')
    expect(existsSync(execMarker)).toBe(true)
  })
})
