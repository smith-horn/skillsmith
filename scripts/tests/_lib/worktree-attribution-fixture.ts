/**
 * Fixture for the Compose-project attribution tests (SMI-7089): remove-worktree.sh
 * and worktree-docker.sh run from COPIES inside a throwaway git repo, so the
 * orphan pruner they call resolves ITS main checkout to that repo (run from the
 * real tree, inside a container, `git worktree list` fails and the pruner refuses
 * -- which would turn every removal red for a reason unrelated to the test).
 *
 * The `docker` on PATH is a recording wrapper. It answers the attribution reads
 * (`info`, `compose config`, `ps -a --filter label=...`, `inspect <id>`) from files
 * in `responsesDir`, appends every call it handles to `logPath`, records for EVERY call
 * whether the watched worktree is still registered (`regLog`), and hands everything
 * else to the orphan-pruner shim (`docker.pruner`) unchanged.
 */

import { spawnSync } from 'child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'

import { makeFixtureEnv } from './git-fixture-env.js'
import {
  addWorktree,
  setupFixture,
  type FixtureRepo,
} from '../prune-orphaned-docker-volumes.helpers.js'

export { addWorktree }

const REAL_SCRIPTS = join(__dirname, '..', '..')
const COPIED = [
  'remove-worktree.sh',
  'worktree-docker.sh',
  'lib/remove-worktree-docker.sh',
  'lib/worktree-project-attribution.sh',
]

export interface AttrFixture extends FixtureRepo {
  /** The orphan-pruner shim the wrapper delegates unhandled calls to. */
  delegate: string
  /** One line per docker call: `<args>|registered=yes|no` for the watched path. */
  regLog: string
}

export type RunResult = { status: number; stdout: string; stderr: string; dockerCalls: string[] }

