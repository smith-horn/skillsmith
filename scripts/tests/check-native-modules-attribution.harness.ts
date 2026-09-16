/**
 * scripts/tests/check-native-modules-attribution.harness.ts
 * SMI-6684 Wave 3 — shared PATH-fake harness for
 * check-native-modules-attribution.test.ts. NOT a *.test.ts file itself
 * (SMI-6684 plan, § Wave 3): no test-only branch in
 * scripts/lib/check-native-modules.sh -- everything here drives the REAL
 * script through PATH-injected fakes, following the
 * scripts/tests/_lib/check-container-deps-fresh-fixtures.sh precedent.
 *
 * What is faked (all generated at runtime here, never committed as
 * fixtures -- only case DATA lives under fixtures/native-attribution/):
 *   - `docker`: merges the prototype's bin/docker (FAKE_DOCKER_RC/SLEEP/HEAD,
 *     scrubbed env on `exec`) with integ/bin/docker's `ps` support
 *     (hook-docker-detect.sh calls `docker ps` for USE_DOCKER detection).
 *   - a curated container PATH (`cbin-*`): symlinks to sh/bash/cat/rm/
 *     mktemp/cp/sleep/node plus a `timeout` shim that records its argv and
 *     execs the rest with no real timing (the fake checker supplies 124
 *     itself via its own `rc` fixture file).
 *   - the checker itself (`app/scripts/lib/check-mount-composition.sh`): a
 *     bash fake that copies FAKE_CASE_DIR's `report`/`report-tmp`/`stdout`/
 *     `nonl`/`rc`/`sleep` files, ported verbatim from the prototype.
 *
 * Binaries are resolved by scanning PATH directories with fs.accessSync
 * (X_OK), never via a shell `command -v` (spec §8.1: a zsh alias for
 * `command -v grep` produced a broken symlink and a false USE_DOCKER=0 in
 * the prototype).
 */
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const SCRIPT = join(__dirname, '..', 'lib', 'check-native-modules.sh')
export const CASES_DIR = join(__dirname, 'fixtures', 'native-attribution', 'cases')

export function resolveBin(name: string): string | undefined {
  const pathEnv = process.env['PATH'] ?? ''
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // keep scanning -- never fall back to `command -v` (spec §8.1)
    }
  }
  return undefined
}

const DOCKER_SH = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG.docker"
case "$1" in
  ps) [ -n "\${FAKE_PS:-}" ] && echo "$FAKE_PS"; exit 0 ;;
  exec) ;;
  *) exit 0 ;;
esac
shift
[ "\${1:-}" = "-w" ] && shift 2
shift
if [ "\${1:-}" = "node" ]; then
  exit "\${FAKE_PROBE_RC:-1}"
fi
if [ -n "\${FAKE_DOCKER_RC:-}" ]; then
  echo "Error response from daemon: fake rc $FAKE_DOCKER_RC" >&2
  exit "$FAKE_DOCKER_RC"
fi
[ -n "\${FAKE_DOCKER_SLEEP:-}" ] && sleep "$FAKE_DOCKER_SLEEP"
cd "$FAKE_APP_DIR" || exit 125
if [ -n "\${FAKE_DOCKER_HEAD:-}" ]; then
  env -i PATH="$FAKE_CONTAINER_PATH" HOME="$HOME" FAKE_CASE_DIR="$FAKE_CASE_DIR" FAKE_LOG="$FAKE_LOG" "$@" | head -n "$FAKE_DOCKER_HEAD"
  exit 0
fi
exec env -i PATH="$FAKE_CONTAINER_PATH" HOME="$HOME" FAKE_CASE_DIR="$FAKE_CASE_DIR" FAKE_LOG="$FAKE_LOG" \${FAKE_CONTAINER_ENV:-} "$@"
`

const TIMEOUT_SH = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG.timeout"
shift
exec "$@"
`

