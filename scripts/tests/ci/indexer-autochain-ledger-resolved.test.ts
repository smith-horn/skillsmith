/**
 * SMI-7167 (ADR-183): scripts/ci/autochain-ledger.sh `resolved`, run through the real
 * `Record dispatch resolved` step text. `gh api` is a fake that prints a configured run list and
 * records the URL it was asked for; curl and sleep are fakes. Nothing touches the network.
 *
 * Contract under test: ALWAYS exit 0; exactly one run carrying [tok=ac-<run id>] -> dispatched;
 * none after a dispatch that did not succeed -> not_dispatched; everything else -> no row + warning.
 */
import { describe, it, expect } from 'vitest'
import { loadWorkflow } from './indexer-autochain-workflow.helpers.ts'
import { runStep, stepById } from './indexer-autochain-ledger.helpers.ts'

const doc = loadWorkflow()
const RESOLVE = stepById(doc, 'ledger_resolve')!
const SINCE = '2026-10-25T10:00:00Z'

type RunSpec = { id: number | string; title: unknown }
const list = (...runs: RunSpec[]) =>
  JSON.stringify({
    total_count: runs.length,
    workflow_runs: runs.map((r) => ({ id: r.id, display_title: r.title })),
  })
const EMPTY = list()
const mine = (id: number) => ({ id, title: `Skill Indexer Backfill env=prod [tok=ac-123] #${id}` })

interface Opts {
  outcome?: string
  polls?: (string | null)[]
  codes?: string[]
  env?: Record<string, string>
}
const resolved = (o: Opts = {}) =>
  runStep(RESOLVE, {
    codes: o.codes ?? ['201'],
    ghPolls: o.polls ?? [EMPTY],
    env: {
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '1',
      LEDGER_SUPABASE_ENV: 'prod',
      LEDGER_SINCE: SINCE,
      LEDGER_DISPATCH_OUTCOME: o.outcome ?? 'success',
      ...(o.env ?? {}),
    },
  })

const baseMeta = (outcome: string, stepOutcome: string) => ({
  dispatch_token: 'ac-123',
  link_run_id: '123',
  link_run_attempt: '1',
  supabase_env: 'prod',
  outcome,
  dispatch_step_outcome: stepOutcome,
})
const hasOutputId = (out: string) => /^dispatched_run_id=/m.test(out)

