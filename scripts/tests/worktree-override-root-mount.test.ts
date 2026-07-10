/**
 * SMI-5626: Unit tests for the ROOT node_modules bind mount that
 * `enumerate_compose_node_modules_mounts` / `generate_docker_override_to_stdout`
 * (scripts/_lib.sh) now emit into a worktree's docker-compose.override.yml, and
 * for `worktree-docker.sh cmd_generate`'s delegation to that single generator.
 *
 * Why this exists: in a worktree compose project the base file's named volume
 * at /app/node_modules is unusable — the worktree's host-side relative symlink
 * (node_modules -> ../../node_modules) sits under the .:/app bind and mount(2)
 * follows symlinks resolving a bind destination, so root-hoisted deps (marked,
 * sanitize-html, …) are unreachable in the container. The fix mounts the MAIN
 * checkout's real root node_modules read-only, mirroring the per-package :ro
 * mounts. See the plan doc's Wave 1 Context section.
 *
 * Per this repo's "never `skipIf(inDocker)`" rule, the generator branch under
 * test is driven through a fixture-local `uname` PATH shim (Darwin vs Linux)
 * rather than the host's real OS — every assertion is on generated YAML text,
 * with NO container start and NO npm install (the wave's hard safety
 * invariant). Fixtures are plain temp dirs (the generator only reads the
 * filesystem); the delegation case builds a real `git worktree` because
 * cmd_generate derives its branch + repo_root via git.
 *
 * Cases:
 *   1  Darwin: root :ro mount emitted 3× (dev/test/orchestrator) + the two
 *      root .vite/.vite-temp overlays; pre-existing per-package line still
 *      present (regression — root mount must not displace per-package mounts).
 *   2  Darwin, no root node_modules dir: no root-mount line; per-package
 *      lines unaffected (mirrors the [[ -d ]] gating convention).
 *   3  Linux: no volumes block at all (existing Darwin gate unchanged).
 *   4  Path with spaces in repo_root: root-mount line survives verbatim.
 *   5  Dual-platform invariant (plan-review Open Q2): main's real
 *      node_modules/@esbuild must carry a linux-* build, since the root :ro
 *      bind now makes every (Linux) worktree container depend on it.
 *   D  Delegation: worktree-docker.sh `generate` writes a file byte-for-byte
 *      identical (modulo the `Generated:` line) to
 *      generate_docker_override_to_stdout — proving the divergent heredoc was
 *      deleted, not partially delegated.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import {
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const LIB_SCRIPT = resolve(__dirname, '..', '_lib.sh')
const WORKTREE_DOCKER_SCRIPT = resolve(__dirname, '..', 'worktree-docker.sh')
const REPO_ROOT = resolve(__dirname, '..', '..')

// Resolved once via the AMBIENT environment so spawnSync gets bash's absolute
// path directly (mirrors create-worktree-ready-probe.test.ts).
const REAL_BASH = execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim()

/** Track temp dirs for teardown. */
let tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = makeFixtureTempDir(prefix)
  tempDirs.push(dir)
  return dir
}

/**
 * Fixture-local `uname` shim: a temp dir carrying only a deterministic `uname`
 * that echoes Darwin or Linux, prepended to the real PATH so every other
 * binary the generator needs (tr, cksum, awk, sed, date, basename, cat) stays
 * available while `uname` is forced.
 */
function unameShimPath(value: 'Darwin' | 'Linux'): string {
  const dir = tempDir('wt-root-mount-uname')
  writeFileSync(join(dir, 'uname'), `#!/bin/sh\necho '${value}'\n`, 'utf8')
  chmodSync(join(dir, 'uname'), 0o755)
  return `${dir}:${process.env.PATH ?? ''}`
}

