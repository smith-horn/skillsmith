/**
 * @fileoverview T-G3 (pure classifier) for the update eligibility gate's
 *   classifier (SMI-6532, A2 step 4).
 * @module @skillsmith/core/services/update-target-gate.purity.test
 * @see docs/internal/implementation/update-safety-and-source-resolution.md §4.3
 *
 * "Fails if `classifyUpdateTarget` makes any call on a recording fs mock."
 * Each is mocked with a PLAIN OBJECT whose EVERY function export is a
 * recording `vi.fn()`, derived from the real module at mock time rather than
 * hand-listed.
 *
 * Four `vi.mock` specifiers are registered below but only TWO are in force:
 * vitest normalises a bare builtin specifier onto the `node:`-prefixed
 * registry key, so `vi.mock('node:fs', …)` overrides `vi.mock('fs', …)` and a
 * bare `import 'fs'` is served by — and records under — the `node:fs` mock.
 * The bare pair is kept as belt-and-braces against that normalisation
 * changing, not because it currently does anything. This is measured, not
 * assumed: the behavioural control at the foot of this file imports bare and
 * asserts the recorded label carries the `node:` prefix, so the day the
 * normalisation changes, that test says so.
 *
 * An earlier version of this file listed exactly the two methods the
 * classifier's import graph reaches today (`readdir`, `readFile`, via
 * `update-target-gate` -> `.rules` -> `local-skill-scan`'s module-scope
 * `import * as fs`). That enumeration was correct and still carried a defect:
 * a call to any method NOT on the list left no record and no error, so it
 * passed silently, and nothing enforced the standing obligation to revisit
 * the list as the graph grew. Deriving the surface removes both the list and
 * the obligation. Measured: `fs.stat` inside a `try/catch` — unlisted, and so
 * invisible before — now fails both tests.
 *
 * WHY A PLAIN OBJECT, NOT A PROXY (SMI-6841 finding 1 — the prior version of
 * this file used `new Proxy({}, { get })`, whose recorder never actually
 * fired). `new Proxy({}, { get })` has no OWN keys — `Object.keys()` on it
 * returns `[]`, since the Proxy has no `ownKeys` trap of its own and falls
 * back to the empty target — so it declares zero exports to Vitest's ESM
 * mock interop, which refused every named-export access with its own `No
 * "readdir" export is defined on the "fs/promises" mock` before the Proxy's
 * `get` trap ever ran. Measured with controls: a direct call to the mocked
 * `fs/promises` threw exactly that Vitest-native error, never this file's own
 * diagnostic; a real `fs.readdir` call injected into `local-skill-scan.ts`
 * left `recordedCalls` empty under the OLD Proxy mock; the same call with the
 * mock removed entirely returned a real directory entry — so the mock WAS in
 * force, the recorder simply never ran, and `expect(recordedCalls).toEqual([])`
 * could never fail no matter what the code under test did. A plain object
 * literal has real, enumerable own keys, so Vitest's export check passes and
 * a genuine call reaches the `vi.fn()` below, which both records AND throws.
 * This also removes the old Proxy's `then`-special-casing entirely: a plain
 * object with no `then` property of its own is never mistaken by `await` for
 * a thenable, unlike the Proxy this file used to return.
 *
 * T-G3's GUARANTEE, MEASURED RATHER THAN ASSUMED (SMI-6841 finding 2). Finding
 * 2 hypothesized this mechanism — record, then throw — only fails the test
 * when the throw goes UNCAUGHT out of
 * `classifyUpdateTarget`, since `scanLocalSkills` (same module as
 * `isBackupDir`, though not itself in this classifier's reachable graph) is
 * ITSELF a catch-and-continue shape around both `fs.readdir` and
 * `fs.readFile` — a realistic future shape for this gap, not a purely
 * theoretical one, if a rule ever called into it instead of the pure
 * `isBackupDir`. Verified directly (both halves reverted after confirming),
 * once finding 1's Proxy -> plain-object fix was in place: an uncaught
 * `fs.readdir(...)` call added to `isBackupDir` makes this file's first `it`
 * FAIL, as expected; the identical call wrapped in its own `try {} catch {}`
 * ALSO makes it FAIL — not pass, contrary to the hypothesis — because
 * `recordedCalls.push` runs (and is asserted against directly, not inferred
 * from whether the call "succeeded") BEFORE the throw, and a local
 * `try`/`catch` inside the code under test has no way to reach back into this
 * file's module-scope array and undo that push. So catching the exception
 * downstream does not matter: detection was never about the throw reaching
 * this file. The throw's remaining job is to stop the code under test from
 * proceeding on a fake return value.
 *
 * TWO HOLES THAT ARE NOT OBVIOUS, both closed by the recursion in
 * `wrapNamespace` (SMI-6841, governance round 3). `default` and `promises` are
 * OBJECTS, so a naive "wrap the functions, pass everything else through" walk
 * treats them as inert values — while each re-exposes the module's entire real
 * function set under a different access path. Measured against the mock object
 * itself: a namespace call threw and recorded; the same call reached as
 * `import fs from 'node:fs/promises'` did neither, performing real I/O in
 * silence. The default-import style is already live in this package
 * (`analysis/file-streamer.ts:11`), so this was a live hole rather than a
 * theoretical one. Both nested namespaces are now wrapped recursively.
 *
 * The shape to notice: every defect in this mechanism has been an assertion
 * whose SUBJECT was broader than the thing it named. The Proxy recorded
 * nothing; the hand-list recorded only two methods; the derived surface
 * skipped two nested namespaces; the first control set covered three access
 * paths and so covered none of `node:fs`'s own. Every version passed its own
 * suite. Treat a green run here as evidence only about what the control
 * quantifies over — which is why the control below is an invariant over the
 * whole reachable surface rather than a list. SMI-6841 holds the measured
 * instances and the mutation that killed each.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ManifestEvidence } from './update-target.evidence.js'
import type { ProbeOk, ProbeOutcome } from './update-target.probe.js'
import type { UpdateTargetPlan } from './update-target-gate.types.js'

const recordedCalls: string[] = []

/**
 * Wrap EVERY function export the real module has, rather than a hand-listed
 * subset.
 *
 * An earlier version listed `['readdir', 'readFile']` — the two methods the
 * classifier's import graph reaches today — and carried an obligation to
 * revisit that list whenever the graph grew. Nothing enforced the obligation,
 * and a call to an undeclared method left no trace and no error: it passed
 * silently, which is the exact shape this whole file exists to detect.
 * Deriving the surface from the module means a method that is added to the
 * graph tomorrow is already covered, with no list to maintain and nothing to
 * forget.
 *
 * `default` and `promises` are NOT passed through, and that is the whole point
 * of the recursion below. Both are objects, so `typeof value !== 'function'`
 * treats them as inert values — but each carries the module's entire REAL
 * function set. Passing them through leaves two silent holes: a call reached
 * as `import fs from 'node:fs/promises'` (the default import) or as
 * `fs.promises.readFile(...)` performs genuine I/O and records nothing, so
 * `expect(recordedCalls).toEqual([])` stays green through exactly the thing it
 * exists to catch. Measured: namespace call throws and records; default-import
 * call did neither. Not hypothetical — the default-import style is already live
 * in this package at `analysis/file-streamer.ts:11`.
 *
 * Everything else non-function (`constants`, `F_OK`, and similar) does pass
 * through: reading a value is not I/O, and replacing it would break importers
 * that only read it. Classes (`Stats`, `Dirent`, `ReadStream`) are functions
 * and so become throwing spies, which is stricter than the alternative and
 * fine — the classifier constructs none of them.
 */
