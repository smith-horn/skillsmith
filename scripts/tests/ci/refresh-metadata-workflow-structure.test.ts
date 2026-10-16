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
import { spawnSync } from 'node:child_process'
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
  'continue-on-error'?: unknown
}
interface Job {
  if?: string
  env?: Record<string, string>
  permissions?: unknown
  'continue-on-error'?: unknown
  'timeout-minutes'?: number
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

const step0 = (w: Workflow): string =>
  w.jobs.refresh.steps.find((s) => s.name === 'Trigger Metadata Refresh')?.run ?? ''

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

  it('the observer can fail the job, holds no write token and is bounded (known-negative: each loosened)', () => {
    // A green-but-skipped observer writes no heartbeat, so the dead-man still pages; a run
    // that never fails the job would hide its own errors from GitHub's failed-run email.
    const ok = (w: Workflow): boolean => {
      const job = w.jobs.observe
      const checkout = job.steps.find((s) => (s.uses ?? '').startsWith('actions/checkout@'))
      return (
        JSON.stringify(job.permissions) === JSON.stringify({ contents: 'read' }) &&
        job['continue-on-error'] === undefined &&
        job.steps.every((s) => s['continue-on-error'] === undefined && s.if === undefined) &&
        checkout?.with?.['persist-credentials'] === false &&
        typeof job['timeout-minutes'] === 'number'
      )
    }
    expect(ok(wf)).toBe(true)

    const mutations: Array<(j: Job) => void> = [
      (j) => (j.permissions = { contents: 'write' }),
      (j) => (j['continue-on-error'] = true),
      (j) => (j.steps[j.steps.length - 1]['continue-on-error'] = true),
      (j) => (j.steps[j.steps.length - 1].if = 'false'),
      (j) => {
        for (const s of j.steps) if (s.with) delete s.with['persist-credentials']
      },
      (j) => delete j['timeout-minutes'],
    ]
    for (const mutate of mutations) {
      const bad = clone(wf)
      mutate(bad.jobs.observe)
      expect(ok(bad)).toBe(false)
    }
  })

