/**
 * @fileoverview Type vocabulary for the namespace-overrides ledger
 *               (SMI-4588 Wave 2 Step 1, PR #1).
 * @module @skillsmith/mcp-server/audit/namespace-overrides.types
 *
 * Schema for `~/.skillsmith/namespace-overrides.json`. Modeled on the
 * dependency-intelligence persistence pattern (SMI-3137). The schema is
 * versioned; `CURRENT_VERSION` is bumped only when the on-disk shape
 * changes incompatibly. Reader/writer live in `./namespace-overrides.ts`.
 *
 * Plan: docs/internal/implementation/smi-4588-rename-engine-ledger-install.md §2.
 */

import type { InventoryKind } from '../utils/local-inventory.types.js'

/**
 * Current ledger schema version. Bumped only when the on-disk shape
 * changes incompatibly. Read-path behavior:
 *
 * - `version === CURRENT_VERSION` → return as-is.
 * - `version < CURRENT_VERSION` → caller may run a `migrateLedger` shim
 *   (currently no historical versions exist, so any value below 1 is
 *   unreachable in practice).
 * - `version > CURRENT_VERSION` → reader returns a typed
 *   `namespace.ledger.version_unsupported` error rather than silently
 *   degrading to an empty ledger (plan §2 Edit 6).
 */
export const CURRENT_VERSION = 1 as const

export type LedgerVersion = typeof CURRENT_VERSION

/**
 * One applied rename. Persisted in `~/.skillsmith/namespace-overrides.json`
 * under `overrides[]`. ULID `id` lets later operations (revert, replay,
 * forensics) reference the entry without depending on `(skillId, kind,
 * originalIdentifier)` triple equality.
 */
export interface OverrideRecord {
  /** ULID prefixed with `ovr_` for log-grep readability. */
  id: string
  /**
   * Skillsmith manifest skill id (`<author>/<name>`) when the renamed
   * artifact is a registered skill, else `null` for local/unregistered
   * commands and agents.
   */
  skillId: string | null
  /**
   * Which inventory kind this override applies to. Mirrors
   * `InventoryKind` from local-inventory so a single ledger covers skills,
   * commands, agents, and CLAUDE.md rules (the last for future use; Wave 2
   * does not write claude_md_rule entries).
   */
  kind: InventoryKind
  /**
   * The original triggering identifier — e.g. `/ship` for a command,
   * `code-review` for a skill name. This is the field the install-time
   * ledger replay matches against when deciding whether to re-apply a
   * rename.
   */
  originalIdentifier: string
  /**
   * The chosen renamed identifier — e.g. `/anthropic-ship`,
   * `anthropic-code-review`.
   */
  renamedTo: string
  /** Absolute path to the original on-disk artifact at apply time. */
  originalPath: string
  /** Absolute path to the renamed on-disk artifact post-apply. */
  renamedPath: string
  /** ISO-8601 timestamp recorded by the writer (UTC). */
  appliedAt: string
  /**
   * FK to `~/.skillsmith/audits/<auditId>/result.json`. Lets a forensic
   * lookup re-derive the original collision context.
   */
  auditId: string
  /**
   * Human-readable reason — e.g.
   * `"collision with skillsmith/release-tools /ship"`. Surfaced verbatim
   * in the audit-report writer (Wave 2 PR #4 extension).
   */
  reason: string
}

/**
 * On-disk shape of `~/.skillsmith/namespace-overrides.json`.
 *
 * `version` is required and validated on read. Unknown future fields are
 * preserved on read-modify-write at the writer layer (additive
 * extensions don't break older clients), but any `version` strictly
 * greater than `CURRENT_VERSION` triggers a typed error per plan §2.
 */
export interface OverridesLedger {
  version: LedgerVersion
  overrides: OverrideRecord[]
}

/**
 * Typed error returned by `readLedger` when the on-disk file declares a
 * higher version than this client understands. The reader does NOT throw
 * — it returns this discriminator so callers can decide whether to abort
 * or fall back. Plan §2 Edit 6.
 */
export interface LedgerVersionUnsupportedError {
  kind: 'namespace.ledger.version_unsupported'
  found: number
  expected: LedgerVersion
}

/**
 * Discriminated union returned by `readLedger`. The success branch is the
 * ledger; the error branches are typed so callers `switch` on `kind` and
 * never silently absorb a higher-version file as empty.
 */
export type ReadLedgerResult =
  | { kind: 'ok'; ledger: OverridesLedger }
  | LedgerVersionUnsupportedError
  | { kind: 'namespace.ledger.malformed'; reason: string }
