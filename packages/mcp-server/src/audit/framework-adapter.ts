/**
 * @fileoverview `claudeCodeAdapter` — v1 implementation of `FrameworkAdapter`.
 *               Wraps Wave 1's `scanLocalInventory`, Wave 2's `applyRename`,
 *               and Wave 3's `applyRecommendedEdit` behind a uniform seam.
 * @module @skillsmith/mcp-server/audit/framework-adapter
 *
 * Plan: docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md §5.
 *
 * v1 contract (Claude-Code only):
 *   - `scanPaths` delegates to `scanLocalInventory` and returns `entries[]`.
 *   - `applyAction({kind:'rename'})` performs a raw `fs.rename` from `from`
 *     to `to` — forward-compat seam for v2 adapters that own their own
 *     audit-history. v1 callers should prefer the `applyRename` wrapper,
 *     which threads `auditId` through Wave 2's full backup + ledger flow.
 *   - `applyAction({kind:'inline-edit', searchMode:'literal'})` translates
 *     the action into a Wave 3 `RecommendedEdit` and dispatches to
 *     `applyRecommendedEdit`. Requires `action.auditId` + `action.pattern`;
 *     missing context throws `namespace.adapter.missing_context`.
 *   - `applyAction({kind:'inline-edit', searchMode:'regex'})` throws the
 *     typed error `namespace.adapter.unsupported_search_mode`. Reserved
 *     for v2 cursorAdapter.
 *   - Convenience wrappers `applyRename` + `applyEdit` build the right
 *     `AdapterAction` shape from inventory/edit context and call
 *     `applyAction`. They do NOT re-implement Wave 2/3 — the rename
 *     wrapper goes through Wave 2's full path (backup + ledger), and the
 *     edit wrapper goes through Wave 3's `applyRecommendedEdit`.
 */

import * as fs from 'node:fs/promises'

import { newAuditId, deriveCollisionId } from './audit-history.js'
import { applyRecommendedEdit, APPLY_TEMPLATE_REGISTRY } from './edit-applier.js'
import { applyRename as applyRenameEngine } from './rename-engine.js'
import type { CollisionId, InventoryEntry } from './collision-detector.types.js'
import type { RecommendedEdit } from './edit-suggester.types.js'
import type { RenameAction, RenameSuggestion } from './rename-engine.types.js'
import { scanLocalInventory } from '../utils/local-inventory.js'

import type {
  AdapterAction,
  FileRenameAction,
  FrameworkAdapter,
  InlineEditAction,
} from './framework-adapter.types.js'

/**
 * Typed error class for adapter-layer failures. Callers `switch` on
 * `kind` to branch on the failure mode without parsing strings.
 */
export class FrameworkAdapterError extends Error {
  public readonly kind:
    | 'namespace.adapter.unsupported_search_mode'
    | 'namespace.adapter.missing_context'
    | 'namespace.adapter.unsupported_action'
    | 'namespace.adapter.template_not_in_apply_registry'
    | 'namespace.adapter.search_not_found'
    | 'namespace.adapter.search_not_unique'

  constructor(kind: FrameworkAdapterError['kind'], message: string) {
    super(message)
    this.name = 'FrameworkAdapterError'
    this.kind = kind
  }
}

/**
 * Map an `InventoryEntry.kind` to the Wave 2 `RenameAction` discriminator.
 */
function inventoryKindToRenameAction(entry: InventoryEntry): RenameAction {
  switch (entry.kind) {
    case 'command':
      return 'rename_command_file'
    case 'agent':
      return 'rename_agent_file'
    case 'skill':
      return 'rename_skill_dir_and_frontmatter'
    case 'claude_md_rule':
      // CLAUDE.md trigger lines are not file-renamable — the inline-edit
      // path is the right surface for them. Reject so callers cannot
      // accidentally pass a `claude_md_rule` entry into the rename flow.
      throw new FrameworkAdapterError(
        'namespace.adapter.unsupported_action',
        `inventory kind "claude_md_rule" cannot be renamed; use applyEdit instead`
      )
    default: {
      const exhaustive: never = entry.kind
      throw new FrameworkAdapterError(
        'namespace.adapter.unsupported_action',
        `unknown inventory kind: ${String(exhaustive)}`
      )
    }
  }
}

