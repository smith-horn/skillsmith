/**
 * Tests for the skillsmith MCP launcher (SMI-5049 / GitHub #1260).
 *
 * The launcher (`scripts/mcp-skillsmith-launcher.sh`) is the host-side
 * pre-flight wrapper invoked by `.mcp.json`. It guards the two states that
 * otherwise produce an opaque Node `Cannot find module` crash — which the
 * MCP host surfaces only as "Failed to reconnect":
 *   - `node_modules/` not installed
 *   - `packages/mcp-server/dist/src/index.js` not built
 * On either miss it must print an actionable `[skillsmith]` message to stderr
 * and exit 1; with both present it must exec node.
 *
 * Fixtures replicate the repo layout (`<root>/scripts/<launcher>`,
 * `<root>/node_modules/.package-lock.json`,
 * `<root>/packages/mcp-server/dist/src/index.js`) under a temp directory —
 * never the real repo. The exec-node case stubs `node` on PATH so the test
 * never starts a real server.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs'
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

/** Create a temp bin dir with a `node` stub that exits 0 and marks invocation. */
function makeNodeStub(): { binDir: string; marker: string } {
  const binDir = mkdtempSync(join(tmpdir(), `nodestub-${Date.now()}-`))
  const marker = join(binDir, 'invoked')
  const stub = join(binDir, 'node')
  writeFileSync(stub, `#!/usr/bin/env bash\ntouch "${marker}"\nexit 0\n`, 'utf8')
  chmodSync(stub, 0o755)
  return { binDir, marker }
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

  it('execs node when node_modules and dist/ are both present', () => {
    const root = makeRoot()
    roots.push(root)
    addNodeModules(root)
    addDist(root)
    const { binDir, marker } = makeNodeStub()
    stubs.push(binDir)
    const res = runLauncher(root, binDir)
    expect(res.status).toBe(0)
    expect(res.stderr).not.toContain('cannot start')
    // The node stub touches a marker file when invoked.
    expect(() => execFileSync('test', ['-f', marker])).not.toThrow()
  })
})
