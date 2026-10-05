/**
 * Shared harness for the dependency-registry-expiry.yml tests (SMI-6949 R1-L4, SMI-6954):
 * parses the workflow and EXECUTES its script with stub `node`, `npm` and `gh`, so the
 * issue dedup, close-when-clean and seed-loop behaviour is observed, not just spelled.
 * The script uses GNU sed escapes (ubuntu runner); tests run in the Linux container.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const WORKFLOW = join(REPO_ROOT, '.github/workflows/dependency-registry-expiry.yml')
const require = createRequire(import.meta.url)
interface Step {
  name?: string
  uses?: string
  run?: string
  shell?: string
}
export interface Doc {
  name: string
  on: { schedule?: Array<{ cron: string }>; workflow_dispatch?: unknown }
  permissions: Record<string, string>
  jobs: Record<string, { steps: Step[]; env?: Record<string, string> }>
}
const yaml = require('js-yaml') as { load: (t: string) => Doc }
export const doc = (): Doc => yaml.load(readFileSync(WORKFLOW, 'utf8'))
export const scriptStep = (): Step => {
  const steps = Object.values(doc().jobs)[0].steps.filter((s) =>
    s.run?.includes('check-dependency-registry')
  )
  expect(steps).toHaveLength(1)
  return steps[0]
}
export const script = (): string => scriptStep().run as string
/**
 * The runner's own invocation of a `run:` step with no `shell:` on Linux is `bash -e {0}`
 * (the run log prints `shell: /usr/bin/bash -e {0}`). The harness runs the script the same way,
 * from a file, so a script that only works with -e off (SMI-6993) is caught here, not in prod.
 */
export const RUNNER_BASH_ARGS = ['-e']

/**
 * Errexit trace (SMI-6996). Every executed run is prefixed with three lines: `set -T` (so the DEBUG
 * trap also fires inside shell functions and command substitutions), a DEBUG trap recording
 * `$-:$LINENO:$BASH_SUBSHELL:FUNCNAME` before each command, and an EXIT trap recording the final
 * `$-`. A depth-0 entry whose flags lack `e` means the `e` flag was clear for a command the script
 * ran at its own level. Entries at depth > 0 are exempt: bash runs command substitutions without
 * -e, and although a `( ... )` subshell inherits -e, the depth field cannot tell the two apart.
 * The flag is not the whole story: bash also IGNORES -e, while `$-` still shows `e`, inside a
 * function, brace group or subshell on the left of `||` or `&&`, in an `if`/`while` condition, and
 * after `!` (measured, bash 5.2.15). So `do_seeds || SREC=$?` would silently disable -e for the
 * whole function body and this trace would not see it. `exec` asserts the depth-0 invariant on
 * every run unless `allowErrexitOff` is set (the known-positive controls).
 */
export const EE_PREFIX_LINES = 3
const EE_PREFIX = [
  'set -T',
  `trap 'printf "%s:%s:%s:%s\\n" "$-" "$LINENO" "$BASH_SUBSHELL" "\${FUNCNAME[0]:-main}" >> "$EE_TRACE"' DEBUG`,
  `trap 'printf "%s" "$-" > "$EE_END"' EXIT`,
  '',
].join('\n')
export interface TraceEntry {
  flags: string
  /** The script line, mapped back through the prefix. */
  line: number
  depth: number
  func: string
}

export interface AuditStub {
  out?: string
  /** npm audit's own exit status. Default mirrors real npm: 0 only for an empty report, else 1. */
  rc?: number
  rec?: string
  recRc?: number
}
/** The seed loop: `--list-seeds` output and status, and each seed's audit and reconcile. */
export interface SeedStub {
  list?: string
  listRc?: number
  /** What `--list-seeds` prints to stderr (its failure cause). */
  listErr?: string
  auditOut?: string
  /** The seed's npm audit exit status; same default as AuditStub.rc. */
  auditRc?: number
  rec?: string
  recRc?: number
}

