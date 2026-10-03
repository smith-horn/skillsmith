/**
 * SMI-6949: shared harness for scripts/tests/npm-audit-gate.test.ts.
 *
 * The helper under test (scripts/ci/npm-audit-gate.sh) is always the REAL file.
 * `npm` is replaced by a PATH shim: either a canned-output shim (fixed text and
 * exit code, argv recorded) or a config-honouring stand-in (STANDIN_NPM below)
 * that models how ambient npm config changes the audited result, so a missing
 * pin flag produces a different, observable result instead of just a different
 * argv. The fixture texts are the MEASURED npm 10.9.7 / 10.9.8 outputs recorded
 * in the SMI-6949 Step 0 measurements.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const HELPER = join(REPO_ROOT, 'scripts/ci/npm-audit-gate.sh')
export const PRE_PUSH = join(REPO_ROOT, 'scripts/pre-push-check.sh')
export const CI_YML = join(REPO_ROOT, '.github/workflows/ci.yml')

export const PINNED_ARGV = [
  'audit',
  '--audit-level=high',
  '--omit=dev',
  '--include=prod',
  '--no-json',
  '--offline=false',
  '--prefer-offline=false',
  '--registry=https://registry.npmjs.org',
  '--workspaces=true',
  '--include-workspace-root=true',
  '--userconfig=/dev/null',
]

export const FIX_CLEAN = 'found 0 vulnerabilities\n'
export const FIX_SINGLE = `# npm audit report

minimist  <=0.2.3
Severity: critical
Prototype Pollution in minimist - https://github.com/advisories/GHSA-vh95-rmgr-6w4m
fix available via \`npm audit fix --force\`
Will install minimist@1.2.8, which is a breaking change
node_modules/minimist

1 critical severity vulnerability

To address all issues (including breaking changes), run:
  npm audit fix --force
`
export const FIX_MIXED_SUMMARY = '3 vulnerabilities (1 high, 2 critical)'
export const FIX_MIXED = `# npm audit report

lodash  <=4.17.23
Severity: critical
Command Injection in lodash - https://github.com/advisories/GHSA-35jh-r3h4-6jhm
node_modules/lodash

node-fetch  <=2.6.6
Severity: high
node-fetch forwards secure headers to untrusted sites - https://github.com/advisories/GHSA-r683-j2x4-v87g
node_modules/node-fetch

${FIX_MIXED_SUMMARY}

To address all issues (including breaking changes), run:
  npm audit fix --force
`
export const FIX_UNREACHABLE = `npm warn audit request to http://127.0.0.1:1/-/npm/v1/security/audits/quick failed, reason: connect ECONNREFUSED 127.0.0.1:1
undefined
npm error audit endpoint returned an error
npm error A complete log of this run can be found in: /root/.npm/_logs/2026-10-03T22_23_27_507Z-debug-0.log
`
/** No summary line, no npm-prefixed network line; an ADVISORY TITLE says "fetch failed". */
export const FIX_TITLE_FETCH_FAILED = `# npm audit report

somepkg  <=1.0.0
Severity: critical
Handler fetch failed to validate request origin - https://github.com/advisories/GHSA-aaaa-bbbb-cccc
node_modules/somepkg
`
export const FIX_UNRECOGNISED = 'npm error something entirely new went wrong\n'

export interface GateResult {
  status: number | null
  stdout: string
  stderr: string
  all: string
  finalLine: string
  argv: string[]
}

export function scratchDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `smi6949-${label}-`))
}

const CANNED_SHIM = `#!/bin/bash
printf '%s\\n' "$@" > "$SHIM_ARGV"
cat "$SHIM_OUT"
exit "$SHIM_RC"
`

/** Stand-in npm that honours ambient config (see file header). */
export const STANDIN_NPM = `#!${process.execPath}
const fs = require('fs')
const argv = process.argv.slice(2)
fs.writeFileSync(process.env.SHIM_ARGV, argv.join('\\n') + '\\n')
const cli = (n) => {
  let v
  for (const a of argv) {
    if (a === '--' + n) v = 'true'
    else if (a.startsWith('--' + n + '=')) v = a.slice(n.length + 3)
    else if (a === '--no-' + n) v = 'false'
  }
  return v
}
const envGet = (n) => {
  for (const k of Object.keys(process.env)) if (k.toLowerCase() === 'npm_config_' + n.replace(/-/g, '_')) return process.env[k]
}
const readRc = (file) => {
  const out = {}
  try {
    for (const l of fs.readFileSync(file, 'utf8').split('\\n')) {
      const m = l.match(/^([a-z-]+)=(.*)$/)
      if (m) out[m[1]] = m[2]
    }
  } catch {}
  return out
}
const userRcPath = cli('userconfig') !== undefined ? cli('userconfig') : envGet('userconfig')
const userRc = userRcPath ? readRc(userRcPath) : {}
const projectRc = readRc(process.cwd() + '/.npmrc')
const get = (n) => {
  for (const v of [cli(n), envGet(n), projectRc[n], userRc[n]]) if (v !== undefined) return v
}
if (get('offline') === 'true') { console.log('found 0 vulnerabilities'); process.exit(0) }
if (!String(get('registry') || 'https://registry.npmjs.org').startsWith('https://registry.npmjs.org')) {
  console.log('npm warn audit request to ' + get('registry') + ' failed, reason: connect ECONNREFUSED 127.0.0.1:1')
  console.log('npm error audit endpoint returned an error')
  process.exit(1)
}
const ws = get('workspace')
const wsAll = get('workspaces')
const root = get('include-workspace-root')
let audited
if (cli('workspaces') === 'true' && cli('include-workspace-root') === 'true') audited = ws ? ['root', ws] : ['root', 'packages/a', 'packages/b']
else if (ws) audited = [ws]
else if (wsAll === 'true') audited = root === 'true' ? ['root', 'packages/a', 'packages/b'] : ['packages/a', 'packages/b']
else if (wsAll === 'false') audited = ['root']
else audited = ['root', 'packages/a', 'packages/b']
const advisories = []
if (audited.includes('root')) advisories.push('critical')
if (audited.includes('packages/b')) advisories.push('high')
if (String(get('include') || '').includes('dev')) advisories.push('critical')
if (get('json') === 'true') { console.log('{"vulnerabilities": {}}'); process.exit(1) }
if (advisories.length === 0) { console.log('found 0 vulnerabilities'); process.exit(0) }
const sevs = [...new Set(advisories)]
if (sevs.length === 1) console.log(advisories.length + ' ' + sevs[0] + ' severity vulnerabilit' + (advisories.length === 1 ? 'y' : 'ies'))
else {
  const n = (s) => advisories.filter((x) => x === s).length
  console.log(advisories.length + ' vulnerabilities (' + n('high') + ' high, ' + n('critical') + ' critical)')
}
process.exit(1)
`

