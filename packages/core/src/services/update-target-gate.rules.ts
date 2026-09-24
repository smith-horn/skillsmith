/**
 * @fileoverview §4.3 "Classification order" rule table (SMI-6532, A2 step 4).
 * @module @skillsmith/core/services/update-target-gate.rules
 * @see docs/internal/implementation/update-safety-and-source-resolution.md §4.3
 * @see update-target-gate.ts — the driver that walks this table
 *
 * THE CENTRAL HAZARD (task brief). Row 16 is "otherwise -> `eligible`" — the
 * one outcome that WRITES the user's files. A first-match-wins table's
 * natural fallthrough is a write, so a rule dropped, reordered past its
 * match, or never reached fails SILENTLY into that write, not loudly. Three
 * things in this file exist specifically to make that impossible rather than
 * merely unlikely:
 *   1. Every rule below carries its own §4.3 row number (`row`), and this
 *      module exports {@link ROW_ORDER} — the exhaustive, ascending row-tag
 *      sequence — so a test can assert the rule table's row set and order
 *      against it, not against a hand-counted expectation that can rot.
 *   2. {@link CLASSIFICATION_RULES}'s length is a literal fact this module's
 *      test asserts against a hard-coded number, not a `.length` snapshot —
 *      an accidentally-emptied or accidentally-shortened array changes a
 *      number the test author had to type deliberately, not one the test
 *      infers from the thing under test.
 *   3. `eligible` (row 16) has an UNCONDITIONAL match — `match: () => ({...})`
 *      — and is the LAST entry. `classifyUpdateTarget` (the driver) has no
 *      `??` fallback, no default argument, and no early return producing
 *      `eligible` outside this loop — see that module for why an exhausted
 *      loop that somehow still matched nothing is a thrown error, not a
 *      silent default.
 *
 * ROW-6/ROW-7 CORRECTION (found while implementing this step, not in the
 * spec). §4.3 row 6 reads "`provenance: 'local'` OR `source: 'unknown'`" ->
 * `local`. Read literally and evaluated BEFORE row 7 (first-match-wins), that
 * OR is broad enough to swallow BOTH of ADR-145's illegal cells before row 7
 * ever sees them: `provenance: 'local'` alone (regardless of `source`) trips
 * row 6's first half even for the `'local'` + registry-ref illegal
 * combination; `source: 'unknown'` alone trips row 6's second half even for
 * the `'registry'` + `'unknown'` illegal combination. As literally specified,
 * row 7 (`illegal-provenance`) is UNREACHABLE — not merely rare, structurally
 * dead, for the exact two cells it exists to catch. This file implements the
 * evident intent instead: row 6 fires only on ADR-145's two LEGAL
 * "local"-bucket cells (`absent`+`'unknown'`, `'local'`+`'unknown'`), and row
 * 7 fires on the two illegal cells, so both rows are reachable and every one
 * of ADR-145's six matrix cells lands on exactly one of them. Flagged back
 * per the task brief's own request, not silently "fixed."
 *
 * `evidence.source: string | null` — ADR-145's matrix only ever discusses two
 * source states (`'unknown'` and a registry ref); the null case isn't in the
 * ADR because `SkillManifestEntry.source` is a required `string` there. This
 * module's `evidence`, though, comes from a resolver that can legitimately
 * produce `null` (`entry.source ?? null`, `update-target.evidence.ts:176`).
 * Treated as equivalent to `'unknown'` everywhere below — "no source
 * recorded" is closer to "nothing claimed" than to "a registry reference
 * exists" for every one of rows 6-8's purposes, and the alternative (treating
 * it as neither) would open exactly the kind of silent-eligible gap this
 * whole file exists to close: `provenance: 'local'` + `source: null` matches
 * none of rows 6/7/8 under a literal-only reading and falls through toward
 * `eligible`.
 *
 * ROW 8 EXTENDED PAST ITS LITERAL §4.3 TEXT (also found while implementing,
 * also flagged, not silently applied). Row 8's own words only cover "no
 * provenance, with a registry reference." But `evidence.entry` (when present)
 * is the FULL `SkillManifestEntry`, `verifiedAt` included — and ADR-145 §4's
 * own explicit contract for the ONE matrix cell that reaches this table's
 * bottom row states: "A row is E1-eligible only... `verifiedAt` present." No
 * §4.3 row checks `verifiedAt` at all. Left unchecked, a `'registry'` +
 * registry-ref entry that has NEVER been re-verified — E3-tier by ADR-145's
 * own table, not E1 — would sail past every row here and land on `eligible`:
 * a manifest entry that merely CLAIMS registry provenance, unconfirmed
 * against the registry's own content hash, silently authorising a write.
 * This is the central hazard from a different direction, so row 8 here also
 * fires on `provenance: 'registry'` + a registry-ref `source` + no
 * `verifiedAt`, reusing the existing `unverified` reason (ADR-144 ties both
 * to the same E3 ceiling) rather than inventing a 24th reason for one more
 * way of being unverified.
 *
 * ROW 8 — "no `verifiedAt`" means three things, not one. An absent field, a
 * present-but-MALFORMED one, and a present, well-formed, but STALE one all
 * fail ADR-145's E1 contract, and the last two need different machinery:
 *
 * (a) MALFORMED is decidable here, purely — a string that is not a timestamp
 *     was never evidence of verification. `isWellFormedVerifiedAt` is
 *     regex-first (strict `YYYY-MM-DDTHH:mm:ss[.sss]Z`) and uses `Date.parse`
 *     only as a backstop for an impossible calendar value (month 13).
 *     **Do not "simplify" this to `Date.parse` alone.** Measured in this
 *     container's own Node: `Date.parse('0')` returns a FINITE
 *     `2000-01-01T00:00:00Z` via V8's lenient legacy fallback, and
 *     `Date.parse('2026')` a finite `2026-01-01` — so a bare parse admits
 *     `'0'` as a verification timestamp. Neither is a value this field's only
 *     writer (`apply_manifest_reconcile`'s `verify`) can produce. The full
 *     case table, with both controls, is in this module's test file.
 * (b) STALE needs a clock, so it cannot live in a pure rule (T-G3). It
 *     arrives as `plan.verificationStale` (`update-target-gate.types.ts`),
 *     computed once by whoever builds `plan`; this row only consumes it,
 *     treating `true` exactly like a missing `verifiedAt` — ADR-145 §3: a
 *     stale value "degrades an entry to the row above it rather than making
 *     it illegal".
 *
 *     What this row DEFERS, stated because it is a real gap and not an
 *     oversight: **neither ADR-145 nor §4.3 defines what "too old" means.**
 *     No freshness window or TTL exists in either document (checked, not
 *     assumed). None is invented here or in `UpdateTargetPlan` — a caller
 *     without a freshness policy simply never sets the field, and (a) still
 *     applies on its own. Whoever sets it owns that policy.
 *
 * ROW 5b (added to §4.3 2026-09-23; see that section's own text for the
 * three-state rationale). `escapes-root` maps to `identity-mismatch`
 * (row 10's reason), never to row 1 ("outside the resolved scope"), for a
 * structural reason: row 1 is not a member of `UpdateTargetReason` at all
 * (`update-target-reason.ts`'s own comment: a target outside scope never
 * becomes an `UpdateTarget`, so `classifyUpdateTarget` is never called for
 * one) — by the time THIS function runs, scope has already been resolved.
 * So an `escapes-root` result reaching this function can only mean: this
 * target's OWN directory is a symlink whose real content lives outside the
 * scanned root — the fan-out-symlink shape UD22 describes, where the real
 * content is legitimately owned by a DIFFERENT key under a different root.
 * That is exactly UD22's non-owning-key case, so it gets that case's
 * reason. No owner is named here (unlike row 10 proper) because nothing
 * available to this rule identifies which OTHER key owns it — only that
 * this one, under this root, does not.
 */

