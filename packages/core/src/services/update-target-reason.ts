/**
 * @fileoverview Closed-set reasons, result codes, groups and remediation data
 *   for `skillsmith update` (SMI-6532 A2, §4.4 of
 *   docs/internal/implementation/update-safety-and-source-resolution.md).
 *
 *   Imports nothing but types (§4.4: "imports nothing but types"). Every
 *   mapping below is a `Record<UpdateTargetReason, X>` or
 *   `Record<UpdateResultCode, X>` (never a `switch` with a `default`), so
 *   adding a new member to either union fails typecheck at every mapping site
 *   instead of silently falling through to nothing at runtime. That
 *   exhaustiveness is the entire point of this module — see CLAUDE.md's
 *   "assert the property that makes the code correct" rule (SMI-6732): a
 *   `switch`+`default` would still compile after a union grows, which is
 *   exactly the silent-success shape this file exists to rule out.
 *
 * @module @skillsmith/core/services/update-target-reason
 */

// ─────────────────────────────────────────────────────────────────────────────
// UpdateTargetReason — the closed set from §4.3's classification table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The closed set of classification reasons a target can land on, per §4.3's
 * "Classification order" table (rows 0a-16), plus the two probe-error reasons
 * named in §4.2's preamble ("Metadata errors ... give `probe-failed`. A read
 * or hash error on SKILL.md or any file in the write set gives `unreadable`")
 * and echoed again in §4.3's own preamble ("A probe error at any row ends
 * classification there, with `probe-failed` or `unreadable`").
 *
 * Row 1 of §4.3 ("Outside the resolved scope or client" -> "not listed") is
 * deliberately NOT a member: a target that isn't in the resolved scope never
 * becomes an `UpdateTarget` in the first place, so it has no reason to
 * classify — there is nothing for a renderer to render. This matches
 * SMI-6532's explicit instruction.
 *
 * MEMBER COUNT: 23. See the "Member count reconciliation" note in this
 * module's test file for the full derivation and a discrepancy this file's
 * author flagged against SMI-6532's own pre-computed count of 22.
 *
 * Defined as a runtime `const` tuple, with the type derived from it (rather
 * than a hand-written string-literal union), so the type and a real,
 * iterable value can never drift apart — the VS Code parity test needs an
 * actual array to diff against, not just a type that erases at runtime.
 */
export const UPDATE_TARGET_REASONS = [
  // Row 0a/0b — the whole run, or a per-root record, couldn't be read at all.
  'manifest-unreadable',
  'recovery-record-unreadable',
  // Row 2 — a backup directory; §4.5 says it "appears only as a count".
  'backup-dir',
  // Row 3 — an unresolved recovery record for this exact target.
  'recovery-pending',
  // Row 4 — no manifest evidence, or evidence that points somewhere else.
  'untracked',
  'manifest-key-conflict',
  // Row 5 — a `.git` ancestor; report-only, never a write target.
  'git-managed',
  // Row 6 — locally authored, or no known registry source.
  'local',
  // Row 7 — an illegal ADR-145 provenance combination.
  'illegal-provenance',
  // Row 8 — no provenance, but a registry reference exists.
  'unverified',
  // Row 9 — blocked by a pin or an update policy.
  'pinned',
  'policy-never',
  'policy-manual',
  // Row 10 — an identity contradiction (includes UD22's non-owning key case).
  'identity-mismatch',
  // Row 11 — fetching or scanning the candidate new content failed.
  'fetch-failed',
  'scan-rejected',
  // Row 12 — the write set holds something other than a plain file.
  'unsupported-entry',
  // Row 13/14 — a `modify` file with no baseline, or one whose bytes differ.
  'no-baseline',
  'local-edits',
  // Row 15/16 — nothing to write, or everything checks out.
  'up-to-date',
  'eligible',
  // §4.2 preamble — probe (I/O) failures, not classification failures.
  'probe-failed',
  'unreadable',
] as const

export type UpdateTargetReason = (typeof UPDATE_TARGET_REASONS)[number]

// ─────────────────────────────────────────────────────────────────────────────
// UpdateResultCode — the closed set from §4.4's own enumeration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The closed set of outcomes an applied (post-plan) update can land on, per
 * §4.4's literal enumeration. Two members (`recovery-pending`,
 * `recovery-record-unreadable`) share a string with an `UpdateTargetReason`
 * member — that is expected (the same underlying condition can be discovered
 * either during planning or during apply) and is exactly why
 * {@link remediationFor} takes a tagged {@link UpdateCode} rather than a bare
 * string: two unrelated unions sharing a literal is invisible to TypeScript's
 * structural typing, so a bare-string dispatch would silently pick whichever
 * Record happened to be checked first.
 *
 * MEMBER COUNT: 15. Same runtime-array-first pattern as
 * {@link UPDATE_TARGET_REASONS} above, for the same reason.
 */
