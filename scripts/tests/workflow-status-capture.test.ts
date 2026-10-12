/**
 * SMI-6996 (retro of #3012): status capture in four sibling workflows. Runs of a `run:` step with
 * no `shell:` are `bash -e {0}` on the runner, so a `$?` read on the line after a command is dead
 * code: the step already stopped when the command failed, and the value read can only be 0.
 *
 * - concurrency-audit-pr.yml `scan_plan`: the per-plan exit label must not carry one plan's status
 *   into the next plan's (EXECUTED, with a stub scan-plan.sh in a temp cwd, so it runs in CI where
 *   the strategy submodule is not checked out).
 * - lint-linear-issues.yml / linear-drift-audit.yml: the `exit_code=$?` output had no reader and
 *   was dead code (EXECUTED with a stub `node`, for exit status 0 and 1).
 * - wasm-env-snapshot.yml: the step needs `docker build`, which no unit harness runs, so a text pin
 *   scoped to that step is the smallest check there is.
 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const WORKFLOWS = join(REPO_ROOT, '.github/workflows')
const require = createRequire(import.meta.url)
interface Step {
  id?: string
  run?: string
  shell?: string
}
const yaml = require('js-yaml') as {
  load: (t: string) => { jobs: Record<string, { steps: Step[] }> }
}

const allSteps = (file: string): Step[] =>
  Object.values(yaml.load(readFileSync(join(WORKFLOWS, file), 'utf8')).jobs).flatMap((j) => j.steps)
const stepRun = (file: string, id: string): string => {
  const steps = allSteps(file).filter((s) => s.id === id)
  expect(steps).toHaveLength(1)
  expect(steps[0]).not.toHaveProperty('shell') // the runner default shell: bash -e {0}
  return steps[0].run as string
}
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p))
const executable = (path: string, body: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}
/** Runs a step's script the way the runner does (`bash -e {0}`), from a file. */
const runStep = (run: string, cwd: string, env: Record<string, string>) => {
  const file = join(cwd, 'step.sh')
  writeFileSync(file, run)
  return spawnSync('bash', ['-e', file], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
  })
}

describe('concurrency-audit-pr.yml scan_plan labels each plan with its own exit status', () => {
  it('D1 a failing plan followed by a passing plan reports exit 1 then exit 0', () => {
    const cwd = tmp('smi6996-conc-')
    executable(
      join(cwd, '.claude/skills/concurrency-auditor/scripts/scan-plan.sh'),
      '#!/bin/bash\ncase "$2" in a.md) echo finding; exit 1 ;; *) echo ok; exit 0 ;; esac\n'
    )
    writeFileSync(join(cwd, 'a.md'), '')
    writeFileSync(join(cwd, 'b.md'), '')
    const out = join(cwd, 'github-output')
    writeFileSync(out, '')
    const r = runStep(stepRun('concurrency-audit-pr.yml', 'scan_plan'), cwd, {
      PLAN_FILES: 'a.md\nb.md',
      GITHUB_OUTPUT: out,
    })
    expect(r.status, r.stderr).toBe(0)
    const o = readFileSync(out, 'utf8')
    expect(o).toContain('### scan-plan --strict a.md (exit 1)')
    expect(o).toContain('### scan-plan --strict b.md (exit 0)')
    expect(o).toContain('exit_code=1')
  })
})

describe('lint-linear-issues.yml and linear-drift-audit.yml write no dead exit_code output', () => {
  const NODE_STUB = '#!/bin/bash\nprintf \'%s\' "$STUB_JSON"\nexit "$STUB_RC"\n'
  const JSON_OUT = '{"violations":[],"total":0}'
  describe.each([
    ['lint-linear-issues.yml', 'lint', 'lint-results.json'],
    ['linear-drift-audit.yml', 'audit', 'drift-results.json'],
  ])('%s step %s', (file, id, resultFile) => {
    it.each([0, 1])(
      'with the tool exiting %i the step ends with that status and no exit_code line',
      (rc) => {
        const cwd = tmp('smi6996-status-')
        executable(join(cwd, 'bin/node'), NODE_STUB)
        const out = join(cwd, 'github-output')
        writeFileSync(out, '')
        const run = stepRun(file, id).split('/tmp/').join(`${cwd}/`)
        const r = runStep(run, cwd, {
          PATH: `${join(cwd, 'bin')}:${process.env.PATH ?? ''}`,
          GITHUB_OUTPUT: out,
          SINCE_INPUT: '',
          STUB_JSON: JSON_OUT,
          STUB_RC: String(rc),
        })
        expect(r.status).toBe(rc)
        // presence: the tool ran and its output was captured, so the absence below is not vacuous
        expect(readFileSync(join(cwd, resultFile), 'utf8')).toBe(JSON_OUT)
        expect(readFileSync(out, 'utf8')).not.toContain('exit_code=')
      }
    )
  })
  it('nothing reads steps.lint.outputs.exit_code or steps.audit.outputs.exit_code; the next step gates on the outcome', () => {
    const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))
    expect(files.length).toBeGreaterThan(2) // presence: the scan covered the workflows
    for (const f of files) {
      const text = readFileSync(join(WORKFLOWS, f), 'utf8')
      expect(text).not.toContain('steps.lint.outputs.exit_code')
      expect(text).not.toContain('steps.audit.outputs.exit_code')
    }
    expect(readFileSync(join(WORKFLOWS, 'lint-linear-issues.yml'), 'utf8')).toContain(
      'steps.lint.outcome'
    )
    expect(readFileSync(join(WORKFLOWS, 'linear-drift-audit.yml'), 'utf8')).toContain(
      'steps.audit.outcome'
    )
  })
})

describe('wasm-env-snapshot.yml', () => {
  it('D3 the snapshot step reads no $? after a command bash -e already stopped on (text pin: the step needs docker build)', () => {
    const steps = allSteps('wasm-env-snapshot.yml').filter((s) =>
      s.run?.includes('wasm-env-snapshot.mjs --emit')
    )
    expect(steps).toHaveLength(1) // presence: the step under test was found
    expect(steps[0].run).not.toContain('$?')
  })
})