/** Run a bash snippet, capturing status + combined stdout/stderr. */
function run(
  script: string,
  opts: { path: string; cwd?: string; env?: Record<string, string> }
): {
  status: number
  stdout: string
  output: string
} {
  const result = spawnSync(REAL_BASH, ['-c', script], {
    cwd: opts.cwd,
    encoding: 'utf8',
    env: { ...process.env, ...opts.env, PATH: opts.path },
    timeout: 20_000,
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    output: (result.stdout ?? '') + (result.stderr ?? ''),
  }
}

/** Invoke generate_docker_override_to_stdout via a sourced _lib.sh. */
function generate(opts: {
  worktreePath: string
  branch: string
  repoRoot: string
  uname: 'Darwin' | 'Linux'
}): { status: number; stdout: string; output: string } {
  const script = [
    'set -euo pipefail',
    `source ${JSON.stringify(LIB_SCRIPT)}`,
    `generate_docker_override_to_stdout ${JSON.stringify(opts.worktreePath)} ${JSON.stringify(
      opts.branch
    )} ${JSON.stringify(opts.repoRoot)}`,
  ].join('\n')
  return run(script, { path: unameShimPath(opts.uname) })
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** Drop the volatile `# Generated:` timestamp line for byte-comparison. */
function stripGenerated(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.startsWith('# Generated:'))
    .join('\n')
}

/** repo_root fixture: node_modules(+.vite) and one package with node_modules. */
function makeGeneratorFixture(opts: { withRootNodeModules: boolean; prefix?: string }): string {
  const repoRoot = tempDir(opts.prefix ?? 'wt-root-mount')
  mkdirSync(join(repoRoot, 'packages', 'foo', 'node_modules'), { recursive: true })
  writeFileSync(join(repoRoot, 'packages', 'foo', 'package.json'), '{}\n', 'utf8')
  if (opts.withRootNodeModules) {
    mkdirSync(join(repoRoot, 'node_modules', '.vite'), { recursive: true })
  }
  return repoRoot
}

beforeEach(() => {
  tempDirs = []
})

afterEach(() => {
  for (const d of tempDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true })
  }
  tempDirs = []
})

describe('SMI-5626: root node_modules bind mount in the worktree override', () => {
  it('Case 1 (Darwin): emits the root :ro mount 3× + both root overlays, per-package line intact', () => {
    const repoRoot = makeGeneratorFixture({ withRootNodeModules: true })
    const worktreePath = join(repoRoot, '.worktrees', 'wt1')
    const { status, stdout } = generate({
      worktreePath,
      branch: 'fix/smi-5626',
      repoRoot,
      uname: 'Darwin',
    })
    expect(status).toBe(0)

    const rootMount = `      - ${repoRoot}/node_modules:/app/node_modules:ro`
    // Once per service (dev/test/orchestrator).
    expect(count(stdout, rootMount)).toBe(3)

    // Writable root cache overlays (NOT :ro), one per service.
    const viteOverlay = `      - ${repoRoot}/node_modules/.vite:/app/node_modules/.vite`
    const viteTempOverlay = `      - ${repoRoot}/node_modules/.vite-temp:/app/node_modules/.vite-temp`
    expect(count(stdout, viteOverlay)).toBe(3)
    expect(count(stdout, viteTempOverlay)).toBe(3)
    expect(stdout).not.toContain(`${viteOverlay}:ro`)

    // Regression: the pre-existing per-package :ro mount must still be present.
    const perPkg = `      - ${repoRoot}/packages/foo/node_modules:/app/packages/foo/node_modules:ro`
    expect(count(stdout, perPkg)).toBe(3)

    // v4 marker label bumped.
    expect(stdout).toContain('# SMI-4689/SMI-5560/SMI-5626 bind mounts v4')
  })

  it('Case 2 (Darwin, no root node_modules): no root-mount line; per-package lines unaffected', () => {
    const repoRoot = makeGeneratorFixture({ withRootNodeModules: false })
    const worktreePath = join(repoRoot, '.worktrees', 'wt1')
    const { status, stdout } = generate({
      worktreePath,
      branch: 'fix/smi-5626',
      repoRoot,
      uname: 'Darwin',
    })
    expect(status).toBe(0)

    // No root mount (gated on the [[ -d node_modules ]] check).
    expect(stdout).not.toContain(':/app/node_modules:ro')
    expect(stdout).not.toContain('/app/node_modules/.vite')

    // Per-package mounts still emitted.
    const perPkg = `      - ${repoRoot}/packages/foo/node_modules:/app/packages/foo/node_modules:ro`
    expect(count(stdout, perPkg)).toBe(3)
  })

  it('Case 3 (Linux): no volumes block at all (Darwin gate unchanged)', () => {
    const repoRoot = makeGeneratorFixture({ withRootNodeModules: true })
    const worktreePath = join(repoRoot, '.worktrees', 'wt1')
    const { status, stdout } = generate({
      worktreePath,
      branch: 'fix/smi-5626',
      repoRoot,
      uname: 'Linux',
    })
    expect(status).toBe(0)
    expect(stdout).not.toContain('volumes:')
    expect(stdout).not.toContain('/app/node_modules')
    expect(stdout).not.toContain(':ro')
    // Sanity: it is still a valid override (container names present).
    expect(stdout).toContain('container_name: smi-5626-dev-1')
  })

  it('Case 4 (Darwin, spaces in repo_root): root-mount line survives verbatim', () => {
    const repoRoot = makeGeneratorFixture({
      withRootNodeModules: true,
      prefix: 'wt root mount has space',
    })
    const worktreePath = join(repoRoot, '.worktrees', 'wt1')
    const { status, stdout } = generate({
      worktreePath,
      branch: 'fix/smi-5626',
      repoRoot,
      uname: 'Darwin',
    })
    expect(status).toBe(0)
    expect(stdout).toContain(`      - ${repoRoot}/node_modules:/app/node_modules:ro`)
  })

  it('Case 5: main node_modules/@esbuild carries a linux-* build (dual-platform invariant, plan-review Open Q2)', () => {
    const esbuildDir = join(REPO_ROOT, 'node_modules', '@esbuild')
    expect(
      existsSync(esbuildDir),
      `${esbuildDir} does not exist — deps are not installed. The SMI-5626 root :ro bind ` +
        `requires main's node_modules/@esbuild to carry a linux-* build for worktree containers.`
    ).toBe(true)

    const entries = readdirSync(esbuildDir)
    const linux = entries.filter((e) => e.startsWith('linux-'))
    const darwin = entries.filter((e) => e.startsWith('darwin-'))
    expect(
      linux.length,
      `node_modules/@esbuild has only darwin variant(s) [${darwin.join(', ')}] and no linux-* build. ` +
        `The SMI-5626 root :ro bind mounts main's node_modules into every worktree's LINUX container, ` +
        `so a linux-* @esbuild build must persist in main's host tree. Present: [${entries.join(', ')}].`
    ).toBeGreaterThan(0)
  })
})