const WRAPPER = (fx: {
  responsesDir: string
  logPath: string
  regLog: string
  repoDir: string
  delegate: string
}) =>
  `#!/bin/bash
RESP="${fx.responsesDir}"; LOG="${fx.logPath}"; REG="${fx.regLog}"; REPO="${fx.repoDir}"; DELEGATE="${fx.delegate}"
watch="$(cat "$RESP/watch_path" 2>/dev/null)"
if [ -n "$watch" ]; then
  if git -C "$REPO" worktree list --porcelain 2>/dev/null | grep -qxF "worktree $watch"; then st=yes; else st=no; fi
  echo "$*|registered=$st" >> "$REG"
fi
# \`exit__<key>.seq\` gives one exit code per successive call (consumed); \`exit__<key>\` a fixed one.
rc_of() {
  if [ -s "$RESP/exit__$1.seq" ]; then
    head -n 1 "$RESP/exit__$1.seq"; tail -n +2 "$RESP/exit__$1.seq" > "$RESP/exit__$1.seq.n"; mv "$RESP/exit__$1.seq.n" "$RESP/exit__$1.seq"
  elif [ -f "$RESP/exit__$1" ]; then cat "$RESP/exit__$1"; else echo 0; fi
}
# One-shot "effect" hook: fires on the FIRST effect-phase call -- \`rm -f\`, a project
# \`network ls --filter\` / \`network rm\`, or the first call that falls
# through to the delegate (Step 3 reads, the pruner) -- and records which call it was
# in hook.trigger. A hook keyed on one verb would not fire if a mutation stopped
# that verb from ever running.
# \`<key>.seq\` (one line per call, ids space-separated) serves a DIFFERENT list on each call.
emit_ids() {
  if [ -s "$RESP/$1.seq" ]; then
    head -n 1 "$RESP/$1.seq" | tr ' ' '\\n'; tail -n +2 "$RESP/$1.seq" > "$RESP/$1.seq.n"; mv "$RESP/$1.seq.n" "$RESP/$1.seq"
  else cat "$RESP/$1" 2>/dev/null; fi
}
fire_effect() { f="$RESP/hook__effect"; if [ -f "$f" ]; then mv "$f" "$f.ran"; echo "$1" > "$RESP/hook.trigger"; bash "$f.ran"; fi; }
run_hook() { f="$RESP/hook__$1"; if [ -f "$f" ]; then mv "$f" "$f.ran"; bash "$f.ran"; fi; }
case "$1" in
  info)
    echo "$@" >> "$LOG"
    exit "$(rc_of info)"
    ;;
  compose)
    echo "$@" >> "$LOG"
    case "$*" in
      *"config --profiles"*)
        cat "$RESP/profiles" 2>/dev/null
        exit "$(rc_of compose_profiles)"
        ;;
      *"--profile dev config --services"*)
        rc="$(rc_of compose_services)"
        if [ "$rc" != 0 ]; then exit "$rc"; fi
        # The services of the dev profile; default \`dev\` (what the repo's compose gives).
        if [ -f "$RESP/compose_services" ]; then cat "$RESP/compose_services"; else echo dev; fi
        exit 0
        ;;
      *"config --format json"*)
        rc="$(rc_of compose_config)"
        if [ "$rc" != 0 ]; then exit "$rc"; fi
        if [ -f "$RESP/compose_config.json" ]; then cat "$RESP/compose_config.json"; else printf '{"name":"%s"}\\n' "$(cat "$RESP/compose_name" 2>/dev/null)"; fi
        exit 0
        ;;
      *down)
        fire_effect "$*"
        run_hook down
        exit "$(rc_of down)"
        ;;
      *" up "*)
        exit "$(rc_of up)"
        ;;
    esac
    exit 0
    ;;
  rm)
    echo "$@" >> "$LOG"
    fire_effect "$*"
    rc="$(rc_of rm)"
    if [ "$rc" != 0 ]; then echo "Error response from daemon: cannot remove container" >&2; exit "$rc"; fi
    exit 0
    ;;
  network)
    echo "$@" >> "$LOG"
    case "$*" in *--filter*|"network rm"*) fire_effect "$*" ;; esac
    # The project-scoped listing has its own exit key (network_ls_filter), so a test
    # can break the Step 3 report's \`network ls\` without breaking the cleanup's.
    case "$*" in *--filter*) rc="$(rc_of "network_$2_filter")" ;; *) rc="$(rc_of "network_$2")" ;; esac
    if [ "$rc" != 0 ]; then echo "Cannot connect to the Docker daemon" >&2; exit "$rc"; fi
    # The project-scoped listing: ids from network_filter_out, one per line.
    case "$*" in *--filter*) cat "$RESP/network_filter_out" 2>/dev/null; exit 0 ;; esac
    # Optional canned output: network_ls_out on stdout, network_ls_err on stderr.
    if [ "$2" = ls ]; then
      if [ -f "$RESP/network_ls_err" ]; then cat "$RESP/network_ls_err" >&2; fi
      if [ -f "$RESP/network_ls_out" ]; then cat "$RESP/network_ls_out"; fi
    fi
    exit 0
    ;;
  ps)
    case "$*" in
      *"--filter network="*)
        echo "$@" >> "$LOG"
        rc="$(rc_of ps_network)"
        if [ "$rc" != 0 ]; then exit "$rc"; fi
        for a in "$@"; do case "$a" in network=*) net="\${a#network=}" ;; esac; done
        cat "$RESP/ps_network__$net" 2>/dev/null
        exit 0
        ;;
      *label=com.docker.compose.project=*)
        echo "$@" >> "$LOG"
        rc="$(rc_of ps)"
        if [ "$rc" != 0 ]; then exit "$rc"; fi
        emit_ids ps_running
        case "$2" in -aq) cat "$RESP/ps_stopped" 2>/dev/null ;; esac
        exit 0
        ;;
    esac
    ;;
  inspect)
    case "$*" in
      "inspect --type container "*"json .Config.Labels"*)
        echo "$@" >> "$LOG"
        rc="$(rc_of inspect)"
        if [ "$rc" != 0 ]; then exit "$rc"; fi
        cat "$RESP/inspect__$4" 2>/dev/null
        exit 0
        ;;
    esac
    ;;
esac
fire_effect "$*"
exec "$DELEGATE" "$@"
`

