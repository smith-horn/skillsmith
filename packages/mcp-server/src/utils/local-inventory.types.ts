/**
 * @fileoverview Type vocabulary for the local-inventory scanner (SMI-4587 Wave 1 Step 1).
 * @module @skillsmith/mcp-server/utils/local-inventory.types
 *
 * Public surface consumed by the collision-detector + audit-history modules.
 * Wave 2/3/4 import these types — keep stable and additive.
 */

import type { ClientId } from '@skillsmith/core/install'

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
  /**
   * Which supported AI coding client this entry was scanned from (SMI-6077).
   * `skill` entries carry whichever client's native skills directory
   * (`CLIENT_NATIVE_PATHS` / `getInstallPath`, `@skillsmith/core/install` —
   * the same source of truth `install_skill --client` and every other
   * client-aware command use) produced them. `command` / `agent` /
   * `claude_md_rule` entries are always `'claude-code'` — those constructs
   * have no equivalent directory for other clients today. Optional: not
   * every `InventoryEntry` literal in this codebase sets it (e.g.
   * `install-preflight.ts`'s synthesized install-candidate entry), so this
   * is a strictly additive field. Always `undefined` for `origin: 'plugin'`
   * entries — see `pluginId` below for how those are identified instead.
   */
  client?: ClientId
  /**
   * Where this entry was scanned from (SMI-6228). `'native-client'` covers
   * every Source 1-4 entry (a supported client's native skills directory,
   * plus Claude Code's own commands/agents/CLAUDE.md rules) — the same
   * population `client` already tags. `'plugin'` covers Source 5: a Claude
   * Code plugin-installed skill discovered under
   * `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/**`.
   * Deliberately a SEPARATE field from `client` rather than widening
   * `ClientId` to include a plugin variant — `ClientId` is a closed union
   * consumed by real install-target resolution (`CLIENT_NATIVE_PATHS`,
   * `install_skill --client`, and other exhaustive switches across
   * `@skillsmith/core/install`), and a plugin is not an install target in
   * that sense. Optional for backward compatibility with pre-SMI-6228
   * `InventoryEntry` literals that don't set it (treat absence as
   * equivalent to `'native-client'` for Source 1-4 provenance).
   */
  origin?: 'native-client' | 'plugin'
  /**
   * Set only when `origin === 'plugin'`: the enabling plugin's id in
   * `<plugin>@<marketplace>` shape, exactly as it appears as a key in
   * `~/.claude/settings.json`'s `enabledPlugins` map (e.g.
   * `"supabase@supabase-agent-skills"`). Lets the audit report and
   * collision detector attribute a plugin-sourced entry back to the plugin
   * that installed it, since `client` is left `undefined` for these
   * entries.
   */
  pluginId?: string
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
