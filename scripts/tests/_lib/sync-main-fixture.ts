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
  if [ "$mode" = fetch-fails-malformed ]; then
    printf 'remote: x\\nfatal: bad \\377\\376 fetch \\233end\\n\\n' >&2
    exit 128
  fi
  "$real" "$@" || exit $?
  [ "$mode" = switch-during-fetch ] && "$real" checkout -q -b feature/y
  exit 0
fi
if [ "$sub" = merge-base ] && [ "$mode" = merge-base-fails ]; then
  exit 128
fi
if [ "$sub" = merge ] || [ "$sub" = reset ]; then
  # Side effects play another session, which never carries this run's reflog nonce.
  ra=\${GIT_REFLOG_ACTION-}
  unset GIT_REFLOG_ACTION
  case "$mode" in
    switch-before-move | switch-before-move-then-commit | switch-before-move-overwrite-orig-head | switch-before-move-then-away-and-back | switch-before-move-and-back | switch-and-back-then-other-sync | reflog-*)
      "$real" symbolic-ref HEAD refs/heads/feature/x ;;
    edit-unrelated-before-move) printf 'edited by another session\\n' >>unrelated.txt ;;
    other-sync-moves-first)
      "$real" symbolic-ref HEAD refs/heads/feature/x
      GIT_REFLOG_ACTION='sync-main other-run' "$real" merge --ff-only -q "\${args[\${#args[@]}-1]}"
      ;;
    detach-before-move-and-back) "$real" checkout -q --detach ;;
    diverge-main-before-move) "$real" commit -q --allow-empty -m 'race commit on main' ;;
    fail-move) exit 1 ;;
    fail-move-with-message) printf 'fatal: simulated index.lock held\\r\\n' >&2; exit 1 ;;
    fail-move-out-verbose)
      { printf 'fatal: first line\\n'; awk 'BEGIN{for(i=0;i<20000;i++)print "more output line", i}'; } >&2; exit 1 ;;
    fail-move-out-leading) printf '\\n\\n  \\nfatal: after blanks\\nsecond line\\n' >&2; exit 1 ;;
    fail-move-out-ansi) printf '\\033[31mfatal: red\\033[0m\\001\\000tail\\n' >&2; exit 1 ;;
    fail-move-out-long) awk 'BEGIN{s="fatal: "; for(i=0;i<300;i++) s=s "x"; print s}' >&2; exit 1 ;;
    fail-move-out-empty) exit 1 ;;
    fail-move-out-ctl-first) printf '\\033\\033\\n  \\nfatal: real reason\\n' >&2; exit 1 ;;
    fail-move-out-malformed) printf 'fatal: bad \\377\\376 bytes \\233 C1 \\177DEL end\\n' >&2; exit 1 ;;
    fail-move-out-huge) awk 'BEGIN{printf "fatal: "; for(i=0;i<2000000;i++) printf "x"; print ""}' >&2; exit 1 ;;
    stage-incoming-then-fail) printf 'staged by another session\\n' >a.txt; "$real" add a.txt; exit 1 ;;
  esac
  st=0
  GIT_REFLOG_ACTION=$ra "$real" "$@" || st=$?
  [ "$mode" = switch-before-move-then-commit ] && "$real" commit -q --allow-empty -m 'later commit'
  [ "$mode" = switch-before-move-overwrite-orig-head ] && "$real" update-ref ORIG_HEAD HEAD
  [ "$mode" = switch-before-move-and-back ] && "$real" symbolic-ref HEAD refs/heads/main
  [ "$mode" = detach-before-move-and-back ] && "$real" symbolic-ref HEAD refs/heads/main
  if [ "$mode" = switch-and-back-then-other-sync ]; then
    "$real" symbolic-ref HEAD refs/heads/main
    GIT_REFLOG_ACTION='sync-main other-run' "$real" merge --ff-only -q "\${args[\${#args[@]}-1]}"
  fi
  case "$mode" in
    reflog-*)
      # Simulate a clock step or a foreign entry by rewriting feature/x's reflog.
      log=$("$real" rev-parse --git-path logs/refs/heads/feature/x)
      last=$(tail -n 1 "$log")
      body=$(sed '$d' "$log")
      target=\${args[\${#args[@]}-1]}
      z=0000000000000000000000000000000000000001
      rolled=$(printf '%s\\n' "$last" | sed -E 's/> [0-9]+ ([-+][0-9]{4})/> 1000000000 \\1/')
      case "$mode" in
        reflog-rollback-with-future) extra="$z $target t <t@t> 9999999999 +0000\\tmerge $target: Fast-forward" final=$rolled ;;
        reflog-future-other) extra="$z $z t <t@t> 9999999999 +0000\\tother" final=$last ;;
        reflog-rollback-with-inwindow) extra="$z $target t <t@t> $(date +%s) +0000\\tother" final=$rolled ;;
      esac
      { [ -z "$body" ] || printf '%s\\n' "$body"; printf '%b\\n' "$extra"; printf '%s\\n' "$final"; } >"$log"
      ;;
  esac
  if [ "$mode" = switch-before-move-then-away-and-back ]; then
    target=\${args[\${#args[@]}-1]}
    "$real" reset -q --soft HEAD^ && "$real" merge -q --ff-only "$target"
  fi
  exit "$st"
fi
exec "$real" "$@"
`
  writeFileSync(join(dir, 'git'), shim)
  chmodSync(join(dir, 'git'), 0o755)
  return { ...GIT_ENV, PATH: `${dir}:${GIT_ENV.PATH ?? ''}` }
}

/**
 * Put an `od` first on PATH that fails (`fail`) or prints too few bytes
 * (`short`), to drive sync-main.sh's nonce-failure path.
 */
export function odShimEnv(repo: Repo, mode: 'fail' | 'short'): NodeJS.ProcessEnv {
  const dir = join(repo.root, 'od-shim')
  mkdirSync(dir, { recursive: true })
  const body = mode === 'fail' ? 'exit 1' : "printf 'ab\\n'"
  writeFileSync(join(dir, 'od'), `#!/bin/sh\n${body}\n`)
  chmodSync(join(dir, 'od'), 0o755)
  return { ...GIT_ENV, PATH: `${dir}:${GIT_ENV.PATH ?? ''}` }
}

/**
 * Put a `grep` first on PATH that fails (exit 2) for sync-main.sh's recursive
 * reflog scan only, and behaves as the real grep for every other call.
 */
export function grepFailEnv(repo: Repo, base: NodeJS.ProcessEnv = GIT_ENV): NodeJS.ProcessEnv {
  const realGrep = execFileSync('sh', ['-c', 'command -v grep'], { encoding: 'utf8' }).trim()
  const dir = join(repo.root, 'grep-shim')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'grep'),
    `#!/bin/sh\ncase " $* " in *" -RlF "*) echo 'grep: simulated read error' >&2; exit 2 ;; esac\nexec ${JSON.stringify(realGrep)} "$@"\n`
  )
  chmodSync(join(dir, 'grep'), 0o755)
  return { ...base, PATH: `${dir}:${base.PATH ?? ''}` }
}