describe('resolved: the plan table, every row', () => {
  it.each([['success'], ['failure'], ['cancelled']])(
    '(%s, exactly 1 run) -> a dispatched row with dispatched_run_id as a string, and GITHUB_OUTPUT',
    (outcome) => {
      const r = resolved({ outcome, polls: [list(mine(555))] })
      expect(r.status).toBe(0)
      expect(r.posts).toHaveLength(1)
      expect(r.posts[0]!.json).toEqual({
        event_type: 'indexer_backfill_autochain_dispatch_resolved',
        actor: 'system',
        action: 'backfill_autochain_dispatch_resolved',
        resource: 'ac-123',
        result: 'success',
        metadata: { ...baseMeta('dispatched', outcome), dispatched_run_id: '555' },
      })
      expect(typeof r.posts[0]!.json.metadata.dispatched_run_id).toBe('string')
      expect(r.githubOutput).toContain('dispatched_run_id=555\n')
      expect(r.ghCalls).toHaveLength(1)
      expect(r.log).not.toContain('::warning::')
    }
  )

  it.each([['failure'], ['cancelled']])(
    '(%s, 0 runs after all polls) -> a not_dispatched row (no run id anywhere), 6 polls of 15s',
    (outcome) => {
      const r = resolved({ outcome, polls: [EMPTY] })
      expect(r.status).toBe(0)
      expect(r.ghCalls).toHaveLength(6)
      expect(r.sleeps).toEqual(Array(6).fill('15'))
      expect(r.posts).toHaveLength(1)
      expect(r.posts[0]!.json.metadata).toEqual(baseMeta('not_dispatched', outcome))
      expect('dispatched_run_id' in r.posts[0]!.json.metadata).toBe(false)
      expect(hasOutputId(r.githubOutput)).toBe(false)
    }
  )

  it('(skipped, 0 runs) -> a not_dispatched row with exactly ONE gh call and NO sleep', () => {
    const r = resolved({ outcome: 'skipped', polls: [EMPTY] })
    expect(r.status).toBe(0)
    expect(r.ghCalls).toHaveLength(1)
    expect(r.sleeps).toEqual([])
    expect(r.posts).toHaveLength(1)
    expect(r.posts[0]!.json.metadata).toEqual(baseMeta('not_dispatched', 'skipped'))
  })

  it('(skipped, 1 run) is still found on the single poll (a skipped step that did dispatch is recorded)', () => {
    const r = resolved({ outcome: 'skipped', polls: [list(mine(7))] })
    expect(r.ghCalls).toHaveLength(1)
    expect(r.posts[0]!.json.metadata.outcome).toBe('dispatched')
    expect(r.posts[0]!.json.metadata.dispatched_run_id).toBe('7')
  })

  it('(success, 0 runs after all polls) -> NO row, a warning, exit 0', () => {
    const r = resolved({ outcome: 'success', polls: [EMPTY] })
    expect(r.status).toBe(0)
    expect(r.ghCalls).toHaveLength(6)
    expect(r.posts).toHaveLength(0)
    expect(r.log).toContain(
      '::warning::autochain-ledger resolved: the dispatch step succeeded but no run titled [tok=ac-123] appeared after 6 poll(s)'
    )
    expect(hasOutputId(r.githubOutput)).toBe(false)
  })

  it.each([['success'], ['failure'], ['cancelled'], ['skipped']])(
    '(%s, 2 runs) -> NO row, a warning naming both ids, no output, exit 0',
    (outcome) => {
      const r = resolved({ outcome, polls: [list(mine(11), mine(22))] })
      expect(r.status).toBe(0)
      expect(r.posts).toHaveLength(0)
      expect(r.log).toContain('::warning::')
      expect(r.log).toContain('2 runs carry [tok=ac-123]')
      expect(r.log).toContain('11,22')
      expect(hasOutputId(r.githubOutput)).toBe(false)
    }
  )

  it('3 runs is also ambiguous', () => {
    const r = resolved({ polls: [list(mine(1), mine(2), mine(3))] })
    expect(r.posts).toHaveLength(0)
    expect(r.log).toContain('3 runs carry [tok=ac-123]')
  })

  it.each([['success'], ['failure']])(
    '(%s, gh failing on every poll) -> NO row, a warning, exit 0',
    (outcome) => {
      const r = resolved({ outcome, polls: [null] })
      expect(r.status).toBe(0)
      expect(r.ghCalls).toHaveLength(6)
      expect(r.posts).toHaveLength(0)
      expect(r.log).toContain('run lookup failed on poll 1')
      expect(r.log).toContain('the run lookup never succeeded')
    }
  )

  it('an unparseable run list is a failed poll, not an empty one', () => {
    const r = resolved({ outcome: 'failure', polls: ['<html>502</html>'] })
    expect(r.status).toBe(0)
    expect(r.posts).toHaveLength(0)
    expect(r.log).toContain('unparseable run list')
  })

  it.each([
    ['dispatched', 'success', [list(mine(555))]],
    ['not_dispatched', 'failure', [EMPTY]],
  ])(
    'the %s row write returning 500 -> warning, exit 0, no dispatched_run_id in GITHUB_OUTPUT',
    (_n, outcome, polls) => {
      const r = resolved({ outcome, polls, codes: ['500'] })
      expect(r.status).toBe(0)
      expect(r.posts).toHaveLength(1)
      expect(r.log).toContain('::warning::autochain-ledger resolved: write returned HTTP 500')
      expect(hasOutputId(r.githubOutput)).toBe(false)
    }
  )

  it('a transport failure on the write is the same: warning, exit 0, no output', () => {
    const r = resolved({ polls: [list(mine(555))], codes: ['EXIT'] })
    expect(r.status).toBe(0)
    expect(r.log).toContain('write returned HTTP 000')
    expect(hasOutputId(r.githubOutput)).toBe(false)
  })
})

