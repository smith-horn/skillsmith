/**
 * Fixture/shim infrastructure for prune-orphaned-docker-volumes.test.ts
 * (SMI-5750). Split out per CLAUDE.md's 500-line file-length guidance --
 * see the sibling test file's header for the full rationale (docker shim
 * conventions, canned-stdout key scheme, why each fixture copies the real
 * script + _lib.sh into its own throwaway repo).
 */

import { execSync, spawnSync } from 'child_process'
import {
  rmSync,
  existsSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  cpSync,
} from 'fs'
import { dirname, join } from 'path'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const REAL_SCRIPT_PATH = join(__dirname, '..', 'prune-orphaned-docker-volumes.sh')
const REAL_LIB_PATH = join(__dirname, '..', '_lib.sh')

/**
 * SMI-4693: GIT_DISCOVERY_VARS-stripped env for every git invocation AND the
 * prune-script subprocess. Same pattern as remove-worktree.test.ts.
 */
const GIT_ENV = makeFixtureEnv()

export function makeTempDir(prefix: string): string {
  return makeFixtureTempDir(prefix)
}

function git(cwd: string, args: string): string {
  return execSync(`git -c init.defaultBranch=main -c protocol.file.allow=always ${args}`, {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
  }).trim()
}

function sh(cmd: string, opts?: { cwd?: string }): string {
  return execSync(cmd, { encoding: 'utf8', env: GIT_ENV, ...opts }).trim()
}

export interface FixtureRepo {
  tempRoot: string
  repoDir: string
  scriptPath: string
  binDir: string
  logPath: string
  responsesDir: string
}

/**
 * Write a `docker` shim to `binDir/docker` that, in addition to recording
 * every invocation to `logPath` (exact convention as the shared
 * `writeDockerShim`: `echo "$@" >> logPath`), emits canned STDOUT read from
 * `responsesDir`, keyed by subcommand + target name + (for label queries)
 * which label was asked for. Response files are plain text; a missing file
 * means "no output" (empty string), which is also how a real absent/
 * mismatched label naturally reads in the script under test -- so tests
 * only need to write the response files that matter for that case.
 *
 * Key scheme (must match the JS-side helpers below exactly):
 *   volume_ls                                  <- `docker volume ls --format {{.Name}}`
 *   images                                      <- `docker images --format {{.Repository}}`
 *   volume_inspect__<vol>__volume                <- compose.volume label
 *   volume_inspect__<vol>__project                <- compose.project label
 *   volume_inspect__<vol>__owned                <- app.skillsmith.owned label
 *   image_inspect__<img>__service                <- compose.service label
 *   image_inspect__<img>__owned                <- app.skillsmith.owned label
 *   ps_volume__<vol>                             <- `docker ps -aq --filter volume=<vol>`
 *   ps_ancestor__<img>                           <- `docker ps -aq --filter ancestor=<img>`
 *   exit__volume_rm__<vol>                       <- exit code override for `docker volume rm <vol>`
 *   exit__rmi__<img>                             <- exit code override for `docker rmi <img>`
 */