import * as path from 'path'

import { isBackupDir } from '../provenance/local-skill-scan.js'
import type { ManifestEvidence } from './update-target.evidence.js'
import type { ProbeOk, ProbeOutcome } from './update-target.probe.js'
import type { UpdateTargetReason } from './update-target-reason.js'
import type { UpdateTargetClassification, UpdateTargetPlan } from './update-target-gate.types.js'

/** Everything one rule's `match` may read. */
export interface RuleContext {
  readonly evidence: ManifestEvidence
  readonly probe: ProbeOutcome
  readonly plan: UpdateTargetPlan
}

/** One row of §4.3's table. `row` is a STRING (not a number) because the
 * table itself has non-numeric positions (`'5b'`). `reason` is carried
 * separately from what `match` returns only for this module's own
 * self-documentation/tests — `match`'s return is authoritative at runtime. */
export interface ClassificationRule {
  readonly row: string
  readonly reason: UpdateTargetReason
  readonly match: (ctx: RuleContext) => UpdateTargetClassification | null
}

/** The exhaustive, ascending row-tag sequence §4.3 defines for what THIS
 * function evaluates. Row 1 ("outside the resolved scope") is deliberately
 * absent — see this module's row-5b comment above for why it can never be
 * evaluated here. Exported so a test can assert {@link CLASSIFICATION_RULES}
 * against it directly rather than against a hand-typed duplicate that could
 * drift from this list. */
