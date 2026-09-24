/**
 * @fileoverview T-G3 (pure classifier) for the update eligibility gate's
 *   classifier (SMI-6532, A2 step 4).
 * @module @skillsmith/core/services/update-target-gate.purity.test
 * @see docs/internal/implementation/update-safety-and-source-resolution.md §4.3
 *
 * "Fails if `classifyUpdateTarget` makes any call on a recording fs mock."
 * `fs`, `fs/promises`, `node:fs` and `node:fs/promises` are each mocked with
 * a PLAIN OBJECT of `vi.fn()`s, one per fs method the classifier's real
 * (non-type) import graph can actually reach — determined by reading the
 * imports, not guessed (SMI-6841 finding 1): `update-target-gate.js` ->
 * `update-target-gate.rules.js` -> `local-skill-scan.js`'s module-scope
 * `import * as fs from 'fs/promises'`, whose only two calls on that binding
 * are `fs.readdir` and `fs.readFile` (both inside `scanLocalSkills`, never
 * inside `isBackupDir` — the only export of that module
 * `update-target-gate.rules.ts` actually calls, which does no I/O of its
 * own, being a plain regex test). Every other real import in the graph
 * (`path`, `SkillParser.js` and `SkillParser.helpers.js`) touches no `fs`
 * module at all — confirmed by reading each file's own import list, not
 * assumed. Both properties throw when called, so a real call is impossible
 * to miss even if it silently no-op'd instead of throwing.
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
 * file's module-scope array and undo that push. So finding 1's fix also
 * closes finding 2's gap for every fs method this mock actually declares
 * (`REACHABLE_FS_METHODS`): catching the exception downstream no longer
 * matters, because detection was never about the throw reaching this file —
 * the throw's only remaining job is to make an UNLISTED reachable-surface
 * change loud rather than silent. The gap that genuinely remains, and is
 * NOT closed by this: a call to an fs method THIS FILE doesn't name (outside
 * `REACHABLE_FS_METHODS`) — e.g. `fs.stat` — if caught downstream, leaves no
 * trace in `recordedCalls` and produces no uncaught error either (measured,
 * reverted the same way); this is exactly why `REACHABLE_FS_METHODS` is
 * derived by reading the real import graph rather than guessed narrow, and
 * why it must be revisited if that graph ever grows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ManifestEvidence } from './update-target.evidence.js'
import type { ProbeOk, ProbeOutcome } from './update-target.probe.js'
import type { UpdateTargetPlan } from './update-target-gate.types.js'

const recordedCalls: string[] = []

/** The exact fs surface `classifyUpdateTarget`'s real import graph can
 * reach — see this module's fileoverview for the derivation. Naming every
 * method explicitly (rather than proxying arbitrary property names) is what
 * makes Vitest's own ESM export-name check pass, which is the actual fix for
 * SMI-6841 finding 1. */
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
 * Non-function exports (`constants`, and similar) are passed through
 * unwrapped: reading one is not I/O, and replacing it would break importers
 * that only read a value.
 */
async function recordingModule(moduleName: string): Promise<Record<string, unknown>> {
  const actual = (await vi.importActual(moduleName)) as Record<string, unknown>
  const mod: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value !== 'function') {
      mod[name] = value
      continue
    }
    mod[name] = vi.fn((...args: unknown[]) => {
      recordedCalls.push(`${moduleName}.${name}(${args.map(String).join(', ')})`)
      throw new Error(
        `classifyUpdateTarget must be pure — ${moduleName}.${name}() was called, which ` +
          'means this rule table (or something it imports) did I/O instead of reading ' +
          'already-resolved evidence/probe/plan data (T-G3)'
      )
    })
  }
  return mod
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
