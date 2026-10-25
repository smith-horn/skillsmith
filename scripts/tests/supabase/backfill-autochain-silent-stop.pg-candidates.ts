/**
 * SMI-7167: the CASE TABLE for backfill_autochain_silent_stop_candidates(). Registered from
 * ./backfill-autochain-silent-stop.pg.test.ts. Every case seeds and calls inside one transaction,
 * with rows dated relative to its now(), so every boundary is exact (+/- 1 minute either side).
 * Each case asserts the exact (arm, key, sub_kind, deadline - now()) rows, not a count: a count would
 * pass when the right number of WRONG rows came back.
 *
 * @module scripts/tests/supabase/backfill-autochain-silent-stop.pg-candidates
 */

import { describe, it, expect } from 'vitest'
import {
  CANDIDATES,
  ackRow,
  cand,
  checkpointRow,
  count,
  dispatchedRow,
  inTxn,
  linkFinishedRow,
  linkStartedRow,
  notDispatchedRow,
  preparedRow,
  type Ctx,
} from './backfill-autochain-silent-stop.test-helpers.ts'

const R = '1001'
const R2 = '2002'
const TOK = 'ac-111'
const H12_PLUS = '12 hours 1 minute'
const H12_MINUS = '11 hours 59 minutes'
const OVER = '-00:01:00' // one minute past the deadline
const OVER_1H = '-01:00:00' // 13h old, 12h rule

type Case = [name: string, seed: string[], expected: string[]]

