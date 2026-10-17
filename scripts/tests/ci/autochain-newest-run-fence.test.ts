/**
 * SMI-7112: scripts/ci/autochain-newest-run-fence.sh must let the autochain
 * dispatch ONLY while the triggering ATTEMPT is still the newest indexer-backfill.yml
 * activity. A newer run in ANY status (including a "delayed" one that appears only after
 * the earlier list calls) skips LOUDLY and non-zero; a re-run (same run id, advanced
 * run_attempt / run_started_at) is a newer attempt, not a no-op; any unreadable state is
 * also non-zero. A stubbed `gh` plays each outcome; nothing calls GitHub.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'ci', 'autochain-newest-run-fence.sh')
const RUN_ID = '5000'
const CREATED = '2026-10-12T10:00:00Z'

// `gh api <path>`: runs/<id> -> $STUB_DIR/run.json (or, after STUB_RUN2_AFTER calls to it,
// run2.json: a re-run landing mid-fence) ; created-filtered list page N -> pageN.json ;
// status=<s> list page N -> status-<s>-pageN.json (absent = an empty list, unless
// STATUS_ERR is set) ; any other missing file is an API error (exit 1). Every call is logged.
const GH_STUB = `#!/usr/bin/env bash
echo "$*" >> "$STUB_DIR/calls.log"
p="$2"
case "$p" in
  *"/workflows/indexer-backfill.yml/runs?"*)
    n=$(printf '%s' "$p" | sed -n 's/.*[?&]page=\\([0-9]*\\).*/\\1/p')
    st=$(printf '%s' "$p" | sed -n 's/.*[?&]status=\\([a-z_]*\\).*/\\1/p')
    if [ -n "$st" ]; then
      [ -z "\${STATUS_ERR:-}" ] || { echo "gh: HTTP 502" >&2; exit 1; }
      f="$STUB_DIR/status-$st-page$n.json"
      [ -f "$f" ] || { echo '{"workflow_runs":[]}'; exit 0; }
    else
      f="$STUB_DIR/page$n.json"
    fi ;;
  *"/actions/runs/"*)
    echo x >> "$STUB_DIR/runreads.log"
    f="$STUB_DIR/run.json"
    if [ -f "$STUB_DIR/run2.json" ] && [ "$(wc -l < "$STUB_DIR/runreads.log")" -gt 1 ]; then f="$STUB_DIR/run2.json"; fi ;;
  *) exit 99 ;;
