/**
 * SMI-7112 (A1, 1.6): backfill-rollout-driver.sh hardening, run for real under
 * its SKILLSMITH_BACKFILL_DRIVER_TEST seam. NEVER touches a live driver: the
 * script runs from this checkout against a stubbed `gh`, pooler and clock.
 *
 * Every test starts from BASELINE -- a fixture where every unrelated guard
 * passes -- and changes exactly one thing, so each fails only on its own
 * mutation. The baseline test proves the fixture itself lets a dispatch through.
 */
import { describe, it, expect } from 'vitest'
import {
  DRIVER,
  PREFIX,
  linesBetweenDispatches,
  makeSeam,
  runScript,
} from './backfill-driver.test-helpers.ts'

const BASELINE = {
  STUB_FLAG_SEQ: '1',
  STUB_RUNS_MODE: 'one',
  STUB_RUN_ID: '111',
  STUB_URL_ID: '111',
  STUB_DONE_AFTER: '1',
}

function drive(over: Record<string, string> = {}) {
  const seam = makeSeam({ ...BASELINE, ...over })
  const r = runScript(DRIVER, [PREFIX], seam)
  return { seam, ...r }
}

describe('driver CONTROL -- baseline lets exactly one dispatch through', () => {
  it('one workflow run, one intent resolved to 111, polls 111', () => {
    const { seam, status, out } = drive()
    expect(status, out).toBe(0)
    expect(seam.count('WORKFLOW_RUN')).toBe(1)
    const lines = seam
      .intents()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines.map((l) => l.event)).toEqual(['intent', 'resolved'])
    expect(lines[1].run_id).toBe(111)
    expect(lines[1].token).toBe(lines[0].token)
    const polled = seam
      .log()
      .split('\n')
      .filter((l) => l.startsWith('RUN_VIEW'))
    expect(polled.length).toBeGreaterThan(0)
    expect(polled.every((l) => l.startsWith('RUN_VIEW id=111 '))).toBe(true)
  })
})

describe('(a) startup check: BACKFILL_AUTOCHAIN_DISABLE must read exactly 1', () => {
  it('startup read "0" => exit 2 and zero workflow runs (per-dispatch read is stubbed 1)', () => {
    const { seam, status, out } = drive({ STUB_FLAG_STARTUP: '0', STUB_FLAG_SEQ: '1' })
    expect(seam.count('WORKFLOW_RUN'), out).toBe(0)
    expect(status).toBe(2)
  })

  it('startup read errors (gh exit 1) => exit 2', () => {
    const { seam, status, out } = drive({ STUB_FLAG_STARTUP: 'ERR', STUB_FLAG_SEQ: '1' })
    expect(status, out).toBe(2)
    expect(seam.count('WORKFLOW_RUN')).toBe(0)
  })

  it('startup read empty => exit 2', () => {
    const { status, out } = drive({ STUB_FLAG_STARTUP: 'EMPTY', STUB_FLAG_SEQ: '1' })
    expect(status, out).toBe(2)
  })
})

describe('(b) per-dispatch check', () => {
  it('the variable flips to 0 after dispatch #1 => halts with exactly 1 workflow run', () => {
    const { seam, status, out } = drive({
      STUB_FLAG_STARTUP: '1',
      STUB_FLAG_SEQ: '1,0',
      STUB_DONE_AFTER: '9',
    })
    expect(seam.count('WORKFLOW_RUN'), out).toBe(1)
    expect(status).toBe(1)
    expect(out).toMatch(/no longer reads exactly 1/)
  })
})