/**
 * Put a `tr` first on PATH that fails (exit 1, with a diagnostic) for the
 * rendering helper's high-byte mapping only, and is the real tr otherwise.
 */
export function trFailEnv(repo: Repo, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const realTr = execFileSync('sh', ['-c', 'command -v tr'], { encoding: 'utf8' }).trim()
  const dir = join(repo.root, 'tr-shim')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'tr'),
    `#!/bin/sh\ncase "$1" in '\\200-\\377') echo 'tr: Illegal byte sequence' >&2; exit 1 ;; esac\nexec ${JSON.stringify(realTr)} "$@"\n`
  )
  chmodSync(join(dir, 'tr'), 0o755)
  return { ...base, PATH: `${dir}:${base.PATH ?? ''}` }
}

/** Put a tool shim first on PATH; `body` is the shim's shell, `real` the real tool's path. */
function toolShimEnv(
  repo: Repo,
  tool: string,
  body: (real: string) => string,
  base: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const real = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim()
  const dir = join(repo.root, `${tool}-shim`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, tool), `#!/bin/sh\n${body(JSON.stringify(real))}\n`)
  chmodSync(join(dir, tool), 0o755)
  return { ...base, PATH: `${dir}:${base.PATH ?? ''}` }
}

/** `readlink` that always names the same relative link, so resolution never ends. */
export function readlinkLoopEnv(
  repo: Repo,
  link: string,
  base: NodeJS.ProcessEnv = GIT_ENV
): NodeJS.ProcessEnv {
  return toolShimEnv(repo, 'readlink', () => `printf '%s\\n' ${JSON.stringify(link)}`, base)
}

/**
 * `tr`, `awk` and `cut` shims that fail one_line's own calls unless LC_ALL=C.
 * one_line's calls are recognised loosely, by any argument that matches: a
 * `tr` argument starting with a backslash, an `awk` argument starting `pick=`,
 * or `cut`'s exact `-c1-200`. No other call in sync-main.sh matches those, so
 * every other call (it uses awk and tr elsewhere) goes to the real tool.
 */
export function oneLineNeedsCLocaleEnv(repo: Repo, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const check = (pattern: string) => (real: string) =>
    `for a in "$@"; do case "$a" in ${pattern}) [ "$LC_ALL" = C ] || { echo "locale $LC_ALL" >&2; exit 1; } ;; esac; done\nexec ${real} "$@"`
  let env = toolShimEnv(repo, 'tr', check("'\\'*"), base)
  env = toolShimEnv(repo, 'awk', check('pick=*'), env)
  return toolShimEnv(repo, 'cut', check('-c1-200'), env)
}
