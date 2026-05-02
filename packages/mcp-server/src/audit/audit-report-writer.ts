/**
 * @fileoverview Markdown audit-report writer for SMI-4587 Wave 1 Step 7/8.
 * @module @skillsmith/mcp-server/audit/audit-report-writer
 *
 * Renders an `InventoryAuditResult` into the markdown report stored at
 * `~/.skillsmith/audits/<auditId>/report.md`. Atomic via tmp-file +
 * `fs.rename` (mirrors `audit-history.ts`).
 *
 * Sections, in order (plan §446):
 *   1. Summary header — auditId, generated-at, totals
 *   2. CLAUDE.md scan caveat — only when any inventory entry is
 *      `kind: 'claude_md_rule'` (D-ANTI-1)
 *   3. Exact collisions — each lists involved entries with absolute paths
 *   4. Generic flags — matched tokens, suggested rename if any
 *   5. Semantic collisions — cosine score, overlapping phrases
 *   6. Recommended edits — Wave 3 plumbing; Wave 1 emits a placeholder
 *
 * Wave 2/4 import this writer via `@skillsmith/mcp-server/audit` (Step 9
 * barrel).
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type {
  ExactCollisionFlag,
  GenericTokenFlag,
  InventoryAuditResult,
  SemanticCollisionFlag,
} from './collision-detector.types.js'
import type { InventoryEntry } from '../utils/local-inventory.types.js'

export interface AuditReportRenderOptions {
  /**
   * Override the report's "Generated" timestamp. Defaults to a fresh
   * `new Date()` at render time. Tests pin this to keep snapshots
   * deterministic; production callers pass nothing.
   */
  generatedAt?: Date
}

export interface AuditReportWriteOptions extends AuditReportRenderOptions {
  /**
   * Per-audit directory (sibling of `result.json`). The writer assumes the
   * directory already exists — `writeAuditHistory` creates it.
   */
  auditDir: string
}

export interface AuditReportWriteResult {
  /** Absolute path to the rendered `report.md`. */
  reportPath: string
}

/**
 * Render an `InventoryAuditResult` into the audit-report markdown body.
 * Pure — no IO. Exposed so tests can inspect the output without round-
 * tripping through the filesystem.
 */
export function renderAuditReport(
  result: InventoryAuditResult,
  opts: AuditReportRenderOptions = {}
): string {
  const generatedAt = opts.generatedAt ?? new Date()
  const sections: string[] = []
  sections.push(renderSummaryHeader(result, generatedAt))

  if (containsClaudeMdRule(result)) {
    sections.push(renderClaudeMdCaveat())
  }

  if (result.exactCollisions.length > 0) {
    sections.push(renderExactCollisions(result.exactCollisions))
  }

  if (result.genericFlags.length > 0) {
    sections.push(renderGenericFlags(result.genericFlags))
  }

  if (result.semanticCollisions.length > 0) {
    sections.push(renderSemanticCollisions(result.semanticCollisions))
  }

  sections.push(renderRecommendedEdits())

  // Single trailing newline; sections already terminate with `\n`.
  return sections.join('\n').replace(/\n+$/, '\n')
}

/**
 * Persist the rendered report to `<auditDir>/report.md`. Atomic via
 * tmp-file + `fs.rename`, matching the audit-history writer's contract so
 * concurrent readers never observe a partially-written file.
 */