async function recordingModule(moduleName: string): Promise<Record<string, unknown>> {
  const actual = (await vi.importActual(moduleName)) as Record<string, unknown>
  return wrapNamespace(actual, moduleName)
}

/** Wrap every function on `ns`, recursing into the two nested namespaces that
 * re-expose the same functions under a different access path. */
function wrapNamespace(ns: Record<string, unknown>, moduleName: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(ns)) {
    if (name === 'default' || name === 'promises') {
      out[name] = wrapNamespace(value as Record<string, unknown>, `${moduleName}.${name}`)
      continue
    }
    if (typeof value !== 'function') {
      out[name] = value
      continue
    }
    out[name] = vi.fn((...args: unknown[]) => {
      recordedCalls.push(`${moduleName}.${name}(${args.map(String).join(', ')})`)
      throw new Error(
        `classifyUpdateTarget must be pure — ${moduleName}.${name}() was called, which ` +
          'means this rule table (or something it imports) did I/O instead of reading ' +
          'already-resolved evidence/probe/plan data (T-G3)'
      )
    })
  }
  return out
}

vi.mock('fs/promises', async () => recordingModule('fs/promises'))
vi.mock('fs', async () => recordingModule('fs'))
vi.mock('node:fs/promises', async () => recordingModule('node:fs/promises'))
vi.mock('node:fs', async () => recordingModule('node:fs'))

