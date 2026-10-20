/**
 * Shared fixtures for the SMI-6531 A1 step 2 `.gitignore` hint tests: real
 * temporary git repos, an isolated HOME, and stub `git` executables on PATH.
 * Every directory is created under os.tmpdir() and removed by `cleanup()`.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface Sandbox {
  /** Fresh temp directory holding everything this test creates. */
  dir: string
  /** The isolated HOME (also the XDG base), so no real user config leaks in. */
  home: string
  cleanup(): void
}

const SAVED_KEYS = [
  'HOME',
  'XDG_CONFIG_HOME',
  'PATH',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
] as const

/** A sandbox with HOME/XDG pointed inside it and every GIT_* redirection cleared. */
export function makeSandbox(): Sandbox {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitignore-hint-')))
  const home = path.join(dir, 'home')
  fs.mkdirSync(path.join(home, '.config', 'git'), { recursive: true })
  const saved: Record<string, string | undefined> = {}
  for (const key of SAVED_KEYS) saved[key] = process.env[key]
  for (const key of SAVED_KEYS) if (key.startsWith('GIT_')) delete process.env[key]
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = path.join(home, '.config')
  return {
    dir,
    home,
    cleanup() {
      for (const key of SAVED_KEYS) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()

/** The git the PATH resolved at import time, before any test rewrites PATH. */
export function realGitPath(): string {
  return REAL_GIT
}

/** Environment for a direct git call from a test: process.env, nothing scrubbed. */
export function rawGit(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(realGitPath(), args, {
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
  })
}

/** `git init` a directory; returns it. */
export function initRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const result = rawGit(['init', '-q', dir])
  if (result.status !== 0) throw new Error(`git init failed: ${result.stderr}`)
  return dir
}

/** Write `body` to `file`, creating parents. */
export function put(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

/** Put an executable script at `dir/name`. */
export function stubExecutable(dir: string, name: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, body, { mode: 0o755 })
  fs.chmodSync(file, 0o755)
  return file
}

/**
 * Puts a `git` wrapper first on PATH that logs each invocation's arguments
 * (joined by `|`, one line per call) and then runs the real git. Returns a
 * reader for the log.
 */
export function installGitSpy(sandbox: Sandbox): () => string[][] {
  const real = realGitPath()
  const bin = path.join(sandbox.dir, 'spybin')
  const log = path.join(sandbox.dir, 'git-calls.log')
  stubExecutable(
    bin,
    'git',
    `#!/bin/sh\nIFS='|'\necho "$*" >> '${log}'\nunset IFS\nexec '${real}' "$@"\n`
  )
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`
  return () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => line.split('|'))
      : []
}

/** Replaces PATH with a directory holding one stub `git`. Other tools stay reachable by absolute path only. */
export function installStubGit(sandbox: Sandbox, body: string): void {
  const bin = path.join(sandbox.dir, 'stubbin')
  stubExecutable(bin, 'git', body)
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`
}

/** Replaces PATH with an empty directory: spawning `git` fails with ENOENT. */
export function removeGitFromPath(sandbox: Sandbox): void {
  const bin = path.join(sandbox.dir, 'emptybin')
  fs.mkdirSync(bin, { recursive: true })
  process.env.PATH = bin
}

/** True when `start` or any ancestor holds a `.git` entry; tests refuse to rely on a dirty tmpdir. */
export function hasGitAtOrAbove(start: string): boolean {
  let dir = start
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return true
    const parent = path.dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}