export const ROW_ORDER = [
  '0a',
  '0b',
  '2',
  '3',
  '4',
  '5',
  '5b',
  '6',
  '7',
  '8',
  '9',
  '10',
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
] as const

const SKILL_MD = path.normalize('SKILL.md')

/** Narrows `probe` to `ProbeOk`, or `null` for any other outcome kind.
 * Called independently by every row-4-and-later rule (not narrowed once at
 * the top and trusted downstream) — see `update-target-gate.ts`'s own
 * comment on why each rule re-checks rather than inheriting a narrowing the
 * type system cannot carry across separate array entries. */
function asProbeOk(probe: ProbeOutcome): ProbeOk | null {
  return probe.kind === 'ok' ? probe : null
}

/** Row 13/14's baseline lookup — SKILL.md uses `plan.originalContentHash`
 * (§4.3's own words: "`fileHashes[rel]`, or `originalContentHash` for
 * SKILL.md"), every other write-set member uses `plan.fileHashes[rel]`. */
function baselineFor(plan: UpdateTargetPlan, rel: string): string | null {
  if (rel === SKILL_MD) return plan.originalContentHash
  return plan.fileHashes[rel] ?? null
}

/** The probe's current hash for one write-set member, or `null` when the
 * probe has no entry for it (should not happen when `plan.writeSet` and the
 * probe's own `ProbeInput.writeSet` were built from the same source, but a
 * missing lookup fails toward "differs from baseline," never toward a
 * silent match). */
function probedHashFor(ok: ProbeOk, rel: string): string | null {
  const file = ok.files.find((f) => f.rel === rel)
  return file ? file.sha256 : null
}

/** Has a "registry reference" `source`, ADR-145's second source class —
 * not `null` and not the `'unknown'` sentinel. See this module's
 * fileoverview for why `null` is folded in with `'unknown'` here. */
function isRegistryRef(source: string | null): boolean {
  return source !== null && source !== 'unknown'
}

/** Row 8's malformed-timestamp check — see this module's fileoverview ROW 8
 * note (a) for why a bare `Date.parse` is not enough on its
 * own (`Date.parse('0')` is finite). Pure: reads only the string it is
 * given, never the system clock — no `Date.now()`, so `classifyUpdateTarget`
 * stays I/O-free (T-G3). Requires the strict extended ISO-8601 UTC shape
 * `apply_manifest_reconcile`'s `verify` action actually writes
 * (`YYYY-MM-DDTHH:mm:ss[.sss]Z`), then uses `Date.parse` only as a backstop
 * against a string that matches the shape but names an impossible calendar
 * value (e.g. month `13`), which the regex alone can't rule out. */
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

function isWellFormedVerifiedAt(verifiedAt: string | undefined): boolean {
  if (verifiedAt === undefined || !ISO_UTC_TIMESTAMP.test(verifiedAt)) return false
  return Number.isFinite(Date.parse(verifiedAt))
}