// Calls are told apart by their flags; every other node call is the expiry check.
const NODE_STUB = `#!/bin/bash
case " $* " in
  *" --list-seeds "*) printf '%s' "$STUB_LIST_ERR" >&2; printf '%s' "$STUB_SEEDS"; exit "$STUB_LIST_RC" ;;
  *" --seed "*) echo "$*" >> "$NODE_LOG"; printf '%s' "$STUB_SEED_REC_OUT"; exit "$STUB_SEED_REC_RC" ;;
  *" --reconcile-audit "*) echo "$*" >> "$NODE_LOG"; printf '%s' "$STUB_REC_OUT"; exit "$STUB_REC_RC" ;;
esac
cat "$STUB_NODE_OUT"
exit "$STUB_NODE_RC"
`
// npm audit: the root audit runs from the repo root, a seed audit from the seed's directory.
const NPM_STUB = `#!/bin/bash
echo "$*" >> "$NODE_LOG"
echo "$PWD" >> "$NPM_CWD_LOG"
if [ "$PWD" = "$STUB_ROOT" ]; then printf '%s' "$STUB_AUDIT_OUT"; exit "$STUB_AUDIT_RC"; fi
printf '%s' "$STUB_SEED_AUDIT_OUT"; exit "$STUB_SEED_AUDIT_RC"
`
const GH_STUB = `#!/bin/bash
echo "$*" >> "$GH_LOG"
if [ "$1 $2" = "$STUB_GH_FAIL" ]; then echo "stub gh: $1 $2 failed" >&2; exit 1; fi
prev=""
for a in "$@"; do
  if [ "$prev" = "--body-file" ]; then cp "$a" "$GH_BODY"; fi
  prev="$a"
done
case "$1 $2" in
  "issue list") printf '%s\\n' "$STUB_EXISTING" ;;
  "issue create") echo https://github.com/o/r/issues/99 ;;
esac
exit 0
`
/**
 * Opt-in: a sed that fails when one of its arguments names the file ending in $STUB_SED_FAIL_ON,
 * and logs that it did, so a test can prove the injected failure fired. Every other sed call
 * runs the real sed.
 */
const SED_STUB = `#!/bin/bash
for a in "$@"; do
  case "$a" in *"$STUB_SED_FAIL_ON") echo "$a" >> "$SED_LOG"; exit 4 ;; esac
done
exec /bin/sed "$@"
`
const EMPTY_AUDIT = '{"auditReportVersion":2,"vulnerabilities":{}}'
/** A report with an advisory, as npm prints it; npm exits 1 whenever it finds one. */
export const FINDINGS_AUDIT =
  '{"auditReportVersion":2,"vulnerabilities":{"pkg":{"name":"pkg","severity":"high"}}}'
/** Real npm audit exits 0 only for a clean report; findings, and a crash with no output, exit 1. */
const npmRc = (out: string): number => (out === EMPTY_AUDIT ? 0 : 1)

