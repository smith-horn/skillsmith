/**
 * Tests for the skillsmith MCP launcher (SMI-5049 / SMI-5451 / GitHub #1260).
 *
 * The launcher (`scripts/mcp-skillsmith-launcher.sh`) is the host-side
 * pre-flight wrapper invoked by `.mcp.json`. It guards the three states that
 * otherwise produce an opaque Node `Cannot find module` crash — which the
 * MCP host surfaces only as "Failed to reconnect":
 *   - `node_modules/` not installed
 *   - `packages/mcp-server/dist/src/index.js` not built
 *   - a runtime dependency unresolvable from the dist entry (empty/corrupt
 *     nested dir shadowing the hoisted copy — the SMI-5451 incident —,
 *     missing package, or unbuilt @skillsmith/* workspace dep)
 * On any miss it must print an actionable `[skillsmith]` message to stderr
 * and exit 1; with everything healthy it must exec node on the dist entry.
 *
 * Fixtures replicate the repo layout (`<root>/scripts/<launcher>`,
 * `<root>/node_modules/.package-lock.json`,
 * `<root>/packages/mcp-server/{package.json,dist/src/index.js,node_modules}`)
 * under a temp directory — never the real repo. The exec-node case stubs
 * `node` on PATH; the stub logs every invocation's argv and DELEGATES
 * `-e` / `-p` / `--input-type=module` calls to the real node (so the
 * dependency probe actually runs) while stand-in-ing the final server exec.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LAUNCHER_SRC = resolve(__dirname, '..', 'mcp-skillsmith-launcher.sh')

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

/** Run the launcher copied into `root`, returning exit code + captured output. */
function runLauncher(root: string, extraPath?: string): RunResult {
  const launcher = join(root, 'scripts', 'mcp-skillsmith-launcher.sh')
  const env = { ...process.env }
  if (extraPath) {
    env.PATH = `${extraPath}:${env.PATH ?? ''}`
  }
  try {
    const stdout = execFileSync('bash', [launcher], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

function makeRoot(): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const root = mkdtempSync(join(tmpdir(), `mcp-launcher-${suffix}-`))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  copyFileSync(LAUNCHER_SRC, join(root, 'scripts', 'mcp-skillsmith-launcher.sh'))
  chmodSync(join(root, 'scripts', 'mcp-skillsmith-launcher.sh'), 0o755)
  return root
}

function addNodeModules(root: string): void {
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}', 'utf8')
}

function addDist(root: string): void {
  const distDir = join(root, 'packages', 'mcp-server', 'dist', 'src')
  mkdirSync(distDir, { recursive: true })
  writeFileSync(join(distDir, 'index.js'), '// stub entry\n', 'utf8')
}

/** Declare the mcp-server package with runtime deps the probe must verify. */
function addMcpServerPackageJson(root: string, dependencies: Record<string, string>): void {
  const pkgDir = join(root, 'packages', 'mcp-server')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@skillsmith/mcp-server', version: '0.0.0', dependencies }),
    'utf8'
  )
}

/** Write a minimal resolvable package at `dir` (package.json main + index.js). */
function writeMinimalPackage(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0', main: 'index.js' }),
    'utf8'
  )
  writeFileSync(join(dir, 'index.js'), 'module.exports = {}\n', 'utf8')
}

/** Install `name` hoisted at `<root>/node_modules/<name>`. */
function addHoistedDep(root: string, name: string): void {
  writeMinimalPackage(join(root, 'node_modules', name), name)
}

/** Install `name` nested at `<root>/packages/mcp-server/node_modules/<name>`. */
function addNestedDep(root: string, name: string, opts: { empty?: boolean } = {}): void {
  const dir = join(root, 'packages', 'mcp-server', 'node_modules', name)
  if (opts.empty) {
    mkdirSync(dir, { recursive: true }) // the SMI-5451 state: dir exists, no contents
    return
  }
  writeMinimalPackage(dir, name)
}

/**
 * Create a temp bin dir with a `node` stub (SMI-5451 C1 redesign):
 * - appends each invocation's argv (one space-joined line) to invocations.log
 * - delegates `-e` / `-p` / `--input-type=module` calls to the REAL node,
 *   so the launcher's dependency probe executes for real
 * - otherwise (the server exec) touches a marker and exits 0
 */
function makeNodeStub(): { binDir: string; marker: string; invocationsLog: string } {
  const binDir = mkdtempSync(join(tmpdir(), `nodestub-${Date.now()}-`))
  const marker = join(binDir, 'invoked')
  const invocationsLog = join(binDir, 'invocations.log')
  const stub = join(binDir, 'node')
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
echo "$*" >> "${invocationsLog}"
for arg in "$@"; do
  case "$arg" in
    -e|-p|--input-type=module) exec "${process.execPath}" "$@" ;;
  esac