describe('(c) intents and token resolution', () => {
  it('the intent is appended BEFORE the workflow run and carries the dispatched token', () => {
    const { seam, out } = drive()
    const m = /^WORKFLOW_RUN token=(\S+) intent_present=(\d)/m.exec(seam.log())
    expect(m, out).not.toBeNull()
    expect(m![2]).toBe('1') // the intent line already existed when gh workflow run executed
    const intent = JSON.parse(seam.intents().trim().split('\n')[0])
    expect(intent.token).toBe(m![1])
    expect(seam.calls()).toContain(`-f dispatch_token=${m![1]}`)
    expect(intent.token).toMatch(/^drv-\d+-[0-9a-f]{8}$/)
  })

  it('the intent records EVERY input the dispatch passes (the first-link replay depends on it)', () => {
    const { seam, out } = drive({
      BACKFILL_MAX_RANGES: '13',
      BACKFILL_MAX_SKILLS_PER_REPO: '41',
      BACKFILL_MAX_ELAPSED_MIN: '211',
      BACKFILL_MIN_SIZE_BYTES: '777',
    })
    const intent = JSON.parse(seam.intents().trim().split('\n')[0])
    expect(intent.params, out).toMatchObject({
      ref: 'main',
      dry_run: false,
      path_prefix: '.agents/skills',
      min_size_bytes: 777,
      max_ranges: 13,
      max_skills_per_repo: 41,
      max_elapsed_minutes: 211,
      mode: expect.stringMatching(/^(COLD-START|RESUME)$/),
      resume_from: expect.any(String),
      max_skills_per_dispatch: expect.any(Number),
    })
    // and the values recorded are the ones actually passed to `gh workflow run`
    for (const k of ['min_size_bytes', 'max_ranges', 'max_skills_per_repo', 'max_elapsed_minutes'])
      expect(seam.calls()).toContain(`-f ${k}=${intent.params[k]}`)
  })

  it('resolves by TOKEN, not by newest/first run: polls 111 though `gh run list` says 222 and 222 is listed first', () => {
    const { seam, out } = drive()
    const polled = seam
      .log()
      .split('\n')
      .filter((l) => l.startsWith('RUN_VIEW'))
      .map((l) => /id=(\d+)/.exec(l)![1])
    expect(new Set(polled), out).toEqual(new Set(['111']))
  })

  it('a token that matches NO run within 5 min => HALT, intent left unresolved, reconciliation printed, printed URL not accepted', () => {
    const { seam, status, out } = drive({ STUB_RUNS_MODE: 'none', STUB_URL_ID: '111' })
    expect(status, out).toBe(1)
    expect(out).toMatch(/RECONCILE/)
    expect(
      seam
        .intents()
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).event)
    ).toEqual(['intent'])
    expect(seam.count('RUN_VIEW')).toBe(0)
    // the stubbed clock advanced to (at least) the 5 minute budget while polling
    const slept = seam
      .log()
      .split('\n')
      .filter((l) => l.startsWith('sleep 15')).length
    expect(slept).toBeGreaterThanOrEqual(19)
  })

  it('API errors on EVERY token lookup => HALT (an error is not "found" and not a pass), intent unresolved', () => {
    const { seam, status, out } = drive({ STUB_RUNS_MODE: 'err', STUB_URL_ID: '111' })
    expect(status, out).toBe(1)
    expect(out).toMatch(/matched no run/)
    expect(seam.count('API_RUNS_QUERY mode=err')).toBeGreaterThan(3) // it kept retrying
    expect(seam.count('RUN_VIEW')).toBe(0)
    expect(
      seam
        .intents()
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).event)
    ).toEqual(['intent'])
  })

  it('TRANSIENT API errors on the first token lookups are retried, then resolved by token', () => {
    const { seam, status, out } = drive({ STUB_RUNS_MODE: 'flaky' })
    expect(status, out).toBe(0)
    expect(seam.count('API_RUNS_QUERY mode=flaky n=')).toBeGreaterThanOrEqual(4)
    expect(
      seam
        .intents()
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).event)
    ).toEqual(['intent', 'resolved'])
  })

  it('a token that matches TWO runs => HALT (never takes the first)', () => {
    const { seam, status, out } = drive({ STUB_RUNS_MODE: 'two' })
    expect(status, out).toBe(1)
    expect(out).toMatch(/matched several runs/)
    expect(seam.count('RUN_VIEW')).toBe(0)
    expect(seam.intents().trim().split('\n')).toHaveLength(1)
  })

  it('a printed URL that disagrees with the token-resolved run => HALT', () => {
    const { status, out } = drive({ STUB_URL_ID: '999' })
    expect(status, out).toBe(1)
    expect(out).toMatch(/disagrees/)
  })
})

describe('(d) the gap after each completed run', () => {
  it('a single wait of >=120s sits between dispatch #1 and dispatch #2', () => {
    const { seam, out } = drive({ STUB_DONE_AFTER: '2' })
    expect(seam.count('WORKFLOW_RUN'), out).toBe(2)
    const sleeps = linesBetweenDispatches(seam.log(), 1)
      .filter((l) => l.startsWith('sleep '))
      .map((l) => Number(/^sleep (\d+)/.exec(l)![1]))
    expect(Math.max(...sleeps)).toBeGreaterThanOrEqual(120)
  })
})