  it('the observer script makes only its three known calls and needs no other file (known-negative: each added)', () => {
    // The sparse checkout fetches only this one file, and the schedule must only observe.
    // Every request goes through post_json's single curl, so pinning its URLs pins them all.
    const ALLOWED = new Set([
      '${SUPABASE_URL}/rest/v1/rpc/refresh_metadata_health',
      '${SUPABASE_URL}/functions/v1/alert-notify',
      '${SUPABASE_URL}/rest/v1/audit_logs',
    ])
    const ok = (text: string): boolean => {
      const code = text.split('\n').filter((l) => !/^\s*#/.test(l))
      const urls = code.flatMap((l) => [...l.matchAll(/post_json "([^"]+)"/g)].map((m) => m[1]))
      // Every call site, quoted or not, minus the definition: an unquoted fourth call fails.
      const calls = code.filter((l) => /\bpost_json\b/.test(l) && !/post_json\s*\(\)/.test(l))
      const fetchers = code.filter((l) => /(^|[\s;&|(])(curl|wget|nc)\s/.test(l))
      const otherNet = code.some((l) =>
        /\/dev\/(tcp|udp)\/|openssl\s+s_client|\bfetch\(|\bpython3?\b|https?:\/\//.test(l)
      )
      const sourced = code.some((l) => /(^|;|&&|\|\||\|)\s*(source|\.)\s+\S/.test(l))
      const otherScripts = code.some((l) => /scripts\//.test(l))
      return (
        urls.length === ALLOWED.size &&
        calls.length === ALLOWED.size &&
        !otherNet &&
        urls.every((u) => ALLOWED.has(u)) &&
        fetchers.length === 1 &&
        !sourced &&
        !otherScripts
      )
    }
    const script = readFileSync(join(REPO_ROOT, OBSERVER), 'utf8')
    expect(ok(script)).toBe(true)
    for (const extra of [
      'X="$(post_json "${SUPABASE_URL}/functions/v1/skills-refresh-metadata" "$WORK/x" "{}")"',
      'curl -sS -X POST "$SUPABASE_URL$FN"',
      'source scripts/ci/lib.sh',
      'true && . ./lib.sh',
      'bash scripts/ci/other.sh',
      'node scripts/ci/other.mjs',
      'X="$(post_json $FN_URL "$WORK/x" "{}")"',
      "node -e 'fetch(process.env.SUPABASE_URL)'",
      'exec 3<>/dev/tcp/example.com/443',
      'python3 -c "import urllib.request"',
    ]) {
      expect(ok(`${script}\n${extra}\n`)).toBe(false)
    }
  })

  it('dispatch inputs reach the shell only via env and are allow-listed (known-negative: inlined, guard dropped)', () => {
    const step = (w: Workflow) =>
      w.jobs.refresh.steps.find((s) => s.name === 'Trigger Metadata Refresh')
    const viaEnv = (w: Workflow): boolean => {
      const st = step(w)
      const inputsInRun = w.jobs.refresh.steps.some((s) =>
        /\$\{\{\s*github\.event\.inputs/.test(s.run ?? '')
      )
      return (
        !inputsInRun &&
        /github\.event\.inputs\.dry_run/.test(st?.env?.DRY_RUN ?? '') &&
        /github\.event\.inputs\.batch_size/.test(st?.env?.BATCH_SIZE ?? '') &&
        /github\.event\.inputs\.stale_days/.test(st?.env?.STALE_DAYS ?? '')
      )
    }
    expect(viaEnv(wf)).toBe(true)
    const inlined = clone(wf)
    const st = step(inlined)
    if (st) st.run = `BATCH_SIZE="\${{ github.event.inputs.batch_size }}"\n${st.run ?? ''}`
    expect(viaEnv(inlined)).toBe(false)

    // Execute the step's own guard lines in bash against a case table.
    const guards = (w: Workflow): string =>
      (step(w)?.run ?? '')
        .split('\n')
        .filter((l) => /^\s*case "\$(BATCH_SIZE|STALE_DAYS|DRY_RUN)"/.test(l))
        .join('\n')
    const accepts = (g: string, batch: string, stale: string, dry: string): boolean =>
      spawnSync('bash', ['-c', `${g}\nexit 0`], {
        env: { PATH: process.env.PATH ?? '', BATCH_SIZE: batch, STALE_DAYS: stale, DRY_RUN: dry },
      }).status === 0
    const g = guards(wf)
    expect(g.split('\n')).toHaveLength(3)
    for (const b of ['1', '9', '10', '200', '499', '500'])
      expect(accepts(g, b, '1', 'false')).toBe(true)
    for (const b of [
      '0',
      '00',
      '007',
      '501',
      '999',
      '1000',
      '99999999999999999999',
      '',
      '12a',
      '$(id)',
      '1;id',
      ' 5',
      '-3',
    ])
      expect(accepts(g, b, '1', 'false')).toBe(false)
    for (const d of ['0', '1', '30', '999']) expect(accepts(g, '200', d, 'true')).toBe(true)
    for (const d of ['00', '01', '1000', '', 'x', '1 2'])
      expect(accepts(g, '200', d, 'true')).toBe(false)
    for (const r of ['TRUE', '1', '', 'yes']) expect(accepts(g, '200', '1', r)).toBe(false)

    // Known-negative: with the batch guard dropped, an unbounded batch is accepted.
    const dropped = g
      .split('\n')
      .filter((l) => !l.includes('BATCH_SIZE'))
      .join('\n')
    expect(accepts(dropped, '99999999999999999999', '1', 'false')).toBe(true)
  })

  it('the transient-error retry never sends a zero batch (known-negative: floor division)', () => {
    const run = step0(wf)
    expect(run).toContain('RETRY_BATCH=$(( (BATCH_SIZE + 1) / 2 ))')
    const half = (expr: string, n: number): number =>
      Number(spawnSync('bash', ['-c', `BATCH_SIZE=${n}; echo $(( ${expr} ))`]).stdout.toString())
    for (const n of [1, 2, 3, 200, 500]) expect(half('(BATCH_SIZE + 1) / 2', n)).toBeGreaterThan(0)
    expect(half('BATCH_SIZE / 2', 1)).toBe(0)
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
