/**
 * @fileoverview Type vocabulary for the rename engine
 *               (SMI-4588 Wave 2 Steps 2-4, PR #2).
 * @module @skillsmith/mcp-server/audit/rename-engine.types
 *
 * Defines the public surface for `generateSuggestionChain`, `applyRename`,
 * and the `apply | revert` action discriminator. The shapes here are the
 * canonical replacement for `RenameSuggestionRef` shipped in
 * `namespace-audit.types.ts` PR #1 — the structural shape is preserved so
 * the swap-in is a drop-in replacement.
 *
 * Plan: docs/internal/implementation/smi-4588-rename-engine-ledger-install.md §1.
 */

import type { CollisionId, InventoryEntry } from './collision-detector.types.js'

/**
 * Three on-disk apply paths. Each maps to a distinct mutation strategy:
 *
 * - `rename_command_file` — `~/.claude/commands/foo.md` → `~/.claude/commands/<author>-foo.md`
 * - `rename_agent_file` — `~/.claude/agents/foo.md` → `~/.claude/agents/<author>-foo.md`
 * - `rename_skill_dir_and_frontmatter` — rename the directory AND rewrite the
 *   `name:` field inside SKILL.md frontmatter.
 */
export type RenameAction =
  | 'rename_command_file'
  | 'rename_agent_file'
  | 'rename_skill_dir_and_frontmatter'

/**
 * One concrete rename suggestion attached to a detected collision. PR #1's
 * `RenameSuggestionRef` shim in `namespace-audit.types.ts` is structurally
 * compatible with this shape; PR #2 replaces the shim with this canonical
 * type.
 *
 * Wave 4's `apply_namespace_rename` MCP tool accepts a `RenameSuggestion`
 * (or a `customName` override) plus an action discriminator and dispatches
 * to `applyRename`.
 */
export interface RenameSuggestion {
  /** Stable across audit runs — derived via `deriveCollisionId`. */
  collisionId: CollisionId
  /** The inventory entry whose identifier collides. */
  entry: InventoryEntry
  /** Current on-disk identifier (filename without `.md`, or skill name). */
  currentName: string
  /**
   * First non-colliding candidate from `generateSuggestionChain`. Walking
   * the chain (and selecting alternatives on collision) is the agent's job;
   * `suggested` is the chain's first viable rename.
   */
  suggested: string
  /** Which on-disk mutation strategy applies. */
  applyAction: RenameAction
  /** Human-readable, e.g. `"collision with skillsmith/release-tools /ship"`. */
  reason: string
}

/**
 * Action discriminator for `applyRename`. PR #2 ships `apply` + `revert`;
 * `customName` (caller supplies override) lands in PR #3 alongside the
 * install-integration plumbing.
 */
export type RenameActionRequest =
  | { action: 'apply'; auditId: string; customName?: string }
  | { action: 'revert'; auditId: string }

/**
 * Top-level apply request. `auditId` is the FK into the audit-history
 * `~/.skillsmith/audits/<auditId>/result.json` so forensic lookups can
 * re-derive the original collision context.
 */
export interface ApplyRenameRequest {
  /** Suggestion produced by `generateRenameSuggestions` / chain walk. */
  suggestion: RenameSuggestion
  /** `apply` (forward rename) or `revert` (inverse, by ledger lookup). */
  request: RenameActionRequest
}

/**
 * Result of a rename apply (or revert). `success === false` populates
 * `error` with a typed discriminator; `success === true` populates the
 * ledger linkage + on-disk paths + the inline revert summary.
 *
 * Idempotent re-apply on the same `(skillId, originalIdentifier)` pair is
 * indicated by `fromPath === toPath` and `backupPath === ''` — callers may
 * detect a no-op without re-reading the ledger.
 */
export interface ApplyRenameResult {
  success: boolean
  collisionId: CollisionId
  appliedAction: RenameAction
  /** Action that ran — useful when `request.action === 'revert'`. */
  appliedRequest: RenameActionRequest['action']
  /** Pre-mutation absolute path. */
  fromPath: string
  /** Post-mutation absolute path. Equal to `fromPath` for idempotent no-ops. */
  toPath: string
  /**
   * Backup directory created by `createSkillBackup`. Empty string when the
   * call was a no-op (idempotent re-apply) — no backup is created in that
   * case because the on-disk state already matches the ledger.
   */
  backupPath: string
  /** ULID of the appended ledger entry — `''` for revert (ledger entry removed). */
  ledgerEntryId: string
  /**
   * Inline revert summary (decision #10). Populated on success; empty
   * string on failure. Literal text:
   *
   *   `"Renamed /<OLD> → /<NEW>. To undo: sklx audit revert <auditId>"`
   *
   * The agent surfaces this directly to the user in tool-response output.
   */
  summary: string
  /** Discriminated error on failure; `undefined` on success. */
  error?: RenameError
}

/**
 * Typed errors surfaced by `applyRename`. Discriminated by `kind` so
 * callers `switch` rather than parsing strings. Plan §1.
 */
export type RenameError =
  | {
      kind: 'namespace.rename.target_exists'
      target: string
      message: string
    }
  | {
      kind: 'namespace.rename.backup_failed'
      reason: string
      message: string
    }
  | {
      kind: 'namespace.rename.frontmatter_rewrite_failed'
      reason: string
      message: string
    }
  | {
      kind: 'namespace.rename.fs_error'
      reason: string
      message: string
    }
  | {
      kind: 'namespace.ledger.disk_divergence'
      ledgerRenamedTo: string
      onDisk: string
      message: string
      remediationHint: string
    }
  | {
      kind: 'namespace.rename.revert_not_found'
      auditId: string
      message: string
    }

/**
 * Output of `generateSuggestionChain`. Up to 3 ordered candidates; if all
 * three collide, `exhausted: true` and the agent must escalate to the
 * human via `customName`.
 */
export interface SuggestionChain {
  /** Up to 3 ordered candidates per decision #11. */
  candidates: string[]
  /** `true` when all 3 candidates collide. */
  exhausted: boolean
}
