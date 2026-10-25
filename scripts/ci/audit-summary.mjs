#!/usr/bin/env node
/**
 * Prints the Standards Audit job-page Markdown for an audit-report.json (SMI-7174).
 *
 * Usage: node scripts/ci/audit-summary.mjs [report]   (default: audit-report.json)
 *
 * Always exits 0. Quality Checks is a required job and its verdict belongs to the
 * "Run standards audit" step; this step only reports, so nothing here may fail it.
 */
import { renderSummary } from '../lib/audit-report.mjs'

try {
  console.log(renderSummary(process.argv[2] ?? 'audit-report.json'))
} catch (err) {
  console.log(
    `## Standards Audit Results\n\nCould not render the summary: ${err?.message ?? String(err)}`
  )
}
process.exitCode = 0
