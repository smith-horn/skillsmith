/**
 * @fileoverview Type vocabulary for the local-inventory scanner (SMI-4587 Wave 1 Step 1).
 * @module @skillsmith/mcp-server/utils/local-inventory.types
 *
 * Public surface consumed by the collision-detector + audit-history modules.
 * Wave 2/3/4 import these types — keep stable and additive.
 */

/**
 * The four sources scanned by `scanLocalInventory`. Each kind carries different
 * `triggerSurface` semantics; the collision detector handles them uniformly.
 */
export type InventoryKind = 'skill' | 'command' | 'agent' | 'claude_md_rule'

/**
 * One entry in the user's local inventory. Keyed by `kind` + `identifier`,
 * sourced at `source_path`, with the trigger text used by the collision detector
 * surfaced in `triggerSurface`.
 */
export interface InventoryEntry {
  kind: InventoryKind
  /** Absolute path to the source file. */
  source_path: string
  /**
   * Skills: name from frontmatter or directory fallback.
   * Commands / agents: filename without `.md`.
   * `claude_md_rule`: hashed line excerpt — see helpers.ts for the derivation.
   */
  identifier: string
  /** Phrases the collision detector matches against. */
  triggerSurface: string[]
  /**
   * Last-modified timestamp (Unix epoch ms) from `fs.stat`. Populated by the
   * scanner; consumed by the audit-report writer's mtime-based collision-cluster
   * sort (most-recent first within each severity group).
   */
  mtime?: number
  meta?: {
    /** From `~/.skillsmith/manifest.json` if registered; else undefined. */
    author?: string
    tags?: string[]
    /** Raw description for audit-report rendering. */
    description?: string
  }
}

/**
 * Soft-failure signal emitted by the scanner. `code` is a stable identifier
 * (catalog in local-inventory.helpers.ts); `context` carries structured detail.
 */
export interface ScanWarning {
  /** Stable warning code; see WARNING_CODES in helpers. */
  code: string
  /** Human-readable text for the audit report. */
  message: string
  context?: Record<string, unknown>
}

/**
 * Output of `scanLocalInventory`. `warnings` are typed-coded objects (not
 * strings) so report writers + telemetry can branch on `code` without parsing
 * prose.
 */
export interface ScanResult {
  entries: InventoryEntry[]
  warnings: ScanWarning[]
  durationMs: number
}

/** Brand type for ULID-shaped audit identifiers. */
export type AuditId = string & { readonly __brand: 'AuditId' }

/**
 * Brand type for collision identifiers.
 *
 * Machine-local constraint (E-ANTI-1): derived from absolute filesystem paths
 * via sha256(auditId + ':' + sortedEntryPaths.join(',')). Portability across
 * home-directory renames is NOT supported in v1; if the user renames their
 * home directory or moves skills, prior `namespace-overrides.json` ledger
 * entries become unreachable. Acceptable for v1 (local-only tool); a v2
 * follow-up will switch to a path-relative derivation.
 */
export type CollisionId = string & { readonly __brand: 'CollisionId' }

/**
 * Exact-name collision: two or more entries share the same normalized
 * `identifier`. Severity is always `error` — exact collisions are unambiguous.
 *
 * Design note (E-CONF-2): no `suggestion` field. Wave 2's rename engine
 * generates suggestions from `ExactCollisionFlag` entries; coupling a
 * suggestion field here would force Wave 4's display logic into the detector
 * module, breaking detection-only separation.
 */
export interface ExactCollisionFlag {
  kind: 'exact'
  collisionId: CollisionId
  identifier: string
  /** Two or more entries colliding on the same identifier. */
  entries: InventoryEntry[]
  severity: 'error'
  reason: string
}