beforeEach(() => {
  recordedCalls.length = 0
})
afterEach(() => {
  vi.clearAllMocks()
})

// ── Minimal fixtures, one per ROW_ORDER position ────────────────────────
// Deliberately NOT shared with `update-target-gate.test.ts`'s richer
// builders: this file's only job is "did anything call fs", so its
// fixtures stay maximally minimal rather than realistic — less to read
// when this file's one failure mode fires.

const EVIDENCE: ManifestEvidence = {
  manifestKey: 'foo',
  entry: {
    id: 'o/foo',
    name: 'foo',
    version: '1.0.0',
    source: 'github:o/foo',
    installPath: '/s/foo',
    installedAt: 'x',
    lastUpdated: 'x',
    verifiedAt: 'x',
  },
  canonicalId: 'o/foo',
  source: 'github:o/foo',
  provenance: 'registry',
  pinnedVersion: null,
  updatePolicy: null,
  disqualifiedBy: null,
}
const PROBE_OK: ProbeOk = {
  kind: 'ok',
  gitAncestor: { kind: 'none' },
  skillMdHash: 'h1',
  files: [{ rel: 'SKILL.md', sha256: 'h1' }],
}
const PLAN: UpdateTargetPlan = {
  dirName: 'foo',
  manifestUnreadable: false,
  recoveryRecordUnreadable: false,
  identityMismatch: null,
  fetchOutcome: 'ok',
  writeSet: [{ rel: 'SKILL.md', mode: 'modify' }],
  originalContentHash: 'h1',
  fileHashes: {},
}

const ROW_FIXTURES: Record<
  string,
  { evidence: ManifestEvidence; probe: ProbeOutcome; plan: UpdateTargetPlan }
> = {
  '0a': { evidence: EVIDENCE, probe: PROBE_OK, plan: { ...PLAN, manifestUnreadable: true } },
  '0b': { evidence: EVIDENCE, probe: PROBE_OK, plan: { ...PLAN, recoveryRecordUnreadable: true } },
  '2': { evidence: EVIDENCE, probe: PROBE_OK, plan: { ...PLAN, dirName: 'foo.backup-1' } },
  '3': { evidence: EVIDENCE, probe: { kind: 'recovery-pending' }, plan: PLAN },
  '4': { evidence: { ...EVIDENCE, disqualifiedBy: 'no-entry' }, probe: PROBE_OK, plan: PLAN },
  '5': {
    evidence: EVIDENCE,
    probe: { ...PROBE_OK, gitAncestor: { kind: 'found', path: '/s/foo/.git' } },
    plan: PLAN,
  },
  '5b': {
    evidence: EVIDENCE,
    probe: { ...PROBE_OK, gitAncestor: { kind: 'undetermined', reason: 'escapes-root' } },
    plan: PLAN,
  },
  '6': {
    evidence: { ...EVIDENCE, provenance: null, source: 'unknown' },
    probe: PROBE_OK,
    plan: PLAN,
  },
  '7': {
    evidence: { ...EVIDENCE, provenance: 'local', source: 'github:o/foo' },
    probe: PROBE_OK,
    plan: PLAN,
  },
  '8': {
    evidence: { ...EVIDENCE, provenance: null, source: 'github:o/foo' },
    probe: PROBE_OK,
    plan: PLAN,
  },
  '9': { evidence: { ...EVIDENCE, pinnedVersion: '1.0.0' }, probe: PROBE_OK, plan: PLAN },
  '10': {
    evidence: EVIDENCE,
    probe: PROBE_OK,
    plan: { ...PLAN, identityMismatch: { ownerManifestKey: 'foo::claude-code' } },
  },
  '11': { evidence: EVIDENCE, probe: PROBE_OK, plan: { ...PLAN, fetchOutcome: 'fetch-failed' } },
  '12': {
    evidence: EVIDENCE,
    probe: { ...PROBE_OK, files: [{ rel: 'SKILL.md', sha256: null, entryType: 'symlink' }] },
    plan: PLAN,
  },
  '13': { evidence: EVIDENCE, probe: PROBE_OK, plan: { ...PLAN, originalContentHash: null } },
  '14': {
    evidence: EVIDENCE,
    probe: { ...PROBE_OK, files: [{ rel: 'SKILL.md', sha256: 'CHANGED' }] },
    plan: PLAN,
  },
  '15': { evidence: EVIDENCE, probe: PROBE_OK, plan: { ...PLAN, writeSet: [] } },
  '16': { evidence: EVIDENCE, probe: PROBE_OK, plan: PLAN },
}

