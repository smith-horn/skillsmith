#!/usr/bin/env node
// SMI-4191: extract a single version's section from a CHANGELOG.md.
// Used by publish.yml's create-gh-release job and detect-release-drift.mjs
// to feed `gh release create --notes-file`.
//
// Accepts any of these header forms (observed across existing CHANGELOGs):
//   ## [X.Y.Z] - YYYY-MM-DD
//   ## [X.Y.Z]
//   ## X.Y.Z
//   ## vX.Y.Z
//   ## vX.Y.Z (YYYY-MM-DD)
//   ## [Unreleased]
//
// Section body is everything from the header line (exclusive) to the next
// `## ` header (exclusive). Leading/trailing blank lines are trimmed.
//
// Usage:
//   node scripts/extract-changelog-section.mjs --package packages/core --version 0.5.1
//   node scripts/extract-changelog-section.mjs --file path/to/CHANGELOG.md --version 0.5.1
//
// Exit codes:
//   0 — section printed to stdout
//   1 — I/O or arg error
//   2 — no released-version sections in file (caller should treat as "no baseline — skip")
//   3 — version not found in file

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** @typedef {{ version: string, lineIndex: number, headerLine: string }} SectionHeader */

/**
 * Parse a header line and return the version it represents, or null if not a version header.
 * @param {string} line
 * @returns {string | null}
 */
export function parseHeader(line) {
  // Match `## ` followed by any of the forms. Capture the version portion.
  const re = /^##\s+(?:\[([^\]]+)\]|v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?))(?:\s*[-(].*)?$/
  const m = line.match(re)
  if (!m) return null
  const raw = m[1] ?? m[2]
  return raw.trim()
}

/**
 * Find all version-section headers in the file.
 * @param {string} content
 * @returns {SectionHeader[]}
 */
export function listSections(content) {
  const lines = content.split('\n')
  /** @type {SectionHeader[]} */
  const sections = []
  for (let i = 0; i < lines.length; i++) {
    const version = parseHeader(lines[i])
    if (version) sections.push({ version, lineIndex: i, headerLine: lines[i] })
  }
  return sections
}

/**
 * Extract the body of the section for the given version.
 * Returns the section body (without the header line, blank-trimmed).
 * @param {string} content
 * @param {string} version
 * @returns {{ ok: true, body: string } | { ok: false, reason: 'not-found' | 'no-baseline' }}
 */
export function extractSection(content, version) {
  const sections = listSections(content)
  if (sections.length === 0) return { ok: false, reason: 'no-baseline' }
  const released = sections.filter((s) => s.version !== 'Unreleased')
  if (released.length === 0 && version !== 'Unreleased') return { ok: false, reason: 'no-baseline' }

  const idx = sections.findIndex((s) => s.version === version)
  if (idx === -1) return { ok: false, reason: 'not-found' }

  const lines = content.split('\n')
  const start = sections[idx].lineIndex + 1
  const end = idx + 1 < sections.length ? sections[idx + 1].lineIndex : lines.length
  const body = lines.slice(start, end).join('\n').trim()
  return { ok: true, body }
}

/**
 * Parse CLI args.
 * @param {string[]} argv
 * @returns {{ file: string, version: string } | { error: string }}
 */
function parseArgs(argv) {
  let packageDir = ''
  let file = ''
  let version = ''
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--package') packageDir = argv[++i] ?? ''
    else if (argv[i] === '--file') file = argv[++i] ?? ''
    else if (argv[i] === '--version') version = argv[++i] ?? ''
  }
  if (!version) return { error: 'missing --version' }
  if (!file && !packageDir) return { error: 'missing --package or --file' }
  if (!file) file = join(packageDir, 'CHANGELOG.md')
  return { file, version }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if ('error' in args) {
    process.stderr.write(`error: ${args.error}\n`)
    process.stderr.write('usage: extract-changelog-section.mjs --package <dir> --version <X.Y.Z>\n')
    process.stderr.write('   or: extract-changelog-section.mjs --file <path> --version <X.Y.Z>\n')
    process.exit(1)
  }

  if (!existsSync(args.file)) {
    process.stderr.write(`error: file not found: ${args.file}\n`)
    process.exit(1)
  }

  const content = readFileSync(args.file, 'utf-8')
  const result = extractSection(content, args.version)
  if (!result.ok) {
    if (result.reason === 'no-baseline') {
      process.stderr.write(
        `error: no released-version sections found in ${args.file} (only [Unreleased] or empty)\n`
      )
      process.exit(2)
    }
    process.stderr.write(`error: version ${args.version} not found in ${args.file}\n`)
    process.exit(3)
  }
  process.stdout.write(result.body + '\n')
}

// ESM "is main script" check
const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) main()
