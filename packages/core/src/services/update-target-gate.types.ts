/**
 * @fileoverview Shared types for the update eligibility gate's classifier
 *   (SMI-6532, A2 §4.3/§4.4 — `classifyUpdateTarget`).
 * @module @skillsmith/core/services/update-target-gate.types
 * @see docs/internal/implementation/update-safety-and-source-resolution.md §4.3
 *
 * WHY THIS FILE EXISTS, SEPARATE FROM BOTH `update-target-gate.ts` AND
 * `update-target-gate.rules.ts`: the same reason `update-target.probe.types.ts`
 * exists (see that module's own fileoverview) — `update-target-gate.ts`
 * (the driver, `classifyUpdateTarget`) needs the rule table from
 * `update-target-gate.rules.ts`, and the rule table needs `UpdateTargetPlan`
 * / `UpdateTargetClassification` to type its own predicates and return
 * values. Defining those types in the driver file would make the rules
 * module import FROM the driver and the driver import FROM the rules module
 * — safe today only because the driver's own import of the types would be
 * type-only, but it READS as circular, which is exactly the shape that file
 * says is worth removing even when erasure makes it harmless today. Both
 * siblings depend on this one, dependency-free module instead.
 *
 * `plan` IS THE THIRD SEAM (SMI-6532 §4.3). `evidence` (`ManifestEvidence`,
 * `update-target.evidence.ts`) and `probe` (`ProbeOutcome`,
 * `update-target.probe.ts`) are both already shipped, locked shapes this
 * step only CONSUMES. Several §4.3 rows need a fact neither shape carries —
 * not just rows 11-15 (fetch/scan outcome, the write set, baselines), which
 * is as far as §4.3's own one-line summary goes, but three more
 * this step's own row-by-row derivation surfaced (see
 * `update-target-gate.rules.ts`'s fileoverview for the reasoning on each):
 *
 *   - Row 0a/0b: whole-RUN and whole-SKILLS-ROOT facts. `ManifestEvidence`
 *     presupposes an already-loaded `manifest: SkillManifest` (§4.1: "one
 *     strict snapshot for the whole run") — if the manifest itself failed to
 *     load, no `ManifestEvidence` could ever have been produced to hand this
 *     function, so that failure cannot be encoded THROUGH `evidence`. The
 *     probe's own `defaultRecoveryPendingChecker` (`update-target.probe.
 *     recovery.ts`) fails an unreadable staging record SILENTLY to `false`
 *     (documented placeholder gap) and `ProbeOutcome` has no variant for it
 *     either, so `probe` cannot carry it. `plan` is the only remaining seam.
 *   - Row 10 (UD22 several-keys ownership): needs to know whether ANOTHER
 *     manifest key owns this target's real directory. `ManifestEvidence` is
 *     scoped to ONE key's own lookup and never cross-references the rest of
 *     the manifest for competing keys (confirmed: `temporaryManifestEvidenceResolver`,
 *     `update-target.evidence.ts:139-182`, never inspects any key but the
 *     one it was asked about). Computing UD22 ownership needs whole-manifest
 *     visibility, which only whoever builds `plan` has.
 *
 * All three are placeholder fields ("A1 fills it in", same status as
 * `temporaryManifestEvidenceResolver` and `defaultRecoveryPendingChecker")
 * with safe, inert defaults a step-5 caller can supply today without lying:
 * `false`/`null`/`'ok'`/`[]` all mean "nothing known to block this target,"
 * never "positively confirmed clean." See this module's field-level comments.
 *
 * A FOURTH placeholder field joined them 2026-09-23 (SMI-6532, row 8's
 * fail-open finding): `verificationStale`. ADR-145 §3 says a stale
 * `verifiedAt` "degrades an entry to the row above it rather than making it
 * illegal" — i.e. row 8's `unverified`, not row 16's `eligible` — but
 * deciding "stale" needs the current time, and `classifyUpdateTarget` must
 * stay pure (T-G3: no `Date.now()`, no clock, no I/O in a rule). So the
 * clock read happens exactly once, by whoever builds `plan` (same seam as
 * the other three), and the rule only reads the boolean it computed.
 * **Neither ADR-145 nor the §4.3 plan doc defines a numeric freshness
 * window/TTL** — confirmed by reading both; see
 * `update-target-gate.rules.ts`'s row-8 comment for the citation. This field
 * carries no default TTL of its own for that reason: inventing one here
 * would be exactly the kind of unmeasured claim CLAUDE.md's "measure, don't
 * reason" rule exists to block. Default `false` — "nothing known to be
 * stale," same fail-closed-toward-`false` direction as this module's other
 * three placeholders (`false` here means "not flagged stale," not
 * "confirmed fresh").
 */

import type { ProbeError } from './update-target.probe.types.js'
import type { UpdateTargetReason } from './update-target-reason.js'

/** Outcome of fetching/scanning the update's candidate new content (§4.3 row
 * 11). `'ok'` means fetch+scan succeeded (not itself a reason — classification
 * continues past row 11). */
export type UpdateFetchOutcome = 'ok' | 'fetch-failed' | 'scan-rejected'

