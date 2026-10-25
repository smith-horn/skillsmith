#!/usr/bin/env node
/**
 * Prints the Standards Audit job-page Markdown for an audit-report.json (SMI-7174).
 *
 * Usage: node scripts/ci/audit-summary.mjs [report]   (default: audit-report.json)
 *
 * Always exits 0. Quality Checks is a required job and its verdict belongs to the
 * "Run standards audit" step; this step only reports, so nothing here may fail it.
 * The renderer is imported inside the try, so even a broken or missing module is
 * reported instead of exiting non-zero.
 */
try {
  const { renderSummary } = await import('../lib/audit-report.mjs')
  console.log(renderSummary(process.argv[2] ?? 'audit-report.json'))
} catch (err) {
  console.log(
    `## Standards Audit Results\n\nCould not render the summary: ${err?.message ?? String(err)}`
  )
} finally {
  process.exitCode = 0
}