export function makeAttrFixture(prefix: string): AttrFixture {
  const base = setupFixture(prefix)
  const scripts = join(base.repoDir, 'scripts')
  for (const f of COPIED) cpSync(join(REAL_SCRIPTS, f), join(scripts, f))
  chmodSync(join(scripts, 'remove-worktree.sh'), 0o755)
  chmodSync(join(scripts, 'worktree-docker.sh'), 0o755)
  const delegate = join(base.binDir, 'docker.pruner')
  renameSync(join(base.binDir, 'docker'), delegate)
  const regLog = join(base.tempRoot, 'registered.log')
  const fx: AttrFixture = { ...base, delegate, regLog }
  writeFileSync(join(base.binDir, 'docker'), WRAPPER(fx))
  chmodSync(join(base.binDir, 'docker'), 0o755)
  return fx
}

export function sanitizeProject(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[_-]+/, '')
}

export function setResp(fx: AttrFixture, key: string, value: string): void {
  writeFileSync(join(fx.responsesDir, key), value.endsWith('\n') ? value : `${value}\n`)
}

/** Make the wrapper's `docker <key>` answer exit `code` (keys: info, compose_config, compose_services, up, rm, ps, ps_network, inspect, network_ls, network_rm). */
export function setExit(fx: AttrFixture, key: string, code: number): void {
  writeFileSync(join(fx.responsesDir, `exit__${key}`), String(code))
}

/** One exit code per successive \`docker <key>\` call (e.g. info: R0 answers 0, the pruner's own check 1). */
export function setExitSequence(fx: AttrFixture, key: string, codes: number[]): void {
  writeFileSync(join(fx.responsesDir, `exit__${key}.seq`), `${codes.join('\n')}\n`)
}

/** Running containers (ids) that Compose created from \`workingDir\`: U6 approves them. */
export function ourContainers(
  fx: AttrFixture,
  workingDir: string,
  ids: string[] = ['c1'],
  services: Record<string, string> = {}
): void {
  setContainers(fx, { running: ids })
  for (const id of ids) setLabels(fx, id, workdirLabels(workingDir, 'x', services[id] ?? 'dev'))
}

/** Containers (ids) attached to network \`net\`, running or not, for \`ps -a --filter network=\`. */
export function setNetworkUsers(fx: AttrFixture, net: string, ids: string[]): void {
  setResp(fx, `ps_network__${net}`, ids.join('\n'))
}

/** Serve a different running-ID list on each successive \`ps\` (space-separated ids per call). */
export function setPsSequence(fx: AttrFixture, lists: string[]): void {
  writeFileSync(join(fx.responsesDir, 'ps_running.seq'), `${lists.join('\n')}\n`)
}

/** The ids \`docker network ls --filter label=com.docker.compose.project=...\` returns. */
export function setProjectNetworks(fx: AttrFixture, ids: string[]): void {
  setResp(fx, 'network_filter_out', ids.join('\n'))
}

/** Declare the ID lists `docker ps` answers: running ones to `-q`/`-aq`, stopped ones to `-aq` only. */
export function setContainers(
  fx: AttrFixture,
  c: { running?: string[]; stopped?: string[] }
): void {
  setResp(fx, 'ps_running', (c.running ?? []).join('\n'))
  setResp(fx, 'ps_stopped', (c.stopped ?? []).join('\n'))
}

/** The `{{json .Config.Labels}}` text for a container created from `workingDir`. */
export function workdirLabels(workingDir: string, project = 'x', service = 'dev'): string {
  return JSON.stringify({
    'com.docker.compose.project': project,
    'com.docker.compose.service': service,
    'com.docker.compose.project.working_dir': workingDir,
  })
}

export function setLabels(fx: AttrFixture, id: string, json: string): void {
  setResp(fx, `inspect__${id}`, json)
}

