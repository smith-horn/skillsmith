/**
 * @fileoverview Type vocabulary for the FrameworkAdapter seam — v1 ships
 *               `claude-code` only; v2 reserves `cursor`, `copilot`, `aider`,
 *               `continue`, `cline`. Defines `AdapterAction` (discriminated
 *               union over `FileRenameAction` + `InlineEditAction`) and the
 *               adapter interface.
 * @module @skillsmith/mcp-server/audit/framework-adapter.types
 *
 * Plan: docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md §1, §5.
 *
 * Why this seam exists (per plan §5): `.cursorrules` (Cursor v2) is a
 * monolithic file with multiple trigger phrases inside a single file; a
 * `FileRenameAction`-only shape would break Cursor support. Shipping
 * `InlineEditAction` from v1 is a forcing function that lets v2 swap in
 * `cursorAdapter` without refactoring call sites.
 *
 * v1 contract (claudeCodeAdapter):
 *   - `FileRenameAction` is supported via convenience wrapper `applyRename`
 *     which performs the full Wave 2 `applyRename` flow (backup + ledger
 *     append + atomic rename). The bare `applyAction({kind:'rename'})`
 *     entry point is a raw transport seam (forward-compat for v2 adapters
 *     that own their own audit-history); v1 callers should prefer the
 *     `applyRename` wrapper which threads `auditId` through correctly.
 *   - `InlineEditAction` with `searchMode: 'literal'` translates to a
 *     `RecommendedEdit` and dispatches to Wave 3's `applyRecommendedEdit`.
 *   - `InlineEditAction` with `searchMode: 'regex'` is rejected with the
 *     typed error `namespace.adapter.unsupported_search_mode`. Reserved
 *     for v2 cursorAdapter.
 */

import type { InventoryEntry } from '../utils/local-inventory.types.js'
import type { RecommendedEdit } from './edit-suggester.types.js'

/**
 * Set of frameworks the audit pipeline can target. v1 ships `claude-code`
 * exclusively. The v2 reserved values document the intended extension
 * surface — adding a new entry here without a matching adapter
 * implementation is a compile-time signal, not a runtime contract.
 */
export type FrameworkName =
  | 'claude-code'
  // v2 (reserved — adapters will land in subsequent Linear issues):
  | 'cursor'
  | 'copilot'
  | 'aider'
  | 'continue'
  | 'cline'

/**
 * Rename a single file (or directory + frontmatter for `.claude/skills/`).
 *
 * For Claude-Code, this maps to Wave 2's `applyRename` flow: the caller
 * should normally invoke the `applyRename` convenience wrapper which
 * builds the action from a full `InventoryEntry` + `auditId`. The bare
 * `applyAction({kind:'rename'})` entry is a transport seam — it expects
 * a richer caller-side context to resolve correctly (see `auditId`
 * field).
 */
export interface FileRenameAction {
  kind: 'rename'
  /** Absolute path (current). */
  from: string
  /** Absolute path (target). */
  to: string
  /**
   * FK into `~/.skillsmith/audits/<auditId>/result.json`. Required by
   * v1 Claude-Code adapter so the rename can be traced in the namespace
   * overrides ledger. v2 adapters that own a different audit history
   * may treat this as optional, hence the optional declaration here.
   */
  auditId?: string
}

/**
 * In-place edit at a specific point in a file. Required for monolithic
 * files (`.cursorrules`, freeform CLAUDE.md sections) where renaming
 * the file itself is meaningless — the edit happens at a section.
 *
 * v1 Claude-Code adapter accepts only `searchMode: 'literal'` and
 * translates the action into a Wave 3 `RecommendedEdit` shape before
 * dispatching to `applyRecommendedEdit`. `searchMode: 'regex'` is
 * rejected with `namespace.adapter.unsupported_search_mode`.
 */
