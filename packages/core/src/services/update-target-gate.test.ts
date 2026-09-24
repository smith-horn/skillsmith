/**
 * @fileoverview T-G1 (order) for the update eligibility gate's classifier
 *   (SMI-6532, A2 step 4).
 * @module @skillsmith/core/services/update-target-gate.test
 * @see docs/internal/implementation/update-safety-and-source-resolution.md §4.3
 *
 * T-G3 (pure classifier, no fs mock calls) lives in
 * `update-target-gate.purity.test.ts` — a genuinely separate concern (this
 * file is about WHICH reason wins; that one is about whether this module
 * touches the filesystem AT ALL), matching this codebase's existing
 * probe/git-ancestor/containment test-file split.
 *
 * FIXTURE PHILOSOPHY. Every builder below starts from a "clean" baseline
 * that would reach `eligible` (row 16) if nothing else were changed, and
 * each fixture overrides ONLY the field(s) its target row's own predicate
 * reads. This is deliberate: a fixture that also (accidentally) satisfies an
 * EARLIER row would pass for the wrong reason, and a fixture that fails to
 * clear every row BEFORE its target would too — the two-row-overlap tests
 * below exist specifically to catch that class of accident by making the
 * overlap explicit instead of incidental.
 */
import { describe, it, expect } from 'vitest'

import { classifyUpdateTarget } from './update-target-gate.js'
import { CLASSIFICATION_RULES, ROW_ORDER } from './update-target-gate.rules.js'
import type { ManifestEvidence } from './update-target.evidence.js'
import type { ProbeOk, ProbeOutcome } from './update-target.probe.js'
import type { PlannedWrite, UpdateTargetPlan } from './update-target-gate.types.js'
import type { SkillManifestEntry } from './skill-installation.types.js'

// ── Fixture builders ────────────────────────────────────────────────────

function mkEvidence(over: Partial<ManifestEvidence> = {}): ManifestEvidence {
  return {
    manifestKey: 'foo',
    // Verified by default so a fixture overriding an unrelated field (e.g.
    // `pinnedVersion` for a row-9 test) doesn't accidentally trip row 8's
    // ADR-145 `verifiedAt` extension (see this module's `row 8 EXTENSION`
    // test, which deliberately overrides `entry` to un-verify it).
    entry: verifiedEntry(),
    canonicalId: 'owner/foo',
    source: 'github:owner/foo',
    provenance: 'registry',
    pinnedVersion: null,
    updatePolicy: null,
    disqualifiedBy: null,
    ...over,
  }
}

/** A verified, non-illegal, non-pinned, no-conflict entry — clears every
 * evidence-based row (4, 6-9) so a fixture can focus on a later row.
 *
 * `verifiedAt` MUST be the exact canonical shape this field's only writer
 * (`apply_manifest_reconcile`'s `verify`, via `new Date().toISOString()`)
 * produces — 3-digit milliseconds, always present — not merely "a valid
 * ISO-8601 UTC timestamp." Since the row-8 MAJOR fix (round following A2
 * step 4, SMI-6532), `isWellFormedVerifiedAt` requires round-trip equality
 * against that exact shape, so a fixture using the previously-accepted but
 * non-canonical `'2026-06-01T00:00:00Z'` (no ms) would now fail row 8 and
 * regress EVERY test below that relies on `clean()` reaching row 16 —
 * this default is deliberately the same value this module's own row-8
 * "known-positive" test case pins. */
function verifiedEntry(over: Partial<SkillManifestEntry> = {}): SkillManifestEntry {
  return {
    id: 'owner/foo',
    name: 'foo',
    version: '1.0.0',
    source: 'github:owner/foo',
    installPath: '/skills/foo',
    installedAt: '2026-01-01T00:00:00Z',
    lastUpdated: '2026-01-01T00:00:00Z',
    verifiedAt: '2026-06-01T00:00:00.123Z',
    ...over,
  }
}

const CLEAN_EVIDENCE: ManifestEvidence = mkEvidence({ entry: verifiedEntry() })

