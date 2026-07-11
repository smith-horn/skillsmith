/**
 * Shared fixture/generator harness for worktree-override-root-mount.test.ts
 * and worktree-override-root-mount-smi5650.test.ts. Split out per CLAUDE.md's
 * 500-line guidance — this file holds the pure infrastructure; the two
 * sibling `.test.ts` files hold only `describe`/`it` suites.
 *
 * Per this repo's "never `skipIf(inDocker)`" rule, the generator branch under
 * test is driven through a fixture-local `uname` PATH shim (Darwin vs Linux)
 * rather than the host's real OS — every assertion is on generated YAML text,
 * with NO container start and NO npm install (the wave's hard safety
 * invariant). Fixtures are plain temp dirs (the generator only reads the
 * filesystem).
 */
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const LIB_SCRIPT = resolve(__dirname, '..', '_lib.sh')
export const WORKTREE_DOCKER_SCRIPT = resolve(__dirname, '..', 'worktree-docker.sh')
export const REPO_ROOT = resolve(__dirname, '..', '..')

// Resolved once via the AMBIENT environment so spawnSync gets bash's absolute
// path directly (mirrors create-worktree-ready-probe.test.ts).
export const REAL_BASH = execFileSync('bash', ['-c', 'command -v bash'], {
  encoding: 'utf8',
}).trim()

/**
 * repo_root fixture directory names for the native-module real-directory
 * gate. `withAliasScopes` (SMI-5650 Wave 1) creates real (non-symlink)
 * node_modules/@skillsmith and node_modules/@smith-horn directories.
 * `withNativeModules` (SMI-5650 Wave 2) creates real directories for all 5
 * NATIVE_MODULES_FOR_OVERLAY entries (including the @esbuild scope).
 */
export const NATIVE_MODULE_DIR_NAMES = [
  'better-sqlite3',
  'onnxruntime-node',
  'esbuild',
  'hnswlib-node',
  '@esbuild',
]

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** Drop the volatile `# Generated:` timestamp line for byte-comparison. */
export function stripGenerated(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.startsWith('# Generated:'))
    .join('\n')
}

export interface Harness {
  tempDir(prefix: string): string
  unameShimPath(value: 'Darwin' | 'Linux'): string
  run(
    script: string,
    opts: { path: string; cwd?: string; env?: Record<string, string> }
  ): { status: number; stdout: string; output: string }
  generate(opts: {
    worktreePath: string
    branch: string
    repoRoot: string
    uname: 'Darwin' | 'Linux'
  }): { status: number; stdout: string; output: string }
  makeGeneratorFixture(opts: {
    withRootNodeModules: boolean
    withAliasScopes?: boolean
    withNativeModules?: boolean
    prefix?: string
  }): string
  reset(): void
  cleanup(): void
}

/**
 * Create a self-contained test harness with its own temp-dir tracking array
 * (each test file that calls this owns its own `reset()`/`cleanup()` pair —
 * wire them to `beforeEach`/`afterEach` respectively, matching the original
 * file's convention).
 */
export function createHarness(): Harness {
  let tempDirs: string[] = []

  function tempDir(prefix: string): string {
    const dir = makeFixtureTempDir(prefix)
    tempDirs.push(dir)
    return dir
  }

  /**
   * Fixture-local `uname` shim: a temp dir carrying only a deterministic
   * `uname` that echoes Darwin or Linux, prepended to the real PATH so every
   * other binary the generator needs (tr, cksum, awk, sed, date, basename,
   * cat) stays available while `uname` is forced.
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
  ): { status: number; stdout: string; output: string } {
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

  function makeGeneratorFixture(opts: {
    withRootNodeModules: boolean
    withAliasScopes?: boolean
    withNativeModules?: boolean
    prefix?: string
  }): string {
    const repoRoot = tempDir(opts.prefix ?? 'wt-root-mount')
    mkdirSync(join(repoRoot, 'packages', 'foo', 'node_modules'), { recursive: true })
    writeFileSync(join(repoRoot, 'packages', 'foo', 'package.json'), '{}\n', 'utf8')
    if (opts.withRootNodeModules) {
      mkdirSync(join(repoRoot, 'node_modules', '.vite'), { recursive: true })
    }
    if (opts.withAliasScopes) {
      mkdirSync(join(repoRoot, 'node_modules', '@skillsmith'), { recursive: true })
      mkdirSync(join(repoRoot, 'node_modules', '@smith-horn'), { recursive: true })
    }
    if (opts.withNativeModules) {
      for (const name of NATIVE_MODULE_DIR_NAMES) {
        mkdirSync(join(repoRoot, 'node_modules', name), { recursive: true })
      }
    }
    return repoRoot
  }

  return {
    tempDir,
    unameShimPath,
    run,
    generate,
    makeGeneratorFixture,
    reset(): void {
      tempDirs = []
    },
    cleanup(): void {
      for (const d of tempDirs) {
        if (existsSync(d)) rmSync(d, { recursive: true, force: true })
      }
      tempDirs = []
    },
  }
}