function writeResponsiveDockerShim(binDir: string, logPath: string, responsesDir: string): void {
  const lines = [
    '#!/bin/sh',
    `echo "$@" >> "${logPath}"`,
    `RESP_DIR="${responsesDir}"`,
    '',
    'emit() {',
    '  key="$1"',
    // A `<key>.seq` file, if present, is CONSUMED one line per call: the first
    // line is emitted and removed. This is the only way to test a value that
    // CHANGES between two reads within a single run -- which is exactly what
    // the SMI-6981 ownership re-check exists to catch. With a static response
    // both reads return the same value, so the re-check's `|| continue` can be
    // changed to `|| true` with nothing observing it (round-2 finding T2).
    // Running the sequence dry emits nothing, i.e. the label has vanished.
    '  if [ -n "$key" ] && [ -f "$RESP_DIR/$key.seq" ]; then',
    '    head -n 1 "$RESP_DIR/$key.seq"',
    '    tail -n +2 "$RESP_DIR/$key.seq" > "$RESP_DIR/$key.seq.next"',
    '    mv "$RESP_DIR/$key.seq.next" "$RESP_DIR/$key.seq"',
    '    return 0',
    '  fi',
    '  if [ -n "$key" ] && [ -f "$RESP_DIR/$key" ]; then',
    '    cat "$RESP_DIR/$key"',
    '  fi',
    '}',
    '',
    'exit_override() {',
    '  file="$RESP_DIR/exit__$1"',
    '  if [ -f "$file" ]; then',
    '    code="$(cat "$file")"',
    '    exit "${code:-0}"',
    '  fi',
    '  exit 0',
    '}',
    '',
    'cmd="$1"',
    'sub="$2"',
    '',
    'case "$cmd" in',
    '  info)',
    '    exit 0',
    '    ;;',
    '  volume)',
    '    case "$sub" in',
    '      ls)',
    '        emit "volume_ls"',
    '        exit 0',
    '        ;;',
    '      inspect)',
    '        vol="$3"',
    '        fmt="$5"',
    '        case "$fmt" in',
    '          *compose.volume*) emit "volume_inspect__${vol}__volume" ;;',
    '          *compose.project*) emit "volume_inspect__${vol}__project" ;;',
    '          *skillsmith.owned*) emit "volume_inspect__${vol}__owned" ;;',
    '        esac',
    '        exit 0',
    '        ;;',
    '      rm)',
    '        exit_override "volume_rm__$3"',
    '        ;;',
    '    esac',
    '    exit 0',
    '    ;;',
    '  images)',
    '    emit "images"',
    '    exit 0',
    '    ;;',
    '  image)',
    '    case "$sub" in',
    '      inspect)',
    '        img="$3"',
    '        fmt="$5"',
    '        case "$fmt" in',
    '          *compose.service*) emit "image_inspect__${img}__service" ;;',
    '          *skillsmith.owned*) emit "image_inspect__${img}__owned" ;;',
    '        esac',
    '        exit 0',
    '        ;;',
    '    esac',
    '    exit 0',
    '    ;;',
    '  rmi)',
    '    exit_override "rmi__$2"',
    '    ;;',
    '  ps)',
    '    if [ "$2" = "-q" ]; then',
    '      emit "container_ids"',
    '      exit 0',
    '    fi',
    '    key=""',
    '    for arg in "$@"; do',
    '      case "$arg" in',
    '        volume=*) key="ps_volume__${arg#volume=}" ;;',
    '        ancestor=*) key="ps_ancestor__${arg#ancestor=}" ;;',
    '      esac',
    '    done',
    '    emit "$key"',
    '    exit 0',
    '    ;;',
    '  inspect)',
    '    id="$2"',
    '    fmt="$4"',
    '    case "$fmt" in',
    '      *".Name"*) emit "container__${id}__name" ;;',
    '      *".Created"*) emit "container__${id}__created" ;;',
    '      *working_dir*) emit "container__${id}__path" ;;',
    '    esac',
    '    exit 0',
    '    ;;',
    '  *)',
    '    exit 0',
    '    ;;',
    'esac',
    '',
  ]
  const shimPath = join(binDir, 'docker')
  writeFileSync(shimPath, `${lines.join('\n')}\n`)
  chmodSync(shimPath, 0o755)
}

/**
 * Build a throwaway main-checkout repo with the real script + _lib.sh copied
 * into its own scripts/ dir (see file header for why this is required), plus
 * a docker shim wired up on a dedicated bin dir.
 */
/**
 * @param opts.spacedPath nest the repo under a directory whose name contains a
 *   space, so the MAIN CHECKOUT's own path has whitespace in it.
 *
 *   No fixture could reach this before: `makeFixtureTempDir` builds on
 *   `tmpdir()`, which is space-free, so every fixture's main checkout sat at a
 *   clean path and the `awk '{print $2}'` truncation was invisible on that
 *   side. It is the worse side -- when the MAIN checkout's path is truncated,
 *   the control name is derived from the same truncation, so every arm of the
 *   enumeration guard agrees and the main checkout's own volume is deletable.
 */
