/**
 * Pre-commit file-length check (SMI-3493)
 *
 * Ensures staged .ts files do not exceed the 500-line CI limit.
 * Called by lint-staged with file paths as arguments.
 *
 * Usage: node scripts/check-file-length.mjs <file1> [file2] ...
 * Exit 0 = all files OK, Exit 1 = one or more files exceed limit.
 *
 * Grandfather ignore-list (SMI-4397): six pre-existing over-limit
 * git-crypt edge-function files cannot be committed without --no-verify.
 * `scripts/check-file-length.ignore` lists repo-relative paths whose
 * hard-fail is suppressed WHILE they remain over-limit. lint-staged v16
 * passes absolute paths, so both sides are normalized to repo-relative
 * before matching. A grandfathered file split below the limit re-enters
 * enforcement and prints an "eligible to de-list" notice.
 */

import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_LINES = 500

/**
 * Resolve a path to its canonical, symlink-free absolute form.
 * Both the repo root and each staged file are canonicalized so a
 * symlinked path component (e.g. macOS `/tmp` → `/private/tmp`, or a
 * worktree's symlinked node_modules) cannot make `path.relative` emit a
 * spurious `../../` prefix that would defeat ignore-list matching.
 * Falls back to a plain `resolve` when the path does not yet exist.
 *
 * @param {string} p - a path to canonicalize
 * @returns {string} canonical absolute path
 */
function canonicalize(p) {
  const abs = resolve(p)
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

/** Canonical absolute path to the repo root (this script lives in scripts/). */
export function getRepoRoot() {
  return canonicalize(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
}

/**
 * Parse the ignore-list file contents into a Set of trimmed,
 * repo-relative paths. Comment (`#`) and blank lines are skipped;
 * trailing whitespace and CRLF line endings are tolerated.
 *
 * @param {string} contents - raw ignore-file text
 * @returns {Set<string>} repo-relative paths to grandfather
 */
export function parseIgnoreList(contents) {
  const entries = new Set()
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim()
    if (line.length === 0 || line.startsWith('#')) {
      continue
    }
    entries.add(line)
  }
  return entries
}

/**
 * Load and parse the sibling check-file-length.ignore file.
 * Returns an empty Set if the file is absent (graceful default).
 *
 * @param {string} ignorePath - absolute path to the ignore file
 * @returns {Set<string>} grandfathered repo-relative paths
 */
export function loadIgnoreList(ignorePath) {
  try {
    return parseIgnoreList(readFileSync(ignorePath, 'utf8'))
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return new Set()
    }
    throw err
  }
}

/**
 * Evaluate staged files against the line limit and ignore-list.
 *
 * lint-staged v16 passes absolute paths; the ignore-list stores
 * repo-relative paths — both are normalized to repo-relative before
 * an exact comparison (SMI-4397 C1). A grandfathered path is only
 * exempt WHILE still over-limit (SMI-4397 H1).
 *
 * @param {string[]} files - staged file paths (absolute or relative)
 * @param {Set<string>} ignoreList - grandfathered repo-relative paths
 * @param {string} repoRoot - absolute repo root
 * @returns {{violations: {relPath: string, lineCount: number}[],
 *            skipped: {relPath: string, lineCount: number}[],
 *            delistable: {relPath: string, lineCount: number}[]}}
 */
export function checkFiles(files, ignoreList, repoRoot) {
  const violations = []
  const skipped = []
  const delistable = []
  // Canonicalize the root too so both sides of `relative` share a
  // symlink-free base (the caller may pass an un-canonicalized path).
  const canonicalRoot = canonicalize(repoRoot)

  for (const filePath of files) {
    // lint-staged v16 passes absolute paths; older invocations may pass
    // CWD-relative ones. Canonicalize before computing the repo-relative
    // form so symlinked path components cannot defeat ignore matching.
    const relPath = relative(canonicalRoot, canonicalize(filePath))
    const content = readFileSync(filePath, 'utf8')
    const lineCount = content.split('\n').length
    const grandfathered = ignoreList.has(relPath)

    if (lineCount > MAX_LINES) {
      if (grandfathered) {
        skipped.push({ relPath, lineCount })
      } else {
        violations.push({ relPath, lineCount })
      }
    } else if (grandfathered) {
      // Shrunk below the limit — exemption is now stale.
      delistable.push({ relPath, lineCount })
    }
  }

  return { violations, skipped, delistable }
}

/** CLI entrypoint — only runs when invoked directly, not on import. */
function main() {
  const files = process.argv.slice(2)
  if (files.length === 0) {
    process.exit(0)
  }

  const repoRoot = getRepoRoot()
  const ignoreList = loadIgnoreList(join(repoRoot, 'scripts', 'check-file-length.ignore'))
  const { violations, skipped, delistable } = checkFiles(files, ignoreList, repoRoot)

  for (const { relPath } of skipped) {
    console.log(`  ${relPath}: skipped (grandfathered — SMI-4948 split pending)`)
  }

  for (const { relPath, lineCount } of delistable) {
    console.log(
      `  ${relPath}: ${lineCount} lines — now under ${MAX_LINES}, eligible to de-list from scripts/check-file-length.ignore`
    )
  }

  if (violations.length > 0) {
    console.error(`\nFile length check failed (max ${MAX_LINES} lines):\n`)
    for (const { relPath, lineCount } of violations) {
      console.error(`  ${relPath}: ${lineCount} lines`)
    }
    console.error(
      '\nSplit large files before committing. See CI Health Requirements in CLAUDE.md.\n'
    )
    process.exit(1)
  }

  process.exit(0)
}

// Canonicalize both sides so a symlinked invocation path (e.g. macOS
// `/tmp` → `/private/tmp`) still recognizes a direct run.
const invokedDirectly =
  canonicalize(fileURLToPath(import.meta.url)) === canonicalize(process.argv[1] ?? '')
if (invokedDirectly) {
  main()
}
