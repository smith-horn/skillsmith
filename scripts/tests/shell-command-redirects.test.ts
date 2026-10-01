/**
 * `scripts/lib/shell-command-redirects.mjs` (SMI-6908 F-1 and F-9): the
 * wrapper-body check reads the body with every reading and follows stdin into
 * a nested wrapper, sharing the caller's depth cap. `inputRedirectSources`'s
 * own rows stay in `shell-command-segments.test.ts`, where they were written.
 *
 * Every arm below fails on `673f19ceb`, where the body was read with the
 * separator reading alone and never recursed; the mutation that kills each is
 * named beside it. End-to-end `decide()` arms live in `env-read-guard.test.ts`
 * ("SMI-6908").
 */

import { describe, expect, it } from 'vitest'

import { normalizeWrappers } from '../lib/shell-command-normalize.mjs'
import { checkNestedRedirectSources } from '../lib/shell-command-redirects.mjs'
import { tokenize } from '../lib/shell-command-tokenize.mjs'

// A stand-in for the env guard's `checkArgv`: `cat` with a `.env` argument is
// a read, `wc`/`grep -q` are not readers, anything else is not either.
const checkArgv = (argv: string[]) =>
  argv[0] === 'cat' && argv.includes('.env') ? { kind: 'read', argv } : null
const deps = {
  tokenize,
  normalizeWrappers,
  checkArgv,
  maxDepth: 6,
  onDepthCap: () => ({ kind: 'depth-cap' }),
}
const check = (body: string, depth = 1) => checkNestedRedirectSources(body, ['.env'], deps, depth)

describe('checkNestedRedirectSources — SMI-6908 F-1: the body is read with every reading', () => {
  // Round 21's shape: a bare reader in the body.
  it('a bare reader in the body gets the source', () => {
    expect(check('cat')).toMatchObject({ kind: 'read' })
  })

  // Killed by reading the body with `splitCommandSegments` alone (the
  // 673f19ceb shape): the head stays `eval`/`nohup`/`nice`/`if`.
  it.each(['eval cat', 'command cat', 'nohup cat', 'nice -n 5 cat', 'if true; then cat; fi'])(
    'a reader behind a transparent word or launcher in the body: %s',
    (body) => {
      expect(check(body)).toMatchObject({ kind: 'read' })
    }
  )

  // Killed by removing the `nested !== null` recursion.
  it.each(["bash -c 'cat'", 'sh -c "bash -c cat"', "bash -c 'eval cat'"])(
    'a body that is itself a wrapper is followed: %s',
    (body) => {
      expect(check(body)).toMatchObject({ kind: 'read' })
    }
  )

  it('a multi-command body is read command by command', () => {
    expect(check('echo hi; nohup cat')).toMatchObject({ kind: 'read' })
  })

  // Controls: the caller's own exceptions still apply, since its `checkArgv`
  // runs on the body's argv with the source appended.
  it.each(['wc -l', 'grep -q K', 'nohup wc -l', 'echo hi', ''])('control: %s -> null', (body) => {
    expect(check(body)).toBeNull()
  })

  it('no sources, no check', () => {
    expect(checkNestedRedirectSources('cat', [], deps, 1)).toBeNull()
  })

  // Killed by dropping the `depth > deps.maxDepth` guard: the recursion then
  // reads a 7-deep chain to its reader and returns `read` instead of the
  // caller's own cap posture.
  it('shares the caller depth counter and fails closed at its cap', () => {
    expect(check('cat', 7)).toEqual({ kind: 'depth-cap' })
    // Each level escapes BOTH the quote and the backslash, the way bash's
    // own double-quote rules require; escaping the quote alone breaks the
    // body at the third level (`\\"` is an escaped backslash then a closing
    // quote), and the broken chain reads nothing.
    const quote = (s: string) => '"' + s.replace(/[\\"]/g, (m) => '\\' + m) + '"'
    const wrap = (levels: number) => {
      let chain = 'cat'
      for (let i = 0; i < levels; i++) chain = `bash -c ${quote(chain)}`
      return chain
    }
    expect(check(wrap(7), 1)).toEqual({ kind: 'depth-cap' })
    // The boundary: the reader of an N-level chain is checked at depth N+1,
    // so five wrappers read `cat` at depth 6 (the cap itself, allowed) and
    // six wrappers reach depth 7 and fail closed.
    expect(check(wrap(6), 1)).toEqual({ kind: 'depth-cap' })
    expect(check(wrap(5), 1)).toMatchObject({ kind: 'read' })
    // Within the cap the chain is read to its reader.
    expect(check('bash -c "bash -c \'cat\'"', 1)).toMatchObject({ kind: 'read' })
  })
})
