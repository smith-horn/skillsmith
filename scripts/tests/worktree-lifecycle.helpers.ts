/**
 * Shared harness for the worktree lifecycle lock tests (SMI-6981).
 *
 * Fixture repos live under the test temp dir (`/tmp`, overlayfs in the dev
 * container), never under `/app`: that is a bind mount (`fuseblk`) the lock's
 * filesystem allow-list rejects by design.
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

import { makeFixtureEnv } from './_lib/git-fixture-env.js'
import type { FixtureRepo } from './prune-orphaned-docker-volumes.helpers.js'

export const GIT_ENV = makeFixtureEnv()

/** Bash text that loads the fixture's copy of the real libraries. */
export function libPrelude(repoDir: string): string {
  return [
    'set -uo pipefail',
    `source "${repoDir}/scripts/_lib.sh"`,
    `source "${repoDir}/scripts/lib/worktree-lifecycle.sh"`,
  ].join('\n')
}

export interface BashResult {
  status: number
  stdout: string
  stderr: string
}

/** Run a bash snippet with the lifecycle library loaded. */
export function runLib(
  repoDir: string,
  body: string,
  env: Record<string, string> = {},
  binDir?: string
): BashResult {
  const r = spawnSync('bash', ['-c', `${libPrelude(repoDir)}\n${body}`], {
    encoding: 'utf8',
    timeout: 60_000,
    cwd: repoDir,
    env: { ...GIT_ENV, ...(binDir ? { PATH: `${binDir}:${GIT_ENV.PATH ?? ''}` } : {}), ...env },
  })
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** Try to take the lock for `waitS` seconds from a fresh process; returns its code. */
export function tryAcquire(
  repoDir: string,
  waitS: number,
  env: Record<string, string> = {}
): number {
  return runLib(repoDir, `worktree_lifecycle_lock_acquire "${repoDir}" ${waitS} t\nexit $?`, env)
    .status
}

export interface Holder {
  child: ChildProcess
  release: () => void
}

function sleepMs(ms: number): void {
  spawnSync('sleep', [String(ms / 1000)])
}

/**
 * A separate OS process that holds the lock. It `exec`s sleep after acquiring so
 * the lock-bearing descriptor lives in exactly one process, which `kill -9` ends
 * (a backgrounded child of the holder would inherit fd 7 and keep the lock).
 */
export function startHolder(repoDir: string, readyFile: string): Holder {
  const script = [
    libPrelude(repoDir),
    `worktree_lifecycle_lock_acquire "${repoDir}" 5 holder || exit 9`,
    `touch "${readyFile}"`,
    'exec sleep 120',
  ].join('\n')
  const child = spawn('bash', ['-c', script], { env: GIT_ENV, stdio: 'ignore' })
  for (let i = 0; i < 200 && !existsSync(readyFile); i++) sleepMs(50)
  if (!existsSync(readyFile)) {
    child.kill('SIGKILL')
    throw new Error('lock holder never became ready')
  }
  return {
    child,
    release: () => {
      child.kill('SIGKILL')
      // wait for the kernel to reap it
      for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) {
        sleepMs(20)
      }
    },
  }
}

/** Write a docker-shim hook (runs once at the keyed call). */
export function setDockerHook(f: FixtureRepo, key: string, body: string): void {
  writeFileSync(join(f.responsesDir, `hook__${key}`), `${body}\n`)
}

export function hookRan(f: FixtureRepo, key: string): boolean {
  return existsSync(join(f.responsesDir, `hook__${key}.ran`))
}

export function marker(f: FixtureRepo, name: string): string | null {
  const p = join(f.tempRoot, `marker__${name}`)
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null
}

export function markerPath(f: FixtureRepo, name: string): string {
  return join(f.tempRoot, `marker__${name}`)
}

/** Bash that records `worktree_lifecycle_lock_acquire`'s code into a marker. */
export function recordAcquire(f: FixtureRepo, name: string, waitS = 0): string {
  return [
    libPrelude(f.repoDir),
    `worktree_lifecycle_lock_acquire "${f.repoDir}" ${waitS} hook`,
    `echo $? > "${markerPath(f, name)}"`,
  ].join('\n')
}