export function exec(
  nodeOut: string,
  nodeRc: number,
  existing = '',
  ghFail = '',
  audit: AuditStub = {},
  seed: SeedStub = {},
  opts: {
    sedFailOn?: string
    /** Rewrites the script before it runs (the known-positive errexit controls). */
    transform?: (script: string) => string
    /** Skip the errexit assertions: the run is a deliberate known-positive control. */
    allowErrexitOff?: boolean
  } = {}
) {
  const auditOut = audit.out ?? EMPTY_AUDIT
  const seedAuditOut = seed.auditOut ?? EMPTY_AUDIT
  const dir = mkdtempSync(join(tmpdir(), 'smi6949-expiry-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const nodeOutFile = join(dir, 'node.out')
  const ghLog = join(dir, 'gh.log')
  const ghBody = join(dir, 'gh.body')
  const nodeLog = join(dir, 'node.log')
  const npmCwdLog = join(dir, 'npm-cwd.log')
  const sedLog = join(dir, 'sed.log')
  const eeTrace = join(dir, 'errexit.trace')
  const eeEnd = join(dir, 'errexit.end')
  writeFileSync(nodeOutFile, nodeOut)
  for (const f of [ghLog, nodeLog, npmCwdLog, sedLog, eeTrace]) writeFileSync(f, '')
  const stubs: [string, string][] = [
    ['node', NODE_STUB],
    ['npm', NPM_STUB],
    ['gh', GH_STUB],
  ]
  if (opts.sedFailOn) stubs.push(['sed', SED_STUB])
  for (const [name, body] of stubs) {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  const scriptFile = join(dir, 'step.sh')
  writeFileSync(scriptFile, EE_PREFIX + (opts.transform ? opts.transform(script()) : script()))
  const r = spawnSync('bash', [...RUNNER_BASH_ARGS, scriptFile], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RUNNER_TEMP: dir,
      ISSUE_LABEL: 'dependency-registry-expiry',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_RUN_ID: '123',
      STUB_ROOT: REPO_ROOT,
      STUB_NODE_OUT: nodeOutFile,
      STUB_NODE_RC: String(nodeRc),
      STUB_AUDIT_OUT: auditOut,
      STUB_AUDIT_RC: String(audit.rc ?? npmRc(auditOut)),
      STUB_REC_OUT: audit.rec ?? '',
      STUB_REC_RC: String(audit.recRc ?? 0),
      STUB_SEEDS: seed.list ?? '',
      STUB_LIST_RC: String(seed.listRc ?? 0),
      STUB_LIST_ERR: seed.listErr ?? '',
      STUB_SEED_AUDIT_OUT: seedAuditOut,
      STUB_SEED_AUDIT_RC: String(seed.auditRc ?? npmRc(seedAuditOut)),
      STUB_SEED_REC_OUT: seed.rec ?? '',
      STUB_SEED_REC_RC: String(seed.recRc ?? 0),
      NODE_LOG: nodeLog,
      NPM_CWD_LOG: npmCwdLog,
      STUB_EXISTING: existing,
      STUB_GH_FAIL: ghFail,
      GH_LOG: ghLog,
      GH_BODY: ghBody,
      STUB_SED_FAIL_ON: opts.sedFailOn ?? '',
      SED_LOG: sedLog,
      EE_TRACE: eeTrace,
      EE_END: eeEnd,
    },
  })
  const lines = (f: string) => readFileSync(f, 'utf8').split('\n').filter(Boolean)
  const body = existsSync(ghBody) ? readFileSync(ghBody, 'utf8') : ''
  const trace: TraceEntry[] = lines(eeTrace).map((l) => {
    const [flags, line, depth, func] = l.split(':')
    return { flags, line: Number(line) - EE_PREFIX_LINES, depth: Number(depth), func }
  })
  const errexitOff = trace.filter((e) => e.depth === 0 && !e.flags.includes('e'))
  const subshellOff = trace.filter((e) => e.depth > 0 && !e.flags.includes('e'))
  const endFlags = existsSync(eeEnd) ? readFileSync(eeEnd, 'utf8') : undefined
  if (!opts.allowErrexitOff) {
    expect(trace.length).toBeGreaterThan(0) // presence: the trace was recorded
    expect(endFlags).toBeDefined() // presence: the EXIT trap ran
    expect(errexitOff).toEqual([])
  }
  return {
    trace,
    errexitOff,
    subshellOff,
    endFlags,
    status: r.status,
    calls: lines(ghLog),
    body,
    stderr: r.stderr,
    stdout: r.stdout,
    nodeCalls: lines(nodeLog),
    npmCwds: lines(npmCwdLog),
    sedFailures: lines(sedLog),
  }
}
/**
 * The text of an issue-body section: from its `### ` heading line up to the next `### ` or `Run:`
 * line. `undefined` when the heading is absent, so a missing section is never an empty match.
 */
export function section(body: string, heading: string): string | undefined {
  const lines = body.split('\n')
  const start = lines.indexOf(heading)
  if (start < 0) return undefined
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('### ') || lines[i].startsWith('Run:')) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}
export const verbs = (calls: string[]) => calls.map((c) => c.split(' ').slice(0, 2).join(' '))
