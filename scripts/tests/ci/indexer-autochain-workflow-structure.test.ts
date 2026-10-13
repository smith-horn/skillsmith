/**
 * SMI-7112 (1.4): structural contract for indexer-backfill-autochain.yml.
 *
 * These pin the properties that make the autochain safe, as YAML facts a refactor
 * cannot silently drop: manual-dispatch support, the DISPATCH_ALLOWED gate on
 * every side effect, and -- the one that matters most -- the authoritative
 * enable read being the command IMMEDIATELY before the dispatch.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'indexer-backfill-autochain.yml')

interface Step {
  name?: string
  id?: string
  if?: string
  env?: Record<string, string>
  run?: string
  uses?: string
}
const doc = parseYaml(readFileSync(WORKFLOW, 'utf8')) as {
  on: Record<string, unknown>
  jobs: { autochain: { if: string; env: Record<string, string>; steps: Step[] } }
}
const job = doc.jobs.autochain
const steps = job.steps

/** Executable commands of a `run:` block: comments/blanks dropped, `\` continuations joined. */
function commands(run: string): string[] {
  const out: string[] = []
  let acc = ''
  for (const raw of run.split('\n')) {
    const line = raw.trim()
    if (acc === '' && (line === '' || line.startsWith('#'))) continue
    if (line.endsWith('\\')) {
      acc += line.slice(0, -1).trim() + ' '
      continue
    }
    out.push((acc + line).trim())
    acc = ''
  }
  if (acc) out.push(acc.trim())
  return out
}
const dispatchStep = steps.find((s) => (s.run ?? '').includes('gh workflow run'))

describe('autochain workflow structure', () => {
  it('declares both workflow_run and workflow_dispatch(completed_run_id, verify_only)', () => {
    expect(doc.on).toHaveProperty('workflow_run')
    const wd = doc.on.workflow_dispatch as {
      inputs: Record<string, { required?: boolean; default?: unknown; type: string }>
    }
    expect(wd.inputs.completed_run_id.required).toBe(true)
    expect(wd.inputs.verify_only.type).toBe('boolean')
    expect(wd.inputs.verify_only.default).toBe(true)
  })

  it('the job `if` admits workflow_dispatch', () => {
    expect(job.if).toMatch(/github\.event_name\s*==\s*'workflow_dispatch'/)
  })

  it('COMPLETED_RUN_ID is taken from inputs.completed_run_id on a manual run', () => {
    expect(job.env.COMPLETED_RUN_ID).toContain('inputs.completed_run_id')
  })

  it('DISPATCH_ALLOWED is job-level and turns on verify_only', () => {
    expect(job.env.DISPATCH_ALLOWED).toContain('inputs.verify_only')
  })

  it('every step that dispatches, alerts or waits is gated on DISPATCH_ALLOWED', () => {
    const risky = steps.filter((s) =>
      /gh workflow run|alert-notify|\bsleep\b/.test(commands(s.run ?? '').join('\n'))
    )
    expect(risky.length).toBeGreaterThanOrEqual(4) // cooldown, retry-cap alert, dispatch, failure alert
    const ungated = risky
      .filter((s) => !(s.if ?? '').includes("env.DISPATCH_ALLOWED == 'true'"))
      .map((s) => s.name)
    expect(
      ungated,
      `side-effect steps missing the DISPATCH_ALLOWED gate: ${ungated.join(', ')}`
    ).toEqual([])
  })

  it('has a Send Alert on Failure step', () => {
    const s = steps.find((x) => x.name === 'Send Alert on Failure')
    expect(s?.if).toContain('failure()')
  })

  describe('the authoritative enable read (R3-1)', () => {
    it('the dispatch step exists and passes a unique dispatch_token', () => {
      expect(dispatchStep).toBeDefined()
      expect(dispatchStep!.run).toContain('-f dispatch_token="ac-$GITHUB_RUN_ID"')
    })

    it('ADJACENCY: the command right before `timeout 60 gh workflow run` is the read script, nothing between', () => {
      const cmds = commands(dispatchStep!.run!)
      const at = cmds.findIndex((c) => c.startsWith('timeout 60 gh workflow run'))
      expect(at, `commands: ${JSON.stringify(cmds)}`).toBeGreaterThan(0)
      expect(cmds[at - 1]).toMatch(
        /^GH_TOKEN="\$VARIABLE_READ_PAT" bash scripts\/ci\/autochain-read-enable\.sh/
      )
    })

    it('the dispatch step has no delay and no `vars.` reference', () => {
      expect(commands(dispatchStep!.run!).join('\n')).not.toMatch(/\bsleep\b/)
      expect(JSON.stringify(dispatchStep)).not.toContain('vars.')
    })

    it('the read uses ONLY the BACKFILL_VARIABLE_READ_PAT secret', () => {
      expect(dispatchStep!.env!.VARIABLE_READ_PAT).toContain('secrets.BACKFILL_VARIABLE_READ_PAT')
    })
  })
})