export const UPDATE_RESULT_CODES = [
  'updated',
  'changed-since-plan',
  'busy',
  'target-changed',
  'root-changed',
  'staging-unsafe',
  'staging-collision',
  'backup-unsafe',
  'recovery-pending',
  'recovery-record-unreadable',
  'recovery-conflict',
  'recovery-identity-changed',
  'recovery-ambiguous',
  'recovery-moved',
  'write-failed',
] as const

export type UpdateResultCode = (typeof UPDATE_RESULT_CODES)[number]

// ─────────────────────────────────────────────────────────────────────────────
// UpdateTargetGroup — the seven printed groups from §4.5
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The seven groups §4.5 prints, in their fixed print order. Values are
 * kebab-case renderer-agnostic identifiers, not the literal print headings
 * (`"Will update"` etc.) — each surface owns its own display text, matching
 * §4.4's "Each surface renders its own text" rule.
 */
export type UpdateTargetGroup =
  | 'will-update'
  | 'needs-attention'
  | 'yours-left-alone'
  | 'git-clones'
  | 'blocked'
  | 'could-not-check'
  | 'up-to-date'

/**
 * `backup-dir` is deliberately NOT one of the seven printed groups above:
 * §4.5 says plainly "Backup dirs appear only as a count" — a backup dir never
 * appears as a row inside any group listing, it only contributes to a number
 * printed once, outside every group. But {@link REASON_GROUP} below must
 * still be a total `Record<UpdateTargetReason, ...>` for the exhaustiveness
 * guarantee this module promises, and `backup-dir` IS an `UpdateTargetReason`
 * member (§4.3 row 2) — so it needs *some* value there.
 *
 * DECISION (documented per SMI-6532's own requirement to flag a deviation
 * rather than silently apply it): rather than
 * silently reusing one of the seven real groups (which would make a renderer
 * that naively iterates a group's reason list print backup dirs as though
 * they were orphaned/blocked/etc. targets — a wrong answer, not just an
 * incomplete one), `backup-dir` maps to this sentinel value instead. A
 * renderer that walks {@link UpdateTargetGroup} print groups never sees it;
 * a renderer that wants the backup count reads {@link REASON_GROUP} directly
 * for the `backup-dir` key.
 */
export const BACKUP_DIR_GROUP = 'backup-count-only' as const

/** The value type of {@link REASON_GROUP}: a real print group, or the backup-dir sentinel. */
export type UpdateTargetReasonGroup = UpdateTargetGroup | typeof BACKUP_DIR_GROUP

/**
 * §4.5's group table, exactly as printed (in print order per group), restated
 * as a `Record<UpdateTargetReason, UpdateTargetReasonGroup>` so a new reason
 * added to {@link UpdateTargetReason} without a group assignment fails
 * typecheck rather than silently landing in no group (and so a renderer never
 * needs its own `switch`/`default` to bucket a reason into a group).
 */
export const REASON_GROUP: Record<UpdateTargetReason, UpdateTargetReasonGroup> = {
  eligible: 'will-update',

  unverified: 'needs-attention',
  'identity-mismatch': 'needs-attention',
  'manifest-key-conflict': 'needs-attention',
  'illegal-provenance': 'needs-attention',
  'no-baseline': 'needs-attention',
  'local-edits': 'needs-attention',
  'unsupported-entry': 'needs-attention',
  'recovery-pending': 'needs-attention',

  local: 'yours-left-alone',
  untracked: 'yours-left-alone',

  'git-managed': 'git-clones',

  pinned: 'blocked',
  'policy-never': 'blocked',
  'policy-manual': 'blocked',

  'probe-failed': 'could-not-check',
  unreadable: 'could-not-check',
  'fetch-failed': 'could-not-check',
  'scan-rejected': 'could-not-check',
  'manifest-unreadable': 'could-not-check',
  'recovery-record-unreadable': 'could-not-check',

  'up-to-date': 'up-to-date',

  'backup-dir': BACKUP_DIR_GROUP,
}

// ─────────────────────────────────────────────────────────────────────────────
// remediationFor — data, never text (§4.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The closed set of remediation kinds. Nine of the ten -- every kind but
 * `set-policy` -- are copied verbatim from §4.4's own enumeration, field
 * names and literal union members included, not inferred.
 *
 * `set-policy { dirName, manifestKey, current: 'never' | 'manual' }` is the
 * tenth, added by owner decision (SMI-6532): §4.4 names no kind for
 * `policy-never`/`policy-manual`, which left both mapped to `{ kind: 'none'
 * }` below -- but SMI-6532's own acceptance criterion requires every printed
 * group to end with a generated next step, and a `none` remediation renders
 * no step at all while the structurally identical `pinned` (also row 9, also
 * a block) renders one via `unpin`. `current` names which policy is
 * blocking so a renderer can act on it; it is data, never the CLI string a
 * renderer would build from it (e.g. `skillsmith pin <dirName> --policy
 * auto`), matching this module's "data, never text" rule for every other
 * kind here.
 */
