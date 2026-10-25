/**
 * Structural test of the live ci.yml wiring for the audit report (SMI-7174, T8).
 *
 * Quality Checks is a REQUIRED job. Its audit step is the job's verdict, and the two
 * report steps after it must never be able to change that verdict. Each assertion pins
 * one property, read from parsed step values (comments stripped), not from text matches
 * anywhere in the file. The repo has no YAML parser dependency, so steps are parsed by
 * indentation within the job body that parseCiYmlJobs (Check 38's parser) returns.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const CI = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

const { parseCiYmlJobs } = (await import('../audit-standards-helpers.mjs')) as {
  parseCiYmlJobs: (c: string) => Array<{ name: string; line: number; body: string }>
}

type Step = Record<string, string> & { with?: Record<string, string> }
const stripComment = (v: string) => v.replace(/\s+#.*$/, '').trim()

/** Steps of a job body: `      - key: value` starts a step; 8-space keys; 10-space `with:` keys. */
function parseSteps(body: string): Step[] {
  const steps: Step[] = []
  let cur: Step | null = null
  let inWith = false
  for (const line of body.split('\n')) {
    const start = line.match(/^ {6}- ([a-z-]+):\s*(.*)$/)
    if (start) {
      cur = { [start[1]]: stripComment(start[2]) }
      steps.push(cur)
      inWith = false
      continue
    }
    if (!cur) continue
    const key = line.match(/^ {8}([a-z-]+):\s*(.*)$/)
    if (key) {
      inWith = key[1] === 'with'
      if (inWith) cur.with = {}
      // run: keeps its full value; everything else drops a trailing comment.
      else cur[key[1]] = key[1] === 'run' ? key[2].trim() : stripComment(key[2])
      continue
    }
    const sub = line.match(/^ {10}([a-z-]+):\s*(.*)$/)
    if (inWith && sub && cur.with) cur.with[sub[1]] = stripComment(sub[2])
  }
  return steps
}

const jobs = parseCiYmlJobs(CI)
const qc = jobs.find((j) => j.name === 'quality-checks')
const steps = qc ? parseSteps(qc.body) : []
const step = (name: string) => steps.find((s) => s.name === name)
const REPORT_IF = "always() && steps.audit.outcome != 'skipped'"

describe('ci.yml: Quality Checks audit wiring (SMI-7174)', () => {
  it('parses the quality-checks job and its steps (instrument check)', () => {
    expect(qc).toBeDefined()
    expect(steps.length).toBeGreaterThan(5)
    expect(step('Checkout')?.uses).toMatch(/^actions\/checkout@/)
  })

  it('the audit step runs the report script, with id audit', () => {
    const s = step('Run standards audit')
    expect(s?.id).toBe('audit')
    expect(s?.run).toBe('bash scripts/ci-code-review.sh audit-report.json')
  })

  // Job-level keys sit at four spaces, outside every step; parseSteps never sees them.
  it('the quality-checks job itself cannot swallow a failure: no job-level continue-on-error', () => {
    const jobKeys = (qc?.body ?? '')
      .split('\n')
      .map((l) => l.match(/^ {4}([a-z-]+):/)?.[1])
      .filter(Boolean)
    expect(jobKeys).toContain('steps') // instrument check: job-level keys are read
    expect(jobKeys).not.toContain('continue-on-error')
  })

  it('the audit step can fail the job: no continue-on-error, no || in its command', () => {
    const s = step('Run standards audit')
    expect(s).toBeDefined()
    expect(s && 'continue-on-error' in s).toBe(false)
    expect(s?.run).not.toContain('||')
  })

  it.each(['Upload audit report', 'Add audit summary to job'])(
    '%s runs after the audit and cannot fail the job',
    (name) => {
      const s = step(name)
      expect(s?.if).toBe(REPORT_IF)
      expect(s?.['continue-on-error']).toBe('true')
    }
  )

  it('the upload step uploads audit-report.json as the audit-report artifact', () => {
    const s = step('Upload audit report')
    expect(s?.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/)
    expect(s?.with?.name).toBe('audit-report')
    expect(s?.with?.path).toBe('audit-report.json')
  })

  it('the summary step renders the report into the job page and the log', () => {
    expect(step('Add audit summary to job')?.run).toBe(
      'node scripts/ci/audit-summary.mjs audit-report.json | tee -a "$GITHUB_STEP_SUMMARY"'
    )
  })

  it('the report steps come after the audit step', () => {
    const i = (n: string) => steps.findIndex((s) => s.name === n)
    expect(i('Run standards audit')).toBeGreaterThan(-1)
    expect(i('Upload audit report')).toBeGreaterThan(i('Run standards audit'))
    expect(i('Add audit summary to job')).toBeGreaterThan(i('Run standards audit'))
  })
})

describe('ci.yml: the Code Review job is retired (SMI-7174)', () => {
  it('no code-review job exists (and the parser does find quality-checks)', () => {
    expect(jobs.map((j) => j.name)).toContain('quality-checks')
    expect(jobs.map((j) => j.name)).not.toContain('code-review')
  })

  it('no workflow names the old artifact', () => {
    const dir = join(ROOT, '.github', 'workflows')
    const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))
    expect(files).toContain('ci.yml')
    for (const f of files) {
      expect(readFileSync(join(dir, f), 'utf8'), f).not.toContain('code-review-report')
    }
  })

  it('ci-code-review.sh passes no --only to the audit (Check 38 cannot see it there)', () => {
    const code = readFileSync(join(ROOT, 'scripts', 'ci-code-review.sh'), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
    expect(code.some((l) => l.includes('run audit:standards'))).toBe(true)
    expect(code.filter((l) => l.includes('--only'))).toEqual([])
  })
})