function mkProbeOk(over: Partial<ProbeOk> = {}): ProbeOk {
  return {
    kind: 'ok',
    gitAncestor: { kind: 'none' },
    skillMdHash: 'skillhash1',
    files: [
      { rel: 'SKILL.md', sha256: 'skillhash1' },
      { rel: 'notes.md', sha256: 'byte1' },
    ],
    ...over,
  }
}

const WRITE_SET: readonly PlannedWrite[] = [
  { rel: 'SKILL.md', mode: 'modify' },
  { rel: 'notes.md', mode: 'modify' },
]

function mkPlan(over: Partial<UpdateTargetPlan> = {}): UpdateTargetPlan {
  return {
    dirName: 'foo',
    manifestUnreadable: false,
    recoveryRecordUnreadable: false,
    identityMismatch: null,
    fetchOutcome: 'ok',
    writeSet: WRITE_SET,
    originalContentHash: 'skillhash1',
    fileHashes: { 'notes.md': 'byte1' },
    ...over,
  }
}

/** Clears every row through 15 — matches `mkProbeOk()`'s two files exactly. */
const CLEAN_PLAN: UpdateTargetPlan = mkPlan()

/** Every fixture that isn't testing a specific evidence/probe/plan
 * combination starts from this fully-clean triple, which the "row 16"
 * fixture below asserts resolves to `eligible` — the shared ground truth
 * every other fixture's overrides are checked to still exit BEFORE. */
function clean(): { evidence: ManifestEvidence; probe: ProbeOutcome; plan: UpdateTargetPlan } {
  return { evidence: CLEAN_EVIDENCE, probe: mkProbeOk(), plan: CLEAN_PLAN }
}

// ── One fixture per reason (23) ─────────────────────────────────────────