/** Watch a worktree path so every docker call records whether it is still registered. */
export function primeAttribution(fx: AttrFixture, worktreeDir: string, composeName?: string): void {
  setResp(fx, 'watch_path', worktreeDir)
  setResp(fx, 'compose_name', composeName ?? sanitizeProject(worktreeDir.split('/').pop() ?? ''))
  setContainers(fx, {})
}

export function setHook(fx: AttrFixture, key: string, body: string): void {
  writeFileSync(join(fx.responsesDir, `hook__${key}`), body)
}

export function composeOverride(worktreeDir: string): void {
  writeFileSync(join(worktreeDir, 'docker-compose.override.yml'), 'services: {}\n')
}

export function composeBase(worktreeDir: string): void {
  writeFileSync(join(worktreeDir, 'docker-compose.yml'), 'services: {}\n')
}

let branchCounter = 0

/** Add a worktree under tempRoot, with the Compose files the scripts look for. */
export function addWt(
  fx: AttrFixture,
  dirName: string,
  opts: { override?: boolean; base?: boolean; parent?: string } = {}
): string {
  const dir = join(opts.parent ?? fx.tempRoot, dirName)
  branchCounter += 1
  addWorktree(fx.repoDir, dir, `b-${branchCounter}`)
  if (opts.override !== false) composeOverride(dir)
  if (opts.base) composeBase(dir)
  return dir
}

export function readLog(fx: AttrFixture): string[] {
  return existsSync(fx.logPath)
    ? readFileSync(fx.logPath, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
    : []
}

export function readRegLog(fx: AttrFixture): string[] {
  return existsSync(fx.regLog)
    ? readFileSync(fx.regLog, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
    : []
}

export function run(
  fx: AttrFixture,
  script: 'remove-worktree.sh' | 'worktree-docker.sh',
  args: string[],
  extraEnv: Record<string, string> = {},
  pathOverride?: string,
  scriptDir?: string
): RunResult {
  const env = {
    ...makeFixtureEnv(),
    PATH: pathOverride ?? `${fx.binDir}:${makeFixtureEnv().PATH ?? ''}`,
    ...extraEnv,
  }
  const r = spawnSync('bash', [join(scriptDir ?? join(fx.repoDir, 'scripts'), script), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env,
    cwd: fx.repoDir,
  })
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    dockerCalls: readLog(fx),
  }
}

export const runRemove = (fx: AttrFixture, args: string[], env: Record<string, string> = {}) =>
  run(fx, 'remove-worktree.sh', args, env)
export const runDocker = (fx: AttrFixture, args: string[], env: Record<string, string> = {}) =>
  run(fx, 'worktree-docker.sh', args, env)

/**
 * A PATH with the tools the scripts need and NO `docker`, for the "docker is not
 * installed" case: `command -v docker` must fail, which a shim on PATH never does.
 */
export function pathWithoutDocker(fx: { tempRoot: string }): string {
  const dir = join(fx.tempRoot, 'nodocker-bin')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const tools = [
    'bash',
    'sh',
    'env',
    'git',
    'perl',
    'node',
    'sed',
    'tr',
    'grep',
    'awk',
    'cat',
    'head',
    'tail',
    'wc',
    'cut',
    'sort',
    'uniq',
    'paste',
    'basename',
    'dirname',
    'mkdir',
    'rm',
    'mv',
    'cp',
    'ln',
    'ls',
    'date',
    'uname',
    'df',
    'mount',
    'readlink',
    'stat',
    'id',
    'sleep',
    'tput',
    'touch',
    'chmod',
    'find',
    'xargs',
    'diff',
    'mktemp',
    'realpath',
    'true',
    'false',
  ]
  for (const t of tools) {
    const r = spawnSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' })
    const p = (r.stdout ?? '').trim()
    if (r.status === 0 && p.startsWith('/')) {
      try {
        symlinkSync(p, join(dir, t))
      } catch {
        // already linked
      }
    }
  }
  return dir
}
