/**
 * Tests for the skillsmith-doc-retrieval MCP launcher (SMI-5718).
 *
 * Sibling to scripts/tests/mcp-skillsmith-launcher.test.ts (SMI-5451) — same
 * fixture-harness pattern, adapted for scripts/mcp-doc-retrieval-launcher.sh:
 *   - `packages/doc-retrieval-mcp` instead of `packages/mcp-server`
 *   - dist entry `dist/src/server.js` instead of `dist/src/index.js`
 *   - a NEW container-liveness check (Check 0) — doc-retrieval-mcp runs
 *     inside the container (native module better-sqlite3), so the final
 *     invocation is `docker exec`, not a direct host `exec node`. This
 *     means the launcher's dependency probe (real node, host-side) and its
 *     final invocation (docker) are stubbed separately: `node` runs for
 *     real so the probe actually executes; `docker` is stubbed to control
 *     container-liveness output and to capture the final exec invocation.
 *
 * Environment note (mirrors the sibling suite's SMI-5570/SMI-5074 comment):
 * this worktree's dev container has a documented root-`node_modules`
 * resolution leak — `import.meta.resolve()` for a real hoisted dependency
 * succeeds from ANY cwd, including an isolated tmpdir fixture, because of a
 * Docker mount-destination quirk (see
 * docs/internal/implementation/smi-5570-5074-worktree-native-module-resolution-plan.md).
 * Verified directly against this container before writing these fixtures.
 * Tests that assert a dependency is MISSING/CORRUPT use fixture-only names
 * for exactly this reason. The launcher's new `zod-to-json-schema`
 * root-hoisted check is therefore only exercised on its PASS path here
 * (see the note on that test) — the same limitation the sibling suite
 * already accepts for its own generic "absent" case.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LAUNCHER_SRC = resolve(__dirname, '..', 'mcp-doc-retrieval-launcher.sh')

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

/**
 * Run the launcher copied into `root`, returning exit code + captured
 * output. `extraPath` (a stub-`docker` bin dir) is prepended to PATH when
 * given; the launcher's real dependency probe always uses the real `node`
 * on PATH (never stubbed — the probe must actually execute).
 */
function runLauncher(root: string, extraPath?: string): RunResult {
  const launcher = join(root, 'scripts', 'mcp-doc-retrieval-launcher.sh')
  const env = { ...process.env }
  if (extraPath) {
    env.PATH = `${extraPath}:${env.PATH ?? ''}`
  }
  const r = spawnSync('bash', [launcher], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function makeRoot(): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const root = mkdtempSync(join(tmpdir(), `mcp-doc-retrieval-launcher-${suffix}-`))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  copyFileSync(LAUNCHER_SRC, join(root, 'scripts', 'mcp-doc-retrieval-launcher.sh'))
  chmodSync(join(root, 'scripts', 'mcp-doc-retrieval-launcher.sh'), 0o755)
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
    JSON.stringify({ name: '@skillsmith/doc-retrieval-mcp', version: '0.0.0', dependencies }),
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
    mkdirSync(dir, { recursive: true }) // the SMI-5452 state: dir exists, no contents
    return
  }
  writeMinimalPackage(dir, name)
}

/**
 * Create a temp bin dir with a `docker` stub:
 *  - `docker ps ...` prints a fake container ID if `running` is true,
 *    otherwise prints nothing (both exit 0 — matches real `docker ps -q`
 *    behavior, which never errors just because the filter matched zero rows)
 *  - `docker exec ...` logs its argv and touches a marker (final-invocation stand-in)
 *  - every invocation's argv is appended to invocations.log for assertions
 */