export async function writeAuditReport(
  result: InventoryAuditResult,
  opts: AuditReportWriteOptions
): Promise<AuditReportWriteResult> {
  const reportPath = path.join(opts.auditDir, 'report.md')
  const tmpPath = `${reportPath}.tmp`
  await fs.mkdir(opts.auditDir, { recursive: true })
  const body = renderAuditReport(result, { generatedAt: opts.generatedAt })
  await fs.writeFile(tmpPath, body, 'utf-8')
  await fs.rename(tmpPath, reportPath)
  return { reportPath }
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderSummaryHeader(result: InventoryAuditResult, generatedAt: Date): string {
  const lines: string[] = []
  lines.push(`# Skillsmith Namespace Audit — ${result.auditId}`)
  lines.push('')
  lines.push(`- Generated: ${generatedAt.toISOString()}`)
  lines.push(`- Total entries scanned: ${result.summary.totalEntries}`)
  lines.push(`- Total flags: ${result.summary.totalFlags}`)
  lines.push(`  - Errors (exact collisions): ${result.summary.errorCount}`)
  lines.push(`  - Warnings (generic + semantic): ${result.summary.warningCount}`)
  lines.push(`- Audit duration: ${result.summary.durationMs.toFixed(2)}ms`)
  lines.push('')
  return lines.join('\n')
}

function renderClaudeMdCaveat(): string {
  const lines: string[] = []
  lines.push('## CLAUDE.md scan caveat')
  lines.push('')
  lines.push('This audit included trigger phrases extracted from `CLAUDE.md` rules. ')
  lines.push('Phrase extraction is heuristic — false-positives are possible when a ')
  lines.push('rule is phrased imperatively ("when X, do Y") without intending to ')
  lines.push('overlap with a skill trigger. Review collisions involving ')
  lines.push('`claude_md_rule` entries before applying any rename.')
  lines.push('')
  return lines.join('\n')
}

function renderExactCollisions(flags: ReadonlyArray<ExactCollisionFlag>): string {
  const lines: string[] = []
  lines.push('## Exact collisions')
  lines.push('')
  for (const flag of flags) {
    lines.push(`### \`${flag.identifier}\` (${flag.entries.length} entries)`)
    lines.push('')
    lines.push(`- Severity: **${flag.severity}**`)
    lines.push(`- Collision id: \`${flag.collisionId}\``)
    lines.push(`- Reason: ${flag.reason}`)
    lines.push('- Involved entries:')
    for (const entry of flag.entries) {
      lines.push(`  - [${entry.kind}] ${entry.source_path}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function renderGenericFlags(flags: ReadonlyArray<GenericTokenFlag>): string {
  const lines: string[] = []
  lines.push('## Generic-token flags')
  lines.push('')
  for (const flag of flags) {
    lines.push(`### \`${flag.identifier}\``)
    lines.push('')
    lines.push(`- Severity: **${flag.severity}**`)
    lines.push(`- Collision id: \`${flag.collisionId}\``)
    lines.push(`- Source: ${flag.entry.source_path}`)
    lines.push(`- Matched generic tokens: ${formatTokens(flag.matchedTokens)}`)
    lines.push(`- Reason: ${flag.reason}`)
    lines.push('')
  }
  return lines.join('\n')
}

function renderSemanticCollisions(flags: ReadonlyArray<SemanticCollisionFlag>): string {
  const lines: string[] = []
  lines.push('## Semantic collisions')
  lines.push('')
  for (const flag of flags) {
    lines.push(`### ${describeEntry(flag.entryA)} ↔ ${describeEntry(flag.entryB)}`)
    lines.push('')
    lines.push(`- Severity: **${flag.severity}**`)
    lines.push(`- Collision id: \`${flag.collisionId}\``)
    lines.push(`- Cosine score: ${flag.cosineScore.toFixed(3)}`)
    lines.push(`- Reason: ${flag.reason}`)
    lines.push(`- Entry A: ${flag.entryA.source_path}`)
    lines.push(`- Entry B: ${flag.entryB.source_path}`)
    if (flag.overlappingPhrases.length > 0) {
      lines.push('- Overlapping phrases:')
      for (const pair of flag.overlappingPhrases) {
        lines.push(`  - "${pair.phrase1}" ↔ "${pair.phrase2}" (sim ${pair.similarity.toFixed(3)})`)
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

function renderRecommendedEdits(): string {
  const lines: string[] = []
  lines.push('## Recommended edits')
  lines.push('')
  lines.push('_No automated edits suggested in Wave 1._')
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function containsClaudeMdRule(result: InventoryAuditResult): boolean {
  return result.inventory.some((e) => e.kind === 'claude_md_rule')
}

function describeEntry(entry: InventoryEntry): string {
  return `\`${entry.identifier}\` (${entry.kind})`
}

function formatTokens(tokens: ReadonlyArray<string>): string {
  if (tokens.length === 0) return '_none_'
  return tokens.map((t) => `\`${t}\``).join(', ')
}