esac
[ -f "$f" ] || { echo "gh: HTTP 502" >&2; exit 1; }
cat "$f"
`

// run_started_at defaults to created_at (an attempt-1 run); a re-run advances it.
const run = (id: number, status: string, created_at: string, run_started_at = created_at) => ({
  id,
  status,
  created_at,
  run_started_at,
})
const trigger = (over: Record<string, unknown> = {}) => ({
  id: Number(RUN_ID),
  created_at: CREATED,
  run_started_at: CREATED,
  run_attempt: 1,
  status: 'completed',
  ...over,
})
const full = (from: number) =>
  Array.from({ length: 100 }, (_, i) => run(from + i, 'completed', '2026-10-12T09:00:00Z'))

function drive(
  pages: Record<number, unknown> | null,
  opts: {
    runBody?: unknown
    run2Body?: unknown
    status?: Record<string, unknown>
    env?: Record<string, string>
  } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), 'smi7112-fence-'))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'gh'), GH_STUB)
  chmodSync(join(dir, 'bin', 'gh'), 0o755)
  writeFileSync(join(dir, 'run.json'), JSON.stringify('runBody' in opts ? opts.runBody : trigger()))
  if ('run2Body' in opts) writeFileSync(join(dir, 'run2.json'), JSON.stringify(opts.run2Body))
  for (const [st, runs] of Object.entries(opts.status ?? {}))
    writeFileSync(join(dir, `status-${st}-page1.json`), JSON.stringify({ workflow_runs: runs }))
  for (const [n, body] of Object.entries(pages ?? {}))
    writeFileSync(
      join(dir, `page${n}.json`),
      typeof body === 'string' ? body : JSON.stringify({ workflow_runs: body })
    )
  const summary = join(dir, 'summary.md')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
    STUB_DIR: dir,
    GH_TOKEN: 'tok',
    GITHUB_REPOSITORY: 'smith-horn/skillsmith',
    COMPLETED_RUN_ID: RUN_ID,
    TRIGGER_RUN_ATTEMPT: '1',
    TRIGGER_EVENT: 'workflow_run',
    GITHUB_STEP_SUMMARY: summary,
    ...opts.env,
  }
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]
  const r = spawnSync('bash', [SCRIPT], { env, encoding: 'utf8', timeout: 30_000 })
  const read = (f: string) => {
    try {
      return readFileSync(f, 'utf8')
    } catch {
      return ''
    }
  }
  return {
    status: r.status,
    out: (r.stdout ?? '') + (r.stderr ?? ''),
    summary: read(summary),
    calls: read(join(dir, 'calls.log')),
  }
}

const SELF = run(5000, 'completed', CREATED)

describe('autochain-newest-run-fence.sh', () => {
  it('CONTROL: the completed run is the only/newest run => exit 0', () => {
    const r = drive({ 1: [SELF, run(4999, 'completed', '2026-10-12T09:59:00Z')] })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/Fence passed/)
    // CONTROL for the status scans: every one of the five non-terminal statuses was read
    for (const s of ['queued', 'in_progress', 'waiting', 'pending', 'requested'])
      expect(r.calls, s).toContain(`status=${s}`)
  })

  it.each(['queued', 'in_progress', 'waiting', 'completed', 'requested', 'pending'])(
    'a NEWER run in status %s => exit 3, warning AND step summary name it',
    (status) => {
      const r = drive({ 1: [SELF, run(5001, status, '2026-10-12T10:05:00Z')] })
      expect(r.status, r.out).toBe(3)
      expect(r.out).toMatch(/::warning::.*5001:/)
      expect(r.summary).toMatch(/NOT dispatched/)
      expect(r.summary).toContain(`5001:${status}`)
    }
  )

  it('a run created in the same second as the completed run (not itself) counts as newer', () => {
    const r = drive({ 1: [SELF, run(5002, 'queued', CREATED)] })
    expect(r.status, r.out).toBe(3)
  })

  it('an OLDER run does not trip the fence', () => {
    const r = drive({ 1: [SELF, run(4000, 'in_progress', '2026-10-12T09:59:59Z')] })
    expect(r.status, r.out).toBe(0)
  })

  it('a delayed run that only exists by the time of the fence read (e.g. a handover first link) => exit 3', () => {
    // The fence is the LAST read before the dispatch, so a run appearing after any
    // earlier check is still seen here.
    const r = drive({ 1: [SELF, run(7001, 'queued', '2026-10-12T10:00:30Z')] })
    expect(r.status, r.out).toBe(3)
  })

  it('a newer run on page 2 is found => exit 3', () => {
    const r = drive({
      1: [SELF, ...full(100).slice(1)],
      2: [run(9001, 'in_progress', '2026-10-12T11:00:00Z')],
    })
    expect(r.status, r.out).toBe(3)
    expect(r.out).toMatch(/9001:in_progress/)
  })

  it('a full page 1 whose page 2 cannot be read => exit 1 (never a pass)', () => {
    const r = drive({ 1: [SELF, ...full(100).slice(1)] })
    expect(r.status, r.out).toBe(1)
    expect(r.out).toMatch(/page 2/)
  })

  it.each([
    ['no created_at', {}],
    ['a malformed created_at', { created_at: 'yesterday' }],
    ['no run_started_at', trigger({ run_started_at: undefined })],
    ['a malformed run_started_at', trigger({ run_started_at: 'soon' })],
    ['no run_attempt', trigger({ run_attempt: undefined })],
    ['a non-integer run_attempt', trigger({ run_attempt: '1' })],
    ['a zero run_attempt', trigger({ run_attempt: 0 })],
  ])('the completed run body has %s => exit 1', (_l, body) => {
    const r = drive({ 1: [SELF] }, { runBody: body })
    expect(r.status, r.out).toBe(1)
    expect(r.calls).not.toMatch(/indexer-backfill\.yml\/runs\?/)
  })

  it.each([
    ['not JSON', 'not json {'],
    ['{} (no workflow_runs)', '{}'],
  ])('the list body is %s => exit 1', (_l, body) => {
    const r = drive({ 1: body })
    expect(r.status, r.out).toBe(1)
  })

  it('no list page at all (API error) => exit 1', () => {
    const r = drive(null)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toMatch(/cannot list/)
  })

  it('a status-filtered list that errors => exit 1 (the non-terminal scan fails closed)', () => {
    const r = drive({ 1: [SELF] }, { env: { STATUS_ERR: '1' } })
    expect(r.status, r.out).toBe(1)
    expect(r.out).toMatch(/cannot list.*status=queued/)
  })

  it.each([
    ['an entry without created_at', [{ id: 1, status: 'completed' }]],
    [
      'an entry without run_started_at',
      [{ id: 1, status: 'completed', created_at: '2026-10-12T09:00:00Z' }],
    ],
    [
      'an entry with a malformed run_started_at',
      [{ id: 1, status: 'completed', created_at: '2026-10-12T09:00:00Z', run_started_at: 'x' }],
    ],
    ['an entry without status', [{ id: 1, created_at: '2026-10-12T09:00:00Z' }]],
    [
      'an entry with a string id',
      [
        {
          id: '1',
          status: 'completed',
          created_at: '2026-10-12T09:00:00Z',
          run_started_at: '2026-10-12T09:00:00Z',
        },
      ],
    ],
  ])('the list has %s => exit 1', (_l, runs) => {
    const r = drive({ 1: runs })
    expect(r.status, r.out).toBe(1)
  })

  it.each([
    ['GH_TOKEN', { GH_TOKEN: '' }],
    ['GITHUB_REPOSITORY', { GITHUB_REPOSITORY: '' }],
    ['a non-numeric COMPLETED_RUN_ID', { COMPLETED_RUN_ID: '12;rm' }],
    ['an empty COMPLETED_RUN_ID', { COMPLETED_RUN_ID: '' }],
    ['an empty TRIGGER_RUN_ATTEMPT', { TRIGGER_RUN_ATTEMPT: '' }],
    ['a non-numeric TRIGGER_RUN_ATTEMPT', { TRIGGER_RUN_ATTEMPT: '2;x' }],
    ['a zero TRIGGER_RUN_ATTEMPT', { TRIGGER_RUN_ATTEMPT: '0' }],
    ['an unknown TRIGGER_EVENT', { TRIGGER_EVENT: 'push' }],
  ])('bad input (%s) => exit 1 WITHOUT calling gh', (_l, env) => {
    const r = drive({ 1: [SELF] }, { env })
    expect(r.status, r.out).toBe(1)
    expect(r.calls).toBe('')
  })
  describe('re-runs (same run id, advanced run_attempt / run_started_at)', () => {
    const LATER = '2026-10-12T10:30:00Z'

    it('a re-run of an OLDER run (old created_at, new run_started_at) in a list => exit 3', () => {
      const rerun = run(4000, 'in_progress', '2026-10-12T08:00:00Z', LATER)
      const r = drive({ 1: [SELF, rerun] })
      expect(r.status, r.out).toBe(3)
      expect(r.out).toMatch(/4000:in_progress/)
    })

    it('a re-run of an OLDER run is found by the NON-TERMINAL scan (a created filter would hide it)', () => {
      // page1 stands for the created>= list, which the real API would NOT return it in.
      const rerun = run(4000, 'queued', '2026-10-12T08:00:00Z', LATER)
      const r = drive({ 1: [SELF] }, { status: { queued: [rerun] } })
      expect(r.status, r.out).toBe(3)
      expect(r.out).toMatch(/4000:queued/)
      expect(r.summary).toContain('4000:queued')
    })

    it('CONTROL: an older run, NOT re-run (old created_at AND old run_started_at), still passes', () => {
      const old = run(4000, 'in_progress', '2026-10-12T08:00:00Z', '2026-10-12T08:00:05Z')
      const r = drive({ 1: [SELF] }, { status: { in_progress: [old] } })
      expect(r.status, r.out).toBe(0)
    })

    it('the TRIGGERING run itself was re-run (current run_attempt 2 > triggering 1) => exit 3, no list read', () => {
      const r = drive(
        { 1: [SELF] },
        { runBody: trigger({ run_attempt: 2, run_started_at: LATER }) }
      )
      expect(r.status, r.out).toBe(3)
      expect(r.out).toMatch(/::warning::.*attempt 2.*re-run/)
      expect(r.summary).toMatch(/NOT dispatched/)
      expect(r.calls).not.toMatch(/indexer-backfill\.yml\/runs\?/)
    })

    it('the triggering run is re-run WHILE the fence reads (attempt 1 at first, 2 at the end) => exit 3', () => {
      const r = drive(
        { 1: [SELF] },
        { run2Body: trigger({ run_attempt: 2, run_started_at: LATER }) }
      )
      expect(r.status, r.out).toBe(3)
      expect(r.out).toMatch(/became attempt 2 while the fence was reading/)
      // it got past the scans first: the re-run was only visible at the final re-read
      expect(r.calls).toContain('status=requested')
    })

    it('a workflow_run whose own attempt is 2 never chains, even when nothing newer exists => exit 3', () => {
      const r = drive(
        { 1: [SELF] },
        {
          runBody: trigger({ run_attempt: 2, run_started_at: LATER }),
          env: { TRIGGER_RUN_ATTEMPT: '2' },
        }
      )
      expect(r.status, r.out).toBe(3)
      expect(r.out).toMatch(/attempt 2 \(a re-run\).*does NOT continue the chain/)
      expect(r.summary).toMatch(/NOT dispatched/)
      expect(r.calls).toBe('') // refused before any API call
    })

    it('a MANUAL dispatch naming attempt 2 for a run that is at attempt 2 is not refused on attempt alone', () => {
      const r = drive(
        { 1: [SELF] },
        {
          runBody: trigger({ run_attempt: 2, run_started_at: LATER }),
          env: { TRIGGER_RUN_ATTEMPT: '2', TRIGGER_EVENT: 'workflow_dispatch' },
        }
      )
      expect(r.status, r.out).toBe(0)
    })

    it('a MANUAL dispatch naming attempt 1 for a run now at attempt 2 is refused (stale operator input)', () => {
      const r = drive(
        { 1: [SELF] },
        {
          runBody: trigger({ run_attempt: 2, run_started_at: LATER }),
          env: { TRIGGER_EVENT: 'workflow_dispatch' },
        }
      )
      expect(r.status, r.out).toBe(3)
    })
  })

  describe('TRIGGER_EVENT=schedule (SMI-7121 resume) has exactly the workflow_dispatch semantics', () => {
    const LATER = '2026-10-12T10:30:00Z'

    it('CONTROL: a schedule resume of the newest run => exit 0', () => {
      const r = drive({ 1: [SELF] }, { env: { TRIGGER_EVENT: 'schedule' } })
      expect(r.status, r.out).toBe(0)
      expect(r.out).toContain('Fence passed')
    })

    it('is not refused on attempt alone: the marker names attempt 2 of a run at attempt 2 => exit 0', () => {
      const r = drive(
        { 1: [SELF] },
        {
          runBody: trigger({ run_attempt: 2, run_started_at: LATER }),
          env: { TRIGGER_RUN_ATTEMPT: '2', TRIGGER_EVENT: 'schedule' },
        }
      )
      expect(r.status, r.out).toBe(0)
    })

    it('check (b) applies: the marker names attempt 1 but the run is now at attempt 2 => exit 3', () => {
      const r = drive(
        { 1: [SELF] },
        {
          runBody: trigger({ run_attempt: 2, run_started_at: LATER }),
          env: { TRIGGER_EVENT: 'schedule' },
        }
      )
      expect(r.status, r.out).toBe(3)
      expect(r.out).toMatch(/now attempt 2 .* re-run/)
    })

    it('check (c) applies: a later run exists => exit 3', () => {
      const r = drive(
        { 1: [SELF, run(5001, 'completed', '2026-10-12T10:05:00Z')] },
        { env: { TRIGGER_EVENT: 'schedule' } }
      )
      expect(r.status, r.out).toBe(3)
      expect(r.out).toMatch(/5001:completed/)
    })

    it('an unreadable run list => exit 1 (never a pass)', () => {
      const r = drive(null, { env: { TRIGGER_EVENT: 'schedule' } })
      expect(r.status, r.out).toBe(1)
    })
  })
})