function makeDockerStub(opts: { running: boolean }): {
  binDir: string
  execMarker: string
  invocationsLog: string
} {
  const binDir = mkdtempSync(join(tmpdir(), `dockerstub-${Date.now()}-`))
  const execMarker = join(binDir, 'exec-invoked')
  const invocationsLog = join(binDir, 'invocations.log')
  const stub = join(binDir, 'docker')
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
echo "$*" >> "${invocationsLog}"
if [ "$1" = "ps" ]; then
  ${opts.running ? 'echo "fakecontainerid0123"' : ''}
  exit 0
fi
if [ "$1" = "exec" ]; then
  touch "${execMarker}"
  exit 0
fi
exit 1
`,
    'utf8'
  )
  chmodSync(stub, 0o755)
  return { binDir, execMarker, invocationsLog }
}

/**
 * A fully healthy fixture: sentinel, dist, package.json + resolvable dep +
 * a resolvable root-hoisted `zod-to-json-schema` (the launcher's explicit
 * extra check — see DEP_PROBE_JS's standalone call — is not one of
 * doc-retrieval-mcp's own declared `dependencies`, so it is never covered
 * by `addDocRetrievalPackageJson`/`addHoistedDep` for an arbitrary dep name;
 * every "healthy" fixture must provision it explicitly or the probe
 * legitimately reports it FAIL missing, exactly as it should for a real
 * environment that doesn't have it hoisted).
 */
function makeHealthyRoot(): string {
  const root = makeRoot()
  addNodeModules(root)
  addDist(root)
  addDocRetrievalPackageJson(root, { glob: '11.1.0' })
  addHoistedDep(root, 'glob')
  addHoistedDep(root, 'zod-to-json-schema')
  return root
}

describe('mcp-doc-retrieval-launcher.sh', () => {
  const roots: string[] = []
  const stubs: string[] = []

  beforeEach(() => {
    roots.length = 0
    stubs.length = 0
  })

  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true })
    for (const s of stubs) rmSync(s, { recursive: true, force: true })
  })

  it('exits 1 with actionable stderr when the container is not running', () => {
    const root = makeHealthyRoot()
    roots.push(root)
    const { binDir } = makeDockerStub({ running: false })
    stubs.push(binDir)
    const res = runLauncher(root, binDir)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('[doc-retrieval]')
    expect(res.stderr).toContain('container is not running')
    expect(res.stderr).toContain('docker compose --profile dev up -d')
  })

  it('checks container liveness before node_modules (container wins when both missing/absent)', () => {
    const root = makeRoot() // no node_modules, no dist, no package.json
    roots.push(root)
    const { binDir } = makeDockerStub({ running: false })
    stubs.push(binDir)
    const res = runLauncher(root, binDir)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('container is not running')
    expect(res.stderr).not.toContain('node_modules missing')
  })

  it('exits 1 with actionable stderr when node_modules is absent (container running)', () => {
    const root = makeRoot()
    roots.push(root)
    const { binDir } = makeDockerStub({ running: true })
    stubs.push(binDir)
    const res = runLauncher(root, binDir)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('[doc-retrieval]')
    expect(res.stderr).toContain('node_modules missing')
    expect(res.stderr).toContain('npm install')
  })

  it('exits 1 with actionable stderr when dist/ is absent (container running)', () => {
    const root = makeRoot()
    roots.push(root)
    addNodeModules(root)
    const { binDir } = makeDockerStub({ running: true })
    stubs.push(binDir)
    const res = runLauncher(root, binDir)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('[doc-retrieval]')
    expect(res.stderr).toContain('dist/ missing')
  })

  it('execs docker exec on the dist entry when everything is healthy', () => {
    const root = makeHealthyRoot()
    roots.push(root)
    const { binDir, execMarker, invocationsLog } = makeDockerStub({ running: true })
    stubs.push(binDir)
    const res = runLauncher(root, binDir)
    expect(res.status).toBe(0)
    expect(res.stderr).not.toContain('cannot start')
    expect(existsSync(execMarker)).toBe(true)
    const invocations = readFileSync(invocationsLog, 'utf8').trim().split('\n')
    const finalInvocation = invocations[invocations.length - 1]
    expect(finalInvocation).toContain('exec')
    expect(finalInvocation).toContain('skillsmith-dev-1')
    expect(finalInvocation).toContain('/app/packages/doc-retrieval-mcp/dist/src/server.js')
    // The new zod-to-json-schema root-hoisted check ran as part of this
    // healthy pass (real `node` on PATH actually executed the probe,
    // real zod-to-json-schema resolves in this dev container) without
    // producing a false failure — see the module docblock for why a
    // dedicated negative case for this specific hardcoded name is not
    // fixture-isolable in this environment.
  })

  // ---- dependency-integrity probe (SMI-5718, mirrors SMI-5451) ----

  it('exits 1 when a nested dep dir exists but is empty (the SMI-5452 incident state, e.g. zod)', () => {
    const root = makeRoot()
    roots.push(root)
    addNodeModules(root)
    addDist(root)
    addDocRetrievalPackageJson(root, { zod: '3.25.76' })
    addNestedDep(root, 'zod', { empty: true })
    const { binDir } = makeDockerStub({ running: true })
    stubs.push(binDir)
    const res = runLauncher(root, binDir)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('[doc-retrieval]')
    expect(res.stderr).toContain('zod')
    expect(res.stderr).toContain('packages/doc-retrieval-mcp/node_modules/')
    expect(res.stderr).toContain('npm install')
    expect(res.stderr).toContain('(See CLAUDE.md')
  })

  it('empty nested dir still fails when a healthy hoisted copy exists (shadowing precedence)', () => {
    const root = makeRoot()
    roots.push(root)
    addNodeModules(root)
    addDist(root)
    addDocRetrievalPackageJson(root, { zod: '3.25.76' })
    addHoistedDep(root, 'zod')
    addNestedDep(root, 'zod', { empty: true })
    const { binDir } = makeDockerStub({ running: true })
    stubs.push(binDir)
    const res = runLauncher(root, binDir)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain(
      'zod dependency corrupt at packages/doc-retrieval-mcp/node_modules/zod'
    )
  })

  it('passes when the dep is present hoisted only', () => {
    const root = makeRoot()
    roots.push(root)
    addNodeModules(root)
    addDist(root)
    addDocRetrievalPackageJson(root, { zod: '3.25.76' })
    addHoistedDep(root, 'zod')
    addHoistedDep(root, 'zod-to-json-schema') // see makeHealthyRoot's docblock
    const { binDir, execMarker } = makeDockerStub({ running: true })
    stubs.push(binDir)
    const res = runLauncher(root, binDir)
    expect(res.status).toBe(0)
    expect(existsSync(execMarker)).toBe(true)
  })

  it('passes when the dep is present nested with a real package.json', () => {
    const root = makeRoot()
    roots.push(root)
    addNodeModules(root)
    addDist(root)
    addDocRetrievalPackageJson(root, { zod: '3.25.76' })
    addNestedDep(root, 'zod')
    addHoistedDep(root, 'zod-to-json-schema') // see makeHealthyRoot's docblock
    const { binDir, execMarker } = makeDockerStub({ running: true })
    stubs.push(binDir)
    const res = runLauncher(root, binDir)
    expect(res.status).toBe(0)
    expect(existsSync(execMarker)).toBe(true)
  })

  it('exits 1 when a dep is absent everywhere', () => {
    const root = makeRoot()
    roots.push(root)
    addNodeModules(root)
    addDist(root)
    // SMI-5570/SMI-5074 (see module docblock): use a fixture-only name so a
    // leaked real hoisted dependency can't accidentally resolve and mask
    // the failure this test asserts.
    addDocRetrievalPackageJson(root, { '__smi-5718-fixture-absent-dep__': '1.0.0' })
    const { binDir } = makeDockerStub({ running: true })
    stubs.push(binDir)
    const res = runLauncher(root, binDir)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('__smi-5718-fixture-absent-dep__ dependency missing')
    expect(res.stderr).toContain('npm install')
  })

  it('fails open with a warning when the probe itself cannot run (probe-infra error)', () => {
    const root = makeRoot()
    roots.push(root)
    addNodeModules(root)
    addDist(root)
    const pkgDir = join(root, 'packages', 'doc-retrieval-mcp')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), '{ this is not JSON', 'utf8')
    const { binDir, execMarker } = makeDockerStub({ running: true })
    stubs.push(binDir)
    const res = runLauncher(root, binDir)
    expect(res.status).toBe(0)
    expect(res.stderr).toContain('preflight warning')
    expect(res.stderr).not.toContain('cannot start')
    expect(existsSync(execMarker)).toBe(true)
  })

  it('never suggests rm -rf for @skillsmith/* workspace deps', () => {
    const root = makeRoot()
    roots.push(root)
    addNodeModules(root)
    addDist(root)
    // Fixture-only @skillsmith/* name — see SMI-5570/SMI-5074 note above;
    // classification only branches on the "@skillsmith/" prefix, so a real
    // package name risks the same leak-driven false pass.
    addDocRetrievalPackageJson(root, { '@skillsmith/__smi-5718-fixture-pkg__': '^0.8.0' })
    const { binDir } = makeDockerStub({ running: true })
    stubs.push(binDir)
    const res = runLauncher(root, binDir)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('@skillsmith/__smi-5718-fixture-pkg__')
    expect(res.stderr).not.toContain('rm -rf')
    expect(res.stderr).toContain('npm run build')
  })
})