/** How one write-set member's on-disk bytes should change. Only `'modify'`
 * entries are ever checked against a baseline (§4.3 rows 13/14) — an `'add'`
 * has nothing to have a baseline against, and a `'remove'`'s current bytes
 * (if any) are not being compared to a prior version of themselves. */
export type UpdateWriteMode = 'add' | 'modify' | 'remove'

/** One file the candidate update would touch. `rel` matches
 * `ProbedFile.rel`/`ProbeInput.writeSet` entries — both are built from the
 * SAME plan by whoever calls `probeUpdateTarget` and `classifyUpdateTarget`
 * for one target, so the two are expected to name the same paths. */
export interface PlannedWrite {
  readonly rel: string
  readonly mode: UpdateWriteMode
}

/**
 * The pure classifier's third parameter. See this module's fileoverview for
 * why each field exists and which §4.3 row(s) read it.
 */
export interface UpdateTargetPlan {
  /** Row 2 (`isBackupDir`) needs the directory's basename; nothing else on
   * `evidence`/`probe` carries it (`ManifestEvidence.manifestKey` is a
   * COMPUTED key, not necessarily dirName verbatim once SMI-6345's real
   * resolver lands). Always known by any real caller — not a placeholder. */
  readonly dirName: string
  /** Row 0a: true when the whole run's manifest could not be loaded
   * strictly. Default `false` — "unknown" must never read as "unreadable",
   * the same fail-closed direction every other placeholder field here takes. */
  readonly manifestUnreadable: boolean
  /** Row 0b: true when an unreadable `.skillsmith-staging/` record exists
   * ANYWHERE under this target's skills root (not necessarily naming this
   * target — see row 3 for that narrower, already-probe-covered case).
   * Default `false`. */
  readonly recoveryRecordUnreadable: boolean
  /** Row 10 (UD22): set when whole-manifest analysis found that another key
   * owns this target's real directory, naming that owner for remediation.
   * `null` = not computed / no conflict found. Default `null`. */
  readonly identityMismatch: { readonly ownerManifestKey: string } | null
  /** Row 11. Default `'ok'`. */
  readonly fetchOutcome: UpdateFetchOutcome
  /** Rows 13-15: the files this update would touch, after diffing candidate
   * content against what's on disk. An empty array is row 15's own trigger
   * (`up-to-date`) — NOT a placeholder default to treat cautiously; A1's
   * real diff is expected to often legitimately produce one. */
  readonly writeSet: readonly PlannedWrite[]
  /** Row 13/14's baseline for SKILL.md specifically — §4.3 names this
   * separately from `fileHashes[rel]` ("`fileHashes[rel]`, or
   * `originalContentHash` for SKILL.md"), matching `SkillManifestEntry.
   * originalContentHash`. `null` = no baseline recorded. */
  readonly originalContentHash: string | null
  /** Row 13/14's baseline for every write-set member OTHER than SKILL.md,
   * keyed by the same normalized `rel` `probe.files[].rel` uses. A missing
   * key (not merely an empty object) is "no baseline recorded" for that
   * file — row 13. */
  readonly fileHashes: Readonly<Record<string, string>>
  /** Row 8 (SMI-6532 §4.3): true when a `provenance: 'registry'` entry's
   * `verifiedAt` was checked against a freshness window BY THE CALLER (this
   * function never computes one itself — see this interface's fileoverview)
   * and found stale. `undefined`/`false` = not flagged stale — row 8 then
   * falls through to whatever the malformed/absent `verifiedAt` check
   * decides on its own. Optional, not merely defaulted, so a caller that
   * genuinely has no freshness policy yet (none is defined today — see the
   * fileoverview) can omit it without writing a lying `false`. */
  readonly verificationStale?: boolean
}

/**
 * `classifyUpdateTarget`'s return value. Deliberately NOT a bare
 * `UpdateTargetReason` string — `error`/`owningManifestKey` carry the extra
 * context a renderer's `remediationFor` (`update-target-reason.ts`) needs
 * (`fixPermissions` reads `{path, errno}`; `reconcileVerify` reads
 * `manifestKey`) and that the reason alone can't express.
 */
export interface UpdateTargetClassification {
  readonly reason: UpdateTargetReason
  /** Set iff `reason === 'eligible'` (§4.3 row 16: "eligible (mode
   * content-write)"). A2 only ever produces `'content-write'`; other modes
   * are A4's (§5b, guided resolution). */
  readonly mode?: 'content-write'
  /** Set for `probe-failed`/`unreadable` reached via the probe's own error
   * outcome (§4.2's sanitized `{path, errno}`) — NOT set for row 5b's
   * `depth-cap` -> `probe-failed` mapping, which has no such payload (the
   * walk did not fail, it merely didn't conclude; see
   * `update-target-gate.rules.ts`). */
  readonly error?: ProbeError
  /** Set for `identity-mismatch` when `plan.identityMismatch` named an
   * owner (§4.3 row 10). Unset for row 5b's `escapes-root` ->
   * `identity-mismatch` mapping, where no owner key is known to this
   * function — see that rule's own comment for why that's still correct. */
  readonly owningManifestKey?: string
}
