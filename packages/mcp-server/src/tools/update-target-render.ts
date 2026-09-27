/**
 * @fileoverview Shared reason/result text TABLE for the MCP surface -- the data a
 *   renderer will use, not a renderer: nothing consumes it yet, so calling it one
 *   would restate the claim the cross-family gate rejected
 *   (SMI-6532 step 6, §4.4 of
 *   docs/internal/implementation/update-safety-and-source-resolution.md).
 *
 *   §4.4: "Each surface renders its own text: CLI `manage.update.render.ts`,
 *   MCP `outdated.ts` and `skill-updates.ts`, VS Code `manifestReader.ts`."
 *   ONE shared table here rather than one per MCP tool: both `outdated.ts`
 *   and `skill-updates.ts` live in this same package, so two separate
 *   38-member tables would be a drift surface where a new union member has
 *   to fail typecheck twice (once per table) to be caught, instead of once.
 *   §4.4's three-surface parity is over CLI / MCP / VS Code, not over
 *   individual tools within a surface.
 *
 *   NOT WIRED into either tool as of this writing (2026-09-26): neither
 *   `outdated.ts` nor `skill-updates.ts` classifies a target against
 *   `UpdateTargetReason`/`UpdateResultCode` at all today — `outdated.ts`
 *   renders its own, older, unrelated `OutdatedDiagnosis` five-state model
 *   (`current | outdated | local-drift | identity-mismatch | unknown`, see
 *   `outdated.identity.ts`), and `skill-updates.ts` reports a plain
 *   `updateAvailable: boolean` off `compareSkillContentHashes()`'s outcome.
 *   Neither has a call site that produces an `UpdateTargetReason` or
 *   `UpdateResultCode` to render. That call site arrives with SMI-6532 step
 *   5 / A1's update-target classification pipeline (`update-target-gate.ts`,
 *   `update-target.probe.ts`) landing behind an MCP entry point. Exporting
 *   this table now, unwired, makes this package's half of §4.4's member set
 *   checkable today without inventing a call site that would change either
 *   tool's current output shape. That is PREPARATORY, not step 6 complete:
 *   §4.4 says each surface RENDERS, and T-R4 fails if a member renders empty
 *   on a surface, so a table nothing consumes satisfies the data-shape half of
 *   the requirement and none of the behavioural half. Completion is wiring
 *   these tables into surface output and testing that boundary, which needs
 *   step 5's call sites. The check lives in the CORE package, not in a
 *   sibling `.test.ts` here -- it AST-reads this file because core cannot
 *   import mcp-server. And it checks the TABLE, not rendering: there is no
 *   call site, so nothing asserts that a user ever sees any of this text. That
 *   distinction was drawn by the cross-family gate on PR #2952; the earlier
 *   wording here claimed renderer parity was checkable today, which overstated
 *   a dormant table's completeness as behaviour.
 *
 *   Total `Record<UpdateTargetReason | UpdateResultCode, string>` (§4.4:
 *   "Every renderer is a `Record<UpdateTargetReason | UpdateResultCode,
 *   ...>`, so a new member fails typecheck") — deliberately not a function
 *   with a `switch`/default branch, which would keep compiling after either
 *   union grows and silently render nothing for the new member. That is the
 *   exact silent-success shape CLAUDE.md's "assert the property that makes
 *   the code correct, not the value a correct implementation happens to
 *   emit" rule (SMI-6732) warns against, and the same rationale
 *   `update-target-reason.ts` itself gives for using a `Record` everywhere.
 *
 *   `UpdateTargetReason` and `UpdateResultCode` share two literal strings
 *   (`recovery-pending`, `recovery-record-unreadable` — see `UpdateCode`'s
 *   doc comment in `@skillsmith/core`'s `update-target-reason.ts`), so
 *   TypeScript's mapped type collapses the union to 36 distinct keys, not
 *   38: both call sites (as a classification reason, and as an apply result
 *   code) read the same sentence for those two strings, which is correct —
 *   `remediationFor` resolves both to the same remediation kind too (a
 *   `doctor` recovery workflow either way), because it is the same
 *   underlying condition discovered at a different pipeline stage.
 *
 * @module @skillsmith/mcp-server/tools/update-target-render
 */

import type { UpdateTargetReason, UpdateResultCode } from '@skillsmith/core'

/**
 * One short, human sentence per closed-set member (§4.4). No trailing
 * period, and never "see the docs" — this text names what happened; the
 * generated next step (once a call site exists) comes from
 * `remediationFor()`'s data, not from this table.
 */
export const UPDATE_TARGET_TEXT: Record<UpdateTargetReason | UpdateResultCode, string> = {
  // ---- UpdateTargetReason (§4.3), in the same order as UPDATE_TARGET_REASONS ----
  'manifest-unreadable': 'The manifest file could not be read',
  'recovery-record-unreadable': 'A recovery record for this skills root could not be read',
  'backup-dir': 'This is a backup directory, not an update target',
  'recovery-pending': 'An unresolved recovery record exists for this skill',
  untracked: 'No manifest entry references this installed skill',
  'manifest-key-conflict': 'Another manifest key already claims this real path',
  'git-managed': 'This skill is a git clone and is pulled, not overwritten',
  local: 'This skill was authored locally, not installed from the registry',
  'illegal-provenance': 'This skill has a provenance combination that is not allowed',
  unverified: 'This skill has a registry reference but no verified provenance',
  pinned: 'This skill is pinned and excluded from updates',
  'policy-never': 'The update policy for this skill is set to never update',
  'policy-manual': 'The update policy for this skill requires a manual update',
  'identity-mismatch': 'The recorded identity for this skill contradicts what is on disk',
  'fetch-failed': 'Fetching the candidate new content failed',
  'scan-rejected': 'The candidate new content failed a security scan',
  'unsupported-entry': 'The write set contains something other than a plain file',
  'no-baseline': 'A modified file has no recorded baseline to compare against',
  'local-edits': 'A file has local edits that differ from its recorded baseline',
  'up-to-date': 'This skill is already up to date',
  eligible: 'This skill is eligible to update',
  'probe-failed': 'Reading this target metadata failed',
  unreadable: 'Reading or hashing a file in this target write set failed',

  // ---- UpdateResultCode (§4.4), excluding the two shared with the reason
  // set above (`recovery-pending`, `recovery-record-unreadable`) ----
  updated: 'The update was applied successfully',
  'changed-since-plan': 'The plan went stale before it could be applied',
  busy: 'A lock held by another process blocked this update',
  'target-changed': 'The target changed underneath this update',
  'root-changed': 'The skills root changed underneath this update',
  'staging-unsafe': 'The staging directory is unsafe to write through',
  'staging-collision': 'The staging directory collides with an existing path',
  'backup-unsafe': 'The backup directory is unsafe to write through',
  'recovery-conflict': 'The recovery record conflicts with the current state',
  'recovery-identity-changed': 'The recovered target identity has changed',
  'recovery-ambiguous': 'The recovery record is ambiguous and needs review',
  'recovery-moved': 'The recovered target has moved and needs relinking',
  'write-failed': 'Writing the update to disk failed',
}