/**
 * Translate an `InlineEditAction` (literal mode) into a Wave 3
 * `RecommendedEdit`. Locates the literal `search` substring in the file
 * and computes a 1-indexed inclusive line range covering it.
 *
 * Throws if `search` is absent from the file or appears more than once
 * (Wave 3's stale-before guard requires byte-for-byte exact match at
 * the recorded `lineRange`).
 */
async function buildRecommendedEditFromInlineEdit(
  action: InlineEditAction
): Promise<RecommendedEdit> {
  if (!action.auditId) {
    throw new FrameworkAdapterError(
      'namespace.adapter.missing_context',
      `inline-edit dispatch requires action.auditId for v1 claudeCodeAdapter`
    )
  }
  if (!action.pattern) {
    throw new FrameworkAdapterError(
      'namespace.adapter.missing_context',
      `inline-edit dispatch requires action.pattern for v1 claudeCodeAdapter`
    )
  }
  if (!APPLY_TEMPLATE_REGISTRY.has(action.pattern)) {
    throw new FrameworkAdapterError(
      'namespace.adapter.template_not_in_apply_registry',
      `template pattern "${action.pattern}" is not in APPLY_TEMPLATE_REGISTRY`
    )
  }

  const fileContent = await fs.readFile(action.filePath, 'utf-8')
  const firstIndex = fileContent.indexOf(action.search)
  if (firstIndex < 0) {
    throw new FrameworkAdapterError(
      'namespace.adapter.search_not_found',
      `literal search string not found in ${action.filePath}`
    )
  }
  const secondIndex = fileContent.indexOf(action.search, firstIndex + 1)
  if (secondIndex >= 0) {
    throw new FrameworkAdapterError(
      'namespace.adapter.search_not_unique',
      `literal search string occurs more than once in ${action.filePath}; refusing to mutate`
    )
  }

  // Compute 1-indexed inclusive line range covering the match. Wave 3's
  // applier uses line-based slicing (`fileLines.slice(start-1, end).join('\n')`
  // must equal `before`), so we expand the substring search to the full
  // line(s) it sits on and replace within those lines.
  const fileLines = fileContent.split('\n')
  const lineStartByteOffsets: number[] = [0]
  for (let i = 0; i < fileLines.length - 1; i++) {
    // +1 for the consumed '\n' separator
    lineStartByteOffsets.push(lineStartByteOffsets[i] + fileLines[i].length + 1)
  }
  // Locate the start line for `firstIndex`.
  let startLine = 1
  for (let i = lineStartByteOffsets.length - 1; i >= 0; i--) {
    if (firstIndex >= lineStartByteOffsets[i]) {
      startLine = i + 1
      break
    }
  }
  // The match may span multiple lines if `search` contains '\n'.
  const matchLineCount = action.search.split('\n').length
  const endLine = startLine + matchLineCount - 1
  // Whole-line `before` = the lines covering the substring match.
  const beforeLines = fileLines.slice(startLine - 1, endLine).join('\n')
  // Whole-line `after` = same lines with `search` substituted for `replace`.
  const afterLines = beforeLines.replace(action.search, action.replace)

  // collisionId is derived from auditId + filePath (single-entry adapter
  // dispatch). Use a synthetic single-entry InventoryEntry shape solely
  // to feed `deriveCollisionId`'s sorted-paths input — the resulting
  // CollisionId is opaque to the caller and stable for the same
  // (auditId, filePath) pair.
  const collisionId: CollisionId = deriveCollisionId(action.auditId, [
    {
      kind: 'claude_md_rule',
      source_path: action.filePath,
      identifier: action.search.slice(0, 64),
      triggerSurface: [],
    },
  ])

  return {
    collisionId,
    category: 'description_overlap',
    pattern: action.pattern,
    filePath: action.filePath,
    lineRange: { start: startLine, end: endLine },
    before: beforeLines,
    after: afterLines,
    rationale:
      'inline-edit dispatched via claudeCodeAdapter.applyAction (literal-mode translation)',
    applyAction: 'recommended_edit',
    applyMode: 'apply_with_confirmation',
    otherEntry: { identifier: '', sourcePath: '' },
  }
}