const armA: Case[] = [
  [
    'A no_link: resolved(dispatched) only, 12h + 1 min old',
    [dispatchedRow(R, H12_PLUS)],
    [cand('A', R, 'no_link', OVER)],
  ],
  ['A no_link: 12h - 1 min old is not yet due', [dispatchedRow(R, H12_MINUS)], []],
  [
    'A checkpoint 31 min old: deadline = checkpoint + 30 min, even though the dispatch is only 2h old',
    [dispatchedRow(R, '2 hours'), checkpointRow(R, '31 minutes')],
    [cand('A', R, 'no_link', OVER)],
  ],
  [
    'A checkpoint 29 min old: not due',
    [dispatchedRow(R, '2 hours'), checkpointRow(R, '29 minutes')],
    [],
  ],
  [
    'A two checkpoints, latest 29 min and older 2h: the LATEST wins, so not due',
    [dispatchedRow(R, '5 hours'), checkpointRow(R, '2 hours'), checkpointRow(R, '29 minutes')],
    [],
  ],
  [
    'A two checkpoints, latest 31 min and older 2h: deadline comes from the latest',
    [dispatchedRow(R, '5 hours'), checkpointRow(R, '2 hours'), checkpointRow(R, '31 minutes')],
    [cand('A', R, 'no_link', OVER)],
  ],
  [
    'A dry_run=true checkpoint 29 min old is ignored: the 12h rule applies (13h old -> due)',
    [dispatchedRow(R, '13 hours'), checkpointRow(R, '29 minutes', true)],
    [cand('A', R, 'no_link', OVER_1H)],
  ],
  [
    'A dry_run=true checkpoint 31 min old is ignored: dispatch 1h old is not due (a counted dry run would page)',
    [dispatchedRow(R, '1 hour'), checkpointRow(R, '31 minutes', true)],
    [],
  ],
  [
    "A a checkpoint of ANOTHER run does not extend this run's deadline",
    [dispatchedRow(R, '13 hours'), checkpointRow(R2, '29 minutes')],
    [cand('A', R, 'no_link', OVER_1H)],
  ],
  [
    'A a checkpoint of ANOTHER run does not make this run due',
    [dispatchedRow(R, '2 hours'), checkpointRow(R2, '31 minutes')],
    [],
  ],
  [
    'A link_started only -> link_unfinished',
    [dispatchedRow(R, '13 hours'), linkStartedRow(R)],
    [cand('A', R, 'link_unfinished', OVER_1H)],
  ],
  [
    'A link_finished status failure -> link_failed',
    [dispatchedRow(R, '13 hours'), linkStartedRow(R), linkFinishedRow(R, '1 minute', 'failure')],
    [cand('A', R, 'link_failed', OVER_1H)],
  ],
  [
    'A a failed link_finished whose link_started was lost still reads link_failed, not no_link',
    [dispatchedRow(R, '13 hours'), linkFinishedRow(R, '1 minute', 'failure')],
    [cand('A', R, 'link_failed', OVER_1H)],
  ],
  [
    'A link_finished status success resolves it (no row)',
    [dispatchedRow(R, '13 hours'), linkStartedRow(R), linkFinishedRow(R, '1 minute', 'success')],
    [],
  ],
  [
    'A a failed link followed by a green one resolves it',
    [
      dispatchedRow(R, '13 hours'),
      linkStartedRow(R),
      linkFinishedRow(R, '2 hours', 'failure'),
      linkFinishedRow(R, '1 hour', 'success'),
    ],
    [],
  ],
  [
    'A a green link_finished for a DIFFERENT run id does not resolve it',
    [dispatchedRow(R, '13 hours'), linkStartedRow(R2), linkFinishedRow(R2, '1 minute', 'success')],
    [cand('A', R, 'no_link', OVER_1H)],
  ],
  [
    'A a non-success, non-failure finish status (cancelled) does not resolve it',
    [dispatchedRow(R, '13 hours'), linkStartedRow(R), linkFinishedRow(R, '1 minute', 'cancelled')],
    [cand('A', R, 'link_failed', OVER_1H)],
  ],
  ["A ack {arm 'A', key R} resolves it", [dispatchedRow(R, '13 hours'), ackRow('A', R)], []],
  [
    "A ack {arm 'B', key R} does NOT resolve an Arm A candidate",
    [dispatchedRow(R, '13 hours'), ackRow('B', R)],
    [cand('A', R, 'no_link', OVER_1H)],
  ],
  [
    "A ack {arm 'A', key <different run>} does NOT resolve it",
    [dispatchedRow(R, '13 hours'), ackRow('A', R2)],
    [cand('A', R, 'no_link', OVER_1H)],
  ],
  [
    'A resolved(not_dispatched) never creates an Arm A candidate (with or without a run id)',
    [
      notDispatchedRow('ac-1', '1', '13 hours'),
      notDispatchedRow('ac-2', '1', '13 hours', { dispatched_run_id: R }),
    ],
    [],
  ],
  [
    'A duplicate resolved rows for one run id produce ONE candidate, deadline from the earliest',
    [dispatchedRow(R, '13 hours'), dispatchedRow(R, '14 hours')],
    [cand('A', R, 'no_link', '-02:00:00')],
  ],
  [
    'A two runs, one green: only the open one is reported',
    [
      dispatchedRow(R, '13 hours'),
      dispatchedRow(R2, '13 hours'),
      linkFinishedRow(R2, '1 minute', 'success'),
    ],
    [cand('A', R, 'no_link', OVER_1H)],
  ],
  [
    'A a 19-digit run id is valid (control for the malformed-id arm)',
    [dispatchedRow('9223372036854775807', '13 hours')],
    [cand('A', '9223372036854775807', 'no_link', OVER_1H)],
  ],
]

