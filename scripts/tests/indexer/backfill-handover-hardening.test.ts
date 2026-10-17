/**
 * SMI-7112 confirmation-review fixes for backfill-handover-check.sh:
 *  - syntactically valid but INCOMPLETE bodies are NO-GO (never "completed undefined");
 *  - the autochain run list is paginated to the end;
 *  - --first-link flips BACKFILL_AUTOCHAIN_DISABLE to 0 LAST, and replays every
 *    dispatch input of the last intent exactly (a missing field is NO-GO).
 * Real script, stubbed `gh`; nothing calls GitHub.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { HELPER, runScript, type Seam } from './backfill-driver.test-helpers.ts'
import {
  FULL_PARAMS,
  allClear,
  listPage,
  runPath,
  statusPath,
  verdict,
  writeIntent,
} from './backfill-handover.fixtures.ts'

const completedRun = (id: number) => ({
  id,
  status: 'completed',
  created_at: '2026-10-12T11:00:00Z',
})

describe('incomplete-but-valid JSON bodies are NO-GO', () => {
  it.each([
    ['a completed run without updated_at', { status: 'completed' }],
    ['a completed run with a malformed updated_at', { status: 'completed', updated_at: 'soon' }],
    ['an empty object', {}],
    ['a run with a non-string status', { status: 7, updated_at: '2026-10-12T10:00:00Z' }],
  ])('intent run lookup returns %s', (_l, body) => {
    const seam = allClear()
    seam.fixture(runPath(500), body)
    const r = runScript(HELPER, [], seam)
    expect(verdict(r), r.out).toBe('NO-GO')
    expect(r.out).toMatch(/unreadable or incomplete body/)
  })

  it.each([
    ['an entry without created_at', [{ id: 9, status: 'completed' }]],
    ['an entry with a malformed created_at', [{ id: 9, status: 'completed', created_at: 'x' }]],
    [
      'an entry with a string id',
      [{ id: '9', status: 'completed', created_at: '2026-10-12T11:00:00Z' }],
    ],
    ['an entry without status', [{ id: 9, created_at: '2026-10-12T11:00:00Z' }]],
  ])('autochain list contains %s', (_l, runs) => {
    const seam = allClear()
    seam.fixture(listPage(1), { workflow_runs: runs })
    const r = runScript(HELPER, [], seam)
    expect(verdict(r), r.out).toBe('NO-GO')
    expect(r.out).toMatch(/unreadable or had an incomplete entry/)
  })

  it('autochain list body without workflow_runs is NO-GO', () => {
    const seam = allClear()
    seam.fixture(listPage(1), {})
    expect(verdict(runScript(HELPER, [], seam))).toBe('NO-GO')
  })

  it('a status-count body without total_count is NO-GO', () => {
    const seam = allClear()
    seam.fixture(statusPath('indexer-backfill.yml', 'queued'), { workflow_runs: [] })
    expect(verdict(runScript(HELPER, [], seam))).toBe('NO-GO')
  })
})

describe('(c) pagination', () => {
  const full = Array.from({ length: 100 }, (_, i) => completedRun(i + 1))

  it('CONTROL: two pages, all completed => GO and both pages were read', () => {
    const seam = allClear()
    seam.fixture(listPage(1), { workflow_runs: full })
    seam.fixture(listPage(2), { workflow_runs: [completedRun(200)] })
    const r = runScript(HELPER, [], seam)
    expect(verdict(r), r.out).toBe('GO')
    expect(r.out).toMatch(/2 page\(s\) read/)
  })

  it('a non-terminal autochain run on page 2 is NO-GO', () => {
    const seam = allClear()
    seam.fixture(listPage(1), { workflow_runs: full })
    seam.fixture(listPage(2), {
      workflow_runs: [{ id: 200, status: 'in_progress', created_at: '2026-10-12T11:05:00Z' }],
    })
    const r = runScript(HELPER, [], seam)
    expect(verdict(r), r.out).toBe('NO-GO')
    expect(r.out).toMatch(/page 2\): 200:in_progress/)
  })

  it('the list is bounded by creation time: a history that would exceed the old 50-page cap is never paged', () => {
    // SMI-7121: the resume schedule adds ~24 autochain runs a day. With the last completion
    // (DONE_AT) more than 35 days old, (c) lists only from now - 35 days. The unbounded
    // listing is seeded with 51 full pages, so code that pages the whole history reads 50
    // of them and goes NO-GO on the page cap.
    const seam = allClear()
    writeFileSync(join(seam.dir, 'clock'), '1798761600') // 2027-01-01T00:00:00Z
    const since = '2026-11-27T00:00:00Z' // clock - 35 days
    const unbounded = (n: number) =>
      `repos/smith-horn/skillsmith/actions/workflows/indexer-backfill-autochain.yml/runs?per_page=100&page=${n}`
    for (let n = 1; n <= 51; n++) seam.fixture(unbounded(n), { workflow_runs: full })
    seam.fixture(listPage(1, since), {
      workflow_runs: [{ id: 7000, status: 'completed', created_at: '2026-12-31T23:00:00Z' }],
    })
    const r = runScript(HELPER, [], seam)
    expect(verdict(r), r.out).toBe('GO')
    expect(r.out).toContain(`listed from ${since} (lookback 35d)`)
    expect(r.out).toMatch(/none open \(1 page\(s\) read\)/)
    const listCalls = seam
      .calls()
      .split('\n')
      .filter((l) => l.includes('indexer-backfill-autochain.yml/runs?per_page=100'))
    expect(listCalls).toHaveLength(1)
    expect(listCalls[0]).toContain(`created=>=${since}`)
  })

  it('CONTROL: a recent last completion is itself the bound (nothing (c) must see is dropped)', () => {
    const seam = allClear() // seam clock predates DONE_AT, so the bound is DONE_AT
    const r = runScript(HELPER, [], seam)
    expect(verdict(r), r.out).toBe('GO')
    expect(r.out).toContain('listed from 2026-10-12T10:00:00Z (lookback 35d)')
  })

  it('a full page 1 whose page 2 cannot be read is NO-GO', () => {
    const seam = allClear()
    seam.fixture(listPage(1), { workflow_runs: full })
    const r = runScript(HELPER, [], seam)
    expect(verdict(r), r.out).toBe('NO-GO')
    expect(r.out).toMatch(/API error listing autochain runs \(page 2\)/)
  })
})

const order = (seam: Seam, ...needles: string[]) => {
  const log = seam.log()
  return needles.map((n) => log.indexOf(n))
}
const noDispatchNoFlip = (seam: Seam) => {
  expect(seam.count('WORKFLOW_RUN')).toBe(0)
  expect(seam.count('VARIABLE_SET')).toBe(0)
}

describe('--first-link: the variable flips LAST', () => {
  it('re-check fails => NO-GO, no dispatch, no flip, no new intent', () => {
    const seam = allClear()
    seam.fixture(statusPath('indexer-backfill-autochain.yml', 'queued'), {
      total_count: 2,
      workflow_runs: [],
    })
    const r = runScript(HELPER, ['--first-link'], seam)
    expect(verdict(r), r.out).toBe('NO-GO')
    noDispatchNoFlip(seam)
    expect(seam.intents().trim().split('\n')).toHaveLength(2)
  })

  it('passes => ONE dispatch, then (and only then) VARIABLE_SET 0, read back; intent logged first', () => {
    const seam = allClear()
    const r = runScript(HELPER, ['--first-link'], seam)
    expect(verdict(r), r.out).toBe('GO')
    expect(seam.count('WORKFLOW_RUN')).toBe(1)
    expect(seam.count('VARIABLE_SET')).toBe(1)
    const [startRead, dispatch, set] = order(
      seam,
      'FLAG_READ phase=startup value=1',
      'WORKFLOW_RUN',
      'VARIABLE_SET value=0'
    )
    expect(startRead).toBeGreaterThanOrEqual(0)
    expect(startRead).toBeLessThan(dispatch)
    expect(dispatch).toBeLessThan(set)
    expect(seam.log()).toMatch(/WORKFLOW_RUN token=drv-\d+-[0-9a-f]{8} intent_present=1/)
    expect(seam.log().indexOf('FLAG_READ phase=after-set value=0')).toBeGreaterThan(set)
    const events = seam
      .intents()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).event)
    expect(events).toEqual(['intent', 'resolved', 'intent', 'resolved'])
  })

  it.each([
    ['0', '0'],
    ['empty', 'EMPTY'],
    ['a gh error', 'ERR'],
  ])('the variable reading %s at the start => NO-GO before anything else', (_l, v) => {
    const seam = allClear()
    seam.env.STUB_FLAG_STARTUP = v
    const r = runScript(HELPER, ['--first-link'], seam)
    expect(verdict(r), r.out).toBe('NO-GO')
    noDispatchNoFlip(seam)
    expect(seam.intents().trim().split('\n')).toHaveLength(2)
  })

  it('the first link not appearing (token matches no run) => NO-GO, variable never set', () => {
    const seam = allClear()
    seam.env.STUB_RUNS_MODE = 'none'
    const r = runScript(HELPER, ['--first-link'], seam)
    expect(verdict(r), r.out).toBe('NO-GO')
    expect(seam.count('WORKFLOW_RUN')).toBe(1)
    expect(seam.count('VARIABLE_SET')).toBe(0)
  })

  it('the first link already completed / not live => NO-GO, variable never set', () => {
    const seam = allClear()
    seam.fixture(runPath(111), { status: 'completed', updated_at: '2026-10-12T12:00:00Z' })
    const r = runScript(HELPER, ['--first-link'], seam)
    expect(verdict(r), r.out).toBe('NO-GO')
    expect(r.out).toMatch(/not queued\/in_progress/)
    expect(seam.count('VARIABLE_SET')).toBe(0)
    // the operator is told exactly what happened and what to do next
    expect(r.out).toContain(
      'The first link finished before the flip. The variable is still 1, so nothing chained. Run --first-link again to dispatch the next link.'
    )
  })

  it('RECOVERY: a first link that finished before the flip => NO-GO; running --first-link again dispatches the next link and flips', () => {
    const seam = allClear()
    seam.fixture(runPath(111), { status: 'completed', updated_at: '2026-10-12T12:00:00Z' })
    const first = runScript(HELPER, ['--first-link'], seam)
    expect(verdict(first), first.out).toBe('NO-GO')
    expect(seam.count('WORKFLOW_RUN')).toBe(1)
    expect(seam.count('VARIABLE_SET')).toBe(0)

    // The completed first link is a RESOLVED intent carrying every input, so the
    // second run's checks pass, and the next link (a new run) is visible and live.
    seam.env.STUB_RUN_ID = '112'
    seam.fixture(runPath(112), { status: 'in_progress' })
    // its last completion is now run 111's, so check (c) lists from there
    seam.fixture(listPage(1, '2026-10-12T12:00:00Z'), {
      workflow_runs: [{ id: 9, status: 'completed', created_at: '2026-10-12T13:00:00Z' }],
    })
    const second = runScript(HELPER, ['--first-link'], seam)
    expect(verdict(second), second.out).toBe('GO')
    expect(seam.count('WORKFLOW_RUN')).toBe(2)
    expect(seam.count('VARIABLE_SET')).toBe(1)
    expect(seam.log()).toContain('VARIABLE_SET value=0')
    // the second dispatch replays the FIRST link's recorded inputs (not defaults)
    const secondCall = seam
      .calls()
      .split('\n')
      .filter((l) => l.includes('workflow run'))
      .pop()!
    for (const frag of [
      '-f resume_from=latest',
      '-f path_prefix=.gemini/skills',
      '-f min_size_bytes=2048',
      '-f max_ranges=7',
      '-f max_skills_per_dispatch=4321',
      '-f max_skills_per_repo=33',
      '-f max_elapsed_minutes=199',
    ])
      expect(secondCall, frag).toContain(frag)
    const events = seam
      .intents()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).event)
    expect(events).toEqual(['intent', 'resolved', 'intent', 'resolved', 'intent', 'resolved'])
  })

  /** Make the first link (run 111) report `body` the instant the variable is set to 0. */
  const changeRunOnFlip = (seam: Seam, body: object) => {
    const key = runPath(111).replace(/[^a-zA-Z0-9]/g, '_')
    writeFileSync(
      join(seam.dir, 'on-varset.sh'),
      `[ "$1" = "0" ] && printf '%s' '${JSON.stringify(body)}' > "$STUB_DIR/api/${key}.json"\nexit 0\n`
    )
  }
  const varWrites = (seam: Seam) =>
    seam
      .log()
      .split('\n')
      .filter((l) => l.startsWith('VARIABLE_SET'))
      .map((l) => l.replace(/ at=.*/, ''))

  it('ORDERING: the first link completes DURING the flip => the variable is restored to 1, NO-GO, next-step guidance', () => {
    const seam = allClear()
    changeRunOnFlip(seam, { status: 'completed', updated_at: '2026-10-12T12:00:00Z' })
    const r = runScript(HELPER, ['--first-link'], seam)
    expect(verdict(r), r.out).toBe('NO-GO')
    expect(varWrites(seam)).toEqual(['VARIABLE_SET value=0', 'VARIABLE_SET value=1'])
    expect(seam.log()).toMatch(/FLAG_READ phase=after-set value=1/)
    expect(r.out).toContain('completed while the variable was being flipped')
    expect(r.out).toContain('Run --first-link again to dispatch the next link.')
    expect(seam.count('WORKFLOW_RUN')).toBe(1)
  })

  it('ORDERING RECOVERY: after a completion during the flip, running --first-link again dispatches the next link and ends at 0', () => {
    const seam = allClear()
    changeRunOnFlip(seam, { status: 'completed', updated_at: '2026-10-12T12:00:00Z' })
    expect(verdict(runScript(HELPER, ['--first-link'], seam))).toBe('NO-GO')
    writeFileSync(join(seam.dir, 'on-varset.sh'), 'exit 0\n')
    seam.env.STUB_RUN_ID = '112'
    seam.fixture(runPath(112), { status: 'in_progress' })
    seam.fixture(listPage(1, '2026-10-12T12:00:00Z'), {
      workflow_runs: [{ id: 9, status: 'completed', created_at: '2026-10-12T13:00:00Z' }],
    })
    const second = runScript(HELPER, ['--first-link'], seam)
    expect(verdict(second), second.out).toBe('GO')
    expect(seam.count('WORKFLOW_RUN')).toBe(2)
    expect(varWrites(seam)).toEqual([
      'VARIABLE_SET value=0',
      'VARIABLE_SET value=1',
      'VARIABLE_SET value=0',
    ])
  })

  it('ORDERING: the restore-to-1 itself fails (only that call) => NO-GO, no second dispatch, set-it-by-hand warning', () => {
    const seam = allClear()
    changeRunOnFlip(seam, { status: 'completed', updated_at: '2026-10-12T12:00:00Z' })
    writeFileSync(join(seam.dir, 'fail-varset-1'), '')
    const r = runScript(HELPER, ['--first-link'], seam)
    expect(verdict(r), r.out).toBe('NO-GO')
    expect(varWrites(seam)).toEqual(['VARIABLE_SET value=0', 'VARIABLE_SET value=1'])
    expect(r.out).toContain('could NOT restore BACKFILL_AUTOCHAIN_DISABLE to 1')
    expect(r.out).toContain('set it to 1 by hand')
    expect(r.out).not.toContain('the variable is restored to 1')
    expect(seam.count('WORKFLOW_RUN')).toBe(1)
  })

  it('ORDERING: a first-link status that is unreadable after the flip is not trusted: variable restored to 1, NO-GO', () => {
    const seam = allClear()
    changeRunOnFlip(seam, {})
    const r = runScript(HELPER, ['--first-link'], seam)
    expect(verdict(r), r.out).toBe('NO-GO')
    expect(varWrites(seam)).toEqual(['VARIABLE_SET value=0', 'VARIABLE_SET value=1'])
    expect(r.out).toContain('cannot be confirmed')
  })

  it('an unreadable first-link status body => NO-GO, variable never set', () => {
    const seam = allClear()
    seam.fixture(runPath(111), {})
    const r = runScript(HELPER, ['--first-link'], seam)
    expect(verdict(r), r.out).toBe('NO-GO')
    expect(seam.count('VARIABLE_SET')).toBe(0)
  })

  it('a failing `gh variable set` => NO-GO', () => {
    const seam = allClear()
    seam.env.STUB_VARSET_FAIL = '1'
    const r = runScript(HELPER, ['--first-link'], seam)
    expect(verdict(r), r.out).toBe('NO-GO')
    expect(r.out).toMatch(/gh variable set' failed/)
  })

  it('a variable that does not read back exactly 0 => NO-GO', () => {
    const seam = allClear()
    seam.env.STUB_VARGET_AFTER_SET = '1'
    const r = runScript(HELPER, ['--first-link'], seam)
    expect(verdict(r), r.out).toBe('NO-GO')
    expect(r.out).toMatch(/did not read back exactly 0/)
  })
})

