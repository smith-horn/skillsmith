/**
 * SMI-7114 W3b: structural contract for refresh-metadata.yml.
 *
 * After W3b, pg_cron triggers the refresh and the GitHub schedule only OBSERVES it. Two
 * properties carry that split, and a refactor could drop either silently:
 *   - on `schedule`, the only job that runs is the observer, and nothing reachable on a
 *     schedule POSTs the refresh function (that would double-trigger and hide a dead pg_cron
 *     from the `dispatch_stale` arm only by accident);
 *   - `workflow_dispatch` still POSTs the function, with dry_run and batch_size.
 * Each predicate is paired with a known-negative: the same predicate on a deliberately
 * broken copy of the workflow must fail.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'refresh-metadata.yml')
const FUNCTION_PATH = '/functions/v1/skills-refresh-metadata'
const OBSERVER = 'scripts/ci/refresh-observer.sh'

interface Step {
  name?: string
  if?: string
  env?: Record<string, string>
  run?: string
  uses?: string
  with?: Record<string, unknown>
}
interface Job {
  if?: string
  env?: Record<string, string>
  steps: Step[]
}
interface Workflow {
  on: {
    schedule?: Array<{ cron: string }>
    workflow_dispatch?: { inputs?: Record<string, unknown> }
  }
  env?: Record<string, string>
  jobs: Record<string, Job>
}

const load = (): Workflow => parseYaml(readFileSync(WORKFLOW, 'utf8')) as Workflow
const clone = (w: Workflow): Workflow => JSON.parse(JSON.stringify(w)) as Workflow

/**
 * Events a job runs on. Only the two exact guards this workflow uses are understood; any
 * other `if:` (or none) is treated as "runs on every event", so an unfamiliar guard fails
 * the schedule check rather than passing it.
 */
function eventsFor(job: Job): Set<string> {
  const guard = (job.if ?? '').trim()
  if (guard === "github.event_name == 'schedule'") return new Set(['schedule'])
  if (guard === "github.event_name == 'workflow_dispatch'") return new Set(['workflow_dispatch'])
  return new Set(['schedule', 'workflow_dispatch'])
}

const jobsOn = (w: Workflow, event: string): string[] =>
  Object.entries(w.jobs)
    .filter(([, j]) => eventsFor(j).has(event))
    .map(([name]) => name)

/** Every string a job can execute or pass on: step runs, uses, with, env, and job env. */
const jobText = (j: Job): string => JSON.stringify([j.env ?? {}, j.steps])

const postsFunction = (j: Job): boolean => jobText(j).includes(FUNCTION_PATH)

const runsObserver = (j: Job): boolean =>
  j.steps.some((s) => (s.run ?? '').split('\n').some((l) => l.trim() === `bash ${OBSERVER}`))

describe('refresh-metadata.yml (SMI-7114 W3b)', () => {
  const wf = load()

  it('keeps the 4-hourly schedule the dead-man SLA was sized from (known-negative: another cron)', () => {
    const crons = (w: Workflow) => (w.on.schedule ?? []).map((s) => s.cron)
    expect(crons(wf)).toEqual(['30 */4 * * *'])
    const bad = clone(wf)
    bad.on.schedule = [{ cron: '30 */6 * * *' }]
    expect(crons(bad)).not.toEqual(['30 */4 * * *'])
  })

  it('on schedule, exactly one job runs and it is the observer (known-negative: unguarded refresh job)', () => {
    expect(jobsOn(wf, 'schedule')).toEqual(['observe'])
    expect(runsObserver(wf.jobs.observe)).toBe(true)

    const bad = clone(wf)
    delete bad.jobs.refresh.if
    expect(jobsOn(bad, 'schedule')).not.toEqual(['observe'])
  })

  it('nothing reachable on schedule POSTs the refresh function (known-negative: observer job calls it)', () => {
    const scheduled = (w: Workflow) => jobsOn(w, 'schedule').map((n) => w.jobs[n])
    expect(scheduled(wf).some(postsFunction)).toBe(false)

    const bad = clone(wf)
    bad.jobs.observe.steps.push({ run: `curl -X POST "$SUPABASE_URL${FUNCTION_PATH}"` })
    expect(scheduled(bad).some(postsFunction)).toBe(true)
  })

  it('the observer step gets its credentials, kill switch and script (known-negative: each removed)', () => {
    const ok = (w: Workflow): boolean => {
      const job = w.jobs.observe
      const env = { ...(w.env ?? {}), ...(job.env ?? {}) }
      const step = job.steps.find((s) => (s.run ?? '').includes(OBSERVER))
      const checkout = job.steps.find((s) => (s.uses ?? '').startsWith('actions/checkout@'))
      const sparse = String(checkout?.with?.['sparse-checkout'] ?? '')
      return (
        env.SUPABASE_URL === '${{ secrets.SUPABASE_URL }}' &&
        env.SUPABASE_SERVICE_ROLE_KEY === '${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}' &&
        step?.env?.SKILLSMITH_REFRESH_OBSERVER_ALERT_DISABLE ===
          '${{ vars.SKILLSMITH_REFRESH_OBSERVER_ALERT_DISABLE }}' &&
        sparse
          .split('\n')
          .map((l) => l.trim())
          .includes(OBSERVER)
      )
    }
    expect(ok(wf)).toBe(true)

    const noKey = clone(wf)
    delete noKey.env?.SUPABASE_SERVICE_ROLE_KEY
    expect(ok(noKey)).toBe(false)

    const noSwitch = clone(wf)
    for (const s of noSwitch.jobs.observe.steps) delete s.env
    expect(ok(noSwitch)).toBe(false)

    const noScript = clone(wf)
    for (const s of noScript.jobs.observe.steps)
      if (s.with) s.with['sparse-checkout'] = 'scripts/ci'
    expect(ok(noScript)).toBe(false)
  })

  it('workflow_dispatch still POSTs the function with dry_run and batch_size (known-negative: job guarded to schedule)', () => {
    const ok = (w: Workflow): boolean => {
      const inputs = Object.keys(w.on.workflow_dispatch?.inputs ?? {})
      const manual = jobsOn(w, 'workflow_dispatch').map((n) => w.jobs[n])
      return (
        inputs.includes('dry_run') && inputs.includes('batch_size') && manual.some(postsFunction)
      )
    }
    expect(ok(wf)).toBe(true)
    expect(jobsOn(wf, 'workflow_dispatch')).toEqual(['refresh'])

    const bad = clone(wf)
    bad.jobs.refresh.if = "github.event_name == 'schedule'"
    expect(ok(bad)).toBe(false)
  })
})
