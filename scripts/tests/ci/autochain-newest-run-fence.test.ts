/**
 * SMI-7112: scripts/ci/autochain-newest-run-fence.sh must let the autochain
 * dispatch ONLY while the completed run is still the newest indexer-backfill.yml
 * run. A newer run in ANY status (including a "delayed" one that appears only after
 * the earlier list calls) skips LOUDLY and non-zero; any unreadable state is also
 * non-zero. A stubbed `gh` plays each outcome; nothing calls GitHub.
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

// `gh api <path>`: runs/<id> -> $STUB_DIR/run.json ; list page N -> $STUB_DIR/pageN.json ;
// a missing file is an API error (exit 1). Every call is logged.
const GH_STUB = `#!/usr/bin/env bash
echo "$*" >> "$STUB_DIR/calls.log"
p="$2"
case "$p" in
  *"/workflows/indexer-backfill.yml/runs?"*)
    n=$(printf '%s' "$p" | sed -n 's/.*[?&]page=\\([0-9]*\\).*/\\1/p')
    f="$STUB_DIR/page$n.json" ;;
  *"/actions/runs/"*) f="$STUB_DIR/run.json" ;;
  *) exit 99 ;;
esac
[ -f "$f" ] || { echo "gh: HTTP 502" >&2; exit 1; }
cat "$f"
`

const run = (id: number, status: string, created_at: string) => ({ id, status, created_at })
const full = (from: number) =>
  Array.from({ length: 100 }, (_, i) => run(from + i, 'completed', '2026-10-12T09:00:00Z'))

function drive(
  pages: Record<number, unknown> | null,
  opts: { runBody?: unknown; env?: Record<string, string> } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), 'smi7112-fence-'))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'gh'), GH_STUB)
  chmodSync(join(dir, 'bin', 'gh'), 0o755)
  writeFileSync(
    join(dir, 'run.json'),
    JSON.stringify(
      'runBody' in opts
        ? opts.runBody
        : { id: Number(RUN_ID), created_at: CREATED, status: 'completed' }
    )
  )
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

  it.each([
    ['an entry without created_at', [{ id: 1, status: 'completed' }]],
    ['an entry without status', [{ id: 1, created_at: '2026-10-12T09:00:00Z' }]],
    [
      'an entry with a string id',
      [{ id: '1', status: 'completed', created_at: '2026-10-12T09:00:00Z' }],
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
  ])('bad input (%s) => exit 1 WITHOUT calling gh', (_l, env) => {
    const r = drive({ 1: [SELF] }, { env })
    expect(r.status, r.out).toBe(1)
    expect(r.calls).toBe('')
  })
})
