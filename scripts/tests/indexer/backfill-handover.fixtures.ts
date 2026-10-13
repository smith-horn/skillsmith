/**
 * SMI-7112: shared fixtures for the backfill-handover-check.sh tests. Not a
 * `*.test.ts` file, so vitest does not collect it.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO, makeSeam, type Seam } from './backfill-driver.test-helpers.ts'

export const WORKFLOWS = ['indexer-backfill.yml', 'indexer-backfill-autochain.yml']
export const STATUSES = ['queued', 'in_progress', 'waiting', 'pending', 'requested']
export const DONE_AT = '2026-10-12T10:00:00Z'

export const statusPath = (wf: string, s: string) =>
  `repos/${REPO}/actions/workflows/${wf}/runs?status=${s}&per_page=1`
export const listPage = (n: number) =>
  `repos/${REPO}/actions/workflows/indexer-backfill-autochain.yml/runs?per_page=100&page=${n}`
export const AUTOCHAIN_LIST = listPage(1)
export const runPath = (id: number) => `repos/${REPO}/actions/runs/${id}`

/** Every dispatch input the driver records; --first-link replays them exactly. */
export const FULL_PARAMS = {
  mode: 'RESUME',
  ref: 'main',
  dry_run: false,
  resume_from: 'latest',
  path_prefix: '.gemini/skills',
  min_size_bytes: 2048,
  max_ranges: 7,
  max_skills_per_dispatch: 4321,
  max_skills_per_repo: 33,
  max_elapsed_minutes: 199,
}

export function intentLines(events: object[]) {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n'
}

/** Write the intent log: one resolved intent (run 500) carrying `params`. */
export function writeIntent(seam: Seam, params: unknown) {
  writeFileSync(
    join(seam.dir, 'intents.jsonl'),
    intentLines([
      { event: 'intent', token: 'drv-1-aaaaaaaa', issued_at: '2026-10-12T09:00:00Z', params },
      { event: 'resolved', token: 'drv-1-aaaaaaaa', run_id: 500 },
    ])
  )
}

/** Everything passes: one resolved+completed intent, zero non-terminal runs, no open autochain runs. */
export function allClear(): Seam {
  const seam = makeSeam({ STUB_RUNS_MODE: 'one', STUB_RUN_ID: '111' })
  writeIntent(seam, FULL_PARAMS)
  seam.fixture(runPath(111), { status: 'in_progress' }) // the first link, once dispatched
  seam.fixture(runPath(500), { status: 'completed', updated_at: DONE_AT })
  for (const wf of WORKFLOWS)
    for (const s of STATUSES) seam.fixture(statusPath(wf, s), { total_count: 0, workflow_runs: [] })
  seam.fixture(AUTOCHAIN_LIST, {
    workflow_runs: [{ id: 9, status: 'completed', created_at: '2026-10-12T11:00:00Z' }],
  })
  return seam
}

export const verdict = (r: { stdout: string }) => r.stdout.trim().split('\n').pop()
