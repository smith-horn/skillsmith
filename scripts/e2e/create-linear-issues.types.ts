/**
 * Shared types for scripts/e2e/create-linear-issues.ts (SMI-5855).
 *
 * Split out to keep create-linear-issues.ts under the repo's 500-line
 * file-length gate (audit:standards / scripts/check-file-length.mjs) as its
 * SMI-5855 rewrite grew to include team/label resolution, retry, and
 * dedup/cap guards. Mirrors the existing scripts/batch-transform-skills.*.ts
 * split-by-suffix convention.
 */

export interface HardcodedIssue {
  type: string
  pattern: string
  value: string
  command: string
  source: string
  severity: string
}

export interface TestFailure {
  testName: string
  testFile: string
  command: string
  error: string
  hardcodedIssues?: HardcodedIssue[]
  timestamp: string
}

export interface LinearIssueInput {
  title: string
  description: string
  priority: number
  labels: string[]
}

export type CreateIssueOutcome =
  | { status: 'created'; identifier: string }
  | { status: 'failed'; reason: string }

export interface IssueFilingSummary {
  attempted: number
  created: number
  skippedDuplicate: number
  suppressedByCap: number
  failed: number
  createdIdentifiers: string[]
}

export interface GqlLabelNode {
  id: string
  name: string
  team: { id: string } | null
}