export interface RunOpts {
  bash?: string
  out?: string
  rc?: number
  /** replaces the canned shim with a custom npm script body */
  npmScript?: string
  env?: Record<string, string>
  /** files written into the working directory (e.g. a project .npmrc) */
  cwdFiles?: Record<string, string>
  /** run with a PATH that has grep but NO npm */
  noNpm?: boolean
  helperPath?: string
}

/** Runs the helper with a PATH shim for npm and returns exit status, output and recorded argv. */
export function runGate(opts: RunOpts = {}): GateResult {
  const dir = scratchDir('gate')
  const bin = join(dir, 'bin')
  const work = join(dir, 'work')
  mkdirSync(bin)
  mkdirSync(work)
  const argvFile = join(dir, 'argv.txt')
  const outFile = join(dir, 'out.txt')
  writeFileSync(outFile, opts.out ?? '')
  if (opts.noNpm) {
    const grep = spawnSync('sh', ['-c', 'command -v grep'], { encoding: 'utf8' }).stdout.trim()
    mkdirSync(join(dir, 'nonpm'))
    writeFileSync(join(dir, 'nonpm', 'grep'), `#!/bin/sh\nexec ${grep} "$@"\n`)
    chmodSync(join(dir, 'nonpm', 'grep'), 0o755)
  } else {
    writeFileSync(join(bin, 'npm'), opts.npmScript ?? CANNED_SHIM)
    chmodSync(join(bin, 'npm'), 0o755)
  }
  for (const [name, body] of Object.entries(opts.cwdFiles ?? {}))
    writeFileSync(join(work, name), body)
  const basePath = opts.noNpm ? join(dir, 'nonpm') : `${bin}:${process.env.PATH ?? ''}`
  // absolute bash: the noNpm PATH deliberately holds only grep
  const defaultBash = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim()
  const r = spawnSync(opts.bash ?? defaultBash, [opts.helperPath ?? HELPER], {
    cwd: work,
    encoding: 'utf8',
    env: {
      PATH: basePath,
      HOME: dir,
      SHIM_ARGV: argvFile,
      SHIM_OUT: outFile,
      SHIM_RC: String(opts.rc ?? 0),
      ...opts.env,
    },
  })
  const all = `${r.stdout}${r.stderr}`
  const lines = r.stdout.split('\n').filter((l) => l.length > 0)
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    all,
    finalLine: lines[lines.length - 1] ?? '',
    argv: existsSync(argvFile) ? readFileSync(argvFile, 'utf8').split('\n').filter(Boolean) : [],
  }
}

export const START_MARK = '# >>> CHECK2-AUDIT-POLICY'
export const END_MARK = '# <<< CHECK2-AUDIT-POLICY'

/** The CHECK 2 policy block of pre-push-check.sh, between its marker comments. */
export function extractPolicyBlock(file = PRE_PUSH): string {
  const text = readFileSync(file, 'utf8')
  const a = text.indexOf(START_MARK)
  const b = text.indexOf(END_MARK)
  if (a < 0 || b < 0 || b <= a) return ''
  return text.slice(a, b)
}

/** Executes the extracted policy block with a given helper status and output. */
export function runPolicyBlock(status: number, output: string, file = PRE_PUSH) {
  const block = extractPolicyBlock(file)
  const script = [
    "RED=''; GREEN=''; YELLOW=''; NC=''; USE_DOCKER=1; IS_WORKTREE=1; DOCKER_CONTAINER=c",
    'unset CHECKS_FAILED',
    block,
    'echo "CHECKS_FAILED=${CHECKS_FAILED-unset}"',
  ].join('\n')
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    // $(...) strips trailing newlines in the real call site; mimic that here.
    env: {
      PATH: process.env.PATH ?? '',
      AUDIT_STATUS: String(status),
      AUDIT_OUTPUT: output.replace(/\n+$/, ''),
    },
  })
  // AUDIT_STATUS/AUDIT_OUTPUT arrive via env; the block reads them as shell vars.
  const checksFailed = /CHECKS_FAILED=(\S+)/.exec(r.stdout)?.[1] ?? 'no-line'
  return { status: r.status, out: `${r.stdout}${r.stderr}`, checksFailed }
}