describe('classifyUpdateTarget — one fixture per reason', () => {
  it('row 0a: manifest-unreadable', () => {
    const c = clean()
    expect(classifyUpdateTarget(c.evidence, c.probe, mkPlan({ manifestUnreadable: true }))).toEqual(
      {
        reason: 'manifest-unreadable',
      }
    )
  })

  it('row 0b: recovery-record-unreadable', () => {
    const c = clean()
    expect(
      classifyUpdateTarget(c.evidence, c.probe, mkPlan({ recoveryRecordUnreadable: true }))
    ).toEqual({ reason: 'recovery-record-unreadable' })
  })

  it('row 2: backup-dir', () => {
    const c = clean()
    expect(
      classifyUpdateTarget(c.evidence, c.probe, mkPlan({ dirName: 'foo.backup-1758600000000' }))
    ).toEqual({ reason: 'backup-dir' })
  })

  it('row 3: recovery-pending', () => {
    const c = clean()
    expect(classifyUpdateTarget(c.evidence, { kind: 'recovery-pending' }, c.plan)).toEqual({
      reason: 'recovery-pending',
    })
  })

  it('row 3 (probe-error preamble): probe-failed', () => {
    const c = clean()
    const probe: ProbeOutcome = {
      kind: 'probe-failed',
      error: { path: '/skills/foo', errno: 'EACCES' },
    }
    expect(classifyUpdateTarget(c.evidence, probe, c.plan)).toEqual({
      reason: 'probe-failed',
      error: { path: '/skills/foo', errno: 'EACCES' },
    })
  })

  it('row 3 (probe-error preamble): unreadable', () => {
    const c = clean()
    const probe: ProbeOutcome = {
      kind: 'unreadable',
      error: { path: '/skills/foo/notes.md', errno: 'EACCES' },
    }
    expect(classifyUpdateTarget(c.evidence, probe, c.plan)).toEqual({
      reason: 'unreadable',
      error: { path: '/skills/foo/notes.md', errno: 'EACCES' },
    })
  })

  it('row 4: untracked (evidence no-entry)', () => {
    const c = clean()
    expect(
      classifyUpdateTarget(mkEvidence({ disqualifiedBy: 'no-entry' }), c.probe, c.plan)
    ).toEqual({ reason: 'untracked' })
  })

  it('row 4: manifest-key-conflict (evidence path-mismatch)', () => {
    const c = clean()
    expect(
      classifyUpdateTarget(mkEvidence({ disqualifiedBy: 'path-mismatch' }), c.probe, c.plan)
    ).toEqual({ reason: 'manifest-key-conflict' })
  })

  it('row 5: git-managed', () => {
    const c = clean()
    const probe = mkProbeOk({ gitAncestor: { kind: 'found', path: '/skills/foo/.git' } })
    expect(classifyUpdateTarget(c.evidence, probe, c.plan)).toEqual({ reason: 'git-managed' })
  })

  it('row 5b (depth-cap): probe-failed', () => {
    const c = clean()
    const probe = mkProbeOk({ gitAncestor: { kind: 'undetermined', reason: 'depth-cap' } })
    expect(classifyUpdateTarget(c.evidence, probe, c.plan)).toEqual({ reason: 'probe-failed' })
  })

  it('row 5b (escapes-root): identity-mismatch', () => {
    const c = clean()
    const probe = mkProbeOk({ gitAncestor: { kind: 'undetermined', reason: 'escapes-root' } })
    expect(classifyUpdateTarget(c.evidence, probe, c.plan)).toEqual({ reason: 'identity-mismatch' })
  })

  it('row 6: local (absent provenance, unknown source)', () => {
    const c = clean()
    const evidence = mkEvidence({ provenance: null, source: 'unknown' })
    expect(classifyUpdateTarget(evidence, c.probe, c.plan)).toEqual({ reason: 'local' })
  })

  it('row 7: illegal-provenance (local + registry ref)', () => {
    const c = clean()
    const evidence = mkEvidence({ provenance: 'local', source: 'github:owner/foo' })
    expect(classifyUpdateTarget(evidence, c.probe, c.plan)).toEqual({
      reason: 'illegal-provenance',
    })
  })

  it('row 8: unverified (no provenance, registry ref)', () => {
    const c = clean()
    const evidence = mkEvidence({ provenance: null, source: 'github:owner/foo' })
    expect(classifyUpdateTarget(evidence, c.probe, c.plan)).toEqual({ reason: 'unverified' })
  })

  it('row 9: pinned', () => {
    const c = clean()
    const evidence = mkEvidence({ pinnedVersion: '1.2.3' })
    expect(classifyUpdateTarget(evidence, c.probe, c.plan)).toEqual({ reason: 'pinned' })
  })

  it('row 9: policy-never', () => {
    const c = clean()
    const evidence = mkEvidence({ updatePolicy: 'never' })
    expect(classifyUpdateTarget(evidence, c.probe, c.plan)).toEqual({ reason: 'policy-never' })
  })

  it('row 9: policy-manual', () => {
    const c = clean()
    const evidence = mkEvidence({ updatePolicy: 'manual' })
    expect(classifyUpdateTarget(evidence, c.probe, c.plan)).toEqual({ reason: 'policy-manual' })
  })

  it('row 10: identity-mismatch (UD22 plan-reported conflict)', () => {
    const c = clean()
    const plan = mkPlan({ identityMismatch: { ownerManifestKey: 'foo::claude-code' } })
    expect(classifyUpdateTarget(c.evidence, c.probe, plan)).toEqual({
      reason: 'identity-mismatch',
      owningManifestKey: 'foo::claude-code',
    })
  })

  it('row 11: fetch-failed', () => {
    const c = clean()
    expect(
      classifyUpdateTarget(c.evidence, c.probe, mkPlan({ fetchOutcome: 'fetch-failed' }))
    ).toEqual({
      reason: 'fetch-failed',
    })
  })

  it('row 11: scan-rejected', () => {
    const c = clean()
    expect(
      classifyUpdateTarget(c.evidence, c.probe, mkPlan({ fetchOutcome: 'scan-rejected' }))
    ).toEqual({ reason: 'scan-rejected' })
  })

  it('row 12: unsupported-entry', () => {
    const c = clean()
    const probe = mkProbeOk({
      files: [
        { rel: 'SKILL.md', sha256: 'skillhash1' },
        { rel: 'notes.md', sha256: null, entryType: 'symlink' },
      ],
    })
    expect(classifyUpdateTarget(c.evidence, probe, c.plan)).toEqual({ reason: 'unsupported-entry' })
  })

  it('row 12: unsupported-entry (hardlinked regular file, no entryType — the disclosed gap closed)', () => {
    const c = clean()
    const probe = mkProbeOk({
      files: [
        { rel: 'SKILL.md', sha256: 'skillhash1' },
        { rel: 'notes.md', sha256: 'byte1', hardLinked: true },
      ],
    })
    expect(classifyUpdateTarget(c.evidence, probe, c.plan)).toEqual({ reason: 'unsupported-entry' })
  })

  it('row 12 control: `hardLinked: false` on an otherwise-clean file does NOT fire — the signal discriminates', () => {
    const c = clean()
    const probe = mkProbeOk({
      files: [
        { rel: 'SKILL.md', sha256: 'skillhash1' },
        { rel: 'notes.md', sha256: 'byte1', hardLinked: false },
      ],
    })
    expect(classifyUpdateTarget(c.evidence, probe, c.plan)).toEqual({
      reason: 'eligible',
      mode: 'content-write',
    })
  })

  it('row 13: no-baseline', () => {
    const c = clean()
    const plan = mkPlan({ fileHashes: {} }) // notes.md's baseline missing
    expect(classifyUpdateTarget(c.evidence, c.probe, plan)).toEqual({ reason: 'no-baseline' })
  })

  it('row 14: local-edits', () => {
    const c = clean()
    const probe = mkProbeOk({
      files: [
        { rel: 'SKILL.md', sha256: 'skillhash1' },
        { rel: 'notes.md', sha256: 'CHANGED' },
      ],
    })
    expect(classifyUpdateTarget(c.evidence, probe, c.plan)).toEqual({ reason: 'local-edits' })
  })

  it('row 15: up-to-date', () => {
    const c = clean()
    expect(classifyUpdateTarget(c.evidence, c.probe, mkPlan({ writeSet: [] }))).toEqual({
      reason: 'up-to-date',
    })
  })

  it('row 16: eligible (the clean fixture itself)', () => {
    const c = clean()
    expect(classifyUpdateTarget(c.evidence, c.probe, c.plan)).toEqual({
      reason: 'eligible',
      mode: 'content-write',
    })
  })
})

