/**
 * @fileoverview `doctor recovery --accept-identity` is taken with `--apply` and
 * `--undo` only (A1 plan §3.9; SMI-6531, PR 3213 gate, owner decision
 * 2026-10-29). With any other action, or with none (the listing), the command
 * prints why and exits 1 before discovery, planning or listing; with `--apply`
 * or `--undo` it plans, passing the flag on.
 *
 * Discovery and planning are counted spies, so "planning never ran" and
 * "planning ran" come from the same counter in the same kind of run. The
 * actions are written out here, not read from core, so a table that lost one
 * would not shrink this suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  discover: 0,
  lists: 0,
  plans: [] as Array<Record<string, unknown>>,
}))
vi.mock('@skillsmith/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@skillsmith/core')>()
  return {
    ...actual,
    discoverRoots: async () => {
      calls.discover++
      return { stateRoots: [], roots: [], skipped: [] }
    },
    listRecovery: async () => {
      calls.lists++
      return []
    },
    // Targeting succeeds without a disk: the flag's gate is what is under test.
    planRecovery: async (request: Record<string, unknown>) => {
      calls.plans.push(request)
      return {
        status: 'planned',
        request,
        root: '/r',
        opDir: '/r/.skillsmith-staging/op',
        report: { label: 'S2 swapped', cls: { kind: 'state' } },
        plan: {
          offered: true,
          action: request['action'],
          steps: [],
          manifest: 'untouched',
          remaining: [],
          notes: [],
        },
        sweep: [],
        emptyTarget: null,
      }
    },
    executeRecovery: async () => {
      throw new Error('executeRecovery must not run: no run here is confirmed')
    },
  }
})

import { createDoctorCommand } from './doctor.js'
import { runDoctorRecovery } from './doctor.recovery.js'
import { runRecoveryAction } from './doctor.recovery.action.js'
import type { RecoveryActionOptions } from './doctor.recovery.action.js'

const OP = 'a'.repeat(32)
// eslint-disable-next-line no-control-regex
const plain = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '')

let err: string[] = []

beforeEach(() => {
  calls.discover = 0
  calls.lists = 0
  calls.plans = []
  err = []
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')))
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

/** Each action, its option, and whether `--accept-identity` is taken with it. */
const ACTIONS: ReadonlyArray<[string, keyof RecoveryActionOptions, boolean]> = [
  ['apply', 'apply', true],
  ['undo', 'undo', true],
  ['abandon', 'abandon', false],
  ['park', 'park', false],
  ['clean-staging', 'cleanStaging', false],
]

describe('doctor recovery --accept-identity: only with --apply or --undo', () => {
  it('covers all five actions', () => {
    expect(ACTIONS.map(([a]) => a)).toEqual(['apply', 'undo', 'abandon', 'park', 'clean-staging'])
  })

  for (const [action, key, taken] of ACTIONS) {
    if (taken) {
      it(`--${action} --accept-identity: discovered and planned, the flag passed on`, async () => {
        await runRecoveryAction({ [key]: OP, acceptIdentity: true, isTTY: () => false })
        expect(calls.discover).toBe(1)
        expect(calls.plans).toHaveLength(1)
        expect(calls.plans[0]).toMatchObject({ action, opId: OP, acceptIdentity: true })
        expect(err).toEqual([])
        // Planned, then not confirmed (no terminal, no --yes): exit 3, nothing run.
        expect(process.exitCode).toBe(3)
      })
    } else {
      it(`--${action} --accept-identity: exit 1 with the message, nothing discovered or planned`, async () => {
        await runRecoveryAction({ [key]: OP, acceptIdentity: true, isTTY: () => false })
        expect(err.map(plain)).toEqual([
          '--accept-identity applies only with --apply <opId> or --undo <opId>.',
        ])
        expect(process.exitCode).toBe(1)
        expect(calls.discover).toBe(0)
        expect(calls.plans).toHaveLength(0)
      })

      it(`the control: --${action} without the flag is discovered and planned`, async () => {
        await runRecoveryAction({ [key]: OP, isTTY: () => false })
        expect(err).toEqual([])
        expect(calls.discover).toBe(1)
        expect(calls.plans).toHaveLength(1)
        expect(calls.plans[0]).toMatchObject({ action, opId: OP })
        expect(calls.plans[0]).not.toHaveProperty('acceptIdentity')
      })
    }
  }
})

describe('doctor recovery --accept-identity with no action: the listing refuses it', () => {
  const MESSAGE = '--accept-identity applies only with --apply <opId> or --undo <opId>.'

  it('runDoctorRecovery: exit 1 with the message, nothing discovered or listed', async () => {
    await runDoctorRecovery({ acceptIdentity: true })
    expect(err.map(plain)).toEqual([MESSAGE])
    expect(process.exitCode).toBe(1)
    expect(calls.discover).toBe(0)
    expect(calls.lists).toBe(0)
  })

  it('through the command line: `doctor recovery --accept-identity` reaches the same refusal', async () => {
    await createDoctorCommand().parseAsync(['recovery', '--accept-identity'], { from: 'user' })
    expect(err.map(plain)).toEqual([MESSAGE])
    expect(process.exitCode).toBe(1)
    expect(calls.discover).toBe(0)
    expect(calls.lists).toBe(0)
    expect(calls.plans).toHaveLength(0)
  })

  it('the control: `doctor recovery` with no flag is discovered and listed', async () => {
    await createDoctorCommand().parseAsync(['recovery'], { from: 'user' })
    expect(err).toEqual([])
    expect(calls.discover).toBe(1)
    expect(calls.lists).toBe(1)
  })
})
