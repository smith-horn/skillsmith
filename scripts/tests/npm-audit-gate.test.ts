/**
 * SMI-6949: scripts/ci/npm-audit-gate.sh and its two call sites.
 *
 * T-numbers refer to the Test Plan in
 * docs/internal/implementation/smi-6949-audit-gate-and-dependency-registry-enforcement.md.
 * Every assertion here was driven RED by a declared mutation (redtests log in the
 * PR); T9, T10 and the static halves are reads of files, so they pin the SPELLING
 * of the delegation, not an executed push. T11/T22/T27 execute the extracted
 * CHECK 2 policy block, not a real `git push`.
 *
 * T1-T5 run under every distinct bash on this machine (macOS host fallback is
 * /bin/bash 3.2; the container has 5.2).
 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CI_YML,
  FIX_CLEAN,
  FIX_MIXED,
  FIX_MIXED_SUMMARY,
  FIX_SINGLE,
  FIX_TITLE_FETCH_FAILED,
  FIX_UNRECOGNISED,
  FIX_UNREACHABLE,
  HELPER,
  PINNED_ARGV,
  PRE_PUSH,
  STANDIN_NPM,
  END_MARK,
  START_MARK,
  extractPolicyBlock,
  runGate,
  runPolicyBlock,
  scratchDir,
} from './npm-audit-gate.helpers'

const require = createRequire(import.meta.url)
interface WorkflowStep {
  name?: string
  run?: string
  [key: string]: unknown
}
interface WorkflowJob {
  steps: WorkflowStep[]
  [key: string]: unknown
}
const yaml = require('js-yaml') as { load: (text: string) => { jobs: Record<string, WorkflowJob> } }

const bashes = [
  ...new Set(['bash', '/bin/bash'].filter((b) => spawnSync(b, ['-c', 'true']).status === 0)),
]
const distinctBashes = bashes.filter((b, i) => {
  const real = (x: string) => {
    const p = spawnSync('sh', ['-c', `command -v ${x}`], { encoding: 'utf8' }).stdout.trim()
    return existsSync(p) ? realpathSync(p) : x
  }
  return bashes.findIndex((o) => real(o) === real(b)) === i
})

describe.each(distinctBashes)('npm-audit-gate.sh classification under %s (T1-T5)', (bash) => {
  it('T1 clean: npm exit 0 => exit 0, final line CLEAN', () => {
    const r = runGate({ bash, out: FIX_CLEAN, rc: 0 })
    expect(r.status).toBe(0)
    expect(r.finalLine).toBe('npm-audit-gate: CLEAN (npm exit 0)')
    expect(r.all).toContain('found 0 vulnerabilities')
  })

  it('T2 vulnerable, single-severity summary => exit 10', () => {
    const r = runGate({ bash, out: FIX_SINGLE, rc: 1 })
    expect(r.status).toBe(10)
    expect(r.finalLine).toBe('npm-audit-gate: VULNERABLE (npm exit 1)')
    expect(r.all).toContain('1 critical severity vulnerability')
  })

  it('T2b vulnerable, mixed-severity summary => exit 10 (the line the single regex missed)', () => {
    const r = runGate({ bash, out: FIX_MIXED, rc: 1 })
    expect(r.all).toContain(FIX_MIXED_SUMMARY)
    expect(r.status).toBe(10)
    expect(r.finalLine).toBe('npm-audit-gate: VULNERABLE (npm exit 1)')
  })

  it('T3 unavailable: npm-prefixed ECONNREFUSED lines => exit 11', () => {
    const r = runGate({ bash, out: FIX_UNREACHABLE, rc: 1 })
    expect(r.status).toBe(11)
    expect(r.finalLine).toBe('npm-audit-gate: UNAVAILABLE (npm exit 1)')
  })

  it('T4a masking guard (restriction): an advisory TITLE saying "fetch failed" is not a network error', () => {
    const r = runGate({ bash, out: FIX_TITLE_FETCH_FAILED, rc: 1 })
    // presence: the title line really is in the output the classifier saw
    expect(r.all).toContain('Handler fetch failed to validate')
    expect(r.status).toBe(12)
    expect(r.finalLine).toBe('npm-audit-gate: UNEXPECTED (npm exit 1)')
  })

  it('T4b masking guard (ordering): vulnerability summary AND a real network line => VULNERABLE, never UNAVAILABLE', () => {
    const out = `${FIX_UNREACHABLE.split('\n')[0]}\n${FIX_MIXED}`
    const r = runGate({ bash, out, rc: 1 })
    expect(r.all).toContain('ECONNREFUSED')
    expect(r.all).toContain(FIX_MIXED_SUMMARY)
    expect(r.status).toBe(10)
  })

  it('T5 unrecognised non-zero failure => exit 12 (fail closed, distinct from 10 and 11)', () => {
    const r = runGate({ bash, out: FIX_UNRECOGNISED, rc: 1 })
    expect(r.status).toBe(12)
    expect(r.finalLine).toBe('npm-audit-gate: UNEXPECTED (npm exit 1)')
  })
})

describe('npm-audit-gate.sh command and ambient config (T6, T7, T8, T23)', () => {
  it('T6 the executed command is exactly the pinned argv', () => {
    const r = runGate({ out: FIX_CLEAN, rc: 0 })
    expect(r.argv).toEqual(PINNED_ARGV)
  })

  const BASELINE = '2 vulnerabilities (1 high, 1 critical)'
  const ambient: Array<[string, Record<string, string>, Record<string, string>?, string?]> = [
    ['NPM_CONFIG_OFFLINE=true', { NPM_CONFIG_OFFLINE: 'true' }],
    ['npm_config_offline=true', { npm_config_offline: 'true' }],
    ['NPM_CONFIG_PREFER_OFFLINE=true', { NPM_CONFIG_PREFER_OFFLINE: 'true' }],
    ['NPM_CONFIG_JSON=true', { NPM_CONFIG_JSON: 'true' }],
    ['NPM_CONFIG_REGISTRY=http://127.0.0.1:1', { NPM_CONFIG_REGISTRY: 'http://127.0.0.1:1' }],
    ['NPM_CONFIG_INCLUDE=dev', { NPM_CONFIG_INCLUDE: 'dev' }],
    ['npm_config_include=dev', { npm_config_include: 'dev' }],
    ['NPM_CONFIG_WORKSPACE=packages/a', { NPM_CONFIG_WORKSPACE: 'packages/a' }],
    ['npm_config_workspace=packages/a', { npm_config_workspace: 'packages/a' }],
    ['NPM_CONFIG_WORKSPACES=true', { NPM_CONFIG_WORKSPACES: 'true' }],
    ['NPM_CONFIG_WORKSPACES=false', { NPM_CONFIG_WORKSPACES: 'false' }],
    ['npm_config_workspaces=true', { npm_config_workspaces: 'true' }],
    [
      'NPM_AUDIT_GATE_FLAGS=--audit-level=low (no env knob)',
      { NPM_AUDIT_GATE_FLAGS: '--audit-level=low' },
    ],
    ['user .npmrc include=dev', {}, { userrc: 'include=dev\n' }],
    ['user .npmrc workspace=packages/a', {}, { userrc: 'workspace=packages/a\n' }],
    ['user .npmrc workspaces=true', {}, { userrc: 'workspaces=true\n' }],
    ['user .npmrc offline=true', {}, { userrc: 'offline=true\n' }],
    ['user .npmrc registry=http://127.0.0.1:1', {}, { userrc: 'registry=http://127.0.0.1:1\n' }],
  ]

  const runAmbient = (
    env: Record<string, string>,
    files?: { userrc?: string; projectrc?: string }
  ) => {
    const dir = scratchDir('rc')
    const standin = join(dir, 'standin')
    mkdirSync(standin)
    const userrc = join(dir, 'user.npmrc')
    if (files?.userrc !== undefined) writeFileSync(userrc, files.userrc)
    return runGate({
      npmScript: STANDIN_NPM,
      rc: 0,
      env: { ...env, ...(files?.userrc !== undefined ? { NPM_CONFIG_USERCONFIG: userrc } : {}) },
      cwdFiles: files?.projectrc !== undefined ? { '.npmrc': files.projectrc } : {},
    })
  }

  it('T7 baseline (no ambient config) audits the full graph: VULNERABLE with both advisories', () => {
    const r = runAmbient({})
    expect(r.all).toContain(BASELINE)
    expect(r.status).toBe(10)
  })

  it.each(ambient)('T7 ambient %s cannot change the audited result', (_label, env, files) => {
    const r = runAmbient(env, files)
    expect(r.all).toContain(BASELINE)
    expect(r.status).toBe(10)
    expect(r.finalLine).toBe('npm-audit-gate: VULNERABLE (npm exit 1)')
  })

  it('T7 the pinned argv is unchanged under every ambient scenario', () => {
    for (const [label, env, files] of ambient) {
      expect(runAmbient(env, files).argv, label).toEqual(PINNED_ARGV)
    }
  })

  it('T7 residual (documented, measured): a PROJECT .npmrc workspace= narrows the audit but never reports CLEAN', () => {
    const r = runAmbient({}, { projectrc: 'workspace=packages/a\n' })
    expect(r.all).toContain('1 critical severity vulnerability')
    expect(r.status).toBe(10)
  })

  it('T8 npm absent => exit 12 with a 127 final line and the shell message', () => {
    const r = runGate({ noNpm: true })
    expect(r.all).toContain('npm: command not found')
    expect(r.finalLine).toBe('npm-audit-gate: UNEXPECTED (npm exit 127)')
    expect(r.status).toBe(12)
  })

  it('T23 guarded capture: under set -euo pipefail a failing npm still reaches classification', () => {
    const vuln = runGate({ out: FIX_SINGLE, rc: 1 })
    expect(vuln.finalLine).toBe('npm-audit-gate: VULNERABLE (npm exit 1)')
    expect(vuln.status).toBe(10)
    const unavailable = runGate({ out: FIX_UNREACHABLE, rc: 1 })
    expect(unavailable.finalLine).toBe('npm-audit-gate: UNAVAILABLE (npm exit 1)')
    expect(unavailable.status).toBe(11)
  })
})

describe('call sites delegate to the helper (T9, T10)', () => {
  const codeLines = (text: string) => text.split('\n').filter((l) => !/^\s*#/.test(l))
  const npmAuditRe = /\bnpm\s+audit\b(?!\s+fix)/

  it.each([
    ['scripts/pre-push-check.sh', PRE_PUSH],
    ['.github/workflows/ci.yml', CI_YML],
  ])('T9 %s calls the helper and has no inline `npm audit` code line', (_n, file) => {
    const text = readFileSync(file, 'utf8')
    // presence control from the same read: the file was read and the delegation is there
    expect(text.length).toBeGreaterThan(1000)
    expect(text).toContain('scripts/ci/npm-audit-gate.sh')
    // quoted text (echo messages, remediation hints) is not an invocation: strip it first
    const stripQuoted = (l: string) => l.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''")
    const offenders = codeLines(text).filter((l) => npmAuditRe.test(stripQuoted(l)))
    expect(offenders).toEqual([])
  })

  const auditStep = () => {
    const doc = yaml.load(readFileSync(CI_YML, 'utf8'))
    const steps = doc.jobs.security.steps.filter((s) => s.name === 'Run dependency audit in Docker')
    expect(steps).toHaveLength(1)
    return { job: doc.jobs.security, step: steps[0] }
  }

  it('T10 static: the audit step has no continue-on-error and no if; neither has the job', () => {
    const { job, step } = auditStep()
    expect(step.run).toContain('scripts/ci/npm-audit-gate.sh')
    expect('continue-on-error' in step).toBe(false)
    expect('if' in step).toBe(false)
    expect('continue-on-error' in job).toBe(false)
    const named = job.steps.filter((s) =>
      /Check audit result|Fail on high-severity/.test(s.name ?? '')
    )
    expect(named).toEqual([])
  })

  it.each([
    [0, 0],
    [10, 1],
    [11, 1],
    [12, 1],
    [2, 1],
    [127, 1],
  ])(
    'T10 executed: helper exit %i makes the step exit non-zero iff not clean (expected %i)',
    (helperRc, expected) => {
      const { step } = auditStep()
      const dir = scratchDir('ci')
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit "$STUB_RC"\n')
      chmodSync(join(bin, 'docker'), 0o755)
      const run = String(step.run)
        .replace(/\$\{\{\s*github\.workspace\s*\}\}/g, dir)
        .replace(/\$\{\{\s*github\.sha\s*\}\}/g, 'abc123')
      const r = spawnSync('bash', ['-e', '-c', run], {
        encoding: 'utf8',
        env: { PATH: `${bin}:${process.env.PATH ?? ''}`, STUB_RC: String(helperRc) },
      })
      expect(r.status === 0 ? 0 : 1).toBe(expected)
      if (expected === 1) expect(r.stdout).toContain('::error::')
    }
  )
})

describe('pre-push CHECK 2 policy block (T11, T22, T27)', () => {
  const OK_FINAL = 'npm-audit-gate: UNAVAILABLE (npm exit 1)'

  it('presence control: the extracted block exists and contains the soft-pass text', () => {
    const block = extractPolicyBlock()
    expect(block.length).toBeGreaterThan(500)
    expect(block).toContain('network unavailable')
    expect(readFileSync(PRE_PUSH, 'utf8')).toContain(END_MARK)
    expect(block.startsWith(START_MARK)).toBe(true)
  })

  it('T11a exit 11 with the exact final line soft-passes (CHECKS_FAILED stays unset)', () => {
    const r = runPolicyBlock(11, `${FIX_UNREACHABLE}${OK_FINAL}\n`)
    expect(r.out).toContain('network unavailable')
    expect(r.checksFailed).toBe('unset')
  })

  it('T11b exit 11 with a different final line blocks', () => {
    const r = runPolicyBlock(11, `${FIX_UNREACHABLE}npm-audit-gate: VULNERABLE (npm exit 1)\n`)
    expect(r.checksFailed).toBe('1')
  })

  it('T11c exits 0, 10, 12 behave per the policy', () => {
    expect(runPolicyBlock(0, `${FIX_CLEAN}npm-audit-gate: CLEAN (npm exit 0)\n`).checksFailed).toBe(
      'unset'
    )
    expect(
      runPolicyBlock(10, `${FIX_SINGLE}npm-audit-gate: VULNERABLE (npm exit 1)\n`).checksFailed
    ).toBe('1')
    const r12 = runPolicyBlock(12, `${FIX_UNRECOGNISED}npm-audit-gate: UNEXPECTED (npm exit 1)\n`)
    expect(r12.checksFailed).toBe('1')
    expect(r12.out).toContain('could not be classified')
    const r127 = runPolicyBlock(
      127,
      'bash: scripts/ci/npm-audit-gate.sh: No such file or directory\n'
    )
    expect(r127.checksFailed).toBe('1')
    expect(r127.out).toContain('bind-mount freeze')
  })

  it('T22 a helper with a shell syntax error blocks pre-push (raw exit is outside {0,10,11,12})', () => {
    const dir = scratchDir('broken')
    const broken = join(dir, 'npm-audit-gate.sh')
    copyFileSync(HELPER, broken)
    writeFileSync(
      broken,
      readFileSync(broken, 'utf8').replace('set -euo pipefail', 'set -euo pipefail\nif then fi')
    )
    const r = runGate({ helperPath: broken, out: FIX_CLEAN, rc: 0 })
    expect([0, 10, 11, 12]).not.toContain(r.status)
    const block = runPolicyBlock(r.status ?? -1, r.all)
    expect(block.checksFailed).toBe('1')
    expect(block.out).toContain('helper failed')
  })

  it('T27 soft-pass is exact equality: a suffixed or non-numeric final line blocks', () => {
    expect(runPolicyBlock(11, `${OK_FINAL} extra\n`).checksFailed).toBe('1')
    expect(runPolicyBlock(11, 'npm-audit-gate: UNAVAILABLE (npm exit x)\n').checksFailed).toBe('1')
    expect(runPolicyBlock(11, `${OK_FINAL}\n`).checksFailed).toBe('unset')
  })
})