/**
 * Install a `git` shim in the fixture's bin dir that logs every
 * `worktree list` (as `GIT worktree-list`) into the docker log, can FAIL a set
 * of those calls, and can run a hook script before the Nth call. Everything
 * else delegates to the real git.
 */
export function installGitShim(
  f: FixtureRepo,
  opts: { failSet?: number[]; hooks?: Record<number, string> } = {}
): void {
  const hooksDir = join(f.tempRoot, 'githooks')
  mkdirSync(hooksDir, { recursive: true })
  for (const [n, body] of Object.entries(opts.hooks ?? {})) {
    writeFileSync(join(hooksDir, `${n}.sh`), `${body}\n`)
  }
  const shim = [
    '#!/usr/bin/env bash',
    `FAIL_SET=",${(opts.failSet ?? []).join(',')},"`,
    `COUNT_FILE="${join(f.tempRoot, 'git-wl.count')}"`,
    `HOOKS_DIR="${hooksDir}"`,
    `LOG="${f.logPath}"`,
    'prev=""; is_list=0',
    'for a in "$@"; do',
    '  if [ "$prev" = "worktree" ] && [ "$a" = "list" ]; then is_list=1; fi',
    '  prev="$a"',
    'done',
    'if [ "$is_list" = 1 ]; then',
    '  echo x >> "$COUNT_FILE"',
    '  n="$(wc -l < "$COUNT_FILE" | tr -d " ")"',
    '  echo "GIT worktree-list #$n" >> "$LOG"',
    '  if [ -f "$HOOKS_DIR/$n.sh" ]; then bash "$HOOKS_DIR/$n.sh"; touch "$HOOKS_DIR/$n.ran"; fi',
    '  case "$FAIL_SET" in',
    '    *",$n,"*) echo "fatal: simulated worktree-list failure (call $n)" >&2; exit 128 ;;',
    '  esac',
    'fi',
    'CLEAN_PATH="$(printf %s "$PATH" | tr ":" "\\n" | grep -vxF "$(dirname "$0")" | paste -sd: -)"',
    'exec env PATH="$CLEAN_PATH" git "$@"',
  ].join('\n')
  const p = join(f.binDir, 'git')
  writeFileSync(p, `${shim}\n`)
  chmodSync(p, 0o755)
}

export function gitHookRan(f: FixtureRepo, n: number): boolean {
  return existsSync(join(f.tempRoot, 'githooks', `${n}.ran`))
}

export function gitListCount(f: FixtureRepo): number {
  const p = join(f.tempRoot, 'git-wl.count')
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).length : 0
}

export function realPerl(): string {
  return spawnSync('bash', ['-c', 'command -v perl'], { encoding: 'utf8' }).stdout.trim()
}

/**
 * A `perl` wrapper that logs `PERL <mode>` (acquire / same / probe / bounded)
 * into the docker log, then execs real perl -- or, with `fakeAcquire`, exits 0
 * for `acquire` WITHOUT locking (a no-op flock).
 */
export function installPerlWrapper(f: FixtureRepo, opts: { fakeAcquire?: boolean } = {}): void {
  const shim = [
    '#!/usr/bin/env bash',
    'mode=bounded',
    'for a in "$@"; do',
    '  case "$a" in acquire|same|probe) mode="$a" ;; esac',
    'done',
    `echo "PERL $mode" >> "${f.logPath}"`,
    opts.fakeAcquire ? 'if [ "$mode" = acquire ]; then exit 0; fi' : '',
    `exec ${realPerl()} "$@"`,
  ].join('\n')
  const p = join(f.binDir, 'perl')
  writeFileSync(p, `${shim}\n`)
  chmodSync(p, 0o755)
}

/** Replace `.git` with a copy (rename + cp -R): a new directory inode. */
export const REPLACE_GIT_DIR = (repoDir: string): string =>
  `mv "${repoDir}/.git" "${repoDir}/.git.old" && cp -R "${repoDir}/.git.old" "${repoDir}/.git"`
