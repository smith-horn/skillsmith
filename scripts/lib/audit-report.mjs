/**
 * The audit:standards CI report (SMI-1826; in Quality Checks since SMI-7174).
 *
 * buildReport() turns the audit's exit code, its log and its own counts file into
 * audit-report.json. Counts come only from the file audit-standards.mjs writes to
 * AUDIT_SUMMARY_FILE, never from log text: the log carries PR-description text (Checks 54
 * and 58 echo opt-out reasons), so scraped counts could be forged or corrupted.
 *
 * renderSummary() turns a report into the job-page Markdown. It never throws: Quality
 * Checks is a required job, and its verdict belongs to the audit step alone.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const isCount = (v) => Number.isInteger(v) && v >= 0

/** The audit's counts, or null unless the text is exactly the shape the audit writes. */
export function readCounts(text) {
  if (typeof text !== 'string' || text === '') return null
  let v
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const { passed, warnings, failed, score } = v
  if (![passed, warnings, failed].every(isCount)) return null
  if (!Number.isInteger(score) || score < 0 || score > 100) return null
  return { passed, warnings, failed, score }
}

export function buildReport({ exitCode, output, countsText, now = new Date() }) {
  const summary = readCounts(countsText)
  return {
    timestamp: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    exit_code: exitCode,
    status: exitCode === 0 ? 'passed' : 'failed',
    summary_found: summary !== null,
    summary,
    output,
  }
}

const HEAD = [
  '## Standards Audit Results',
  '',
  "Pass/fail comes from the 'Run standards audit' step; this table is informational.",
  '',
]
const FOOTER = ['', 'Full report: `audit-report` artifact (7 days).']
const REPRODUCE = [
  '',
  'Reproduce locally: `docker exec skillsmith-dev-1 npm run audit:standards` (main checkout) or `./scripts/worktree-docker.sh exec -- npm run audit:standards` (worktree).',
]

function validReport(r) {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return false
  if (!Number.isInteger(r.exit_code) || typeof r.summary_found !== 'boolean') return false
  if (!r.summary_found) return r.summary === null
  return readCounts(JSON.stringify(r.summary)) !== null
}

/** Markdown for the job page. `readFile` is injected for tests. */
export function renderSummary(path, { readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  let text
  try {
    text = readFile(path)
  } catch (err) {
    if (err?.code === 'ENOENT') return [...HEAD, 'Audit report not generated.'].join('\n')
    return [...HEAD, `Cannot read the report: \`${err?.code ?? err?.message ?? err}\``].join('\n')
  }
  let r
  try {
    r = JSON.parse(text)
  } catch (err) {
    const why = String(err?.message ?? err).split('\n')[0] || '(no parser output)'
    return [...HEAD, `Report JSON could not be parsed: \`${why}\``, ...FOOTER].join('\n')
  }
  if (!validReport(r)) {
    return [...HEAD, 'Report has an unexpected shape; counts not available.', ...FOOTER].join('\n')
  }
  const failed = r.exit_code !== 0
  const lines = [...HEAD]
  if (!r.summary_found) {
    lines.push(
      `The audit did not print its summary (exit ${r.exit_code}). Counts not available.`,
      '',
      `| Status | ${failed ? 'Failed' : 'Passed'} |`,
      '|--------|-------|'
    )
  } else {
    const s = r.summary
    lines.push(
      '| Metric | Value |',
      '|--------|-------|',
      `| Status | ${failed ? 'Failed' : 'Passed'} |`,
      `| Compliance Score | ${s.score}% |`,
      `| Passed | ${s.passed} |`,
      `| Warnings | ${s.warnings} |`,
      `| Failed | ${s.failed} |`
    )
  }
  if (failed) lines.push(...REPRODUCE)
  lines.push(...FOOTER)
  return lines.join('\n')
}

/** CLI used by scripts/ci-code-review.sh: env in, report file out. */
function buildCli(env) {
  const exitCode = Number.parseInt(env.AUDIT_EXIT_CODE ?? '', 10)
  let countsText = ''
  try {
    countsText = readFileSync(env.SUMMARY_FILE, 'utf8')
  } catch {
    // No counts file: the audit ended before its Summary. summary_found will be false.
  }
  const report = buildReport({
    exitCode: Number.isInteger(exitCode) ? exitCode : -1,
    output: readFileSync(env.TEMP_OUTPUT, 'utf8'),
    countsText,
  })
  writeFileSync(env.OUTPUT_FILE, JSON.stringify(report, null, 2) + '\n')
  const s = report.summary
  console.log(`\nReport generated: ${env.OUTPUT_FILE}`)
  console.log(
    s
      ? `Summary: passed=${s.passed}, warnings=${s.warnings}, failed=${s.failed}, score=${s.score}%`
      : 'Summary: not available (the audit did not print one)'
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href && process.argv[2] === 'build') {
  buildCli(process.env)
}