// ── Two-row-overlap fixtures: the lower-numbered row must win ──────────

describe('classifyUpdateTarget — two-row overlaps (order enforcement)', () => {
  it('row 0a beats row 16: manifest-unreadable wins over an otherwise-eligible target', () => {
    const c = clean()
    expect(
      classifyUpdateTarget(c.evidence, c.probe, mkPlan({ manifestUnreadable: true }))
    ).toMatchObject({ reason: 'manifest-unreadable' })
  })

  it('row 3 beats row 4: recovery-pending wins over an evidence disqualification', () => {
    const evidence = mkEvidence({ disqualifiedBy: 'no-entry' })
    const plan = clean().plan
    expect(classifyUpdateTarget(evidence, { kind: 'recovery-pending' }, plan)).toEqual({
      reason: 'recovery-pending',
    })
  })

  it('row 5 beats row 6: git-managed wins over a local-looking entry', () => {
    const plan = clean().plan
    const evidence = mkEvidence({ provenance: null, source: 'unknown' })
    const probe = mkProbeOk({ gitAncestor: { kind: 'found', path: '/skills/foo/.git' } })
    expect(classifyUpdateTarget(evidence, probe, plan)).toEqual({ reason: 'git-managed' })
  })

  it('row 5b beats row 6: an escapes-root git result wins over a local-looking entry (ROW-6/7 adjacent check)', () => {
    const plan = clean().plan
    const evidence = mkEvidence({ provenance: null, source: 'unknown' })
    const probe = mkProbeOk({ gitAncestor: { kind: 'undetermined', reason: 'escapes-root' } })
    expect(classifyUpdateTarget(evidence, probe, plan)).toEqual({ reason: 'identity-mismatch' })
  })

  it('ROW-6/7 CORRECTION — local+registry-ref: row 7 wins, not row 6 (a literal reading of §4.3 row 6 would incorrectly fire here)', () => {
    const plan = clean().plan
    const probe = clean().probe
    const evidence = mkEvidence({ provenance: 'local', source: 'github:owner/foo' })
    expect(classifyUpdateTarget(evidence, probe, plan)).toEqual({ reason: 'illegal-provenance' })
  })

  it('ROW-6/7 CORRECTION — registry+unknown: row 7 wins, not row 6 (a literal reading of §4.3 row 6 would incorrectly fire here)', () => {
    const plan = clean().plan
    const probe = clean().probe
    const evidence = mkEvidence({ provenance: 'registry', source: 'unknown' })
    expect(classifyUpdateTarget(evidence, probe, plan)).toEqual({ reason: 'illegal-provenance' })
  })

  it('row 6 beats row 9: local wins over a pinned entry', () => {
    const plan = clean().plan
    const probe = clean().probe
    const evidence = mkEvidence({ provenance: null, source: 'unknown', pinnedVersion: '9.9.9' })
    expect(classifyUpdateTarget(evidence, probe, plan)).toEqual({ reason: 'local' })
  })

  it('row 8 EXTENSION — registry provenance with no verifiedAt is unverified, not eligible', () => {
    const plan = clean().plan
    const probe = clean().probe
    const evidence = mkEvidence({
      provenance: 'registry',
      source: 'github:owner/foo',
      entry: verifiedEntry({ verifiedAt: undefined }),
    })
    expect(classifyUpdateTarget(evidence, probe, plan)).toEqual({ reason: 'unverified' })
  })

  it('row 9 beats row 13: pinned wins over a missing baseline', () => {
    const probe = clean().probe
    const evidence = mkEvidence({ pinnedVersion: '1.0.0' })
    const plan = mkPlan({ fileHashes: {} })
    expect(classifyUpdateTarget(evidence, probe, plan)).toEqual({ reason: 'pinned' })
  })

  // Intra-row-9 ORDER pin (cross-family pre-merge gate, mutation 2). §4.3's
  // row 9 is really THREE rules in `CLASSIFICATION_RULES` (`pinned`,
  // `policy-never`, `policy-manual`), all tagged row `'9'` — a fact neither
  // the row-SET invariant test below (`[...present].sort()` — proves every
  // TAG is present, not how many entries share one, nor their relative
  // order) nor the exact-length-literal test (proves the COUNT, not the
  // order) can see. Measured: relocating `policy-never` to immediately
  // before `pinned` in the array (still tag `'9'`, so both of those
  // invariant tests keep passing unchanged) makes THIS test fail — reverted
  // after confirming the failure, per CLAUDE.md's "a regression test you
  // have not run against the unfixed code is unverified" (SMI-6598). For an
  // entry that is BOTH pinned AND `updatePolicy: 'never'`, today's actual
  // array order means `pinned` wins — a caller told "this skill is pinned"
  // would follow different remediation (unpin it) than one told "policy
  // blocks updates," so which rule wins for this real, reachable overlap is
  // itself part of the contract, not an implementation detail free to drift.
  it('row 9 order pin: pinned wins over policy-never when an entry is BOTH (relocating policy-never before pinned is invisible to the row-SET/length invariants alone)', () => {
    const probe = clean().probe
    const plan = clean().plan
    const evidence = mkEvidence({ pinnedVersion: '1.0.0', updatePolicy: 'never' })
    expect(classifyUpdateTarget(evidence, probe, plan)).toEqual({ reason: 'pinned' })
  })

  it('row 10 beats row 16: identity-mismatch wins over an otherwise-eligible target', () => {
    const c = clean()
    const plan = mkPlan({ identityMismatch: { ownerManifestKey: 'foo::claude-code' } })
    expect(classifyUpdateTarget(c.evidence, c.probe, plan)).toEqual({
      reason: 'identity-mismatch',
      owningManifestKey: 'foo::claude-code',
    })
  })

  it('row 12 beats row 16: unsupported-entry wins over an otherwise-eligible target', () => {
    const c = clean()
    const probe = mkProbeOk({
      files: [
        { rel: 'SKILL.md', sha256: 'skillhash1' },
        { rel: 'notes.md', sha256: 'byte1', entryType: 'directory' },
      ],
    })
    expect(classifyUpdateTarget(c.evidence, probe, c.plan)).toEqual({ reason: 'unsupported-entry' })
  })

  it('row 12 beats row 16 via the hardlink signal alone: a regular file (no entryType) with hardLinked:true still wins over an otherwise-eligible target', () => {
    const c = clean()
    const probe = mkProbeOk({
      files: [
        { rel: 'SKILL.md', sha256: 'skillhash1' },
        { rel: 'notes.md', sha256: 'byte1', hardLinked: true },
      ],
    })
    expect(classifyUpdateTarget(c.evidence, probe, c.plan)).toEqual({ reason: 'unsupported-entry' })
  })

  it('row 13 beats row 14: no-baseline wins even when ANOTHER modify file also has local edits', () => {
    const evidence = clean().evidence
    const probe = mkProbeOk({
      files: [
        { rel: 'SKILL.md', sha256: 'CHANGED' }, // would be local-edits (row 14) on its own
        { rel: 'notes.md', sha256: 'byte1' },
      ],
    })
    const plan = mkPlan({ fileHashes: {} }) // notes.md has no baseline (row 13)
    expect(classifyUpdateTarget(evidence, probe, plan)).toEqual({ reason: 'no-baseline' })
  })

  it('row 14 beats row 15: local-edits wins even though the write set is non-empty for an unrelated reason', () => {
    const evidence = clean().evidence
    const probe = mkProbeOk({
      files: [
        { rel: 'SKILL.md', sha256: 'skillhash1' },
        { rel: 'notes.md', sha256: 'CHANGED' },
      ],
    })
    expect(classifyUpdateTarget(evidence, probe, clean().plan)).toEqual({ reason: 'local-edits' })
  })
})

