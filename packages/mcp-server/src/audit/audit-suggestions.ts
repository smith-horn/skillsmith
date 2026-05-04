/**
 * @fileoverview Per-audit suggestion persistence (SMI-4590 Wave 4 PR 4).
 * @module @skillsmith/mcp-server/audit/audit-suggestions
 *
 * Persists `RenameSuggestion[]` (Wave 2) + `RecommendedEdit[]` (Wave 3)
 * alongside the existing `~/.skillsmith/audits/<auditId>/result.json`
 * (Wave 1, see `audit-history.ts`). The `apply_namespace_rename` and
 * `apply_recommended_edit` MCP tools (this PR) read this file to look up
 * the suggestion that corresponds to a `(auditId, collisionId)` pair.
 *
 * File layout: `<auditDir>/suggestions.json` — atomic via tmp-file +
 * `fs.rename`, mirroring `audit-history.ts`. Schema is versioned so a
 * future PR can extend the persisted shape without breaking older
 * audit dirs.
 *
 * Why a sibling file (vs. extending `result.json`):
 *   - `result.json` is keyed by `InventoryAuditResult` shape (Wave 1
 *     barrel surface). Extending it pulls Wave 2/3 types into Wave 1's
 *     persistence layer.
 *   - The CLI (PR 5) wants to render `result.json` as-is for
 *     `--report-only` callers; suggestions live alongside but aren't
 *     part of the inventory snapshot.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import type { RecommendedEdit } from './edit-suggester.types.js'
import type { RenameSuggestion } from './rename-engine.types.js'

const DEFAULT_AUDITS_DIR = path.join(os.homedir(), '.skillsmith', 'audits')

/** Persisted shape. `version: 1` is the only supported schema. */
export interface AuditSuggestionsFile {
  version: 1
  auditId: string
  renameSuggestions: RenameSuggestion[]
  recommendedEdits: RecommendedEdit[]
}

export interface AuditSuggestionsOptions {
  /** Override the audits root (default `~/.skillsmith/audits`). */
  auditsDir?: string
}

/**
 * Persist the suggestion arrays for `auditId` to
 * `<auditsDir>/<auditId>/suggestions.json`. Atomic. Creates the per-audit
 * directory if missing (matches `writeAuditHistory` semantics).
 */
export async function writeAuditSuggestions(
  auditId: string,
  renameSuggestions: ReadonlyArray<RenameSuggestion>,
  recommendedEdits: ReadonlyArray<RecommendedEdit>,
  opts: AuditSuggestionsOptions = {}
): Promise<{ suggestionsPath: string }> {
  const auditsDir = opts.auditsDir ?? DEFAULT_AUDITS_DIR
  const auditDir = path.join(auditsDir, auditId)
  const suggestionsPath = path.join(auditDir, 'suggestions.json')
  const tmpPath = `${suggestionsPath}.tmp`

  await fs.mkdir(auditDir, { recursive: true })

  const payload: AuditSuggestionsFile = {
    version: 1,
    auditId,
    renameSuggestions: [...renameSuggestions],
    recommendedEdits: [...recommendedEdits],
  }
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf-8')
  await fs.rename(tmpPath, suggestionsPath)

  return { suggestionsPath }
}

/**
 * Read back the persisted suggestions for `auditId`. Returns `null` for
 * unknown / missing audit dirs and for malformed / wrong-version files.
 * Callers treat the absence as "no suggestions"; the apply-tools surface
 * a typed error when the lookup is required but returns null.
 */
export async function readAuditSuggestions(
  auditId: string,
  opts: AuditSuggestionsOptions = {}
): Promise<AuditSuggestionsFile | null> {
  const auditsDir = opts.auditsDir ?? DEFAULT_AUDITS_DIR
  const suggestionsPath = path.join(auditsDir, auditId, 'suggestions.json')

  let raw: string
  try {
    raw = await fs.readFile(suggestionsPath, 'utf-8')
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!isAuditSuggestionsFile(parsed)) return null
  return parsed
}

function isAuditSuggestionsFile(v: unknown): v is AuditSuggestionsFile {
  if (!v || typeof v !== 'object') return false
  const obj = v as Record<string, unknown>
  if (obj.version !== 1) return false
  if (typeof obj.auditId !== 'string' || obj.auditId.length === 0) return false
  if (!Array.isArray(obj.renameSuggestions)) return false
  if (!Array.isArray(obj.recommendedEdits)) return false
  return true
}