const armB: Case[] = [
  [
    'B prepared 31 min old with no resolved row',
    [preparedRow(TOK, '1', '31 minutes')],
    [cand('B', `${TOK}:1`, 'unresolved', OVER)],
  ],
  ['B prepared 29 min old is not yet due', [preparedRow(TOK, '1', '29 minutes')], []],
  [
    'B resolved(not_dispatched) for the same (token, attempt) resolves it',
    [preparedRow(TOK, '1', '31 minutes'), notDispatchedRow(TOK, '1', '5 minutes')],
    [],
  ],
  [
    'B resolved(dispatched) for the same (token, attempt) resolves it too',
    [
      preparedRow(TOK, '1', '31 minutes'),
      dispatchedRow('3003', '5 minutes', { dispatch_token: TOK, link_run_attempt: '1' }),
    ],
    [],
  ],
  [
    'B resolved for (token, attempt 2) does NOT resolve (token, attempt 1)',
    [preparedRow(TOK, '1', '31 minutes'), notDispatchedRow(TOK, '2', '5 minutes')],
    [cand('B', `${TOK}:1`, 'unresolved', OVER)],
  ],
  [
    'B resolved for (another token, attempt 1) does NOT resolve it',
    [preparedRow(TOK, '1', '31 minutes'), notDispatchedRow('ac-222', '1', '5 minutes')],
    [cand('B', `${TOK}:1`, 'unresolved', OVER)],
  ],
  [
    "B ack {arm 'B', key 'token:attempt'} resolves it",
    [preparedRow(TOK, '1', '31 minutes'), ackRow('B', `${TOK}:1`)],
    [],
  ],
  [
    "B ack {arm 'A', key 'token:attempt'} does NOT resolve it",
    [preparedRow(TOK, '1', '31 minutes'), ackRow('A', `${TOK}:1`)],
    [cand('B', `${TOK}:1`, 'unresolved', OVER)],
  ],
  [
    'B ack for attempt 2 does NOT resolve attempt 1',
    [preparedRow(TOK, '1', '31 minutes'), ackRow('B', `${TOK}:2`)],
    [cand('B', `${TOK}:1`, 'unresolved', OVER)],
  ],
  [
    'B two attempts of one token are separate candidates; resolving one leaves the other',
    [
      preparedRow(TOK, '1', '31 minutes'),
      preparedRow(TOK, '2', '32 minutes'),
      notDispatchedRow(TOK, '2', '5 minutes'),
    ],
    [cand('B', `${TOK}:1`, 'unresolved', OVER)],
  ],
  [
    'B duplicate prepared rows for one (token, attempt) produce ONE candidate, deadline from the earliest',
    [preparedRow(TOK, '1', '31 minutes'), preparedRow(TOK, '1', '90 minutes')],
    [cand('B', `${TOK}:1`, 'unresolved', '-01:00:00')],
  ],
]

const mixed: Case[] = [
  [
    'A and B together are ordered by arm, each with its own key and deadline',
    [
      preparedRow(TOK, '1', '31 minutes'),
      dispatchedRow(R, H12_PLUS),
      dispatchedRow(R2, '13 hours'),
    ],
    [
      cand('A', R, 'no_link', OVER),
      cand('A', R2, 'no_link', OVER_1H),
      cand('B', `${TOK}:1`, 'unresolved', OVER),
    ],
  ],
  ['no ledger rows: no candidates', [], []],
]

// A malformed id must be IGNORED and must not make the call raise. A valid control row sits beside
// each one so an empty result cannot mean a dead function.
const CONTROL_A = dispatchedRow('7007', '13 hours')
const controlA = [cand('A', '7007', 'no_link', OVER_1H)]
const CONTROL_B = preparedRow('ac-5', '1', '31 minutes')
const controlB = [cand('B', 'ac-5:1', 'unresolved', OVER)]

const malformedDispatched: Array<[string, unknown]> = [
  ['leading zero', '0123'],
  ['a 20-digit id', '12345678901234567890'],
  ['non-numeric', 'abc'],
  ['zero', '0'],
  ['empty', ''],
  ['signed', '-5'],
  ['padded', ' 123'],
]
const malformedPrepared: Array<[string, Record<string, unknown>]> = [
  ['token without the ac- prefix', { dispatch_token: 'bad' }],
  ['token with a leading zero', { dispatch_token: 'ac-0123' }],
  ['token with a 20-digit number', { dispatch_token: 'ac-12345678901234567890' }],
  ['attempt 0', { link_run_attempt: '0' }],
  ['attempt with a leading zero', { link_run_attempt: '01' }],
  ['attempt non-numeric', { link_run_attempt: 'x' }],
  ['attempt of 6 digits', { link_run_attempt: '123456' }],
]

