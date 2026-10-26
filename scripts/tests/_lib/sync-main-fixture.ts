/**
 * SMI-6465 — fixture helpers for scripts/tests/sync-main-preserve.test.ts.
 *
 * Each fixture is three repositories under one temp dir: a bare `origin`, an
 * `up` clone that plays upstream, and a `local` clone that plays the shared
 * main checkout `sync-main.sh` runs in. Every git call uses the SMI-4693
 * fixture env, so the author's own git config never shapes a result.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import { makeFixtureEnv, makeFixtureTempDir } from './git-fixture-env.js'

export const SCRIPT_PATH = join(__dirname, '..', '..', 'sync-main.sh')
export const GIT_ENV = makeFixtureEnv({ GIT_ALLOW_PROTOCOL: 'file' })
export const STATE_PRE = 'Nothing was changed.'
export const STATE_POST = 'Nothing local was changed (origin/main was fetched).'

const tempDirs: string[] = []

export function cleanupFixtures(): void {
  for (const dir of tempDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
  tempDirs.length = 0
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'init.defaultBranch=main', '-c', 'protocol.file.allow=always', ...args],
    { cwd, encoding: 'utf8', env: GIT_ENV }
  ).trim()
}

/** Like git(), but keeps trailing whitespace and NULs (for -z output). */
export function gitRaw(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV })
}

export interface Repo {
  root: string
  origin: string
  up: string
  local: string
}

export const SEED: Record<string, string> = {
  'a.txt': 'a\n',
  'b.txt': 'b\n',
  'c.txt': 'c\n',
  'unrelated.txt': 'u\n',
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
}

/** Bare origin, an upstream clone and a local clone, all at one seed commit. */
export function makeRepo(seed: Record<string, string> = SEED): Repo {
  const root = makeFixtureTempDir('sync-main-preserve')
  tempDirs.push(root)
  const origin = join(root, 'origin.git')
  const up = join(root, 'up')
  const local = join(root, 'local')
  git(root, 'init', '-q', '--bare', origin)
  git(root, 'clone', '-q', origin, up)
  writeFiles(up, seed)
  git(up, 'add', '-A')
  git(up, 'commit', '-q', '-m', 'seed')
  git(up, 'push', '-q', 'origin', 'main')
  git(root, 'clone', '-q', origin, local)
  return { root, origin, up, local }
}

/** Commit `files` upstream and push. `force` paths are added with -f. */
export function pushUpstream(
  repo: Repo,
  files: Record<string, string>,
  opts: { force?: string[]; msg?: string } = {}
): string {
  writeFiles(repo.up, files)
  for (const path of Object.keys(files)) {
    git(repo.up, 'add', ...(opts.force?.includes(path) ? ['-f'] : []), '--', path)
  }
  git(repo.up, 'commit', '-q', '-m', opts.msg ?? 'upstream')
  git(repo.up, 'push', '-q', 'origin', 'main')
  return git(repo.up, 'rev-parse', 'HEAD')
}

/** Commit `files` on local main (making it ahead of, or diverged from, origin). */
export function commitLocal(repo: Repo, files: Record<string, string>): string {
  writeFiles(repo.local, files)
  git(repo.local, 'add', '-A', '--', ...Object.keys(files))
  git(repo.local, 'commit', '-q', '-m', 'local work')
  return git(repo.local, 'rev-parse', 'HEAD')
}

export function write(dir: string, path: string, content: string): void {
  writeFiles(dir, { [path]: content })
}

export function read(dir: string, path: string): string {
  return readFileSync(join(dir, path), 'utf8')
}

/** The blob hash git would store for `content`. */
export function blobOf(cwd: string, content: string): string {
  return execFileSync('git', ['hash-object', '--stdin'], {
    cwd,
    input: content,
    encoding: 'utf8',
    env: GIT_ENV,
  }).trim()
}

export interface SyncResult {
  status: number
  stdout: string
  stderr: string
}

export function runSync(
  cwd: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = GIT_ENV
): SyncResult {
  const result = spawnSync('bash', [SCRIPT_PATH, ...args], {
    cwd,
    encoding: 'utf8',
    env,
    timeout: 30_000,
  })
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/**
 * Everything a refusal must leave alone: which ref HEAD names, every local
 * ref (remote-tracking refs excluded: a refusal after the fetch moves those),
 * the stash, the index, and every byte of the working tree outside .git.
 */
export function snapshot(dir: string): string {
  const files: string[] = []
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      if (rel === '' && name === '.git') continue
      const path = rel === '' ? name : `${rel}/${name}`
      const st = lstatSync(join(dir, path))
      if (st.isSymbolicLink()) files.push(`L ${path} -> ${readlinkSync(join(dir, path))}`)
      else if (st.isDirectory()) walk(path)
      else files.push(`F ${path} ${st.mode.toString(8)} ${readFileSync(join(dir, path), 'base64')}`)
    }
  }
  walk('')
  const headRef = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], {
    cwd: dir,
    encoding: 'utf8',
    env: GIT_ENV,
  }).stdout.trim()
  return [
    `HEAD-ref ${headRef || '(detached)'}`,
    `HEAD ${git(dir, 'rev-parse', 'HEAD')}`,
    gitRaw(dir, 'for-each-ref', '--format=%(refname) %(objectname)')
      .split('\n')
      .filter((line) => !line.startsWith('refs/remotes/'))
      .join('\n'),
    `index\n${gitRaw(dir, 'ls-files', '-s', '-v')}`,
    ...files,
  ].join('\n')
}

/** The ref origin/main points at in `dir` ('' if absent). */
export function originMain(dir: string): string {
  return spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/remotes/origin/main'], {
    cwd: dir,
    encoding: 'utf8',
    env: GIT_ENV,
  }).stdout.trim()
}

/**
 * Install a `git` wrapper first on PATH that performs `mode`'s side effect
 * around one subcommand, then delegates to the real git. Returns the env.
 */
export function shimEnv(repo: Repo, mode: string): NodeJS.ProcessEnv {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const dir = join(repo.root, 'shim')
  mkdirSync(dir, { recursive: true })
  const shim = `#!/usr/bin/env bash
real=${JSON.stringify(realGit)}
sub=''
args=("$@")
i=0
while [ "$i" -lt "\${#args[@]}" ]; do
  case "\${args[$i]}" in
    -c) i=$((i + 2)) ;;
    -*) i=$((i + 1)) ;;
    *) sub=\${args[$i]}; break ;;
  esac
done
mode=${JSON.stringify(mode)}
if [ "$sub" = fetch ]; then
  "$real" "$@" || exit $?
  [ "$mode" = switch-during-fetch ] && "$real" checkout -q -b feature/y
  exit 0
fi
if [ "$sub" = merge ] || [ "$sub" = reset ]; then
  case "$mode" in
    switch-before-move | switch-before-move-then-commit) "$real" symbolic-ref HEAD refs/heads/feature/x ;;
    edit-unrelated-before-move) printf 'edited by another session\\n' >>unrelated.txt ;;
  esac
  st=0
  "$real" "$@" || st=$?
  [ "$mode" = switch-before-move-then-commit ] && "$real" commit -q --allow-empty -m 'later commit'
  exit "$st"
fi
exec "$real" "$@"
`
  writeFileSync(join(dir, 'git'), shim)
  chmodSync(join(dir, 'git'), 0o755)
  return { ...GIT_ENV, PATH: `${dir}:${GIT_ENV.PATH ?? ''}` }
}