describe('classifyUpdateTarget — T-G3 purity', () => {
  it('makes zero fs calls across every reachable row, given only already-resolved data', async () => {
    const { classifyUpdateTarget } = await import('./update-target-gate.js')
    const { CLASSIFICATION_RULES, ROW_ORDER } = await import('./update-target-gate.rules.js')

    // Exercise one fixture per ROW_ORDER position (not merely per reason —
    // §4.1's I/O-purity property is about EVERY row the table can reach,
    // including the ones the original (corrected) resolver-parameter text
    // would have violated).
    for (const row of ROW_ORDER) {
      const fixture = ROW_FIXTURES[row]
      expect(fixture, `no purity fixture registered for row ${row}`).toBeDefined()
      classifyUpdateTarget(fixture.evidence, fixture.probe, fixture.plan)
    }

    expect(recordedCalls).toEqual([])
    expect(ROW_ORDER.length).toBeGreaterThan(0)
    expect(CLASSIFICATION_RULES.length).toBeGreaterThanOrEqual(ROW_ORDER.length)
  })

  it('does not call fs even when a rule is asked about a backup-dir name that looks path-like', async () => {
    const { classifyUpdateTarget } = await import('./update-target-gate.js')
    const base = ROW_FIXTURES['2']
    classifyUpdateTarget(base.evidence, base.probe, {
      ...base.plan,
      dirName: '../../etc/passwd.backup-1',
    })
    expect(recordedCalls).toEqual([])
  })
})

