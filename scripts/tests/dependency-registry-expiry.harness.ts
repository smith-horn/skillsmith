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
}
export interface Doc {
  name: string
  on: { schedule?: Array<{ cron: string }>; workflow_dispatch?: unknown }
  permissions: Record<string, string>
  jobs: Record<string, { steps: Step[]; env?: Record<string, string> }>
}
const yaml = require('js-yaml') as { load: (t: string) => Doc }
export const doc = (): Doc => yaml.load(readFileSync(WORKFLOW, 'utf8'))
export const script = (): string => {
  const steps = Object.values(doc().jobs)[0].steps.filter((s) =>
    s.run?.includes('check-dependency-registry')
  )
  expect(steps).toHaveLength(1)
  return steps[0].run as string
}

export interface AuditStub {
  out?: string
  rec?: string
  recRc?: number
}
/** The seed loop: `--list-seeds` output and status, and each seed's audit and reconcile. */
export interface SeedStub {
  list?: string
  listRc?: number
  auditOut?: string
  rec?: string
  recRc?: number
}

// Calls are told apart by their flags; every other node call is the expiry check.
const NODE_STUB = `#!/bin/bash
case " $* " in
  *" --list-seeds "*) printf '%s' "$STUB_SEEDS"; exit "$STUB_LIST_RC" ;;
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
if [ "$PWD" = "$STUB_ROOT" ]; then printf '%s' "$STUB_AUDIT_OUT"; else printf '%s' "$STUB_SEED_AUDIT_OUT"; fi
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
const EMPTY_AUDIT = '{"auditReportVersion":2,"vulnerabilities":{}}'

export function exec(
  nodeOut: string,
  nodeRc: number,
  existing = '',
  ghFail = '',
  audit: AuditStub = {},
  seed: SeedStub = {}
) {
  const dir = mkdtempSync(join(tmpdir(), 'smi6949-expiry-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const nodeOutFile = join(dir, 'node.out')
  const ghLog = join(dir, 'gh.log')
  const ghBody = join(dir, 'gh.body')
  const nodeLog = join(dir, 'node.log')
  const npmCwdLog = join(dir, 'npm-cwd.log')
  writeFileSync(nodeOutFile, nodeOut)
  for (const f of [ghLog, nodeLog, npmCwdLog]) writeFileSync(f, '')
  for (const [name, body] of [
    ['node', NODE_STUB],
    ['npm', NPM_STUB],
    ['gh', GH_STUB],
  ]) {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  const r = spawnSync('bash', ['-c', script()], {
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
      STUB_AUDIT_OUT: audit.out ?? EMPTY_AUDIT,
      STUB_REC_OUT: audit.rec ?? '',
      STUB_REC_RC: String(audit.recRc ?? 0),
      STUB_SEEDS: seed.list ?? '',
      STUB_LIST_RC: String(seed.listRc ?? 0),
      STUB_SEED_AUDIT_OUT: seed.auditOut ?? EMPTY_AUDIT,
      STUB_SEED_REC_OUT: seed.rec ?? '',
      STUB_SEED_REC_RC: String(seed.recRc ?? 0),
      NODE_LOG: nodeLog,
      NPM_CWD_LOG: npmCwdLog,
      STUB_EXISTING: existing,
      STUB_GH_FAIL: ghFail,
      GH_LOG: ghLog,
      GH_BODY: ghBody,
    },
  })
  const lines = (f: string) => readFileSync(f, 'utf8').split('\n').filter(Boolean)
  const body = existsSync(ghBody) ? readFileSync(ghBody, 'utf8') : ''
  return {
    status: r.status,
    calls: lines(ghLog),
    body,
    stderr: r.stderr,
    stdout: r.stdout,
    nodeCalls: lines(nodeLog),
    npmCwds: lines(npmCwdLog),
  }
}
export const verbs = (calls: string[]) => calls.map((c) => c.split(' ').slice(0, 2).join(' '))