export function setupFixture(prefix: string, opts: { spacedPath?: boolean } = {}): FixtureRepo {
  const tempRoot = makeTempDir(prefix)
  const repoParent = opts.spacedPath ? join(tempRoot, 'My Projects') : tempRoot
  if (opts.spacedPath) mkdirSync(repoParent, { recursive: true })
  const repoDir = join(repoParent, 'repo')

  git(repoParent, `init "${repoDir}"`)
  sh(`touch "${join(repoDir, 'README.md')}"`)
  git(repoDir, 'add README.md')
  git(repoDir, 'commit -m "initial"')

  const scriptsDir = join(repoDir, 'scripts')
  mkdirSync(scriptsDir, { recursive: true })
  const scriptPath = join(scriptsDir, 'prune-orphaned-docker-volumes.sh')
  cpSync(REAL_SCRIPT_PATH, scriptPath)
  cpSync(REAL_LIB_PATH, join(scriptsDir, '_lib.sh'))
  chmodSync(scriptPath, 0o755)

  const binDir = join(tempRoot, 'bin')
  mkdirSync(binDir, { recursive: true })
  const responsesDir = join(tempRoot, 'responses')
  mkdirSync(responsesDir, { recursive: true })
  const logPath = join(tempRoot, 'docker.log')

  writeResponsiveDockerShim(binDir, logPath, responsesDir)

  return { tempRoot, repoDir, scriptPath, binDir, logPath, responsesDir }
}

/** Register a real worktree (in-tree or out-of-tree) via `git worktree add`. */
export function addWorktree(repoDir: string, worktreePath: string, branch: string): void {
  mkdirSync(dirname(worktreePath), { recursive: true })
  git(repoDir, `worktree add -b ${branch} "${worktreePath}"`)
}

function setResponse(responsesDir: string, key: string, value: string): void {
  writeFileSync(join(responsesDir, key), value.endsWith('\n') ? value : `${value}\n`)
}

export function volumeListResponse(fixture: FixtureRepo, names: string[]): void {
  setResponse(fixture.responsesDir, 'volume_ls', names.join('\n'))
}

/**
 * Serve a DIFFERENT value for each successive read of one volume label, so a
 * test can model a label that changes mid-run. Takes precedence over any
 * static value set by `volumeLabels` for the same label.
 *
 * Pass fewer values than there are reads to model the label VANISHING: once
 * the sequence runs dry, `emit` produces nothing, which is what `docker volume
 * inspect` yields for an absent label.
 */
export function volumeLabelSequence(
  fixture: FixtureRepo,
  vol: string,
  label: 'volume' | 'project' | 'owned',
  values: string[]
): void {
  setResponse(fixture.responsesDir, `volume_inspect__${vol}__${label}.seq`, values.join('\n'))
}

export function imagesResponse(fixture: FixtureRepo, repos: string[]): void {
  setResponse(fixture.responsesDir, 'images', repos.join('\n'))
}

export function volumeLabels(
  fixture: FixtureRepo,
  vol: string,
  labels: { volume?: string; project?: string; owned?: string }
): void {
  if (labels.volume !== undefined) {
    setResponse(fixture.responsesDir, `volume_inspect__${vol}__volume`, labels.volume)
  }
  if (labels.project !== undefined) {
    setResponse(fixture.responsesDir, `volume_inspect__${vol}__project`, labels.project)
  }
  if (labels.owned !== undefined) {
    setResponse(fixture.responsesDir, `volume_inspect__${vol}__owned`, labels.owned)
  }
}

export function imageLabels(
  fixture: FixtureRepo,
  img: string,
  labels: { service?: string; owned?: string }
): void {
  if (labels.service !== undefined) {
    setResponse(fixture.responsesDir, `image_inspect__${img}__service`, labels.service)
  }
  if (labels.owned !== undefined) {
    setResponse(fixture.responsesDir, `image_inspect__${img}__owned`, labels.owned)
  }
}

export function volumePsResponse(fixture: FixtureRepo, vol: string, containerIds: string): void {
  setResponse(fixture.responsesDir, `ps_volume__${vol}`, containerIds)
}

export function setVolumeRmExit(fixture: FixtureRepo, vol: string, code: number): void {
  writeFileSync(join(fixture.responsesDir, `exit__volume_rm__${vol}`), String(code))
}