export interface InlineEditAction {
  kind: 'inline-edit'
  /** Absolute path to the file to mutate. */
  filePath: string
  /**
   * Exact substring (when `searchMode === 'literal'`) or regex source
   * string (when `searchMode === 'regex'`) to locate within the file.
   */
  search: string
  /** Replacement text. */
  replace: string
  /**
   * Required. v1 `claudeCodeAdapter` rejects `'regex'` with the typed
   * error `namespace.adapter.unsupported_search_mode`. Future v2
   * `cursorAdapter` supports both modes.
   */
  searchMode: 'literal' | 'regex'
  /**
   * FK into `~/.skillsmith/audits/<auditId>/result.json`. Required by
   * v1 Claude-Code adapter so the edit-applier ledger entry is bound
   * to the originating audit. v2 adapters may treat this as optional,
   * hence the optional declaration here.
   */
  auditId?: string
  /**
   * The edit-suggester template pattern that produced this action. v1
   * Claude-Code adapter passes this through to Wave 3's
   * `applyRecommendedEdit`, which gates on `APPLY_TEMPLATE_REGISTRY`.
   * Only `'add_domain_qualifier'` is in the registry in v1.
   */
  pattern?: RecommendedEdit['pattern']
}

/**
 * Discriminated union over every adapter action shape. The `kind`
 * literal narrows the union for downstream dispatchers.
 */
export type AdapterAction = FileRenameAction | InlineEditAction

/**
 * Framework adapter — abstracts over `claude-code` (v1), `cursor`,
 * `copilot`, `aider`, `continue`, `cline` (v2). Wave 4's MCP tools,
 * the CLI, and Wave 2's install pre-flight all consume the adapter
 * rather than calling `scanLocalInventory` / `applyRename` /
 * `applyRecommendedEdit` directly. This is the seam that lets v2 swap
 * in `cursorAdapter` without touching call sites.
 */
export interface FrameworkAdapter {
  name: FrameworkName
  /** Glob/path examples for transparency in audit reports. */
  describesFiles(): string[]
  /**
   * Scan the framework's relevant filesystem locations for inventory.
   * For `claude-code` this wraps Wave 1's `scanLocalInventory`.
   */
  scanPaths(homeDir: string, projectDir?: string): Promise<InventoryEntry[]>
  /**
   * Required unified entry point. v1 Claude-Code:
   *   - `kind: 'rename'` — REFUSED. A thin {from, to} pair cannot
   *     reconstruct the `InventoryEntry` Wave 2's `applyRename` needs;
   *     a raw `fs.rename` would bypass the backup + namespace ledger.
   *     Callers must use the `applyRename(entry, newName, opts)`
   *     convenience wrapper. The shape stays in the union for v2
   *     adapters that own their own audit-history.
   *   - `kind: 'inline-edit'` with `searchMode: 'literal'` — translates
   *     to a `RecommendedEdit` and dispatches to Wave 3
   *     `applyRecommendedEdit`. Requires `auditId` + `pattern`.
   *   - `kind: 'inline-edit'` with `searchMode: 'regex'` — rejected
   *     with `namespace.adapter.unsupported_search_mode`.
   */
  applyAction(action: AdapterAction): Promise<void>
  /**
   * Convenience wrapper for the common `claude-code` rename flow:
   * builds a `FileRenameAction` and forwards. v1 Claude-Code wraps
   * Wave 2's `applyRename` (full backup + ledger append + atomic
   * rename). Optional on the interface — v2 adapters that don't have
   * a per-file rename concept (Cursor) may omit it.
   */
  applyRename?(entry: InventoryEntry, newName: string, opts: { auditId: string }): Promise<void>
  /**
   * Convenience wrapper for Wave 3's prose-edit surface. v1
   * Claude-Code builds an `InlineEditAction` with
   * `searchMode: 'literal'` from the `RecommendedEdit` shape and
   * forwards to `applyAction`.
   */
  applyEdit?(edit: RecommendedEdit, opts: { auditId: string }): Promise<void>
}
