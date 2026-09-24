/**
 * @fileoverview T-G3 (pure classifier) for the update eligibility gate's
 *   classifier (SMI-6532, A2 step 4).
 * @module @skillsmith/core/services/update-target-gate.purity.test
 * @see docs/internal/implementation/update-safety-and-source-resolution.md §4.3
 *
 * "Fails if `classifyUpdateTarget` makes any call on a recording fs mock."
 * `fs`, `fs/promises`, `node:fs` and `node:fs/promises` are each mocked with a
 * PLAIN OBJECT whose EVERY function export is a recording `vi.fn()`, derived
 * from the real module at mock time rather than hand-listed.
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
 * The shape to notice, since it has now recurred three times on this branch:
 * each of these was an assertion whose SUBJECT was broader than the thing it
 * named. The Proxy recorded nothing; the hand-list recorded only two methods;
 * the derived surface skipped two nested namespaces. Every version passed.
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
// only. An instrument that returns the same value for both states measures
// nothing, and this one has now been wrong three times in three different ways
// (see `recordingModule`'s comment) — each version passed every test in this
// file while recording strictly less than it claimed to.
//
// Named mutation, measured: replacing `recordingModule`'s body with
// `return actual` — disabling the recorder completely, so a real fs call does
// real I/O and leaves no trace — left the two purity tests above GREEN
// (`Tests 2 passed (2)`). It fails all three tests below.
//
// One arm per access path, because the recorder reaches them by three
// different code routes and a defect has historically lived in exactly one:
// the named export, the `default` re-export (the `import fs from 'fs/promises'`
// style, live in this package at `analysis/file-streamer.ts:11`), and the
// nested `promises` object on `node:fs`. Each asserts BOTH halves of the
// mechanism — that the call is recorded, and that it throws — because a
// recorder that logs without throwing would let a rule's I/O complete.
describe('the fs recorder — known-positive control (T-G3)', () => {
  it('records and throws on a named-export call', async () => {
    const fsp = await import('node:fs/promises')
    expect(() => fsp.readdir('/control-named')).toThrow(/must be pure/)
    expect(recordedCalls).toEqual(['node:fs/promises.readdir(/control-named)'])
  })

  it('records and throws on a call reached through `default`', async () => {
    const fsp = await import('node:fs/promises')
    expect(() => fsp.default.readdir('/control-default')).toThrow(/must be pure/)
    expect(recordedCalls).toEqual(['node:fs/promises.default.readdir(/control-default)'])
  })

  it('records and throws on a call reached through `promises`', async () => {
    const fs = await import('node:fs')
    expect(() => fs.promises.readdir('/control-promises')).toThrow(/must be pure/)
    expect(recordedCalls).toEqual(['node:fs.promises.readdir(/control-promises)'])
  })
})