/**
 * v1 implementation of `FrameworkAdapter` for Claude-Code.
 */
export const claudeCodeAdapter: FrameworkAdapter = {
  name: 'claude-code',
  describesFiles: () => [
    '~/.claude/skills/*/SKILL.md',
    '~/.claude/commands/*.md',
    '~/.claude/agents/*.md',
    '~/.claude/CLAUDE.md',
    '<project>/CLAUDE.md',
  ],
  scanPaths: async (homeDir, projectDir) => {
    const result = await scanLocalInventory({ homeDir, projectDir })
    return result.entries
  },
  applyAction: async (action: AdapterAction): Promise<void> => {
    if (action.kind === 'rename') {
      // Forward-compat seam: a raw filesystem rename. v1 callers
      // should normally prefer `applyRename(entry, newName, opts)` so
      // the rename is backed up + recorded in the namespace ledger.
      // This bare path is intentional — v2 adapters that own their
      // own audit-history use `applyAction` as the unified seam.
      await fs.rename(action.from, action.to)
      return
    }
    if (action.kind === 'inline-edit') {
      if (action.searchMode === 'regex') {
        throw new FrameworkAdapterError(
          'namespace.adapter.unsupported_search_mode',
          `searchMode "regex" not supported by v1 claudeCodeAdapter; reserved for v2 cursorAdapter`
        )
      }
      // Literal mode: translate to RecommendedEdit + dispatch to Wave 3.
      const edit = await buildRecommendedEditFromInlineEdit(action)
      const result = await applyRecommendedEdit(edit, {
        // narrowed by buildRecommendedEditFromInlineEdit:
        auditId: action.auditId as string,
        mode: 'apply_with_confirmation',
      })
      if (!result.success) {
        throw new FrameworkAdapterError(
          'namespace.adapter.unsupported_action',
          `applyRecommendedEdit failed: ${result.error?.message ?? 'unknown'}`
        )
      }
      return
    }
    // Exhaustiveness guard.
    const exhaustive: never = action
    throw new FrameworkAdapterError(
      'namespace.adapter.unsupported_action',
      `unsupported action shape: ${JSON.stringify(exhaustive)}`
    )
  },
  applyRename: async (
    entry: InventoryEntry,
    newName: string,
    opts: { auditId: string }
  ): Promise<void> => {
    // Build a minimal RenameSuggestion and call Wave 2's applyRename
    // for the full backup + ledger + atomic rename flow. The
    // collisionId is synthetic (derived from auditId + the single
    // entry's path) — the Wave 2 ledger entry is keyed by
    // (skillId, kind, originalIdentifier), not by collisionId, so
    // a synthetic id is acceptable for adapter-mediated renames.
    const collisionId: CollisionId = deriveCollisionId(opts.auditId, [entry])
    const suggestion: RenameSuggestion = {
      collisionId,
      entry,
      currentName: entry.identifier,
      suggested: newName,
      applyAction: inventoryKindToRenameAction(entry),
      reason: 'claudeCodeAdapter.applyRename convenience wrapper',
    }
    const result = await applyRenameEngine({
      suggestion,
      request: { action: 'apply', auditId: opts.auditId },
    })
    if (!result.success) {
      throw new FrameworkAdapterError(
        'namespace.adapter.unsupported_action',
        `applyRename failed: ${result.error?.message ?? 'unknown'}`
      )
    }
  },
  applyEdit: async (edit: RecommendedEdit, opts: { auditId: string }): Promise<void> => {
    // Convenience wrapper: build an InlineEditAction and dispatch
    // through applyAction so the literal-mode translation path runs
    // its registry guard + uniqueness check uniformly.
    const action: InlineEditAction = {
      kind: 'inline-edit',
      filePath: edit.filePath,
      search: edit.before,
      replace: edit.after,
      searchMode: 'literal',
      auditId: opts.auditId,
      pattern: edit.pattern,
    }
    await claudeCodeAdapter.applyAction(action)
  },
}

// Re-export helpers used by tests + callers.
export { newAuditId }
export type { FileRenameAction, InlineEditAction }