describe('SMI-5626: worktree-docker.sh cmd_generate delegation', () => {
  it('Case D (Darwin): generate writes a file identical to generate_docker_override_to_stdout (modulo Generated:)', () => {
    const repoRoot = tempDir('wt-root-mount-deleg')
    const env = makeFixtureEnv()

    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', repoRoot], { env })
    // Filesystem state the volumes block reads (main checkout, host tree).
    mkdirSync(join(repoRoot, 'node_modules', '.vite'), { recursive: true })
    mkdirSync(join(repoRoot, 'packages', 'foo', 'node_modules'), { recursive: true })
    writeFileSync(join(repoRoot, 'packages', 'foo', 'package.json'), '{}\n', 'utf8')
    // cmd_generate guards on a docker-compose.yml in the worktree.
    writeFileSync(join(repoRoot, 'docker-compose.yml'), 'services: {}\n', 'utf8')
    execFileSync('git', ['-C', repoRoot, 'add', '-A'], { env })
    execFileSync('git', ['-C', repoRoot, 'commit', '--quiet', '-m', 'init'], { env })

    const worktreePath = join(repoRoot, '.worktrees', 'wt1')
    const branch = 'fix/smi-5626-deleg'
    execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '-q', '-b', branch, worktreePath], {
      env,
    })

    const shimPath = unameShimPath('Darwin')

    // Actual: run the real cmd_generate end-to-end (sources _lib.sh internally).
    const gen = spawnSync(REAL_BASH, [WORKTREE_DOCKER_SCRIPT, 'generate', worktreePath], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...env, PATH: shimPath },
      timeout: 20_000,
    })
    expect(gen.status, gen.stdout + (gen.stderr ?? '')).toBe(0)
    const actualFile = join(worktreePath, 'docker-compose.override.yml')
    expect(existsSync(actualFile)).toBe(true)
    const actual = readFileSync(actualFile, 'utf8')

    // Expected: the single generator, with the same derived args.
    const expected = generate({ worktreePath, branch, repoRoot, uname: 'Darwin' }).stdout

    expect(stripGenerated(actual)).toBe(stripGenerated(expected))
    // And the delegated output really does carry the volumes block (not the
    // old volumes-less heredoc).
    expect(actual).toContain('# SMI-4689/SMI-5560/SMI-5626 bind mounts v4')
    expect(actual).toContain(`${repoRoot}/node_modules:/app/node_modules:ro`)
  })
})
