/**
 * Pre-commit file-length check (SMI-3493)
 *
 * Ensures staged .ts files do not exceed the 500-line CI limit.
 * Called by lint-staged with file paths as arguments.
 *
 * Usage: node scripts/check-file-length.mjs <file1> [file2] ...
 * Exit 0 = all files OK, Exit 1 = one or more files exceed limit.
 */

import { readFileSync } from 'node:fs'

const MAX_LINES = 500
const files = process.argv.slice(2)

if (files.length === 0) {
  process.exit(0)
}

const violations = []

for (const filePath of files) {
  const content = readFileSync(filePath, 'utf8')
  const lineCount = content.split('\n').length
  if (lineCount > MAX_LINES) {
    violations.push({ filePath, lineCount })
  }
}

if (violations.length > 0) {
  console.error(`\nFile length check failed (max ${MAX_LINES} lines):\n`)
  for (const { filePath, lineCount } of violations) {
    console.error(`  ${filePath}: ${lineCount} lines`)
  }
  console.error('\nSplit large files before committing. See CI Health Requirements in CLAUDE.md.\n')
  process.exit(1)
}
