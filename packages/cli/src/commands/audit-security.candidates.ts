/**
 * @fileoverview Candidate ordering, pagination, and rendering for
 *               `sklx audit security` (SMI-5883 Wave 2, §3f/§5).
 * @module @skillsmith/cli/commands/audit-security.candidates
 *
 * Split out of `audit-security.action.ts` per the 500-line file gate.
 * Resolution (what `--accept` can reach) is UNCAPPED and lives entirely in
 * `result.candidateIndex` (`@skillsmith/mcp-server/audit`) -- this module
 * only concerns RENDERING a bounded view of it.
 */

import chalk from 'chalk'
import type { Candidate } from '@skillsmith/mcp-server/audit'

export interface Pagination {
  page: number
  pageSize: number
  total: number
  totalPages: number
  complete: boolean
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

/** Deterministic total ordering (D-14): severity desc, identifier, filePath, lineNumber, acceptKey tiebreaker -- guarantees no candidate is skipped or duplicated across pages. */
export function compareCandidates(a: Candidate, b: Candidate): number {
  const sa = SEVERITY_RANK[a.finding.severity] ?? 4
  const sb = SEVERITY_RANK[b.finding.severity] ?? 4
  if (sa !== sb) return sa - sb
  if (a.identifier !== b.identifier) return a.identifier < b.identifier ? -1 : 1
  const fa = a.finding.filePath ?? ''
  const fb = b.finding.filePath ?? ''
  if (fa !== fb) return fa < fb ? -1 : 1
  const la = a.finding.lineNumber ?? -1
  const lb = b.finding.lineNumber ?? -1
  if (la !== lb) return la - lb
  return a.acceptKey < b.acceptKey ? -1 : a.acceptKey > b.acceptKey ? 1 : 0
}

export function orderedCandidates(candidateIndex: ReadonlyMap<string, Candidate>): Candidate[] {
  return [...candidateIndex.values()].sort(compareCandidates)
}

/** Select page `page` (1-indexed) of `pageSize` from the total ordering. Out-of-range -> empty array, correct pagination block (not an error). */
export function paginate(
  all: readonly Candidate[],
  page: number,
  pageSize: number
): { items: Candidate[]; pagination: Pagination } {
  const total = all.length
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)))
  const start = (page - 1) * pageSize
  const items = start < 0 || start >= total ? [] : all.slice(start, start + pageSize)
  return { items, pagination: { page, pageSize, total, totalPages, complete: false } }
}

export function allCandidatesPagination(total: number): Pagination {
  return { page: 1, pageSize: Math.max(total, 1), total, totalPages: 1, complete: true }
}

const DEFAULT_HUMAN_LIMIT = 20

/** Human-readable candidate listing: top `limit` candidates + an unconditional footer whenever more exist. */
export function printCandidates(
  candidateIndex: ReadonlyMap<string, Candidate>,
  limit: number = DEFAULT_HUMAN_LIMIT
): void {
  const all = orderedCandidates(candidateIndex)
  if (all.length === 0) {
    console.log(chalk.dim('No candidate findings on this run.'))
    return
  }
  const shown = all.slice(0, limit)
  console.log(chalk.bold.blue(`\n=== Candidate findings (${all.length} total) ===`))
  for (const c of shown) {
    const status = c.acceptedAt ? chalk.green('[accepted]') : ''
    console.log(
      `CANDIDATE  ${chalk.bold(c.identifier)}  ${chalk.dim(c.finding.severity)}  ${chalk.dim(c.finding.type)}` +
        `${c.finding.location ? `  ${c.finding.location}${c.finding.lineNumber ? `:${c.finding.lineNumber}` : ''}` : ''} ${status}`
    )
    console.log(`  "${c.finding.message}"`)
    if (c.affectedSkills.length > 1) {
      // Code-review round 2: content-based keying (D-1) can legitimately
      // collapse a byte-identical finding on a genuinely different skill
      // into this SAME candidate -- disclose that explicitly so accepting
      // it doesn't silently suppress a skill the user never saw listed.
      console.log(
        chalk.yellow(
          `  Also matches ${c.affectedSkills.length - 1} other skill(s) with byte-identical content: ` +
            c.affectedSkills
              .filter((s) => s.identifier !== c.identifier || s.sourcePath !== c.sourcePath)
              .map((s) => s.identifier)
              .join(', ')
        )
      )
    }
    if (!c.acceptedAt) {
      console.log(chalk.dim(`  sklx audit security --accept ${c.acceptKey} --reason "<why>"`))
    }
  }
  if (all.length > shown.length) {
    console.log(
      chalk.dim(
        `\n... and ${all.length - shown.length} more candidate finding(s). See them all with: sklx audit security --json --all-candidates`
      )
    )
  }
}
