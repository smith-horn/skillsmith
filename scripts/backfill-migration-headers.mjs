#!/usr/bin/env node
// audit:host-npm-required — see SMI-4814 (this script doesn't run npm at all, but the marker keeps it from being mistakenly flagged in the future)
/**
 * SMI-4815: backfill `-- SMI-XXXX: ...` and `-- Created: YYYY-MM-DD` headers
 * on migrations that audit:standards Check 11 flags.
 *
 * Idempotent: only prepends a header to migrations that don't already have
 * BOTH an SMI ref AND a date in the first 10 lines (matches the audit's
 * own check at scripts/audit-standards.mjs:540-557).
 *
 * SMI derivation:
 *   1. Parse the introducing commit subject for `/SMI-(\d+)/i`.
 *   2. If absent, fall back to `SMI-NONE` with a `Justification:` line that
 *      cites the PR number (parsed from the commit subject's `(#NNNN)`
 *      suffix). The audit regex must be relaxed in the same commit to
 *      accept `SMI-(\d+|NONE)` — see scripts/audit-standards.mjs:550.
 *
 * Date derivation: `git log --reverse --diff-filter=A --format='%ad'
 * --date=short` on the migration file — the introducing commit's author
 * date in `YYYY-MM-DD` form.
 *
 * Skips:
 *   - Migrations < 030 (audit's MIN_MIGRATION_NUMBER exemption).
 *   - Files whose first byte is the git-crypt magic header (\x00GITCRYPT).
 *
 * Usage:
 *   node scripts/backfill-migration-headers.mjs [--dry-run]
 *
 * Run from the repo root.
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = 'supabase/migrations'
const MIN_MIGRATION_NUMBER = 30
const DRY_RUN = process.argv.includes('--dry-run')

function isGitCrypted(buf) {
  return buf[0] === 0x00 && buf.toString('utf8', 1, 9) === 'GITCRYPT'
}

function deriveSmiAndDate(file) {
  const path = `${MIGRATIONS_DIR}/${file}`
  const out = execSync(
    `git log --reverse --diff-filter=A --format='%ad|%s' --date=short -- ${path} | head -1`,
    { encoding: 'utf8' }
  ).trim()
  if (!out) return { smi: null, date: null, prNumber: null, subject: null }
  const sep = out.indexOf('|')
  const date = out.slice(0, sep)
  const subject = out.slice(sep + 1)
  const smiMatch = subject.match(/SMI-(\d+)/i)
  const prMatch = subject.match(/\(#(\d+)\)/)
  return {
    smi: smiMatch ? `SMI-${smiMatch[1]}` : null,
    date,
    prNumber: prMatch ? prMatch[1] : null,
    subject,
  }
}

function buildHeader({ smi, date, subject, prNumber, file }) {
  if (smi) {
    return [`-- ${smi}: ${describeFromSubject(subject, smi)}`, `-- Created: ${date}`, '--', '']
  }
  // No SMI in commit — emit SMI-NONE with justification (audit regex must
  // accept SMI-NONE for this to pass; landed in same commit as this script).
  const justification = prNumber
    ? `Justification: pre-convention migration; introducing commit had no SMI ref. See PR #${prNumber}: ${subject}`
    : `Justification: pre-convention migration; no introducing commit context recovered`
  return [
    `-- SMI-NONE: pre-convention migration (${file})`,
    `-- Created: ${date}`,
    `-- ${justification}`,
    '--',
    '',
  ]
}

function describeFromSubject(subject, smi) {
  // Strip noise from commit subject to make a one-line description.
  // Drop the `(#NNNN)` PR suffix and leading conventional-commit tag.
  return subject
    .replace(/\s*\(#\d+\)\s*$/, '')
    .replace(new RegExp(`\\b${smi}\\b\\s*[-:]?\\s*`, 'i'), '')
    .replace(/^[a-z]+(\([^)]+\))?:\s*/i, '')
    .trim()
}

function hasHeaderInFirst10Lines(content) {
  const head = content.split('\n').slice(0, 10).join('\n')
  const hasSmi = /--\s*SMI-(\d+|NONE)/i.test(head)
  const hasDate =
    /--.*\d{4}-\d{2}-\d{2}/.test(head) || /--.*Created:\s*\d{4}-\d{2}-\d{2}/.test(head)
  return hasSmi && hasDate
}

function main() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => {
      const num = parseInt(f.substring(0, 3), 10)
      return !Number.isNaN(num) && num >= MIN_MIGRATION_NUMBER
    })
    .sort()

  let written = 0
  let skipped = 0
  let crypted = 0
  const log = []

  for (const file of files) {
    const path = join(MIGRATIONS_DIR, file)
    const buf = readFileSync(path)
    if (isGitCrypted(buf)) {
      crypted++
      continue
    }
    const content = buf.toString('utf8')
    if (hasHeaderInFirst10Lines(content)) {
      skipped++
      continue
    }
    const { smi, date, prNumber, subject } = deriveSmiAndDate(file)
    if (!date) {
      log.push(`  ${file}: SKIPPED (no introducing commit found)`)
      skipped++
      continue
    }
    const header = buildHeader({ smi, date, subject, prNumber, file })
    const newContent = header.join('\n') + content
    if (DRY_RUN) {
      log.push(`  ${file}: would prepend ${smi ?? 'SMI-NONE'} (${date})`)
    } else {
      writeFileSync(path, newContent)
      log.push(`  ${file}: prepended ${smi ?? 'SMI-NONE'} (${date})`)
    }
    written++
  }

  console.log(log.join('\n'))
  console.log()
  console.log(
    `${DRY_RUN ? '[dry-run] ' : ''}wrote ${written}, already-headered ${skipped}, git-crypt ${crypted}`
  )
}

main()
