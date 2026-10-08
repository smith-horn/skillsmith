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
import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { makeFixtureEnv } from './_lib/git-fixture-env.js'
import { PROBE_COMMAND } from '../../packages/doc-retrieval-mcp/src/retrieval-log/ruflo-bridge-state.js'
import { extractLearningCounters, isProducerPresent } from '../ruflo-bridge-probe.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

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

describe('SMI-7032: PROBE_COMMAND names a command that can actually load the probe', () => {
  // This lives HERE, not beside the constant in
  // packages/doc-retrieval-mcp/src/retrieval-log/ruflo-bridge-state.test.ts,
  // and the placement is the point. That file is reached by
  // `Test (<package>)`, gated on `affected_count != '0'`. Measured with the
  // repo's own classifier (scripts/ci/detect-affected.ts), with controls:
  //
  //   scripts/ruflo-bridge-probe.mjs        -> affected_count=0   job SKIPS
  //   ...retrieval-log/*.render.ts          -> affected_count=1   job runs
  //   README.md                             -> affected_count=0
  //
  // So a PR editing only the probe's own imports — the change most likely to
  // break this again — would skip that job entirely. `Test (root)` runs this
  // file unconditionally on any `code`-tier diff.
  //
  // What it asserts: the command every [ruflo-bridge] banner tells its reader
  // to run can load the probe's module graph. Two tests previously asserted
  // only that the banner CONTAINED the command string, which is why a command
  // that exited 1 with ERR_MODULE_NOT_FOUND for everyone, every time, lived
  // its whole life green.
  //
  // Importing the probe is side-effect-free: under `-e` its argv[1] is
  // undefined, so is-main-module's guard returns false and nothing spawns,
  // locks, or writes state. Verified by snapshotting ~/.skillsmith across both
  // arms.
  const tokens = PROBE_COMMAND.trim().split(/\s+/)
  const scriptRel = tokens[tokens.length - 1]
  const runner = tokens.slice(0, -1)

  // One budget, derived, rather than two literals that disagree: the old
  // version declared 120s per spawn while vitest's own testTimeout is 15s
  // (vitest.preset.ts), so the larger number could never be reached and the
  // smaller one was unstated. Measured runtime is 324-568ms per spawn.
  const SPAWN_BUDGET_MS = 4_000
  const TEST_BUDGET_MS = 2 * SPAWN_BUDGET_MS + 2_000

  const run = (argv: string[], importExpr: string) =>
    spawnSync(argv[0], [...argv.slice(1), '-e', importExpr], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: SPAWN_BUDGET_MS,
      env: makeFixtureEnv(),
    })

  it(
    'resolves under the named runner, and NOT under bare node',
    () => {
      expect(runner.length).toBeGreaterThan(0)

      const probeAbs = join(REPO_ROOT, scriptRel)
      // isFile, not merely exists: `existsSync(join(REPO_ROOT, ''))` is true
      // for the repo root itself, so a degenerate PROBE_COMMAND would pass an
      // existence check while naming no script.
      expect(statSync(probeAbs).isFile()).toBe(true)

      const importExpr = `import(${JSON.stringify(
        `file://${probeAbs}`
      )}).then(()=>console.log('RESOLVED')).catch((e)=>console.log('ERRCODE='+e.code))`

      const viaCommand = run(runner, importExpr)
      expect(viaCommand.stdout ?? '').toContain('RESOLVED')

      // Known-negative control, same execution. Without it this test would
      // pass for any runner at all, including one that resolved nothing —
      // it is what makes the positive result above evidence.
      const viaBareNode = run(['node'], importExpr)
      expect(viaBareNode.stdout ?? '').toContain('ERRCODE=ERR_MODULE_NOT_FOUND')
      expect(viaBareNode.stdout ?? '').not.toContain('RESOLVED')
    },
    TEST_BUDGET_MS
  )
})