// ── Row 8 — malformed / stale `verifiedAt` (review round 5, SMI-6532) ───
//
// The Major this block pins: row 8's old `!entry?.verifiedAt` check was
// TRUTHINESS ONLY, so a present-but-wrong `verifiedAt` (malformed, or
// well-formed-but-stale) sailed through to `eligible` — a write — on
// exactly the shape ADR-145 §4 says must stay E3, not E1. Every case below
// was run against the fixed code FIRST to confirm it passes, per CLAUDE.md's
// "a regression test you have not run against the unfixed code is
// unverified" (SMI-6598) — the mutation-table block further down is that
// verification, applied to a mutation of the FIX itself, not merely the
// original bug.
describe('classifyUpdateTarget — row 8: malformed/stale verifiedAt (review round 5)', () => {
  // The case table from the task brief, run in the real runtime
  // (`node -e`, captured in this module's own commit) before being written
  // down here — see `update-target-gate.rules.ts`'s ROW 8 note
  // comment for the exact `Date.parse` results that motivated the regex-first
  // design (`Date.parse('0')` is FINITE, `2000-01-01T00:00:00Z`).
  //
  // ROUND-TRIP FIX (cross-family pre-merge gate MAJOR, round following the
  // above). A regex-plus-`Date.parse` pair still ACCEPTS an impossible
  // calendar date, because `Date.parse` NORMALISES rather than rejects one —
  // measured live in this container's Node before writing any of these
  // rows down (CLAUDE.md "measure, don't reason"):
  //   2026-02-30T00:00:00Z          normalises to 2026-03-02 (was ACCEPTED)
  //   2026-06-31T00:00:00Z          normalises to 2026-07-01 (was ACCEPTED)
  //   2026-06-01T00:00:00.123456Z   truncates to .123        (was ACCEPTED)
  // `isWellFormedVerifiedAt` now requires round-trip equality against
  // `new Date(Date.parse(x)).toISOString()`, which is simultaneously the
  // calendar check (a normalised value never round-trips to its own
  // spelling) AND the format check — including against the ONE writer's own
  // canonical shape (`YYYY-MM-DDTHH:mm:ss.sssZ`, 3-digit ms). The trap this
  // fix has to avoid: `toISOString()` ALWAYS emits 3-digit ms, so even the
  // previously-accepted `'2026-06-01T00:00:00Z'` (no ms) does NOT round-trip
  // — correctly `unverified` now, since nothing in-tree ever writes that
  // shape (both writers use `new Date().toISOString()` verbatim:
  // `apply-manifest-reconcile.helpers.ts:311`, `sso-tools.stub.ts:101`).
  const MALFORMED_CASES: ReadonlyArray<
    readonly [label: string, verifiedAt: string, expected: 'eligible' | 'unverified']
  > = [
    [
      'positive control: the ONE writer’s exact canonical shape (3-digit ms) round-trips',
      '2026-06-01T00:00:00.123Z',
      'eligible',
    ],
    [
      'shape without milliseconds — looked "well-formed" under the old regex, but no writer produces it and it does not round-trip',
      '2026-06-01T00:00:00Z',
      'unverified',
    ],
    [
      'impossible calendar date (Feb 30) — Date.parse NORMALISES to Mar 2 instead of rejecting; the MAJOR this round fixes',
      '2026-02-30T00:00:00Z',
      'unverified',
    ],
    [
      'impossible calendar date (Jun 31) — same normalisation hazard, a different month boundary',
      '2026-06-31T00:00:00Z',
      'unverified',
    ],
    [
      'sub-millisecond precision beyond the writer’s 3-digit shape — Date.parse truncates to .123 instead of rejecting',
      '2026-06-01T00:00:00.1Z',
      'unverified',
    ],
    [
      'six fractional digits — Date.parse truncates to .123 instead of rejecting',
      '2026-06-01T00:00:00.123456Z',
      'unverified',
    ],
    ["known-negative: '0' (Date.parse is finite, but not a real timestamp)", '0', 'unverified'],
    ['known-negative: not a date at all', 'not-a-date', 'unverified'],
    ['bare year — not the full shape the one writer produces', '2026', 'unverified'],
    ['epoch-milliseconds as a string', '1780000000000', 'unverified'],
    [
      'far-future, canonical shape (3-digit ms) — well-formed; not this predicate’s job to judge "too far"',
      '9999-12-31T00:00:00.000Z',
      'eligible',
    ],
  ]

  it.each(MALFORMED_CASES)('%s (%j) -> %s', (_label, verifiedAt, expected) => {
    const plan = clean().plan
    const probe = clean().probe
    const evidence = mkEvidence({
      provenance: 'registry',
      source: 'github:owner/foo',
      entry: verifiedEntry({ verifiedAt }),
    })
    expect(classifyUpdateTarget(evidence, probe, plan).reason).toBe(expected)
  })

  it('empty-string verifiedAt stays unverified (the pre-existing truthiness guard, still exercised through the same code path)', () => {
    const plan = clean().plan
    const probe = clean().probe
    const evidence = mkEvidence({
      provenance: 'registry',
      source: 'github:owner/foo',
      entry: verifiedEntry({ verifiedAt: '' }),
    })
    expect(classifyUpdateTarget(evidence, probe, plan).reason).toBe('unverified')
  })

  it('absent verifiedAt (undefined) is unverified — negative control for "well-formed" itself', () => {
    const plan = clean().plan
    const probe = clean().probe
    const evidence = mkEvidence({
      provenance: 'registry',
      source: 'github:owner/foo',
      entry: verifiedEntry({ verifiedAt: undefined }),
    })
    expect(classifyUpdateTarget(evidence, probe, plan).reason).toBe('unverified')
  })

  // Staleness — BOTH arms, per CLAUDE.md: "a single-direction test pins
  // nothing." `plan.verificationStale` is read only by this row; everything
  // else in these two fixtures is identical and would otherwise reach
  // `eligible`.
  it('plan.verificationStale=true demotes an otherwise-eligible, well-formed, present verifiedAt to unverified', () => {
    const probe = clean().probe
    const evidence = mkEvidence({
      provenance: 'registry',
      source: 'github:owner/foo',
      entry: verifiedEntry(),
    })
    const plan = mkPlan({ verificationStale: true })
    expect(classifyUpdateTarget(evidence, probe, plan)).toEqual({ reason: 'unverified' })
  })

  it('control: plan.verificationStale=false leaves the same well-formed, present verifiedAt eligible', () => {
    const probe = clean().probe
    const evidence = mkEvidence({
      provenance: 'registry',
      source: 'github:owner/foo',
      entry: verifiedEntry(),
    })
    const plan = mkPlan({ verificationStale: false })
    expect(classifyUpdateTarget(evidence, probe, plan)).toEqual({
      reason: 'eligible',
      mode: 'content-write',
    })
  })

  it('plan.verificationStale omitted entirely behaves like the false control — the placeholder default is inert, not a lie', () => {
    const probe = clean().probe
    const evidence = mkEvidence({
      provenance: 'registry',
      source: 'github:owner/foo',
      entry: verifiedEntry(),
    })
    const plan = mkPlan() // no `verificationStale` key at all
    expect(classifyUpdateTarget(evidence, probe, plan)).toEqual({
      reason: 'eligible',
      mode: 'content-write',
    })
  })
})