const CHECKER_SH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG.checker"
rep=""; while [ $# -gt 0 ]; do case $1 in --report) rep=$2; shift 2;; *) shift;; esac; done
if [ "\${SKILLSMITH_MOUNT_COMPOSITION_DISABLE:-}" = 1 ]; then echo "[mount-composition] disabled via SKILLSMITH_MOUNT_COMPOSITION_DISABLE=1"; exit 0; fi
[ -f "$FAKE_CASE_DIR/sleep" ] && sleep "$(cat "$FAKE_CASE_DIR/sleep")"
[ -f "$FAKE_CASE_DIR/report" ] && cp "$FAKE_CASE_DIR/report" "$rep"
[ -f "$FAKE_CASE_DIR/report-tmp" ] && cp "$FAKE_CASE_DIR/report-tmp" "$rep.tmp.$$"
[ -f "$FAKE_CASE_DIR/stdout" ] && cat "$FAKE_CASE_DIR/stdout"
[ -f "$FAKE_CASE_DIR/nonl" ] && printf '%s' "$(cat "$FAKE_CASE_DIR/nonl")"
exit "$(cat "$FAKE_CASE_DIR/rc" 2>/dev/null || echo 0)"
`

const CURATED_TOOLS = ['sh', 'bash', 'cat', 'rm', 'mktemp', 'cp', 'sleep', 'node']
const HOST_TOOLS = [
  'git',
  'grep',
  'cut',
  'sed',
  'head',
  'tail',
  'date',
  'kill',
  'sleep',
  'cat',
  'mkdir',
  'rm',
  'env',
  'sh',
  'bash',
  'true',
  'false',
  'wc',
  'dirname',
  'basename',
  'mktemp',
  'tr',
]

function writeExec(path: string, content: string): void {
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

function symlinkTools(dir: string, names: string[]): void {
  for (const name of names) {
    const resolved = resolveBin(name)
    if (resolved && !existsSync(join(dir, name))) {
      symlinkSync(resolved, join(dir, name))
    }
  }
}

export interface Fixtures {
  root: string
  hostBin: string
  hostBinNoMktemp: string
  cbinFull: string
  cbinNoNode: string
  cbinNoTimeout: string
  appDir: string
  appNoCheckerDir: string
  repoDir: string
  cleanup: () => void
}

/** Builds the static scaffold ONCE per describe block (bin/docker, curated
 * container PATH variants, the fake checker, an empty checker-less app
 * root, and a plain non-worktree git repo to run the real script from). */
export function setupFixtures(): Fixtures {
  const root = mkdtempSync(join(tmpdir(), 'nca-attrib-'))
  const hostBin = join(root, 'host-bin')
  const hostBinNoMktemp = join(root, 'host-bin-no-mktemp')
  const cbinFull = join(root, 'cbin-full')
  const cbinNoNode = join(root, 'cbin-nonode')
  const cbinNoTimeout = join(root, 'cbin-notimeout')
  const appDir = join(root, 'app')
  const appNoCheckerDir = join(root, 'app-nochecker')
  const repoDir = join(root, 'repo')

  for (const d of [
    hostBin,
    hostBinNoMktemp,
    cbinFull,
    cbinNoNode,
    cbinNoTimeout,
    appNoCheckerDir,
    repoDir,
  ]) {
    mkdirSync(d, { recursive: true })
  }
  mkdirSync(join(appDir, 'scripts', 'lib'), { recursive: true })

  writeExec(join(hostBin, 'docker'), DOCKER_SH)
  writeExec(join(hostBinNoMktemp, 'docker'), DOCKER_SH)
  symlinkTools(hostBin, HOST_TOOLS)
  symlinkTools(
    hostBinNoMktemp,
    HOST_TOOLS.filter((t) => t !== 'mktemp')
  )

  symlinkTools(cbinFull, CURATED_TOOLS)
  writeExec(join(cbinFull, 'timeout'), TIMEOUT_SH)

  symlinkTools(
    cbinNoNode,
    CURATED_TOOLS.filter((t) => t !== 'node')
  )
  writeExec(join(cbinNoNode, 'timeout'), TIMEOUT_SH)

  symlinkTools(cbinNoTimeout, CURATED_TOOLS) // no `timeout` shim -- that's the point

  writeExec(join(appDir, 'scripts', 'lib', 'check-mount-composition.sh'), CHECKER_SH)

  const git = resolveBin('git') ?? 'git'
  spawnSync(git, ['init', '-q'], { cwd: repoDir })
  spawnSync(git, ['config', 'user.email', 't@t.example'], { cwd: repoDir })
  spawnSync(git, ['config', 'user.name', 'test'], { cwd: repoDir })
  writeFileSync(join(repoDir, 'f'), 'x')
  spawnSync(git, ['add', 'f'], { cwd: repoDir })
  spawnSync(git, ['commit', '-q', '-m', 'init'], { cwd: repoDir })

  return {
    root,
    hostBin,
    hostBinNoMktemp,
    cbinFull,
    cbinNoNode,
    cbinNoTimeout,
    appDir,
    appNoCheckerDir,
    repoDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** Stages CASES_DIR/<caseId>'s provenance-prefixed files into a fresh temp
 * dir under plain names (report/report-tmp/stdout/rc/nonl/sleep) -- the
 * fake checker script (above) is an unmodified port of the prototype's,
 * which expects plain names. Exported so a test that needs a MODIFIED case
 * (e.g. T-OLDFAIL's reworded FAIL string) can stage into a scratch dir
 * without ever writing inside the committed fixtures tree. */
export function stageCase(root: string, caseId: string): string {
  const src = join(CASES_DIR, caseId)
  const dest = mkdtempSync(join(root, 'case-'))
  if (existsSync(src)) {
    for (const entry of readdirSync(src)) {
      const m = entry.match(/^(real-paired|real|derived|synthetic)-(.+)$/)
      if (!m) continue
      cpSync(join(src, entry), join(dest, m[2]))
    }
  }
  return dest
}

export interface RunOpts {
  fakePs?: string
  fakeProbeRc?: string
  fakeDockerRc?: string
  fakeDockerSleep?: string
  fakeDockerHead?: string
  fakeContainerEnv?: string
  cbin?: string
  appDir?: string
  hostBin?: string
  env?: Record<string, string>
  home?: string
  devnull?: boolean
  /** Reader closes the pipe immediately -- SIGPIPE scope guard (I-SIGPIPE). */
  closeStdoutImmediately?: boolean
  /** Reader consumes N lines then closes -- SIGPIPE mid-attribution (R-PIPE). */
  closeStdoutAfterLines?: number
}

export interface RunResult {
  status: number
  stdout: string
  stderr: string
  home: string
  execCount: number
  dockerLog: string[]
  timeoutLog: string[]
  checkerLog: string[]
}

export function runCase(fx: Fixtures, caseId: string, opts: RunOpts = {}): RunResult {
  const caseDir = stageCase(fx.root, caseId)
  return runFromCaseDir(fx, caseDir, opts)
}

/** Same as runCase(), but takes an already-staged (plain-named) case dir
 * directly -- for a test that needs to modify a case's content first
 * (T-OLDFAIL) without ever writing inside the committed fixtures tree. */
export function runFromCaseDir(fx: Fixtures, caseDir: string, opts: RunOpts = {}): RunResult {
  const logBase = join(fx.root, `log-${Math.random().toString(36).slice(2)}`)
  const home = opts.home ?? mkdtempSync(join(fx.root, 'home-'))
  const cbin = opts.cbin ?? fx.cbinFull
  const appDir = opts.appDir ?? fx.appDir
  const hostBin = opts.hostBin ?? fx.hostBin

  const env: NodeJS.ProcessEnv = {
    PATH: `${hostBin}:${process.env['PATH'] ?? ''}`,
    HOME: home,
    FAKE_LOG: logBase,
    FAKE_APP_DIR: appDir,
    FAKE_CASE_DIR: caseDir,
    FAKE_CONTAINER_PATH: cbin,
    FAKE_PS: opts.fakePs ?? 'skillsmith-dev-1',
    FAKE_PROBE_RC: opts.fakeProbeRc ?? '1',
    ...(opts.fakeDockerRc !== undefined ? { FAKE_DOCKER_RC: opts.fakeDockerRc } : {}),
    ...(opts.fakeDockerSleep !== undefined ? { FAKE_DOCKER_SLEEP: opts.fakeDockerSleep } : {}),
    ...(opts.fakeDockerHead !== undefined ? { FAKE_DOCKER_HEAD: opts.fakeDockerHead } : {}),
    ...(opts.fakeContainerEnv !== undefined ? { FAKE_CONTAINER_ENV: opts.fakeContainerEnv } : {}),
    ...opts.env,
  }

  const shBin = resolveBin('sh') ?? '/bin/sh'

  if (opts.closeStdoutAfterLines !== undefined) {
    // A reader that consumes exactly N lines then closes -- unlike
    // closeStdoutImmediately (0 lines), this lets the frame header through
    // so the SIGPIPE lands INSIDE the attribution subshell's own nca_render
    // printf calls (R-PIPE, F-11/F-12). Same FIFO-based rationale as
    // closeStdoutImmediately below: a real pipeline's own exit status is its
    // LAST command's, so `head` must be the process whose rc/stderr we read.
    const fifoDir = mkdtempSync(join(fx.root, 'fifo-'))
    const fifo = join(fifoDir, 'out')
    const rcFile = join(fifoDir, 'rc')
    const errFile = join(fifoDir, 'err')
    const wrapper = [
      'mkfifo "$1"',
      '("$2" "$3" >"$1" 2>"$5"; echo $? >"$4") &',
      'wpid=$!',
      'head -n "$6" <"$1" >/dev/null',
      'wait "$wpid"',
    ].join('\n')
    spawnSync(
      shBin,
      [
        '-c',
        wrapper,
        'wrapper',
        fifo,
        shBin,
        SCRIPT,
        rcFile,
        errFile,
        String(opts.closeStdoutAfterLines),
      ],
      { cwd: fx.repoDir, env, encoding: 'utf8', timeout: 20_000 }
    )
    let status = -1
    try {
      status = Number(readFileSync(rcFile, 'utf8').trim())
    } catch {
      // rcFile missing means the wrapper itself never completed -- status stays -1
    }
    const stderr = existsSync(errFile) ? readFileSync(errFile, 'utf8') : ''
    return finishResult(
      { status, stdout: '', stderr } as ReturnType<typeof spawnSync>,
      logBase,
      home
    )
  }

  if (opts.closeStdoutImmediately) {
    // A real FIFO whose reader opens and closes at once (I-SIGPIPE, spec
    // §6.3). A `sh SCRIPT | true` pipeline is NOT equivalent: (a) a
    // pipeline's own exit status is its LAST command's (POSIX), which
    // would always read 0 regardless of what happened to SCRIPT -- the
    // exact "never conclude from truncated output" trap -- and (b) with a
    // real pipe the writer can finish entirely inside the kernel pipe
    // buffer before the reader is even scheduled, so SIGPIPE may never
    // fire at all. Opening a FIFO for writing blocks until a reader
    // appears; once that reader opens and immediately closes, the writer's
    // very first write hits a reader-less FIFO and SIGPIPEs deterministically.
    const fifoDir = mkdtempSync(join(fx.root, 'fifo-'))
    const fifo = join(fifoDir, 'out')
    const rcFile = join(fifoDir, 'rc')
    const wrapper = [
      'mkfifo "$1"',
      '("$2" "$3" >"$1" 2>&1; echo $? >"$4") &',
      'wpid=$!',
      ': <"$1"',
      'wait "$wpid"',
    ].join('\n')
    spawnSync(shBin, ['-c', wrapper, 'wrapper', fifo, shBin, SCRIPT, rcFile], {
      cwd: fx.repoDir,
      env,
      encoding: 'utf8',
      timeout: 20_000,
    })
    let status = -1
    try {
      status = Number(readFileSync(rcFile, 'utf8').trim())
    } catch {
      // rcFile missing means the wrapper itself never completed -- status stays -1
    }
    return finishResult(
      { status, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>,
      logBase,
      home
    )
  }

  const r = spawnSync(shBin, [SCRIPT], {
    cwd: fx.repoDir,
    env,
    stdio: opts.devnull ? ['ignore', 'ignore', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 20_000,
  })
  return finishResult(r, logBase, home)
}

function finishResult(r: ReturnType<typeof spawnSync>, logBase: string, home: string): RunResult {
  const readLog = (suffix: string): string[] => {
    try {
      return readFileSync(`${logBase}${suffix}`, 'utf8').split('\n').filter(Boolean)
    } catch {
      return []
    }
  }
  const dockerLog = readLog('.docker')
  const checkerLog = readLog('.checker')
  return {
    status: r.status ?? -1,
    stdout: (r.stdout as string) ?? '',
    stderr: (r.stderr as string) ?? '',
    home,
    execCount: dockerLog.filter((l) => l.startsWith('exec ')).length,
    dockerLog,
    timeoutLog: readLog('.timeout'),
    checkerLog,
  }
}

export interface ParsedAttribution {
  state: string
  mismatch: boolean
  cause: string
  detail: string
  evidence: string
  tier: 0 | 1 | 2
}

// Stable grep contract, spec §5.2.
const GREP_CONTRACT =
  /^ {2}Mount check: (CLEAN|PARTIAL|FINDINGS|FINDINGS \+ PARTIAL|UNAVAILABLE|TIMEOUT|UNEXPECTED|MALFORMED|NO-REPORT|OFF)(, REPORT\/OUTPUT MISMATCH)? -- cause: ([A-Z-]+) \[(.*)]$/m

const EVIDENCE_CAUSES = [
  'FALL-THROUGH',
  'MOUNT-MISSING',
  'MOUNT-SUBSTITUTED',
  'SEED-CONTENT',
  'OTHER-NATIVE-FINDING',
]

export function parseAttribution(stdout: string): ParsedAttribution | undefined {
  const m = GREP_CONTRACT.exec(stdout)
  if (!m) return undefined
  const [, state, mismatchFlag, cause, detail] = m
  const lines = stdout.split('\n')
  const idx = lines.findIndex((l) => l.startsWith(`  Mount check: ${state}`))
  const l2 = idx >= 0 ? (lines[idx + 1] ?? '') : ''
  let evidence = ''
  let tier: 0 | 1 | 2 = 0
  if (EVIDENCE_CAUSES.includes(cause)) {
    tier = l2.includes('(root copy)') ? 2 : 1
    const stripped = l2.replace(/ \(from partial output\)$/, '')
    const parts = stripped.split(': ')
    evidence = parts[parts.length - 1] ?? ''
  }
  return { state, mismatch: !!mismatchFlag, cause, detail, evidence, tier }
}