export function registerCandidateTests(ctx: Ctx): void {
  describe('case 5: backfill_autochain_silent_stop_candidates() -- case table', () => {
    it.each([...armA, ...armB, ...mixed])('%s', async (_name, seed, expected) => {
      const r = await inTxn(ctx.ctl(), [...seed, CANDIDATES])
      expect(r.lines).toEqual(expected)
    })

    it.each(malformedDispatched)(
      'a dispatched_run_id that is %s (%j) is ignored and does not raise',
      async (_label, bad) => {
        const r = await inTxn(ctx.ctl(), [dispatchedRow(bad, '13 hours'), CONTROL_A, CANDIDATES])
        expect(r.lines).toEqual(controlA)
      }
    )

    it.each(malformedPrepared)(
      'a prepared row with %s is ignored and does not raise',
      async (_label, meta) => {
        const r = await inTxn(ctx.ctl(), [
          preparedRow('ac-9', '1', '31 minutes', meta),
          CONTROL_B,
          CANDIDATES,
        ])
        expect(r.lines).toEqual(controlB)
      }
    )

    // The workflow writes every id as a JSON STRING. A JSON NUMBER is not that shape; `->>` would
    // render it as digits, so only a typeof check keeps it out. Isolated so a failure is unambiguous.
    it('a dispatched_run_id that is a JSON number is ignored (ids are JSON strings)', async () => {
      const r = await inTxn(ctx.ctl(), [dispatchedRow(5555, '13 hours'), CONTROL_A, CANDIDATES])
      expect(r.lines).toEqual(controlA)
    })

    it('a prepared link_run_attempt that is a JSON number is ignored (ids are JSON strings)', async () => {
      const r = await inTxn(ctx.ctl(), [
        preparedRow('ac-9', '1', '31 minutes', { link_run_attempt: 1 }),
        CONTROL_B,
        CANDIDATES,
      ])
      expect(r.lines).toEqual(controlB)
    })

    it('a malformed completed_run_id or ack key on a ledger row does not raise and resolves nothing', async () => {
      const r = await inTxn(ctx.ctl(), [
        dispatchedRow(R, '13 hours'),
        linkFinishedRow('abc', '1 minute', 'success'),
        linkFinishedRow('0'.repeat(30), '1 minute', 'success'),
        ackRow('A', 'not-a-run'),
        CANDIDATES,
      ])
      expect(r.lines).toEqual([cand('A', R, 'no_link', OVER_1H)])
    })

    describe('the 1-year window (the audit_logs retention)', () => {
      it('a row 364 days old is still a candidate; one 366 days old is ignored', async () => {
        const inside = await inTxn(ctx.ctl(), [
          dispatchedRow(R, '364 days'),
          preparedRow(TOK, '1', '364 days'),
          CANDIDATES,
        ])
        expect(inside.lines).toEqual([
          cand('A', R, 'no_link', '-363 days -12:00:00'),
          cand('B', `${TOK}:1`, 'unresolved', '-363 days -23:30:00'),
        ])
        const outside = await inTxn(ctx.ctl(), [
          dispatchedRow(R, '366 days'),
          preparedRow(TOK, '1', '366 days'),
          CANDIDATES,
        ])
        expect(outside.lines).toEqual([])
      })
    })

    it('read-only: calling it writes nothing', async () => {
      const total = count('rows', 'audit_logs')
      const r = await inTxn(ctx.ctl(), [
        dispatchedRow(R, '13 hours'),
        preparedRow(TOK, '1', '31 minutes'),
        total,
        CANDIDATES,
        total,
      ])
      expect(r.lines[0]).toBe('rows=2')
      expect(r.lines.at(-1)).toBe('rows=2')
      expect(r.lines).toHaveLength(4)
    })
  })
}