export type UpdateRemediation =
  | { readonly kind: 'git-pull'; readonly repoRoot: string }
  | {
      readonly kind: 'reconcile'
      readonly action: 'verify' | 'relink'
      readonly manifestKey: string
    }
  | { readonly kind: 'unpin'; readonly dirName: string }
  | {
      readonly kind: 'set-policy'
      readonly dirName: string
      readonly manifestKey: string
      readonly current: 'never' | 'manual'
    }
  | { readonly kind: 'fix-permissions'; readonly path: string; readonly errno: string }
  | { readonly kind: 'audit-sources' }
  | { readonly kind: 'move-aside'; readonly dir: string }
  | {
      readonly kind: 'doctor'
      readonly command: 'locks' | 'recovery'
      readonly action?: 'apply' | 'undo' | 'abandon' | 'quarantine'
      readonly opId?: string
      readonly root?: string
    }
  | { readonly kind: 'retry' }
  | { readonly kind: 'none' }

/**
 * Everything a remediation builder might need to fill in a kind's payload.
 * All fields are optional because most reasons/result codes only need one or
 * two of them — a builder reads only the field(s) its own kind requires.
 */
export interface UpdateRemediationContext {
  readonly repoRoot?: string
  readonly manifestKey?: string
  readonly dirName?: string
  readonly path?: string
  readonly errno?: string
  readonly dir?: string
  readonly opId?: string
  readonly root?: string
}

/**
 * Tagged input to {@link remediationFor}. A plain `UpdateTargetReason |
 * UpdateResultCode` union was considered and rejected: `recovery-pending` and
 * `recovery-record-unreadable` are valid members of BOTH unions (see the
 * {@link UpdateResultCode} doc comment), so a bare string can't say which
 * table it came from. Today both tables happen to resolve those two values to
 * the same remediation kind, but that is an implementation detail, not a
 * guarantee — a future revision of either table is free to diverge on them,
 * and a bare-string dispatch would have no way to notice or honor that. The
 * tag removes the ambiguity structurally instead of relying on the two
 * tables staying accidentally in agreement.
 */
export type UpdateCode =
  | { readonly kind: 'reason'; readonly reason: UpdateTargetReason }
  | { readonly kind: 'result'; readonly result: UpdateResultCode }

type RemediationBuilder = (context: UpdateRemediationContext) => UpdateRemediation

const NONE: UpdateRemediation = { kind: 'none' }
const RETRY: UpdateRemediation = { kind: 'retry' }
const AUDIT_SOURCES: UpdateRemediation = { kind: 'audit-sources' }

const fixPermissions = (c: UpdateRemediationContext): UpdateRemediation => ({
  kind: 'fix-permissions',
  path: c.path ?? '',
  errno: c.errno ?? '',
})
const gitPull = (c: UpdateRemediationContext): UpdateRemediation => ({
  kind: 'git-pull',
  repoRoot: c.repoRoot ?? '',
})
const reconcileVerify = (c: UpdateRemediationContext): UpdateRemediation => ({
  kind: 'reconcile',
  action: 'verify',
  manifestKey: c.manifestKey ?? '',
})
const reconcileRelink = (c: UpdateRemediationContext): UpdateRemediation => ({
  kind: 'reconcile',
  action: 'relink',
  manifestKey: c.manifestKey ?? '',
})
const unpin = (c: UpdateRemediationContext): UpdateRemediation => ({
  kind: 'unpin',
  dirName: c.dirName ?? '',
})
const setPolicy =
  (current: 'never' | 'manual') =>
  (c: UpdateRemediationContext): UpdateRemediation => ({
    kind: 'set-policy',
    dirName: c.dirName ?? '',
    manifestKey: c.manifestKey ?? '',
    current,
  })
const moveAside = (c: UpdateRemediationContext): UpdateRemediation => ({
  kind: 'move-aside',
  dir: c.dir ?? '',
})
const doctorRecovery =
  (action?: 'apply' | 'undo' | 'abandon' | 'quarantine') =>
  (c: UpdateRemediationContext): UpdateRemediation => ({
    kind: 'doctor',
    command: 'recovery',
    action,
    opId: c.opId,
    root: c.root,
  })

