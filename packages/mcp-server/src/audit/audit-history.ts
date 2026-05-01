/**
 * @fileoverview ULID-keyed audit history persistence (SMI-4587 Wave 1 Step 3).
 * @module @skillsmith/mcp-server/audit/audit-history
 *
 * Writes `~/.skillsmith/audits/<auditId>/result.json` (and, in subsequent
 * PRs, `report.md` next to it). Atomic via tmp-file + rename. The
 * directory pattern follows the existing `~/.skillsmith/<name>/`
 * convention (see CLAUDE.md "Auth" section).
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { ulid } from 'ulid'

import type { AuditId, CollisionId, ExactCollisionFlag } from './collision-detector.types.js'
import type { InventoryAuditResult } from './collision-detector.types.js'
import type { InventoryEntry } from '../utils/local-inventory.types.js'

const DEFAULT_AUDITS_DIR = path.join(os.homedir(), '.skillsmith', 'audits')

export interface WriteAuditHistoryResult {
  auditId: AuditId
  resultPath: string
  /**
   * Path where `report.md` will be written. The audit-report writer (added
   * in a subsequent PR) reuses the same per-audit directory.
   */
  reportPath: string
}

export interface AuditHistoryOptions {
  /** Override the audits root (default `~/.skillsmith/audits`). */
  auditsDir?: string
}

/**
 * Generate a fresh ULID-shaped `auditId`.
 *
 * Exposed so callers can pre-allocate the id and pass it into both the
 * collision detector and the writer (single source of truth for the run).
 */
export function newAuditId(): AuditId {
  return ulid() as AuditId
}

/**
 * Persist an `InventoryAuditResult` snapshot to
 * `~/.skillsmith/audits/<auditId>/result.json`. Atomic (write-tmp +
 * rename). Creates the per-audit directory with `recursive: true` so
 * first-run on a fresh install does not throw (E-MISS-2).
 *
 * Returns both `resultPath` and `reportPath` so the caller can chain a
 * report writer without re-deriving the directory.
 */
export async function writeAuditHistory(
  result: InventoryAuditResult,
  opts: AuditHistoryOptions = {}
): Promise<WriteAuditHistoryResult> {
  const auditsDir = opts.auditsDir ?? DEFAULT_AUDITS_DIR
  const auditDir = path.join(auditsDir, result.auditId)
  const resultPath = path.join(auditDir, 'result.json')
  const reportPath = path.join(auditDir, 'report.md')
  const tmpPath = `${resultPath}.tmp`

  // E-MISS-2: ensure the per-audit directory exists before any temp-write.
  // First run on a fresh install hits a non-existent ~/.skillsmith/audits/.
  await fs.mkdir(auditDir, { recursive: true })

  const json = JSON.stringify(result, null, 2)
  await fs.writeFile(tmpPath, json, 'utf-8')
  await fs.rename(tmpPath, resultPath)

  return {
    auditId: result.auditId,
    resultPath,
    reportPath,
  }
}

/**
 * Read back a previously-written audit result. Returns `null` for an
 * unknown auditId — callers should not rely on the audit-history
 * directory being present.
 */
export async function readAuditHistory(
  auditId: string,
  opts: AuditHistoryOptions = {}
): Promise<InventoryAuditResult | null> {
  const auditsDir = opts.auditsDir ?? DEFAULT_AUDITS_DIR
  const resultPath = path.join(auditsDir, auditId, 'result.json')
  try {
    const raw = await fs.readFile(resultPath, 'utf-8')
    return JSON.parse(raw) as InventoryAuditResult
  } catch {
    return null
  }
}

/**
 * Derive a collision identifier from `auditId` + sorted entry paths.
 *
 * `collisionId` is the load-bearing key for Wave 2's idempotency check
 * against the `namespace-overrides.json` ledger. Changing this derivation
 * requires coordinated plan-review on both Wave 1 and Wave 2.
 *
 * E-CONF-1 special case: when any colliding entry is `kind: 'claude_md_rule'`,
 * include the entry identifier in the input string. Otherwise, multiple
 * trigger phrases extracted from the same CLAUDE.md would deduplicate via
 * `sortedEntryPaths.join(',')` and produce identical `collisionId`s for
 * distinct logical collisions.
 */
export function deriveCollisionId(
  auditId: string,
  entries: ReadonlyArray<InventoryEntry>
): CollisionId {
  const sortedPaths = [...entries.map((e) => e.source_path)].sort()
  const claudeMdEntries = entries.filter((e) => e.kind === 'claude_md_rule')
  const sortedClaudeMdIdentifiers = [...claudeMdEntries.map((e) => e.identifier)].sort()

  const claudeMdSuffix =
    sortedClaudeMdIdentifiers.length > 0 ? `:${sortedClaudeMdIdentifiers.join(',')}` : ''

  const input = `${auditId}:${sortedPaths.join(',')}${claudeMdSuffix}`
  const digest = crypto.createHash('sha256').update(input).digest('hex')
  return digest.slice(0, 16) as CollisionId
}

/**
 * Type-narrowing helper used by the report writer (next PR) to flag
 * collisions whose entries include CLAUDE.md rules — render order +
 * caveat presentation depend on it.
 */
export function hasClaudeMdEntries(flag: { entries: InventoryEntry[] }): boolean {
  return flag.entries.some((e) => e.kind === 'claude_md_rule')
}

/**
 * Re-export to keep audit-related helpers reachable from one entrypoint.
 * Wave 2's apply path imports `deriveCollisionId` to look up ledger
 * entries by id.
 */
export type { ExactCollisionFlag, InventoryAuditResult }
