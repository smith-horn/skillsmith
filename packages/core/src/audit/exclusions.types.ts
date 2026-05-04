/**
 * @fileoverview Types for the audit exclusions file (SMI-4590 Wave 4 PR 3).
 * @module @skillsmith/core/audit/exclusions.types
 *
 * Schema for `~/.skillsmith/audit-exclusions.json`. Version-gated; wraps a
 * list of per-skill / per-command suppression entries that filter the
 * inventory audit result before it surfaces to the user. See plan §8 of
 * `docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md`.
 */

/** A single suppression entry. Discriminated union on `kind`. */
export type ExclusionEntry =
  | {
      kind: 'command'
      /** Slash-command identifier, e.g. `'/ship'`. */
      identifier: string
      /** Free-text rationale shown in audit output. Required. */
      reason: string
    }
  | {
      kind: 'skill'
      /** Skill identifier, e.g. `'anthropic/code-helper'`. */
      skillId: string
      /** Free-text rationale shown in audit output. Required. */
      reason: string
    }

/** Top-level config wrapper. `version: 1` is the only supported schema. */
export interface ExclusionsConfig {
  version: 1
  exclusions: ExclusionEntry[]
}

/**
 * Minimal duck-typed entry shape that {@link isExcluded} accepts.
 *
 * Callers map their domain types (e.g. mcp-server's `InventoryEntry` or
 * `ExactCollisionFlag`) onto this before calling. Keeps `@skillsmith/core`
 * from depending on `@skillsmith/mcp-server` (which would be circular —
 * mcp-server depends on core).
 */
export interface ExcludableEntry {
  /** `'command'` for slash-commands; `'skill'` for skill ids. */
  kind: 'command' | 'skill'
  /** Required when `kind === 'command'`. */
  commandIdentifier?: string
  /** Required when `kind === 'skill'`. */
  skillId?: string
}
