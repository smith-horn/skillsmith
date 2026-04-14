#!/usr/bin/env node
// SMI-4191: count entries in root CHANGELOG.md [Unreleased] section.
// Used by .github/workflows/release-cadence.yml to decide whether to open a
// release PR mid-week (threshold fires ahead of the Sunday 03:00 UTC cron).
//
// "Entry" = any list item (line starting with `- ` or `* `) directly under
// [Unreleased] or its subsections (### Added / ### Fixed / etc). Nested list
// items (indented `- `) do NOT count — they're continuations of their parent.
//
// Exit codes:
//   0 — count < threshold  (under the trigger)
//   1 — count ≥ threshold  (cadence workflow should open a PR)
//   2 — no [Unreleased] section in file (no-op; same effect as 0)
//   3 — I/O error
//
// stdout: the count (integer) always, so workflows can log it.
//
// Env:
//   UNRELEASED_THRESHOLD — integer, default 15 (calibrated per ADR-114)

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_THRESHOLD = 15

/**
 * Count top-level list entries under the [Unreleased] section.
 * @param {string} content
 * @returns {number | null} count, or null if [Unreleased] header is absent
 */
export function countUnreleasedEntries(content) {
  const lines = content.split('\n')
  let inUnreleased = false
  let count = 0
  for (const line of lines) {
    if (/^##\s+\[?Unreleased\]?/i.test(line)) {
      inUnreleased = true
      continue
    }
    if (inUnreleased && /^##\s+(?!#)/.test(line)) {
      // Next version heading (## X.Y.Z or ## [...]) — stop.
      break
    }
    if (!inUnreleased) continue
    // Top-level bullet: line starts with `- ` or `* ` with no leading whitespace
    if (/^[-*]\s+/.test(line)) count++
  }
  return inUnreleased ? count : null
}

/**
 * Resolve threshold from env.
 * @returns {number}
 */
export function resolveThreshold() {
  const raw = process.env.UNRELEASED_THRESHOLD
  if (!raw) return DEFAULT_THRESHOLD
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n) || n < 1) return DEFAULT_THRESHOLD
  return n
}

function parseArgs(argv) {
  let file = 'CHANGELOG.md'
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') file = argv[++i] ?? file
  }
  return { file }
}

function main() {
  const { file } = parseArgs(process.argv.slice(2))
  const abs = join(process.cwd(), file)
  if (!existsSync(abs)) {
    process.stderr.write(`error: file not found: ${abs}\n`)
    process.exit(3)
  }
  const content = readFileSync(abs, 'utf-8')
  const count = countUnreleasedEntries(content)
  const threshold = resolveThreshold()

  if (count === null) {
    process.stdout.write('0\n')
    process.stderr.write(`no [Unreleased] section in ${file}; treating as 0 entries\n`)
    process.exit(2)
  }

  process.stdout.write(`${count}\n`)
  process.stderr.write(`[Unreleased] entries: ${count} / threshold: ${threshold}\n`)
  process.exit(count >= threshold ? 1 : 0)
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) main()
