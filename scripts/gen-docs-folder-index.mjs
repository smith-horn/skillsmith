#!/usr/bin/env node
// SMI-4932: regenerate the "Folder Reference" table in docs/internal/index.md.
//
// The table is one row per direct subdirectory of docs/internal/, columns
// `Folder | Files | Has Index`. It is hand-maintained and perpetually drifts
// (a doc PR adding a file anywhere under docs/internal/ silently staleness it).
// This script regenerates it from the filesystem so the drift class is closed.
//
// Counting rule (reverse-engineered from rows still correct as of 2026-05-18 —
// adr 50=50, architecture 39=39, archive 8=8, analysis 10=10, backups 0):
//   count = number of *.md files among a folder's DIRECT children
//           (non-recursive), INCLUDING index.md itself.
//   Has Index = ✓ iff <folder>/index.md exists.
//   Folder set = direct subdirectories of docs/internal/, no dot-dirs, sorted.
//
// Scope: ONLY the `## Folder Reference` block is regenerated. The ~7 curated
// aggregate tables (Quick Access / Engineering / etc.) are editorial subsets and
// are NOT touched — see docs/internal/implementation/smi-4932-folder-index-generator.md
// and SMI-4946.
//
// Anchor contract: the table is wrapped in a <details> block —
//   ## Folder Reference -> <details> -> <summary> -> blank -> header+separator
//   -> data rows -> blank -> </details>. spliceBlock anchors on the
//   `| Folder | Files | Has Index |` header + separator and replaces ONLY the
//   contiguous `| ... |` data rows. The <details>/<summary>/</details> tags and
//   the trailing `**Last updated**:` stamp are outside the region and untouched.
//   If the anchors are absent the script exits 1 — it never writes a malformed
//   file (fail-closed).
//
// Usage:
//   node scripts/gen-docs-folder-index.mjs            # --write (rewrite in place)
//   node scripts/gen-docs-folder-index.mjs --write
//   node scripts/gen-docs-folder-index.mjs --check    # exit 1 + diff if stale
//   node scripts/gen-docs-folder-index.mjs --root <path>   # default docs/internal
//   node scripts/gen-docs-folder-index.mjs --help
//
// Exit codes:
//   0 — success (--write done, or --check found the table fresh)
//   1 — --check found drift, or a fatal error (anchors absent, root missing)

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

const HEADER = '| Folder | Files | Has Index |'

/** Direct subdirectories of `root`, excluding dot-dirs, sorted alphabetically. */
export function listFolders(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
}

/** Count of `*.md` files among `dir`'s direct children (non-recursive). */
export function countMd(dir) {
  return readdirSync(dir, { withFileTypes: true }).filter(
    (e) => e.isFile() && e.name.endsWith('.md')
  ).length
}

/** True iff `<dir>/index.md` exists. */
export function hasIndex(dir) {
  return existsSync(join(dir, 'index.md'))
}

/** One markdown table row per folder under `root`, in folder order. */
export function buildRows(root) {
  return listFolders(root).map((name) => {
    const dir = join(root, name)
    return `| ${name} | ${countMd(dir)} | ${hasIndex(dir) ? '✓ ' : ''}|`
  })
}

/** Map a list of `| name | count | mark |` rows to { name: rowText }. */
function indexRows(rows) {
  const map = new Map()
  for (const r of rows) {
    const name = r.split('|')[1]?.trim()
    if (name) map.set(name, r)
  }
  return map
}

/** Human-readable per-folder diff between committed and expected rows. */
export function diffRows(committed, expected) {
  const before = indexRows(committed)
  const after = indexRows(expected)
  const lines = []
  for (const [name, row] of after) {
    if (!before.has(name)) lines.push(`  + ${row}   (new folder)`)
    else if (before.get(name) !== row) lines.push(`  - ${before.get(name)}\n  + ${row}`)
  }
  for (const [name, row] of before) {
    if (!after.has(name)) lines.push(`  - ${row}   (folder removed)`)
  }
  return lines
}

/** Folder Reference data rows currently committed in `text` (between anchors). */
function committedRows(text) {
  const lines = text.split('\n')
  const h = lines.findIndex((l) => l.trim() === HEADER)
  if (h === -1) return []
  let end = h + 2
  while (end < lines.length && lines[end].startsWith('|')) end++
  return lines.slice(h + 2, end)
}

/**
 * Replace the Folder Reference data rows in `text` with `rows`.
 * Anchors on the `| Folder | Files | Has Index |` header + separator line;
 * replaces the contiguous run of `| ... |` rows that follows. Throws if the
 * anchors are absent — never returns a malformed document.
 */
export function spliceBlock(text, rows) {
  const lines = text.split('\n')
  const h = lines.findIndex((l) => l.trim() === HEADER)
  if (h === -1) {
    throw new Error(`Anchor not found: "${HEADER}" header missing from index.md`)
  }
  const sep = lines[h + 1]
  if (!sep || !/^\s*\|[-\s|]+\|\s*$/.test(sep)) {
    throw new Error(`Anchor not found: separator row missing after the table header`)
  }
  let end = h + 2
  while (end < lines.length && lines[end].startsWith('|')) end++
  return [...lines.slice(0, h + 2), ...rows, ...lines.slice(end)].join('\n')
}

/** Read index.md, returns { path, text }. Exits 1 if root or file is absent. */
function loadIndex(root) {
  if (!existsSync(root)) {
    console.error(`✖ root not found: ${root}`)
    process.exit(1)
  }
  const path = join(root, 'index.md')
  if (!existsSync(path)) {
    console.error(`✖ index.md not found: ${path}`)
    process.exit(1)
  }
  return { path, text: readFileSync(path, 'utf8') }
}

function main(argv) {
  if (argv.includes('--help')) {
    console.log(
      [
        'gen-docs-folder-index.mjs — regenerate the Folder Reference table in index.md',
        '',
        'Usage:',
        '  node scripts/gen-docs-folder-index.mjs            rewrite in place (--write)',
        '  node scripts/gen-docs-folder-index.mjs --check    exit 1 + diff if stale',
        '  node scripts/gen-docs-folder-index.mjs --root <p> root dir (default docs/internal)',
        '  node scripts/gen-docs-folder-index.mjs --help     this message',
      ].join('\n')
    )
    return 0
  }
  const rootIdx = argv.indexOf('--root')
  if (rootIdx !== -1 && !argv[rootIdx + 1]) {
    console.error('✖ --root requires a path argument')
    return 1
  }
  const rootArg = rootIdx !== -1 ? argv[rootIdx + 1] : 'docs/internal'
  const root = join(REPO_ROOT, rootArg)
  const check = argv.includes('--check')

  const { path, text } = loadIndex(root)
  const rows = buildRows(root)
  const updated = spliceBlock(text, rows)

  if (check) {
    if (updated === text) {
      console.log('✓ Folder Reference table is up to date')
      return 0
    }
    console.error('✖ Folder Reference table is stale. Run: npm run docs:folder-index')
    for (const line of diffRows(committedRows(text), rows)) console.error(line)
    return 1
  }

  if (updated === text) {
    console.log('✓ Folder Reference table already up to date — no change')
    return 0
  }
  writeFileSync(path, updated)
  console.log(`✓ Regenerated Folder Reference table in ${path}`)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)))
}
