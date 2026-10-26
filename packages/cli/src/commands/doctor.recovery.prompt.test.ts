/**
 * @fileoverview The production prompt of `doctor recovery --apply`/`--undo`
 * (A1 plan §3.9 items 2-3; SMI-6531 step 6a-ii): `askOnce` driven through a
 * PassThrough stdin and stdout, and the default terminal predicate.
 */
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ executes: 0 }))
vi.mock('@skillsmith/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@skillsmith/core')>()
  return {
    ...actual,
    // Targeting succeeds without a disk: the prompt is what is under test.
    planRecovery: async () => ({
      status: 'planned',
      request: { action: 'apply', opId: 'a'.repeat(32), roots: [] },
      root: '/r',
      opDir: '/r/.skillsmith-staging/op',
      report: { label: 'S2 swapped', cls: { kind: 'state' } },
      plan: {
        offered: true,
        action: 'apply',
        steps: [],
        manifest: 'untouched',
        remaining: [],
        notes: [],
      },
      sweep: [],
      emptyTarget: null,
    }),
    discoverRoots: async () => ({ stateRoots: [], roots: [], skipped: [] }),
    executeRecovery: async () => {
      calls.executes++
      return {
        status: 'done',
        opId: 'a'.repeat(32),
        action: 'apply',
        from: 'S2 swapped',
        installed: null,
        kept: [],
        manifest: 'untouched',
        audit: { kind: 'none' },
        warnings: [],
        swept: { removed: [], left: [] },
      }
    },
  }
})

import { askOnce, isInteractive, runRecoveryAction } from './doctor.recovery.action.js'
import type { PromptAnswer } from './doctor.recovery.action.js'

beforeEach(() => {
  calls.executes = 0
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

/** `askOnce` on fresh streams; `feed` drives the input after the question is asked. */
async function ask(feed: (input: PassThrough) => void, terminal = false): Promise<PromptAnswer> {
  const input = new PassThrough()
  const output = new PassThrough()
  output.resume()
  const answer = askOnce('Proceed? [y/N] ', { input, output, terminal })
  feed(input)
  return answer
}

describe('askOnce', () => {
  it('y and yes (any case) are yes', async () => {
    for (const text of ['y\n', 'yes\n', 'YES\n', ' Y \n']) {
      expect(await ask((i) => i.write(text)), JSON.stringify(text)).toBe('yes')
    }
  })

  it('an empty line and any other answer are no', async () => {
    for (const text of ['\n', 'n\n', 'no\n', 'yep\n', 'sure\n']) {
      expect(await ask((i) => i.write(text)), JSON.stringify(text)).toBe('no')
    }
  })

  it('EOF before an answer is no', async () => {
    expect(await ask((i) => i.end())).toBe('no')
  })

  it('Ctrl-C at a terminal is interrupt, and the command exits 130 with nothing run', async () => {
    expect(await ask((i) => i.write('\x03'), true)).toBe('interrupt')
    await runRecoveryAction({
      apply: 'a'.repeat(32),
      isTTY: () => true,
      prompt: () => ask((i) => i.write('\x03'), true),
    })
    expect(process.exitCode).toBe(130)
    expect(calls.executes).toBe(0)
  })

  it('the positive: yes through the real prompt runs the action', async () => {
    await runRecoveryAction({
      apply: 'a'.repeat(32),
      isTTY: () => true,
      prompt: () => ask((i) => i.write('y\n')),
    })
    expect(process.exitCode).toBeUndefined()
    expect(calls.executes).toBe(1)
  })
})

describe('isInteractive, the default terminal predicate', () => {
  it('requires both stdin and stdout to be terminals', () => {
    expect(isInteractive({ isTTY: true }, { isTTY: true })).toBe(true)
    expect(isInteractive({ isTTY: true }, { isTTY: false })).toBe(false)
    expect(isInteractive({ isTTY: false }, { isTTY: true })).toBe(false)
    expect(isInteractive({}, {})).toBe(false)
  })
})