done
touch "${marker}"
exit 0
`,
    'utf8'
  )
  chmodSync(stub, 0o755)
  return { binDir, marker, invocationsLog }
}

/** A fully healthy fixture: sentinel, dist, package.json + resolvable dep. */
function makeHealthyRoot(): string {
  const root = makeRoot()
  addNodeModules(root)
  addDist(root)
  addMcpServerPackageJson(root, { ulid: '3.0.1' })
  addHoistedDep(root, 'ulid')
  return root
}

describe('mcp-skillsmith-launcher.sh', () => {
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

  it('exits 1 with actionable stderr when node_modules is absent', () => {
    const root = makeRoot()
    roots.push(root)
    const res = runLauncher(root)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('[skillsmith]')
    expect(res.stderr).toContain('node_modules missing')
    expect(res.stderr).toContain('npm run build')
  })

  it('exits 1 with actionable stderr when dist/ is absent', () => {
    const root = makeRoot()
    roots.push(root)
    addNodeModules(root)
    const res = runLauncher(root)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('[skillsmith]')
    expect(res.stderr).toContain('dist/ missing')
    expect(res.stderr).toContain('docker compose --profile dev up -d')
  })

  it('checks node_modules before dist/ (node_modules wins when both absent)', () => {
    const root = makeRoot()
    roots.push(root)
    const res = runLauncher(root)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('node_modules missing')
    expect(res.stderr).not.toContain('dist/ missing')
  })

  it('execs node on the dist entry when install, dist, and deps are all healthy', () => {
    const root = makeHealthyRoot()
    roots.push(root)
    const { binDir, marker, invocationsLog } = makeNodeStub()
    stubs.push(binDir)
    const res = runLauncher(root, binDir)
    expect(res.status).toBe(0)
    expect(res.stderr).not.toContain('cannot start')
    // The node stub touches a marker file when invoked for the server exec.
    expect(() => execFileSync('test', ['-f', marker])).not.toThrow()
    // C1: the FINAL node invocation must target the dist entry — this fails
    // if `exec node "$DIST_ENTRY"` is ever removed from the launcher.
    const invocations = readFileSync(invocationsLog, 'utf8').trim().split('\n')
    expect(invocations[invocations.length - 1]).toContain(join('dist', 'src', 'index.js'))
  })

  // ---- SMI-5451: dependency-integrity probe ----

  it('exits 1 when a nested dep dir exists but is empty (the SMI-5451 incident)', () => {
    const root = makeRoot()
    roots.push(root)
    addNodeModules(root)
    addDist(root)
    addMcpServerPackageJson(root, { ulid: '3.0.1' })
    addNestedDep(root, 'ulid', { empty: true })
    const res = runLauncher(root)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('[skillsmith]')
    expect(res.stderr).toContain('ulid')
    expect(res.stderr).toContain('packages/mcp-server/node_modules/')
    expect(res.stderr).toContain('npm install')
    expect(res.stderr).toContain('(See CLAUDE.md')
  })

  it('empty nested dir still fails when a healthy hoisted copy exists (shadowing precedence)', () => {
    const root = makeRoot()
    roots.push(root)
    addNodeModules(root)
    addDist(root)
    addMcpServerPackageJson(root, { ulid: '3.0.1' })
    addHoistedDep(root, 'ulid') // healthy hoisted copy…
    addNestedDep(root, 'ulid', { empty: true }) // …shadowed by the empty nested dir
    const res = runLauncher(root)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('ulid dependency corrupt at packages/mcp-server/node_modules/ulid')
  })

  it('passes when the dep is present hoisted only', () => {
    const root = makeRoot()
    roots.push(root)
    addNodeModules(root)
    addDist(root)
    addMcpServerPackageJson(root, { ulid: '3.0.1' })
    addHoistedDep(root, 'ulid')
    const { binDir, marker } = makeNodeStub()
    stubs.push(binDir)
    const res = runLauncher(root, binDir)
    expect(res.status).toBe(0)
    expect(() => execFileSync('test', ['-f', marker])).not.toThrow()
  })

  it('passes when the dep is present nested with a real package.json', () => {
    const root = makeRoot()
    roots.push(root)
    addNodeModules(root)
    addDist(root)
    addMcpServerPackageJson(root, { ulid: '3.0.1' })
    addNestedDep(root, 'ulid')
    const { binDir, marker } = makeNodeStub()
    stubs.push(binDir)
    const res = runLauncher(root, binDir)
    expect(res.status).toBe(0)
    expect(() => execFileSync('test', ['-f', marker])).not.toThrow()
  })

  it('exits 1 when a dep is absent everywhere', () => {
    const root = makeRoot()
    roots.push(root)
    addNodeModules(root)
    addDist(root)
    addMcpServerPackageJson(root, { ulid: '3.0.1' })
    const res = runLauncher(root)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('ulid dependency missing')
    expect(res.stderr).toContain('npm install')
  })

  it('never suggests rm -rf for @skillsmith/* workspace deps (C2)', () => {
    const root = makeRoot()
    roots.push(root)
    addNodeModules(root)
    addDist(root)
    addMcpServerPackageJson(root, { '@skillsmith/core': '^0.8.0' })
    const res = runLauncher(root)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('@skillsmith/core')
    expect(res.stderr).toContain('npm run build')
    // Workspace symlinks point at real source — rm -rf must never be emitted.
    expect(res.stderr).not.toContain('rm -rf')
  })
})