/**
 * The §4.3 rule table, in evaluation order. `classifyUpdateTarget`
 * (`update-target-gate.ts`) walks this array and returns the first non-null
 * match — see that module for the loop and why it never falls back outside
 * this array.
 */
export const CLASSIFICATION_RULES: readonly ClassificationRule[] = [
  {
    row: '0a',
    reason: 'manifest-unreadable',
    match: (ctx) => (ctx.plan.manifestUnreadable ? { reason: 'manifest-unreadable' } : null),
  },
  {
    row: '0b',
    reason: 'recovery-record-unreadable',
    match: (ctx) =>
      ctx.plan.recoveryRecordUnreadable ? { reason: 'recovery-record-unreadable' } : null,
  },
  {
    row: '2',
    reason: 'backup-dir',
    match: (ctx) => (isBackupDir(ctx.plan.dirName) ? { reason: 'backup-dir' } : null),
  },
  {
    row: '3',
    reason: 'recovery-pending',
    match: (ctx) => (ctx.probe.kind === 'recovery-pending' ? { reason: 'recovery-pending' } : null),
  },
  {
    // §4.2/§4.3 preamble: "A probe error at any row ends classification
    // there, with `probe-failed` or `unreadable`." Row 3 is the first row
    // that needs `probe.kind` at all (rows 0a/0b/2 read only `plan`), so
    // this is the earliest point that preamble can apply — placed here, not
    // hoisted above row 2, so rows 0a/0b/2 still fire even when the probe
    // itself failed (none of them need probe data to answer their own
    // question).
    row: '3',
    reason: 'probe-failed',
    match: (ctx) =>
      ctx.probe.kind === 'probe-failed' ? { reason: 'probe-failed', error: ctx.probe.error } : null,
  },
  {
    row: '3',
    reason: 'unreadable',
    match: (ctx) =>
      ctx.probe.kind === 'unreadable' ? { reason: 'unreadable', error: ctx.probe.error } : null,
  },
  {
    row: '4',
    reason: 'untracked',
    match: (ctx) => (ctx.evidence.disqualifiedBy === 'no-entry' ? { reason: 'untracked' } : null),
  },
  {
    row: '4',
    reason: 'manifest-key-conflict',
    match: (ctx) =>
      ctx.evidence.disqualifiedBy === 'path-mismatch' ||
      ctx.evidence.disqualifiedBy === 'invalid-install-path'
        ? { reason: 'manifest-key-conflict' }
        : null,
  },
  {
    row: '5',
    reason: 'git-managed',
    match: (ctx) => {
      const ok = asProbeOk(ctx.probe)
      return ok && ok.gitAncestor.kind === 'found' ? { reason: 'git-managed' } : null
    },
  },
  {
    row: '5b',
    reason: 'probe-failed',
    match: (ctx) => {
      const ok = asProbeOk(ctx.probe)
      const g = ok?.gitAncestor
      return g?.kind === 'undetermined' && g.reason === 'depth-cap'
        ? { reason: 'probe-failed' }
        : null
    },
  },
  {
    row: '5b',
    reason: 'identity-mismatch',
    match: (ctx) => {
      const ok = asProbeOk(ctx.probe)
      const g = ok?.gitAncestor
      return g?.kind === 'undetermined' && g.reason === 'escapes-root'
        ? { reason: 'identity-mismatch' }
        : null
    },
  },
  {
    // See fileoverview "ROW-6/ROW-7 CORRECTION": narrowed to the two LEGAL
    // ADR-145 cells, not the literal §4.3 OR, so row 7 stays reachable.
    row: '6',
    reason: 'local',
    match: (ctx) => {
      const { provenance, source } = ctx.evidence
      const isUnknownish = source === null || source === 'unknown'
      return provenance !== 'registry' && isUnknownish ? { reason: 'local' } : null
    },
  },
  {
    row: '7',
    reason: 'illegal-provenance',
    match: (ctx) => {
      const { provenance, source } = ctx.evidence
      const isUnknownish = source === null || source === 'unknown'
      const illegal =
        (provenance === 'local' && isRegistryRef(source)) ||
        (provenance === 'registry' && isUnknownish)
      return illegal ? { reason: 'illegal-provenance' } : null
    },
  },
  {
    row: '8',
    reason: 'unverified',
    match: (ctx) => {
      const { provenance, source, entry } = ctx.evidence
      // §4.3's own words: no provenance at all, with a real registry ref.
      if (provenance === null && isRegistryRef(source)) return { reason: 'unverified' }
      // Extended per fileoverview "ROW 8 EXTENDED PAST ITS LITERAL TEXT":
      // ADR-145's own E1 contract requires `verifiedAt`, which no other row
      // checks. Per the ROW 8 note above: ABSENT, MALFORMED, and STALE
      // are three different ways to fail that requirement, checked here in
      // that order — absent/malformed is decidable purely (a), staleness
      // reads the caller-computed `plan.verificationStale` flag (b), never a
      // clock of this rule's own.
      if (provenance === 'registry' && isRegistryRef(source)) {
        if (!isWellFormedVerifiedAt(entry?.verifiedAt) || ctx.plan.verificationStale === true) {
          return { reason: 'unverified' }
        }
      }
      return null
    },
  },
  {
    row: '9',
    reason: 'pinned',
    match: (ctx) => (ctx.evidence.pinnedVersion !== null ? { reason: 'pinned' } : null),
  },
  {
    row: '9',
    reason: 'policy-never',
    match: (ctx) => (ctx.evidence.updatePolicy === 'never' ? { reason: 'policy-never' } : null),
  },
  {
    row: '9',
    reason: 'policy-manual',
    match: (ctx) => (ctx.evidence.updatePolicy === 'manual' ? { reason: 'policy-manual' } : null),
  },
  {
    row: '10',
    reason: 'identity-mismatch',
    match: (ctx) =>
      ctx.plan.identityMismatch !== null
        ? {
            reason: 'identity-mismatch',
            owningManifestKey: ctx.plan.identityMismatch.ownerManifestKey,
          }
        : null,
  },
  {
    row: '11',
    reason: 'fetch-failed',
    match: (ctx) => (ctx.plan.fetchOutcome === 'fetch-failed' ? { reason: 'fetch-failed' } : null),
  },
  {
    row: '11',
    reason: 'scan-rejected',
    match: (ctx) =>
      ctx.plan.fetchOutcome === 'scan-rejected' ? { reason: 'scan-rejected' } : null,
  },
  {
    row: '12',
    reason: 'unsupported-entry',
    match: (ctx) => {
      const ok = asProbeOk(ctx.probe)
      if (!ok) return null
      return ok.files.some((f) => f.entryType !== undefined)
        ? { reason: 'unsupported-entry' }
        : null
    },
  },
  {
    row: '13',
    reason: 'no-baseline',
    match: (ctx) => {
      const ok = asProbeOk(ctx.probe)
      if (!ok) return null
      const missing = ctx.plan.writeSet.some(
        (w) => w.mode === 'modify' && baselineFor(ctx.plan, w.rel) === null
      )
      return missing ? { reason: 'no-baseline' } : null
    },
  },
  {
    row: '14',
    reason: 'local-edits',
    match: (ctx) => {
      const ok = asProbeOk(ctx.probe)
      if (!ok) return null
      const edited = ctx.plan.writeSet.some((w) => {
        if (w.mode !== 'modify') return false
        const baseline = baselineFor(ctx.plan, w.rel)
        // A missing baseline is row 13's job; row 14 only compares when one
        // exists (first-match-wins already stopped at row 13 otherwise).
        if (baseline === null) return false
        return probedHashFor(ok, w.rel) !== baseline
      })
      return edited ? { reason: 'local-edits' } : null
    },
  },
  {
    row: '15',
    reason: 'up-to-date',
    match: (ctx) => (ctx.plan.writeSet.length === 0 ? { reason: 'up-to-date' } : null),
  },
  {
    // Requirement #3 (task brief): eligible is reachable ONLY by exhausting
    // this table. This is that exhaustion point — unconditional, and the
    // LAST entry. See `update-target-gate.ts` for why the driver itself adds
    // no further fallback of its own.
    row: '16',
    reason: 'eligible',
    match: () => ({ reason: 'eligible', mode: 'content-write' }),
  },
]