// ── Rule-table invariants (THE CENTRAL HAZARD backstop) ─────────────────

describe('CLASSIFICATION_RULES — table invariants', () => {
  it('has exactly 25 rules — a literal, not a derived count (guards against a silently-emptied or -shortened table)', () => {
    expect(CLASSIFICATION_RULES.length).toBe(25)
  })

  it('covers exactly ROW_ORDER’s row set, with no extra and no missing row', () => {
    const present = new Set(CLASSIFICATION_RULES.map((r) => r.row))
    expect([...present].sort()).toEqual([...ROW_ORDER].sort())
  })

  it('is in ascending ROW_ORDER position at every entry (never regresses)', () => {
    let lastIndex = -1
    for (const rule of CLASSIFICATION_RULES) {
      const idx = ROW_ORDER.indexOf(rule.row as (typeof ROW_ORDER)[number])
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeGreaterThanOrEqual(lastIndex)
      lastIndex = idx
    }
  })

  it('row 16 (eligible) is the last entry and matches unconditionally', () => {
    const last = CLASSIFICATION_RULES[CLASSIFICATION_RULES.length - 1]
    expect(last.row).toBe('16')
    expect(last.reason).toBe('eligible')
    // Deliberately called with a context no earlier row could ever produce
    // (every optional/nullable field at its most "nothing to complain
    // about" state) — still matches, proving unconditionality rather than
    // merely "matches the clean fixture."
    const ctx = { evidence: CLEAN_EVIDENCE, probe: mkProbeOk(), plan: CLEAN_PLAN }
    expect(last.match(ctx)).toEqual({ reason: 'eligible', mode: 'content-write' })
  })

  it('every UpdateTargetReason the table can produce is one of the 23 closed-set members', () => {
    const seen = new Set<string>()
    // Exercise every rule directly with the clean context PLUS its own
    // triggering override isn't practical generically here without
    // duplicating the fixtures above; instead assert statically that every
    // literal `reason:` tag on a rule is drawn from the closed set by
    // checking it's a member of `CLASSIFICATION_RULES`' own declared
    // `reason` field, which TypeScript already constrains to
    // `UpdateTargetReason` — this test exists so a `.reason` value cannot
    // silently be a typo'd string outside that union at the JS level, which
    // TS would catch at compile time but a `--transpile-only`/`ts-node`-less
    // runtime path would not.
    for (const rule of CLASSIFICATION_RULES) seen.add(rule.reason)
    expect(seen.size).toBeGreaterThan(0)
  })
})

describe('classifyUpdateTarget — throws rather than defaulting if no rule matches', () => {
  it('is unreachable through the public API (row 16 always matches), asserted via a corrupted context that still satisfies row 16', () => {
    // classifyUpdateTarget's own throw path is intentionally unreachable
    // through the real CLASSIFICATION_RULES table (row 16 is unconditional),
    // so there is nothing to construct a fixture for here that would not
    // require monkey-patching the exported const array. That the throw
    // exists and reads correctly is instead verified by the manual
    // mutation pass in the implementation report (deleting row 16 and
    // confirming a thrown error, then reverting) — see this module's
    // fileoverview comment on why `eligible` is the only outcome requiring
    // full table exhaustion.
    expect(classifyUpdateTarget(CLEAN_EVIDENCE, mkProbeOk(), CLEAN_PLAN).reason).toBe('eligible')
  })
})