// ── Known-positive control for the recorder itself ──────────────────────
//
// Every test above asserts `recordedCalls` is EMPTY. That is a known-negative
// only, and an instrument returning the same value for both states measures
// nothing. Measured: replacing `recordingModule`'s body with `return actual`
// — disabling the recorder completely, so a real fs call does real I/O and
// leaves no trace — left every one of those tests GREEN.
//
// WHY THIS IS AN INVARIANT AND NOT A LIST OF ARMS. The first version of this
// control WAS a list: one arm per access path, for the three paths whose
// absence had each caused a real defect. It was itself an instance of this
// mechanism's recurring shape — a subject broader than the thing it names.
// The arms covered `node:fs/promises` (named), its `default`, and
// `node:fs.promises`, and so covered no part of `node:fs`'s own top-level
// surface. `classifyUpdateTarget` is synchronous, so the realistic accidental
// impurity is `existsSync`/`readFileSync` off `node:fs` — exactly what the
// arms missed. Measured: a `wrapNamespace` passthrough confined to `node:fs`
// left all three arms green while the classifier did unrecorded, unthrown I/O.
//
// WHY IT ASSERTS BEHAVIOUR AND NOT MEMBERSHIP. The version after that walked
// the same surface but asserted only `vi.isMockFunction` — membership in "is
// a mock", not in "is THIS factory's spy" — and carried the gap in prose: a
// comment claiming one behavioural arm sufficed because every spy comes from
// one `vi.fn(...)` factory. True of the code, asserted by nothing, and the
// three defects before it were each "a subset treated differently". Measured:
// a second factory giving every key except `existsSync` a record-only,
// NON-THROWING spy passed all seven tests, while `fs.readFileSync(...)`
// returned `undefined` instead of throwing. Detection survived, since
// `recordedCalls` was still non-empty — but containment, which is the throw's
// whole remaining job, was gone for every function but one.
//
// So the walk below CALLS each function and asserts the pair directly. An
// enumerated arm set can only cover the paths someone thought of, and a
// membership check can only cover the property someone named; quantifying the
// behaviour over the whole reachable surface needs neither list. This kills
// every historical defect in this mechanism — the Proxy wrapping nothing, the
// hand-list wrapping two, the unrecursed `default`/`promises`, the `node:fs`
// passthrough, and the two-factory split — without naming any of them.
//
// Calling every function is safe precisely BECAUSE the mechanism holds: each
// spy throws before reaching real I/O. If that stops being true this test is
// how you find out, which is the point.
describe('the fs recorder — known-positive control (T-G3)', () => {
  // Load each specifier through a static literal, never a variable: a fully
  // dynamic `import(spec)` is not statically analysable and is not guaranteed
  // to reach the mock registry.
  //
  // Four entries, two measurements: vitest serves the bare pair from the
  // `node:` registrations (see the file header), so `fs` and `node:fs` hand
  // back the same object. Kept so the day that stops being true, it shows up
  // here rather than as a silently unmocked import.
  const MOCKED_MODULES = [
    ['node:fs', () => import('node:fs')],
    ['node:fs/promises', () => import('node:fs/promises')],
    ['fs', () => import('fs')],
    ['fs/promises', () => import('fs/promises')],
  ] as const

  it.each(MOCKED_MODULES)(
    'every function reachable in the %s mock records AND throws when called',
    async (specifier, load) => {
      const notMocked: string[] = []
      const neverThrew: string[] = []
      const neverRecorded: string[] = []
      let rootFunctions = 0
      let called = 0
      const visited = new WeakSet<object>()

      const walk = (obj: Record<string, unknown>, path: string, depth: number): void => {
        for (const [key, value] of Object.entries(obj)) {
          const label = `${path}.${key}`
          if (typeof value === 'function') {
            if (depth === 0) rootFunctions += 1
            // Never CALL something that is not a spy — that would be real I/O
            // against the real module. Record it and move on; the assertion
            // below fails on it either way.
            if (!vi.isMockFunction(value)) {
              notMocked.push(label)
              continue
            }
            called += 1
            const recordedBefore = recordedCalls.length
            let threw = false
            try {
              ;(value as unknown as () => unknown)()
            } catch {
              threw = true
            }
            if (!threw) neverThrew.push(label)
            if (recordedCalls.length === recordedBefore) neverRecorded.push(label)
            continue
          }
          // Recurse into nested namespaces only. Functions are not walked:
          // a spy's own properties are vitest's, not the module's. Note this
          // is a statement about the MOCK, not about `node:fs` — the real
          // module does hang functions off functions (`realpath.native`), and
          // `wrapNamespace` drops them rather than passing them through.
          if (value !== null && typeof value === 'object') {
            if (visited.has(value)) continue
            visited.add(value)
            walk(value as Record<string, unknown>, label, depth + 1)
          }
        }
      }
      walk((await load()) as unknown as Record<string, unknown>, specifier, 0)

      expect({ notMocked, neverThrew, neverRecorded }).toEqual({
        notMocked: [],
        neverThrew: [],
        neverRecorded: [],
      })
      // Two denominators, because an empty finding list is otherwise both
      // "everything passed" and "nothing was examined".
      //
      // They measure different things and a single total measures neither:
      // a walk that skipped the entire top level and saw only the nested
      // namespaces still sums to a large number. `rootFunctions` pins the top
      // level specifically; `called > rootFunctions` pins that the nested
      // namespaces were reached too. Floors, not exact counts — the real
      // figures are Node-version-dependent, and this file runs in the
      // container, not on the host.
      expect(rootFunctions).toBeGreaterThan(25)
      expect(called).toBeGreaterThan(rootFunctions)
    }
  )

  it('the recorded label names the registration that served a bare specifier', async () => {
    // This is the ONLY exact-string assertion in the file, and it earns that
    // because the string is the measurement: the label's prefix is the only
    // observable telling you WHICH registration served a bare import. Vitest
    // normalises a bare builtin specifier onto the `node:`-prefixed registry
    // key, so `vi.mock('node:fs', ...)` overrides `vi.mock('fs', ...)` and a
    // bare import records as `node:fs.…`.
    //
    // Do not relax this to `toContain('existsSync')` — that passes under both
    // states and measures neither. Record+throw for this and every other
    // function is covered by the invariant above, so this test is not carrying
    // that; if the label FORMAT changes, fix the expectation here rather than
    // weakening the matcher.
    const fs = await import('fs')
    expect(() => fs.existsSync('/control-sync')).toThrow(/must be pure/)
    expect(recordedCalls).toEqual(['node:fs.existsSync(/control-sync)'])
  })
})