describe('--first-link: replays the last intent exactly', () => {
  it('every NON-DEFAULT recorded input reaches the stubbed `gh workflow run`', () => {
    const seam = allClear()
    const r = runScript(HELPER, ['--first-link'], seam)
    expect(verdict(r), r.out).toBe('GO')
    const c = seam.calls()
    for (const frag of [
      '--ref main',
      '-f dry_run=false',
      '-f resume_from=latest',
      '-f path_prefix=.gemini/skills',
      '-f min_size_bytes=2048',
      '-f max_ranges=7',
      '-f max_skills_per_dispatch=4321',
      '-f max_skills_per_repo=33',
      '-f max_elapsed_minutes=199',
    ])
      expect(c, frag).toContain(frag)
    const logged = JSON.parse(seam.intents().trim().split('\n')[2])
    expect(logged.params).toMatchObject({ ...FULL_PARAMS, mode: 'FIRST-LINK' })
  })

  it('a recorded dry_run=true and ref are replayed, not defaulted', () => {
    const seam = allClear()
    writeIntent(seam, { ...FULL_PARAMS, dry_run: true, ref: 'release-x' })
    const r = runScript(HELPER, ['--first-link'], seam)
    expect(verdict(r), r.out).toBe('GO')
    expect(seam.calls()).toContain('-f dry_run=true')
    expect(seam.calls()).toContain('--ref release-x')
  })

  it('a recorded coldstart-* resume_from becomes latest', () => {
    const seam = allClear()
    writeIntent(seam, { ...FULL_PARAMS, resume_from: 'coldstart-gemini-skills' })
    const r = runScript(HELPER, ['--first-link'], seam)
    expect(verdict(r), r.out).toBe('GO')
    expect(seam.calls()).toContain('-f resume_from=latest')
    expect(seam.calls()).not.toContain('coldstart')
  })

  it('an empty recorded path_prefix (broad query) is valid', () => {
    const seam = allClear()
    writeIntent(seam, { ...FULL_PARAMS, path_prefix: '' })
    expect(verdict(runScript(HELPER, ['--first-link'], seam))).toBe('GO')
  })

  const fields = Object.keys(FULL_PARAMS)
  it.each(fields)('the last intent missing %s => NO-GO, nothing dispatched or flipped', (field) => {
    const seam = allClear()
    const params: Record<string, unknown> = { ...FULL_PARAMS }
    delete params[field]
    writeIntent(seam, params)
    const r = runScript(HELPER, ['--first-link'], seam)
    expect(verdict(r), r.out).toBe('NO-GO')
    expect(r.out).toMatch(/missing a valid|no params/)
    noDispatchNoFlip(seam)
  })

  it('an intent with a wrong-typed number (string max_ranges) => NO-GO', () => {
    const seam = allClear()
    writeIntent(seam, { ...FULL_PARAMS, max_ranges: '7' })
    expect(verdict(runScript(HELPER, ['--first-link'], seam))).toBe('NO-GO')
    expect(seam.count('WORKFLOW_RUN')).toBe(0)
  })

  it('a last intent with null params => NO-GO (nothing to replay)', () => {
    const seam = allClear()
    writeIntent(seam, null)
    expect(verdict(runScript(HELPER, ['--first-link'], seam))).toBe('NO-GO')
    noDispatchNoFlip(seam)
  })
})
