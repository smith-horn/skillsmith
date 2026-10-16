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
  needs?: string | string[]
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

const ALL_EVENTS = ['schedule', 'workflow_dispatch']

/**
 * Events a job runs on. Only the two exact guards this workflow uses (or no guard) are
 * understood, and for those a job runs only where every job it `needs` also runs: GitHub
 * skips a job whose dependency was skipped. Any other `if:` (`always()`, `failure()`, ...)
 * can run past a skipped dependency, so it counts as "runs on every event" and `needs` is
 * ignored -- an unfamiliar guard fails the schedule checks rather than passing them.
 */
function eventsFor(w: Workflow, name: string, seen: Set<string> = new Set()): Set<string> {
  const job = w.jobs[name]
  if (!job || seen.has(name)) return new Set()
  const guard = (job.if ?? '').trim()
  let own: string[]
  if (guard === "github.event_name == 'schedule'") own = ['schedule']
  else if (guard === "github.event_name == 'workflow_dispatch'") own = ['workflow_dispatch']
  else if (guard === '') own = ALL_EVENTS
  else return new Set(ALL_EVENTS)
  const needs = job.needs === undefined ? [] : [job.needs].flat()
  const next = new Set([...seen, name])
  return new Set(own.filter((e) => needs.every((n) => eventsFor(w, n, next).has(e))))
}

const jobsOn = (w: Workflow, event: string): string[] =>
  Object.keys(w.jobs).filter((name) => eventsFor(w, name).has(event))

/**
 * The ENTIRE observe job, key for key and value for value. Anything a scheduled run can be
 * steered by -- a step `shell:` or `working-directory:`, checkout `repository:`/`ref:`, a
 * different action SHA, extra env, `services`, `container`, a reusable `uses`, or a guard that
 * never fires -- differs from this object, so an allow-list this exact cannot be evaded by a
 * key the predicate forgot to inspect. Changing the observer job means changing this too.
 */
const EXPECTED_OBSERVE = {
  name: 'Observe Metadata Refresh',
  if: "github.event_name == 'schedule'",
  'runs-on': 'ubuntu-latest',
  'timeout-minutes': 10,
  permissions: { contents: 'read' },
  steps: [
    {
      name: 'Checkout',
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: {
        'sparse-checkout': OBSERVER,
        'sparse-checkout-cone-mode': false,
        'persist-credentials': false,
      },
    },
    {
      name: 'Run refresh observer',
      env: {
        SKILLSMITH_REFRESH_OBSERVER_ALERT_DISABLE:
          '${{ vars.SKILLSMITH_REFRESH_OBSERVER_ALERT_DISABLE }}',
      },
      run: `bash ${OBSERVER}`,
    },
  ],
}

/** Workflow-level keys and env: `defaults` (e.g. a run shell) or env such as BASH_ENV would reach every step. */
const EXPECTED_TOP_KEYS = ['name', 'on', 'env', 'jobs']
const EXPECTED_ENV = {
  SUPABASE_URL: '${{ secrets.SUPABASE_URL }}',
  SUPABASE_SERVICE_ROLE_KEY: '${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}',
}

/** Deep equality with key order ignored. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/**
 * Everything that may run on a schedule: the workflow carries only the expected top-level keys
 * and env, the observe job is exactly EXPECTED_OBSERVE (so its guard is the exact schedule
 * guard and the observer really runs), and no other job is reachable on schedule. An
 * allow-list rather than a search for the function URL, which a constructed URL evades.
 */
function scheduleRunsOnlyObserver(w: Workflow): boolean {
  const top = Object.keys(w).sort()
  if (!same(top, [...EXPECTED_TOP_KEYS].sort())) return false
  if (!same(w.env, EXPECTED_ENV)) return false
  if (!same(w.jobs.observe, EXPECTED_OBSERVE)) return false
  return same(jobsOn(w, 'schedule'), ['observe'])
}

/** Every string a job can execute or pass on: step runs, uses, with, env, and job env. */
const jobText = (j: Job): string => JSON.stringify([j.env ?? {}, j.steps])

const postsFunction = (j: Job): boolean => jobText(j).includes(FUNCTION_PATH)

const step0 = (w: Workflow): string =>
  w.jobs.refresh.steps.find((s) => s.name === 'Trigger Metadata Refresh')?.run ?? ''

describe('refresh-metadata.yml (SMI-7114 W3b)', () => {
  const wf = load()

  it('keeps the 4-hourly schedule the dead-man SLA was sized from (known-negative: another cron)', () => {
    const crons = (w: Workflow) => (w.on.schedule ?? []).map((s) => s.cron)
    expect(crons(wf)).toEqual(['30 */4 * * *'])
    const bad = clone(wf)
    bad.on.schedule = [{ cron: '30 */6 * * *' }]
    expect(crons(bad)).not.toEqual(['30 */4 * * *'])
  })

  it('on schedule, only the observer job runs, and only checkout plus the observer script (known-negative: each escape)', () => {
    expect(scheduleRunsOnlyObserver(wf)).toBe(true)
    expect(jobsOn(wf, 'schedule')).toEqual(['observe'])

    const mutations: Array<(w: Workflow) => void> = [
      // the refresh job loses its guard and runs on schedule too
      (w) => delete w.jobs.refresh.if,
      // a scheduled step builds the function URL from pieces
      (w) =>
        w.jobs.observe.steps.push({
          run: 'SUFFIX=metadata\ncurl -X POST "$SUPABASE_URL/functions/v1/skills-refresh-$SUFFIX"',
        }),
      // the observer depends on the manual-only job, so GitHub skips it on schedule
      (w) => (w.jobs.observe.needs = 'refresh'),
      // the refresh job runs past its skipped dependency
      (w) => {
        w.jobs.refresh.needs = 'observe'
        w.jobs.refresh.if = 'always()'
      },
      // extra work smuggled into the observer job or its run step
      (w) => ((w.jobs.observe as unknown as Record<string, unknown>).services = { db: {} }),
      (w) => (w.jobs.observe.steps[1].run = `bash ${OBSERVER}\ncurl -X POST "$X"`),
      // round-2 gate survivors: a shell override, another repo's script, a guard that never fires
      (w) =>
        ((w.jobs.observe.steps[1] as Record<string, unknown>).shell =
          'bash -c "curl $X; bash $1" -- {0}'),
      (w) => ((w.jobs.observe.steps[0].with ??= {}).repository = 'someone/else'),
      (w) => (w.jobs.observe.if = '${{ false }}'),
      (w) => (w.jobs.observe.if = "${{ github.event_name == 'workflow_dispatch' }}"),
      // workflow-wide reach: run defaults, or env that bash sources before every script
      (w) => ((w as unknown as Record<string, unknown>).defaults = { run: { shell: 'sh' } }),
      (w) => ((w.env ??= {}).BASH_ENV = '/tmp/x'),
      (w) => ((w.jobs.observe.steps[1] as Record<string, unknown>)['working-directory'] = '/tmp'),
    ]
    for (const mutate of mutations) {
      const bad = clone(wf)
      mutate(bad)
      expect(scheduleRunsOnlyObserver(bad)).toBe(false)
    }
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
