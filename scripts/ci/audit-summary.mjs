#!/usr/bin/env node
/**
 * Prints the Standards Audit job-page Markdown for an audit-report.json (SMI-7174).
 *
 * Usage: node scripts/ci/audit-summary.mjs [report]   (default: audit-report.json)
 *
 * Always exits 0. Quality Checks is a required job and its verdict belongs to the
 * "Run standards audit" step; this step only reports, so nothing here may fail it.
 * The renderer is imported inside the try, so a broken or missing module is reported,
 * and output errors (EPIPE when the pipe closes early, a throwing write) or any other
 * uncaught exception end the process with 0 rather than 1.
 */
process.on('uncaughtException', () => process.exit(0))
process.on('unhandledRejection', () => process.exit(0))
process.stdout.on('error', () => process.exit(0))

const say = (text) => {
  try {
    process.stdout.write(`${text}\n`)
  } catch {
    // Nowhere left to report to; the exit code stays 0.
  }
}
const why = (err) => {
  try {
    return String(err?.message ?? err)
  } catch {
    return 'unknown error'
  }
}

try {
  const { renderSummary } = await import('../lib/audit-report.mjs')
  say(renderSummary(process.argv[2] ?? 'audit-report.json'))
} catch (err) {
  say(`## Standards Audit Results\n\nCould not render the summary: ${why(err)}`)
} finally {
  process.exitCode = 0
}
