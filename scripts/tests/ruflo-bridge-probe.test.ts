/**
 * SMI-6967 PR-gate (H-A): no test exercised the payload-to-producer
 * derivation at all before this -- every existing liveness-fold test
 * (`ruflo-bridge-state.test.ts`) injects the already-computed
 * `producerPresentThisProbe` boolean directly, so a mutant at the actual
 * derivation site (`isProducerPresent` in `ruflo-bridge-probe.mjs`) stayed
 * green through three review rounds. These tests drive `isProducerPresent`
 * itself from real `memory_bridge_status` payload shapes, asserting the
 * PROPERTY (a valid non-negative INTEGER count arms; anything else does
 * not) rather than re-asserting a value the production code already
 * computed.
 *
 * The mutation this must catch (H-A): reverting the shared
 * `isValidCount(total) && total > 0` check back to the prior inline
 * `Number.isFinite(total) && total > 0` wrongly re-admits a fractional
 * `totalEntries` such as `0.5` -- finite and positive, but not a count any
 * real probe would ever produce. Because `foldLiveness` LATCHES
 * `everProducerPresent` permanently on a single `true` reading, one invalid
 * fractional payload would otherwise arm the gate forever.
 *
 * Importing `ruflo-bridge-probe.mjs` here is safe only because that file now
 * carries an `isMainModule` entry-point guard (same SMI, same PR) -- without
 * it, importing the module for its export would also run `main()` as a side
 * effect (spawn the launcher, take the bridge lock, write state). See that
 * file's own comment at the bottom for why the guard was added.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { extractLearningCounters, isProducerPresent } from '../ruflo-bridge-probe.mjs'

describe('isProducerPresent — agentdb.totalEntries arm (SMI-6967 H-A: shared isValidCount, not a second Number.isFinite copy)', () => {
  it('arms on an integer totalEntries > 0', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: 1 } })).toBe(true)
  })

  it('does NOT arm on a fractional totalEntries — the H-A mutant case: 0.5 passes Number.isFinite but is not a count', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: 0.5 } })).toBe(false)
  })

  it('does NOT arm on totalEntries === 0 (valid count, but not > 0)', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: 0 } })).toBe(false)
  })

  it('does NOT arm on a negative totalEntries', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: -1 } })).toBe(false)
  })

  it('does NOT arm on a string totalEntries', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: '5' } })).toBe(false)
  })

  it('does NOT arm on Infinity', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: Infinity } })).toBe(false)
  })

  it('does NOT arm on NaN', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: NaN } })).toBe(false)
  })

  it('does NOT arm on a boolean totalEntries', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: true } })).toBe(false)
  })

  it('does NOT arm on an array totalEntries', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: [1] } })).toBe(false)
  })

  it('does NOT arm on an object totalEntries', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: {} } })).toBe(false)
  })

  it('does NOT arm when totalEntries is absent', () => {
    expect(isProducerPresent({ agentdb: {} })).toBe(false)
    expect(isProducerPresent({})).toBe(false)
  })

  it('does NOT arm when totalEntries is explicitly null', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: null } })).toBe(false)
  })
})

describe("isProducerPresent — bridge.status === 'connected' arm (independent of the totalEntries arm)", () => {
  it("arms on bridge.status === 'connected' alone, with no agentdb block at all", () => {
    expect(isProducerPresent({ bridge: { status: 'connected' } })).toBe(true)
  })

  it('arms on a connected bridge even when totalEntries is invalid — the two arms never gate each other', () => {
    expect(
      isProducerPresent({ bridge: { status: 'connected' }, agentdb: { totalEntries: 0.5 } })
    ).toBe(true)
  })

  it("does NOT arm on a non-'connected' bridge.status", () => {
    expect(isProducerPresent({ bridge: { status: 'not-synced' } })).toBe(false)
  })

  it('does NOT arm when bridge.status is absent', () => {
    expect(isProducerPresent({ bridge: {} })).toBe(false)
  })

  it('does NOT arm when bridge is absent entirely', () => {
    expect(isProducerPresent({})).toBe(false)
  })

  it('does NOT arm when bridge is null', () => {
    expect(isProducerPresent({ bridge: null })).toBe(false)
  })
})

describe('isProducerPresent — malformed top-level payload', () => {
  it('does NOT arm, and does not throw, on a null payload', () => {
    expect(isProducerPresent(null)).toBe(false)
  })

  it('does NOT arm, and does not throw, on an undefined payload', () => {
    expect(isProducerPresent(undefined)).toBe(false)
  })
})

// SMI-6985 Medium: before this seam was split out, nothing drove this exact
// extraction from any test (confirmed: `grep -n intelligence scripts/tests/
// *.ts packages/doc-retrieval-mcp/src/retrieval-log/*.test.ts` returned a
// single hit, a type declaration) — the gap that let a reachable, healthy
// payload whose `intelligence` block silently vanished go permanently
// unreportable (ruflo-bridge-state.liveness.ts's own SMI-6985 doc comment
// has the full mechanism).
describe('extractLearningCounters (SMI-6985 Medium)', () => {
  it('reads both counters when the intelligence block is present', () => {
    expect(
      extractLearningCounters({ intelligence: { patternsLearned: 3, trajectoriesRecorded: 5 } })
    ).toEqual({ patternsLearned: 3, trajectoriesRecorded: 5 })
  })

  it('returns {null, null} when the intelligence block is entirely absent — the exact reported shape', () => {
    expect(extractLearningCounters({ agentdb: {}, bridge: { status: 'connected' } })).toEqual({
      patternsLearned: null,
      trajectoriesRecorded: null,
    })
  })

  it('returns {null, null} on an empty payload, without throwing', () => {
    expect(extractLearningCounters({})).toEqual({
      patternsLearned: null,
      trajectoriesRecorded: null,
    })
  })

  it('does not throw, and returns {null, null}, on a null payload', () => {
    expect(extractLearningCounters(null)).toEqual({
      patternsLearned: null,
      trajectoriesRecorded: null,
    })
  })

  it('reads a partial intelligence block (one counter present, the other absent) independently per axis', () => {
    expect(extractLearningCounters({ intelligence: { patternsLearned: 4 } })).toEqual({
      patternsLearned: 4,
      trajectoriesRecorded: null,
    })
  })
})

// Two sequential spawnSync children (subject + control) block the event loop, so
// the per-test timeout must exceed both spawn ceilings; vitest's default (15 s)
// would otherwise fire only after the blocked loop is released.
const SPAWN_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = 2 * SPAWN_TIMEOUT_MS + 30_000

// SMI-6976. `resolveHostKey`'s `rev-parse` fallback used to set no `stdio`, so a
// git failure printed `fatal:` to the user's terminal. Its return value is the
// same either way, so only live bytes on stderr can tell -- observed here from a
// child process with a fake `git` first on PATH. The fake records its argv
// (proof the fallback actually ran git), then writes a unique token and
// unrelated git-style noise to stderr and exits non-zero. Both git calls in
// `resolveHostKey` (`worktree list` inside `resolveMainRepoKey`, then the
// `rev-parse` fallback) hit the fake, so the recorded argv must show BOTH.
describe('resolveHostKey -- git stderr stays off the parent terminal (SMI-6976)', () => {
  it(
    'quiets the rev-parse fallback and still returns the default key',
    () => {
      const work = mkdtempSync(join(tmpdir(), 'bridge-probe-stderr-'))
      try {
        const here = dirname(fileURLToPath(import.meta.url))
        const repoRoot = join(here, '..', '..')
        const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx')
        const token = `LEAK_TOKEN_${process.pid}_${Date.now()}`
        const binDir = join(work, 'bin')
        const callsLog = join(work, 'git-calls.log')
        mkdirSync(binDir)
        writeFileSync(
          join(binDir, 'git'),
          [
            '#!/bin/sh',
            `echo "$@" >> '${callsLog}'`,
            `echo 'warning: unable to read git configuration' >&2`,
            `echo '${token}' >&2`,
            'exit 1',
            '',
          ].join('\n'),
          { mode: 0o755 }
        )
        const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` }
        const probe = JSON.stringify(join(repoRoot, 'scripts', 'ruflo-bridge-probe.mjs'))
        const run = (name: string, body: string) => {
          const runner = join(work, `${name}.mts`)
          writeFileSync(runner, body)
          return spawnSync(tsx, [runner], { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, env })
        }

        const subject = run(
          'subject',
          [
            `const { resolveHostKey } = await import(${probe})`,
            `process.stdout.write('KEY=' + resolveHostKey() + '\\n')`,
          ].join('\n')
        )
        const calls = existsSync(callsLog) ? readFileSync(callsLog, 'utf8') : ''

        // Presence proofs for the absence assertion: the child reached the
        // observation, and the rev-parse fallback specifically ran git.
        expect(subject.status, `subject child failed: ${subject.stderr}`).toBe(0)
        // With every git call failing, the key is the script's own parent
        // directory (join(HERE, '..')), i.e. the repo root this test file is in.
        expect(subject.stdout).toBe(`KEY=${repoRoot}\n`)
        expect(calls, 'worktree-list call never reached git').toMatch(/worktree list --porcelain/)
        expect(calls, 'rev-parse fallback never reached git').toMatch(/rev-parse --show-toplevel/)

        // Exactly empty: any git noise at all is a leak.
        expect(subject.stderr).toBe('')

        // Positive control on the instrument: the same fake, unquieted, must put
        // the token on the parent's stderr.
        const control = run(
          'control',
          [
            `import { execFileSync } from 'node:child_process'`,
            `try { execFileSync('git', ['rev-parse'], { encoding: 'utf8' }) } catch { /* expected */ }`,
          ].join('\n')
        )
        expect(control.stderr, 'control did not leak -- stderr capture is not working').toContain(
          token
        )
      } finally {
        rmSync(work, { recursive: true, force: true })
      }
    },
    TEST_TIMEOUT_MS
  )
})
