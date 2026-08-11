/**
 * Shared harness for the SMI-5983 git-crypt lock/marker test files
 * (git-crypt-filter-lock-marker.test.ts and
 * git-crypt-filter-lock-trap-composition.test.ts) -- split out once the
 * combined file exceeded the 500-line guidance. Sources the real
 * scripts/_lib.sh via `source`, exercises real functions against plain
 * `git init` temp-dir fixtures. Each importing test file registers its own
 * `afterEach(() => cleanupTrackedTempDirs())` -- vitest runs each test file
 * in its own worker/module registry by default, so this module's state is
 * never actually shared ACROSS files at runtime, only the source is.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureEnv, makeFixtureTempDir } from './git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const LIB_SCRIPT = resolve(__dirname, '..', '..', '_lib.sh')
export const DISABLE_SCRIPT = resolve(__dirname, '..', '..', '_rebase-git-crypt-disable.sh')
export const REAL_BASH = execFileSync('bash', ['-c', 'command -v bash'], {
  encoding: 'utf8',
}).trim()

const GIT_CRYPT_SHIM_DIR = mkdtempSync(join(tmpdir(), 'git-crypt-lockmarker-shim-'))
writeFileSync(join(GIT_CRYPT_SHIM_DIR, 'git-crypt'), '#!/bin/sh\nexit 0\n')
execFileSync('chmod', ['755', join(GIT_CRYPT_SHIM_DIR, 'git-crypt')])
export const GIT_ENV = {
  ...makeFixtureEnv(),
  PATH: `${GIT_CRYPT_SHIM_DIR}:${process.env.PATH ?? ''}`,
}

const trackedTempDirs: string[] = []

/** Call from an `afterEach()` in every importing test file. */
export function cleanupTrackedTempDirs(): void {
  for (const d of trackedTempDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true })
  }
  trackedTempDirs.length = 0
}

export function makeRepo(): string {
  const dir = makeFixtureTempDir('git-crypt-lock-marker')
  trackedTempDirs.push(dir)
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: GIT_ENV })
  return dir
}

export function setConfig(dir: string, key: string, value: string): void {
  execFileSync('git', ['-C', dir, 'config', '--local', key, value], { env: GIT_ENV })
}

export function getConfig(dir: string, key: string): string {
  const result = spawnSync('git', ['-C', dir, 'config', '--local', '--get', key], {
    encoding: 'utf8',
    env: GIT_ENV,
  })
  return result.status === 0 ? result.stdout.trim() : ''
}

export interface RunResult {
  status: number
  stdout: string
  stderr: string
  combined: string
}

export function sourceAndRun(call: string, extraEnv: Record<string, string> = {}): RunResult {
  // set -e (not just -u/pipefail), matching every real caller of these
  // functions (create-worktree.sh, rebase-worktree.sh, _lib.sh itself all
  // declare `set -euo pipefail`) -- without -e here, this suite would not
  // have caught the read_git_crypt_disabled_marker()/has_active_rebase_
  // state()/acquire_git_crypt_filter_lock()/release_git_crypt_filter_lock()
  // set -e hazard found and fixed this same round (a plain `x="$(cmd)"`
  // assignment's own exit status is the substituted command's, so `git
  // config --get` on an absent key, `cat` on a missing PID file, or
  // `base64 -d` on malformed input each silently killed the calling script
  // before this fix -- see those four functions' `|| echo ""`/`|| var=""`
  // guards in scripts/_lib.sh) (NEEDLE review finding, SMI-5983
  // implementation round).
  const script = ['set -euo pipefail', `source ${JSON.stringify(LIB_SCRIPT)}`, call].join('\n')
  const result = spawnSync(REAL_BASH, ['-c', script], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...GIT_ENV, ...extraEnv },
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  return { status: result.status ?? 0, stdout, stderr, combined: stdout + stderr }
}

/**
 * Sources the REAL Step 7 wrapper (_rebase-git-crypt-disable.sh, which
 * itself sources _lib.sh) and calls disable_git_crypt_filters_or_fail()
 * directly, matching production's exact call sequence -- covers the
 * end-to-end path the mechanism-only tests don't (NEEDLE review finding,
 * SMI-5983 implementation round): does a real rebase's Step 7 genuinely
 * refuse to capture "cat"/"cat" as an original value when another
 * session's disable is already live?
 */
export function sourceDisableAndRun(worktreePath: string, dryRun = false): RunResult {
  const script = [
    'set -euo pipefail',
    `WORKTREE_PATH=${JSON.stringify(worktreePath)}`,
    `DRY_RUN=${dryRun}`,
    `source ${JSON.stringify(DISABLE_SCRIPT)}`,
    'disable_git_crypt_filters_or_fail',
    'echo "RC:$?"',
  ].join('\n')
  const result = spawnSync(REAL_BASH, ['-c', script], {
    encoding: 'utf8',
    timeout: 15_000,
    env: GIT_ENV,
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  return { status: result.status ?? 0, stdout, stderr, combined: stdout + stderr }
}

/** A PID guaranteed not to be running: fork a child, capture its PID, let it exit, wait for reap. */
export function deadPid(): number {
  const result = spawnSync('bash', ['-c', 'sh -c "exit 0" & echo $!; wait'], { encoding: 'utf8' })
  return Number.parseInt(result.stdout.trim(), 10)
}
