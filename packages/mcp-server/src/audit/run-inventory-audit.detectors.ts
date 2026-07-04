/**
 * @fileoverview Detector-composition helpers for `runInventoryAudit`
 *               (SMI-5536 Wave 2B split — extracted to keep
 *               `run-inventory-audit.ts` under the 500-line CI gate after
 *               wiring in the rot detector).
 * @module @skillsmith/mcp-server/audit/run-inventory-audit.detectors
 *
 * Two independent pieces of composition logic live here:
 *   1. `buildRenameSuggestions` — turn each `ExactCollisionFlag` into a
 *      `RenameSuggestion` (Wave 2 rename engine plumbing).
 *   2. `dedupeAgentPackCollisions` — self-exempt the dual-path Skillsmith
 *      Agent pack from exact-collision flags (SMI-5456 Wave 1 Step 5).
 *
 * Both are pure functions of an `InventoryAuditResult` (+ inventory, for
 * #1) — no IO beyond the content-hash read `dedupeAgentPackCollisions`
 * needs to prove dual-path identity.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'

import { AGENT_PACK_SKILL_NAME } from '@skillsmith/core'

import type { InventoryEntry } from '../utils/local-inventory.types.js'
import type { ExactCollisionFlag, InventoryAuditResult } from './collision-detector.types.js'
import { generateSuggestionChain } from './suggestion-chain.js'
import type { RenameAction, RenameSuggestion } from './rename-engine.types.js'
import { FIELD_LIMITS } from '../tools/validate.types.js'

/**
 * Build a `RenameSuggestion[]` from each `ExactCollisionFlag`. We pick the
 * **most-recently-installed** entry (mtime descending) as the rename
 * target — matches plan §259 default-entry tiebreak. Falls back to the
 * first entry when mtime is missing.
 *
 * Author / packDomain are left null for v1 — chain falls through to the
 * `local-` prefix path (`local-foo`, `local-foo-<shortHash>`). Wave 4 PR 5
 * extends this with manifest lookups for richer prefixes.
 */
export function buildRenameSuggestions(
  result: InventoryAuditResult,
  fullInventory: ReadonlyArray<InventoryEntry>
): RenameSuggestion[] {
  const suggestions: RenameSuggestion[] = []
  for (const flag of result.exactCollisions) {
    if (flag.entries.length === 0) continue

    // mtime-descending tiebreak; missing mtime sinks to the bottom.
    const sorted = [...flag.entries].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
    const target = sorted[0]!
    const action = inventoryKindToRenameAction(target)
    if (action === null) continue // claude_md_rule entries can't be renamed.

    // SMI-4737: defensive cap on filesystem-derived identifier. Filesystem
    // entries with > 128-char names produce no rename suggestion; the
    // collision is still surfaced via `result.exactCollisions`.
    const rawToken = stripLeadingSlash(target.identifier)
    if (rawToken.length > FIELD_LIMITS.token) {
      continue
    }
    const chain = generateSuggestionChain({
      token: rawToken,
      author: target.meta?.author ?? null,
      packDomain: null,
      tagFallback: target.meta?.tags?.[0] ?? null,
      authorPath: target.source_path,
      existingInventory: fullInventory,
    })
    const lowercaseInventory = new Set(fullInventory.map((e) => e.identifier.toLowerCase()))
    const firstFree = chain.candidates.find((c) => !lowercaseInventory.has(c.toLowerCase()))
    const suggested = firstFree ?? chain.candidates[0] ?? target.identifier

    suggestions.push({
      collisionId: flag.collisionId,
      entry: target,
      currentName: target.identifier,
      suggested,
      applyAction: action,
      reason: flag.reason,
    })
  }
  return suggestions
}

function stripLeadingSlash(identifier: string): string {
  return identifier.startsWith('/') ? identifier.slice(1) : identifier
}

/** Map an `InventoryEntry.kind` to a `RenameAction`, or `null` for unrenamable kinds. */
function inventoryKindToRenameAction(entry: InventoryEntry): RenameAction | null {
  switch (entry.kind) {
    case 'command':
      return 'rename_command_file'
    case 'agent':
      return 'rename_agent_file'
    case 'skill':
      return 'rename_skill_dir_and_frontmatter'
    case 'claude_md_rule':
      return null
    default:
      return null
  }
}

/**
 * SMI-5456 Wave 1 Step 5 (plan §6): drop an exact-collision flag when it is
 * the dual-path Skillsmith Agent pack colliding with itself.
 *
 * Dedupe key is name+content-hash, NOT name alone: a flag is dropped only
 * when EVERY entry in it is `kind: 'skill'`, has `identifier ===
 * AGENT_PACK_SKILL_NAME` ('skillsmith-agent'), AND shares an identical
 * SHA-256 of its `source_path` file content. The content-hash check is the
 * load-bearing part — a namespace-squatting skill hand-named
 * "skillsmith-agent" with DIFFERENT content must still be flagged (that is
 * exactly the collision detector's job); only a genuine byte-identical
 * dual-path copy (which the installer guarantees per-release, per
 * `AgentInstallResult` P-5 "Dual-path pack copies" invariant) is self-exempt.
 *
 * A read/hash failure on any entry (e.g. a symlink race) is treated as
 * "cannot prove identity" — the flag is KEPT (fail toward showing the
 * finding, never toward silently hiding a real collision).
 *
 * Exported (not just used internally) so it is directly unit-testable
 * without invoking the full `runInventoryAudit` pipeline, which writes to
 * the real `~/.skillsmith/audits/` (no test-isolation override exists for
 * that path today — see `run-inventory-audit.dedup.test.ts`'s header).
 */
export function dedupeAgentPackCollisions(result: InventoryAuditResult): InventoryAuditResult {
  const exactCollisions = result.exactCollisions.filter((flag) => !isAgentPackSelfCollision(flag))

  if (exactCollisions.length === result.exactCollisions.length) return result

  const errorCount = exactCollisions.length
  const warningCount = result.genericFlags.length + result.semanticCollisions.length
  return {
    ...result,
    exactCollisions,
    summary: {
      ...result.summary,
      totalFlags: errorCount + warningCount,
      errorCount,
    },
  }
}

/** Is `flag` entirely explained by byte-identical dual-path copies of the Skillsmith Agent pack? */
function isAgentPackSelfCollision(flag: ExactCollisionFlag): boolean {
  if (flag.entries.length < 2) return false
  if (
    !flag.entries.every(
      (entry) => entry.kind === 'skill' && entry.identifier === AGENT_PACK_SKILL_NAME
    )
  ) {
    return false
  }

  const hashes = flag.entries.map((entry) => hashFileContent(entry.source_path))
  if (hashes.some((h) => h === null)) return false // unreadable — fail toward keeping the flag.
  const [first, ...rest] = hashes
  return rest.every((h) => h === first)
}

/** SHA-256 hex of a file's content, or null on any read failure (never throws). */
function hashFileContent(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath)
    return crypto.createHash('sha256').update(content).digest('hex')
  } catch {
    return null
  }
}