export function resetLog(fixture: FixtureRepo): void {
  if (existsSync(fixture.logPath)) rmSync(fixture.logPath)
  // Also clear any sequenced responses. `.seq` files are CONSUMED, so one left
  // over from a previous runPrune in the same test would be dry on the next
  // call and read as "label absent" -- which is the BLOCKING outcome, so a
  // two-run test combining `.seq` with resetLog would pass for the wrong
  // reason. Clearing here means a sequence is scoped to one run unless the
  // test deliberately re-arms it.
  for (const f of readdirSync(fixture.responsesDir)) {
    if (f.endsWith('.seq') || f.endsWith('.seq.next')) {
      rmSync(join(fixture.responsesDir, f))
    }
  }
}

/**
 * Make `git worktree list` fail while leaving every other git subcommand
 * working, by shadowing `git` on the fixture's PATH.
 *
 * This is the failure mode `derive_protected_or_die` exists for, and it is NOT
 * the same as "the protected set is empty": the `.worktrees/*` scan still
 * contributes entries, so the set comes back non-empty but WITHOUT the main
 * checkout's own name. Pass `withWorktreeDirs` to reproduce that shape.
 */
export function breakGitWorktreeList(fixture: FixtureRepo, withWorktreeDirs: string[] = []): void {
  for (const name of withWorktreeDirs) {
    mkdirSync(join(fixture.repoDir, '.worktrees', name), { recursive: true })
  }
  const shim = [
    '#!/usr/bin/env bash',
    '# Fail ONLY `worktree list`; delegate everything else to the real git, so',
    '# the fixture repo still works and the test isolates one failure.',
    // Require `list` to be the arg IMMEDIATELY after `worktree`, not merely
    // somewhere after it. A looser scan also rejects `worktree add -b list
    // <path>` and `worktree remove list` -- unreachable from this script, which
    // runs neither, but a shim that fails more than the one call it names
    // cannot isolate anything.
    'prev=""',
    'for a in "$@"; do',
    '  if [ "$prev" = "worktree" ] && [ "$a" = "list" ]; then',
    '    echo "fatal: simulated worktree-list failure" >&2',
    '    exit 128',
    '  fi',
    '  prev="$a"',
    'done',
    '# Strip this shim dir from PATH so the lookup finds the real binary.',
    'CLEAN_PATH="$(printf %s "$PATH" | tr ":" "\\n" | grep -vxF "$(dirname "$0")" | paste -sd: -)"',
    'exec env PATH="$CLEAN_PATH" git "$@"',
  ].join('\n')
  const p = join(fixture.binDir, 'git')
  writeFileSync(p, `${shim}\n`)
  chmodSync(p, 0o755)
}

export function containerResponses(
  fixture: FixtureRepo,
  containers: Array<{ id: string; name: string; created: string; path: string }>
): void {
  setResponse(
    fixture.responsesDir,
    'container_ids',
    containers.map((container) => container.id).join('\n')
  )
  for (const container of containers) {
    setResponse(fixture.responsesDir, `container__${container.id}__name`, `/${container.name}`)
    setResponse(fixture.responsesDir, `container__${container.id}__created`, container.created)
    setResponse(fixture.responsesDir, `container__${container.id}__path`, container.path)
  }
}

/**
 * Run the fixture's copy of prune-orphaned-docker-volumes.sh with the fake
 * docker shim on PATH. Uses spawnSync (not execSync) so stdout AND stderr
 * are both captured regardless of exit code -- several cases here assert on
 * stderr (warn()) or stdout (info()/echo) on a SUCCESSFUL (exit 0) run,
 * which execSync cannot give you (it only exposes stderr via the thrown
 * error on a non-zero exit).
 */
export function runPrune(
  fixture: FixtureRepo,
  args: string[] = [],
  extraEnv: Record<string, string> = {}
): { status: number; stdout: string; stderr: string; dockerCalls: string[] } {
  const env = {
    ...GIT_ENV,
    PATH: `${fixture.binDir}:${GIT_ENV.PATH ?? ''}`,
    ...extraEnv,
  }
  const result = spawnSync('bash', [fixture.scriptPath, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env,
    cwd: fixture.repoDir,
  })
  const dockerCalls = existsSync(fixture.logPath)
    ? readFileSync(fixture.logPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
    : []
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    dockerCalls,
  }
}
