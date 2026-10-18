/**
 * SMI-7121 (V3): scripts/ci/autochain-tick-yield.sh makes a scheduled resume tick stop
 * quietly while any NON-schedule autochain run (a link or a manual dispatch) is queued or
 * running, and is red when that cannot be determined. A stubbed `gh` plays each status
 * list; nothing calls GitHub.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const SCRIPT = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
  'scripts/ci/autochain-tick-yield.sh'
)
const STATUSES = ['queued', 'in_progress', 'waiting', 'pending', 'requested']

// `gh api <path>`: status=<s> -> $STUB_DIR/<s>.json if present, else an empty list;
// $STUB_DIR/<s>.err makes that status an API error. Every call is logged.
const GH_STUB = `#!/usr/bin/env bash
echo "$*" >> "$STUB_DIR/calls.log"
st=$(printf '%s' "$2" | sed -n 's/.*[?&]status=\\([a-z_]*\\).*/\\1/p')
[ -f "$STUB_DIR/$st.err" ] && { echo "gh: HTTP 502" >&2; exit 1; }
[ -f "$STUB_DIR/$st.json" ] && { cat "$STUB_DIR/$st.json"; exit 0; }
echo '{"total_count":0,"workflow_runs":[]}'
`

const run = (id: number, event: string, display_title?: string) => ({
  id,
  event,
  status: 'x',
  ...(display_title === undefined ? {} : { display_title }),
})
const list = (runs: unknown[], total = runs.length) => ({ total_count: total, workflow_runs: runs })

function drive(
  bodies: Record<string, unknown> = {},
  opts: { err?: string[]; env?: Record<string, string> } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), 'smi7121-yield-'))
  writeFileSync(join(dir, 'gh'), GH_STUB)
  chmodSync(join(dir, 'gh'), 0o755)
  for (const [s, b] of Object.entries(bodies))
    writeFileSync(join(dir, `${s}.json`), typeof b === 'string' ? b : JSON.stringify(b))
  for (const s of opts.err ?? []) writeFileSync(join(dir, `${s}.err`), '')
  const envFile = join(dir, 'github_env')
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      STUB_DIR: dir,
      GH_TOKEN: 't',
      GITHUB_REPOSITORY: 'smith-horn/skillsmith',
      GITHUB_RUN_ID: '900',
      GITHUB_ENV: envFile,
      ...opts.env,
    },
  })
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
  return {
    status: r.status,
    out: r.stdout + r.stderr,
    githubEnv: read(envFile),
    calls: read(join(dir, 'calls.log')),
  }
}

describe('autochain-tick-yield.sh', () => {
  it('CONTROL: no non-terminal autochain run => proceeds (no skip), every status checked', () => {
    const r = drive()
    expect(r.status, r.out).toBe(0)
    expect(r.githubEnv).toBe('')
    for (const s of STATUSES)
      expect(r.calls).toContain(
        `repos/smith-horn/skillsmith/actions/workflows/indexer-backfill-autochain.yml/runs?status=${s}&per_page=100`
      )
  })

  it.each([
    ['a queued workflow_run link', 'queued', 'workflow_run'],
    ['a running workflow_run link', 'in_progress', 'workflow_run'],
    ['a waiting manual dispatch', 'waiting', 'workflow_dispatch'],
    ['a pending link', 'pending', 'workflow_run'],
    ['a requested link', 'requested', 'workflow_run'],
  ])('%s => the tick yields quietly (skip=true, exit 0)', (_l, s, event) => {
    const r = drive({ [s]: list([run(77, event)]) })
    expect(r.status, r.out).toBe(0)
    expect(r.githubEnv).toBe('skip=true\n')
    expect(r.out).toContain(`77:${event} (${s})`)
  })

  it('other schedule ticks, and this tick itself, never make it yield', () => {
    const r = drive({ in_progress: list([run(900, 'workflow_run'), run(901, 'schedule')]) })
    expect(r.status, r.out).toBe(0)
    expect(r.githubEnv).toBe('')
  })

  // SMI-7142: a mode=resume workflow_dispatch is a resume, not a link. Its event is
  // workflow_dispatch, so only the exact run-name tells it apart.
  const RESUME_TITLE = 'Skill Indexer Backfill Autochain [resume]'
  it('a queued mode=resume dispatch (exact tagged title) never makes the tick yield', () => {
    const r = drive({ queued: list([run(77, 'workflow_dispatch', RESUME_TITLE)]) })
    expect(r.status, r.out).toBe(0)
    expect(r.githubEnv).toBe('')
  })

  it.each([
    ['[resume] in the old source position', `${RESUME_TITLE} ([resume])`],
    ['[resume] in a parenthesised source', 'Skill Indexer Backfill Autochain ([resume])'],
    ['[resume] as a prefix', `[resume] ${RESUME_TITLE}`],
    ['[resume] followed by anything', `${RESUME_TITLE} (pg_cron-prod)`],
    ['[resume] followed by a space', `${RESUME_TITLE} `],
    ['[resume] in the middle', 'Skill Indexer Backfill Autochain x [resume] y'],
    ['a different workflow prefix', 'Other [resume]'],
  ])('a link whose title carries %s still makes the tick yield', (_l, title) => {
    const r = drive({ in_progress: list([run(77, 'workflow_dispatch', title)]) })
    expect(r.status, r.out).toBe(0)
    expect(r.githubEnv).toBe('skip=true\n')
    expect(r.out).toMatch(/\b77:workflow_dispatch\b/)
  })

  it('a manual link dispatch (untagged title) still makes the tick yield, and only it is reported', () => {
    const r = drive({
      in_progress: list([
        run(77, 'workflow_dispatch', 'Skill Indexer Backfill Autochain'),
        run(78, 'workflow_dispatch', RESUME_TITLE),
      ]),
    })
    expect(r.status, r.out).toBe(0)
    expect(r.githubEnv).toBe('skip=true\n')
    expect(r.out).toMatch(/\b77:workflow_dispatch\b/)
    expect(r.out).not.toContain('78:')
  })

  it('an entry with no display_title is treated as a link (the safe side), not as a resume', () => {
    const r = drive({ queued: list([run(77, 'workflow_dispatch')]) })
    expect(r.githubEnv).toBe('skip=true\n')
  })

  it('a workflow_run link is never excluded by a title', () => {
    const r = drive({ queued: list([run(77, 'workflow_run', 'Skill Indexer Backfill Autochain')]) })
    expect(r.githubEnv).toBe('skip=true\n')
  })

  it.each([
    ['an API error', {}, ['waiting']],
    ['an unreadable body', { queued: 'not json' }, []],
    ['an entry without event', { queued: list([{ id: 1 }]) }, []],
    ['a body without total_count', { queued: { workflow_runs: [] } }, []],
    ['more runs than one page shows', { in_progress: list([run(1, 'schedule')], 150) }, []],
  ] as [string, Record<string, unknown>, string[]][])(
    '%s => exit 1 (red), no skip',
    (_l, bodies, err) => {
      const r = drive(bodies, { err })
      expect(r.status, r.out).toBe(1)
      expect(r.githubEnv).toBe('')
      expect(r.out).toMatch(/::error::autochain-tick-yield/)
    }
  )

  it('a non-numeric GITHUB_RUN_ID => exit 1 without calling gh', () => {
    const r = drive({}, { env: { GITHUB_RUN_ID: '9;x' } })
    expect(r.status).toBe(1)
    expect(r.calls).toBe('')
  })
})
