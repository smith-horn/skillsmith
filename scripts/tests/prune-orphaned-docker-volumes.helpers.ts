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
import { setResponse } from './prune-orphaned-docker-volumes.responses.js'

const REAL_SCRIPT_PATH = join(__dirname, '..', 'prune-orphaned-docker-volumes.sh')
const REAL_LIB_PATH = join(__dirname, '..', '_lib.sh')
const REAL_SPRAWL_LIB_PATH = join(__dirname, '..', 'lib', 'report-sprawl-containers.sh')
const REAL_LIFECYCLE_LIB_PATH = join(__dirname, '..', 'lib', 'worktree-lifecycle.sh')
const REAL_LIFECYCLE_DOCKER_LIB_PATH = join(__dirname, '..', 'lib', 'worktree-lifecycle-docker.sh')

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
export function writeResponsiveDockerShim(
  binDir: string,
  logPath: string,
  responsesDir: string
): void {
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
    // SMI-6981 interleaving seam: a `hook__<key>` file is run ONCE, synchronously,
    // by the shim at the point the keyed call is made -- inside the pruner's own
    // child, so it executes at a deterministic point of the run. Consumed by a
    // rename to `.ran`, which is also the "the hook ran" presence proof.
    'run_hook() {',
    '  f="$RESP_DIR/hook__$1"',
    '  if [ -n "$1" ] && [ -f "$f" ]; then',
    '    mv "$f" "$f.ran"',
    '    bash "$f.ran"',
    '  fi',
    '}',
    '',
    // Counted hook: runs `hook__<key>__<n>` on the n-th call that reaches it, so a
    // test can act AFTER a specific call has answered (SMI-6981 lock tests).
    'nth_hook() {',
    '  n=$(cat "$RESP_DIR/nth__$1" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$RESP_DIR/nth__$1"',
    '  run_hook "$1__$n"',
    '}',
    '',
    // `ps`, `volume ls`, `images` (keys `container_ids`/`volume_ls`/`images`): a nonzero exit code, static (`exit__<key>`) or one per read
    // (`exit__<key>.seq`, consumed like `emit`'s), models a failing daemon query.
    'ps_exit() {',
    '  [ -n "$1" ] || return 0',
    '  code=0',
    '  if [ -f "$RESP_DIR/exit__$1.seq" ]; then',
    '    code="$(head -n 1 "$RESP_DIR/exit__$1.seq")"',
    '    tail -n +2 "$RESP_DIR/exit__$1.seq" > "$RESP_DIR/exit__$1.seq.next"',
    '    mv "$RESP_DIR/exit__$1.seq.next" "$RESP_DIR/exit__$1.seq"',
    '  elif [ -f "$RESP_DIR/exit__$1" ]; then',
    '    code="$(cat "$RESP_DIR/exit__$1")"',
    '  fi',
    '  [ "${code:-0}" = 0 ] || exit "$code"',
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
    '        ps_exit "volume_ls"',
    '        emit "volume_ls"',
    '        exit 0',
    '        ;;',
    '      inspect)',
    '        vol="$3"',
    '        fmt="$5"',
    '        run_hook "volume_inspect__${vol}"',
    '        nth_hook "volume_inspect_n__${vol}"',
    '        case "$fmt" in',
    // SMI-6981: the incarnation read ("<CreatedAt>|<owned>"). A static or
    // sequenced `__incarnation` response wins; otherwise it is composed from the
    // volume's `__owned` response (consumed like any other read of it) and a
    // fixed CreatedAt, so tests that only set labels keep working. The line is
    // "<CreatedAt>|<shape>|<project>|<owned>" (one inspect carries identity and
    // every predicate).
    '          *CreatedAt*)',
    '            line="$(emit "volume_inspect__${vol}__incarnation")"',
    '            if [ -z "$line" ]; then',
    '              sh_="$(emit "volume_inspect__${vol}__volume")"',
    '              pj="$(emit "volume_inspect__${vol}__project")"',
    '              o="$(emit "volume_inspect__${vol}__owned")"',
    '              line="2000-01-01T00:00:00Z|$sh_|$pj|$o"',
    '            fi',
    '            printf "%s\\n" "$line"',
    '            run_hook "volume_after_project_read__${vol}"',
    '            ;;',
    '          *compose.volume*) emit "volume_inspect__${vol}__volume" ;;',
    '          *compose.project*) emit "volume_inspect__${vol}__project"; run_hook "volume_after_project_read__${vol}" ;;',
    '          *skillsmith.owned*) emit "volume_inspect__${vol}__owned" ;;',
    '        esac',
    '        exit 0',
    '        ;;',
    '      rm)',
    '        run_hook "volume_rm__$3"',
    '        exit_override "volume_rm__$3"',
    '        ;;',
    '    esac',
    '    exit 0',
    '    ;;',
    '  images)',
    '    ps_exit "images"',
    '    emit "images"',
    '    exit 0',
    '    ;;',
    '  image)',
    '    case "$sub" in',
    '      inspect)',
    '        img="$3"',
    '        fmt="$5"',
    '        case "$fmt" in',
    // SMI-7089: the whole label map as JSON, read ONCE at selection. A
    // `__labels` response wins (a literal JSON string, e.g. `null`); otherwise the
    // map is composed from the per-key responses (consumed like any other read of
    // them), and a map with no labels at all reads `null`, as Docker prints it.
    '          *"json .Config.Labels"*)',
    '            lbl="$(emit "image_inspect__${img}__labels")"',
    '            if [ -z "$lbl" ]; then',
    '              sv="$(emit "image_inspect__${img}__service")"',
    '              ow="$(emit "image_inspect__${img}__owned")"',
    '              pj="$(emit "image_inspect__${img}__project")"',
    '              if [ -z "$sv$ow$pj" ]; then lbl="null"; else',
    '                lbl="{"; sep=""',
    '                if [ -n "$pj" ]; then lbl="$lbl$sep\\"com.docker.compose.project\\":\\"$pj\\""; sep=","; fi',
    '                if [ -n "$sv" ]; then lbl="$lbl$sep\\"com.docker.compose.service\\":\\"$sv\\""; sep=","; fi',
    '                if [ -n "$ow" ]; then lbl="$lbl$sep\\"app.skillsmith.owned\\":\\"$ow\\""; sep=","; fi',
    '                lbl="$lbl}"',
    '              fi',
    '            fi',
    '            printf "%s\\n" "$lbl"',
    '            ;;',
    '          *".Id"*) emit "image_inspect__${img}__id"; nth_hook "image_id_after__${img}" ;;',
    '          *compose.service*) emit "image_inspect__${img}__service" ;;',
    '          *skillsmith.owned*) emit "image_inspect__${img}__owned" ;;',
    '        esac',
    '        exit 0',
    '        ;;',
    '    esac',
    '    exit 0',
    '    ;;',
    '  rmi)',
    '    run_hook "rmi__$2"',
    '    exit_override "rmi__$2"',
    '    ;;',
    '  ps)',
    '    if [ "$2" = "-q" ]; then',
    '      ps_exit "container_ids"',
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
    '    run_hook "$key"',
    '    nth_hook "ps_n__${key}"',
    '    ps_exit "$key"',
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
  mkdirSync(join(scriptsDir, 'lib'), { recursive: true })
  const scriptPath = join(scriptsDir, 'prune-orphaned-docker-volumes.sh')
  cpSync(REAL_SCRIPT_PATH, scriptPath)
  cpSync(REAL_LIB_PATH, join(scriptsDir, '_lib.sh'))
  cpSync(REAL_SPRAWL_LIB_PATH, join(scriptsDir, 'lib', 'report-sprawl-containers.sh'))
  cpSync(REAL_LIFECYCLE_LIB_PATH, join(scriptsDir, 'lib', 'worktree-lifecycle.sh'))
  cpSync(REAL_LIFECYCLE_DOCKER_LIB_PATH, join(scriptsDir, 'lib', 'worktree-lifecycle-docker.sh'))
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

// The canned-response setters live in the sibling .responses.ts (500-line
// gate); re-exported here so existing imports keep working.
export {
  volumeListResponse,
  volumeLabelSequence,
  imagesResponse,
  volumeLabels,
  imageIdFor,
  imageLabels,
  volumePsResponse,
  setVolumeRmExit,
} from './prune-orphaned-docker-volumes.responses.js'

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

// The git-failure shims live in the sibling .shims.ts (500-line gate);
// re-exported here so existing imports keep working.
export {
  breakGitWorktreeList,
  failGitWorktreeListCalls,
  worktreeListCallCount,
} from './prune-orphaned-docker-volumes.shims.js'

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