/**
 * §4.3-reason -> remediation. Several of these are not literally spelled out
 * in §4.4 (which enumerates the *kinds*, not a reason-by-reason table) and
 * were chosen by the closest semantic match between the reason's own §4.3
 * description and an available kind; each is called out in the test file's
 * "Remediation choices" block so a reader can see the reasoning without
 * re-deriving it. None of these choices affects classification (§4.3), only
 * what a renderer suggests doing next.
 */
const REASON_REMEDIATION: Record<UpdateTargetReason, RemediationBuilder> = {
  // I/O failures: the failing path/errno came from the probe, so surface them.
  'manifest-unreadable': fixPermissions,
  'recovery-record-unreadable': fixPermissions,
  'probe-failed': fixPermissions,
  unreadable: fixPermissions,

  // Not a real target — nothing to remediate directly.
  'backup-dir': () => NONE,

  // §3.9 doctor recovery workflow.
  'recovery-pending': doctorRecovery(),

  // "Yours, left alone" — no action needed.
  untracked: () => NONE,
  local: () => NONE,

  // UD22: remediation names the owning key; §4.3's own text says so.
  'manifest-key-conflict': reconcileVerify,
  'identity-mismatch': reconcileVerify,

  // Git clones are pulled, never overwritten by `update`.
  'git-managed': gitPull,

  // ADR-145 illegal combination / no-provenance-with-registry-ref: both need
  // a human to look at where the content actually came from.
  'illegal-provenance': () => AUDIT_SOURCES,
  unverified: () => AUDIT_SOURCES,
  'scan-rejected': () => AUDIT_SOURCES,
  'no-baseline': () => AUDIT_SOURCES,

  // Explicit pin: the direct unpin action exists for exactly this.
  pinned: unpin,

  // Update *policy* (never/manual): owner decision, SMI-6532 (see
  // UpdateRemediation's own doc comment) — routes to the tenth kind,
  // set-policy, naming which policy is blocking, instead of `none`.
  'policy-never': setPolicy('never'),
  'policy-manual': setPolicy('manual'),

  // Transient — the probe itself already retries 3x (§4.2); a renderer-level
  // retry is the next reasonable step for a network-shaped failure.
  'fetch-failed': () => RETRY,

  // The write set contains something `update` can't write through directly.
  'unsupported-entry': moveAside,

  // A `modify` file whose bytes differ from baseline needs the user to look,
  // not an automated action (A2 doesn't ship `--overwrite-local-edits`; B does).
  'local-edits': () => NONE,

  // Terminal, non-error states.
  'up-to-date': () => NONE,
  eligible: () => NONE,
}

/**
 * §4.4 result-code -> remediation. See {@link REASON_REMEDIATION}'s doc
 * comment: §4.4 does not spell every one of these out either, so choices are
 * the closest semantic match and are explained in the test file.
 */
const RESULT_REMEDIATION: Record<UpdateResultCode, RemediationBuilder> = {
  // Success — nothing to do.
  updated: () => NONE,

  // Plan went stale between prompt and apply, or a lock/target/root moved
  // underneath the run — all three are "re-plan and try again" shapes.
  'changed-since-plan': () => RETRY,
  busy: () => RETRY,
  'target-changed': () => RETRY,
  'root-changed': () => RETRY,

  // An unsafe or colliding staging/backup directory blocks the write until
  // the offending directory is moved out of the way.
  'staging-unsafe': moveAside,
  'staging-collision': moveAside,
  'backup-unsafe': moveAside,

  // §3.9 doctor recovery workflow, differentiated by action where the name
  // itself implies one: an unresolved record needs applying/undoing (left to
  // the operator, hence no forced action here); a conflicting or ambiguous
  // record should be quarantined rather than guessed at; an identity change
  // needs the same reconcile-verify treatment as its planning-time cousin.
  'recovery-pending': doctorRecovery(),
  'recovery-record-unreadable': fixPermissions,
  'recovery-conflict': doctorRecovery('quarantine'),
  'recovery-ambiguous': doctorRecovery('quarantine'),
  'recovery-identity-changed': reconcileVerify,
  'recovery-moved': reconcileRelink,

  // Carries an errno (§4.4: "which carries the errno, so ENOSPC names the
  // full device") — surface path/errno the same way a probe failure does.
  'write-failed': fixPermissions,
}

/**
 * Look up the data-only remediation for a classification reason or an apply
 * result code. Returns data, never text (§4.4) — each surface (CLI
 * `manage.update.render.ts`, MCP `outdated.ts`/`skill-updates.ts`, VS Code
 * `manifestReader.ts`) renders its own text from the returned `kind`.
 */
export function remediationFor(
  code: UpdateCode,
  context: UpdateRemediationContext = {}
): UpdateRemediation {
  return code.kind === 'reason'
    ? REASON_REMEDIATION[code.reason](context)
    : RESULT_REMEDIATION[code.result](context)
}