describe('resolved: matching, URL and polling', () => {
  it('a token PREFIX never matches: [tok=ac-1234] is not ac-123', () => {
    const near = { id: 9, title: 'Skill Indexer Backfill [tok=ac-1234]' }
    const r = resolved({ outcome: 'failure', polls: [list(near)] })
    expect(r.posts).toHaveLength(1)
    expect(r.posts[0]!.json.metadata.outcome).toBe('not_dispatched')
    const r2 = resolved({ outcome: 'success', polls: [list(near)] })
    expect(r2.posts).toHaveLength(0)
    // paired positive control from the same run shape: add a real match and it IS found, alone
    const r3 = resolved({ outcome: 'success', polls: [list(near, mine(555))] })
    expect(r3.posts[0]!.json.metadata.dispatched_run_id).toBe('555')
  })

  it('bare "ac-123" or "tok=ac-123" without the brackets does not match', () => {
    const r = resolved({
      outcome: 'failure',
      polls: [
        list(
          { id: 1, title: 'ac-123 fix' },
          { id: 2, title: 'tok=ac-123' },
          { id: 3, title: '[tok=ac-123' }
        ),
      ],
    })
    expect(r.posts[0]!.json.metadata.outcome).toBe('not_dispatched')
  })

  it('a shorter token does not match a longer GITHUB_RUN_ID either (ac-12 vs ac-123)', () => {
    const r = resolved({
      outcome: 'failure',
      polls: [list({ id: 1, title: 'x [tok=ac-12] y' })],
    })
    expect(r.posts[0]!.json.metadata.outcome).toBe('not_dispatched')
  })

  it('titles that are not strings are ignored without breaking the poll', () => {
    const r = resolved({
      polls: [list({ id: 1, title: null }, { id: 2, title: 42 }, mine(555))],
    })
    expect(r.posts[0]!.json.metadata.dispatched_run_id).toBe('555')
  })

  it('a response with no workflow_runs key is an empty poll', () => {
    const r = resolved({ outcome: 'failure', polls: ['{"message":"ok"}'] })
    expect(r.ghCalls).toHaveLength(6)
    expect(r.posts[0]!.json.metadata.outcome).toBe('not_dispatched')
  })

  it('asks for runs created at or after LEDGER_SINCE, 100 per page, on indexer-backfill.yml', () => {
    const r = resolved({ polls: [list(mine(1))] })
    expect(r.ghCalls).toEqual([
      `api repos/o/r/actions/workflows/indexer-backfill.yml/runs?created=%3E%3D${SINCE}&per_page=100`,
    ])
    expect(r.ghCalls[0]).toContain('created=%3E%3D2026-10-25T10:00:00Z')
  })

  it('with LEDGER_SINCE empty, the floor falls back to a timestamp about 30 minutes ago', () => {
    const r = resolved({ polls: [list(mine(1))], env: { LEDGER_SINCE: '' } })
    expect(r.posts).toHaveLength(1)
    const m = /created=%3E%3D(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)&per_page=100/.exec(
      r.ghCalls[0]!
    )
    expect(m, r.ghCalls[0]).not.toBeNull()
    const ageMin = (Date.now() - Date.parse(m![1]!)) / 60000
    expect(ageMin).toBeGreaterThan(29.5)
    expect(ageMin).toBeLessThan(31)
  })

  it('a run that appears only on poll 3 is found (empty, empty, then one run)', () => {
    const r = resolved({ polls: [EMPTY, EMPTY, list(mine(555))] })
    expect(r.ghCalls).toHaveLength(3)
    expect(r.sleeps).toEqual(['15', '15', '15'])
    expect(r.posts[0]!.json.metadata.outcome).toBe('dispatched')
    expect(r.posts[0]!.json.metadata.dispatched_run_id).toBe('555')
    expect(r.githubOutput).toContain('dispatched_run_id=555\n')
  })

  it('a failed poll followed by a good one still resolves', () => {
    const r = resolved({ polls: [null, list(mine(555))] })
    expect(r.ghCalls).toHaveLength(2)
    expect(r.posts[0]!.json.metadata.dispatched_run_id).toBe('555')
  })

  it('LEDGER_POLLS and LEDGER_POLL_SLEEP seams bound the loop', () => {
    const r = resolved({
      outcome: 'failure',
      polls: [EMPTY],
      env: { LEDGER_POLLS: '2', LEDGER_POLL_SLEEP: '1' },
    })
    expect(r.ghCalls).toHaveLength(2)
    expect(r.sleeps).toEqual(['1', '1'])
  })
})

describe('resolved: ALWAYS exits 0', () => {
  it.each([
    ['SUPABASE_URL'],
    ['SUPABASE_SERVICE_ROLE_KEY'],
    ['GITHUB_RUN_ID'],
    ['GITHUB_RUN_ATTEMPT'],
    ['GITHUB_OUTPUT'],
    ['GITHUB_REPOSITORY'],
  ])('missing %s -> exit 0, a ::warning::, no POST, no lookup', (name) => {
    const r = resolved({ polls: [list(mine(1))], env: { [name]: '' } })
    expect(r.status).toBe(0)
    expect(r.log).toContain(`::warning::autochain-ledger resolved: ${name} is not set`)
    expect(r.posts).toHaveLength(0)
    expect(r.ghCalls).toHaveLength(0)
  })

  it('every outcome of the dispatch step, including an empty one, exits 0', () => {
    for (const outcome of ['success', 'failure', 'cancelled', 'skipped', '']) {
      for (const polls of [[EMPTY], [list(mine(1))], [list(mine(1), mine(2))], [null]]) {
        expect(resolved({ outcome, polls }).status, `${outcome} ${polls[0]}`).toBe(0)
      }
    }
  })
})
