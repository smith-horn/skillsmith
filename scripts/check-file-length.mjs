/**
 * Pre-commit file-length check (SMI-3493)
 *
 * Checks whatever staged file paths lint-staged passes it — currently
 * .ts and .sh per lint-staged.config.js (SMI-5658 widened this from
 * .ts-only) — against the 500-line CI limit. The script itself has no
 * extension filter; the routing is entirely lint-staged.config.js's glob.
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
 *
 * SMI-5992: MAX_LINES and the test-file exemption predicate
 * (isExemptFromLengthCheck) are shared with CI's Check 3 in
 * scripts/audit-standards.mjs via scripts/file-length-policy.mjs. Only
 * the threshold + exemption predicate are shared — this script's own
 * directory scope (whatever's staged, not just packages/+apps/), its
 * extensions (.ts + .sh), and its severity (hard-fail, vs. Check 3's
 * warn-only) remain intentionally different. See SMI-5994 for the
 * still-tracked scope/severity divergence.
 */

import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_LINES, isExemptFromLengthCheck } from './file-length-policy.mjs'

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

/** Matches the `# SMI-XXXX split follow-up` comment convention (SMI-4397). */
const SMI_FOLLOW_UP_RE = /^#\s*(SMI-\d+)\s+split follow-up/

/**
 * Parse the ignore-list file contents into a Map of trimmed,
 * repo-relative paths to the SMI issue reference named by the
 * `# SMI-XXXX split follow-up` comment immediately preceding that path
 * (or `null` if no such comment directly precedes it — e.g. a stale entry
 * added without following the convention). Comment (`#`) and blank lines
 * are otherwise skipped; trailing whitespace and CRLF line endings are
 * tolerated.
 *
 * @param {string} contents - raw ignore-file text
 * @returns {Map<string, string|null>} repo-relative path -> SMI reference (or null)
 */
export function parseIgnoreList(contents) {
  const entries = new Map()
  let pendingSmiRef = null
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim()
    if (line.length === 0) {
      continue
    }
    if (line.startsWith('#')) {
      const match = line.match(SMI_FOLLOW_UP_RE)
      pendingSmiRef = match ? match[1] : null
      continue
    }
    entries.set(line, pendingSmiRef)
    pendingSmiRef = null
  }
  return entries
}

/**
 * Load and parse the sibling check-file-length.ignore file.
 * Returns an empty Map if the file is absent (graceful default).
 *
 * @param {string} ignorePath - absolute path to the ignore file
 * @returns {Map<string, string|null>} grandfathered repo-relative paths -> SMI reference
 */
export function loadIgnoreList(ignorePath) {
  try {
    return parseIgnoreList(readFileSync(ignorePath, 'utf8'))
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return new Map()
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
 * SMI-5992: a `.test.`/`.spec.` file over the limit is also reported via
 * `skipped` (shared `isExemptFromLengthCheck` predicate, same as CI's
 * Check 3) rather than silently passing with no output.
 *
 * @param {string[]} files - staged file paths (absolute or relative)
 * @param {Map<string, string|null>} ignoreList - grandfathered repo-relative paths -> SMI reference
 * @param {string} repoRoot - absolute repo root
 * @returns {{violations: {relPath: string, lineCount: number}[],
 *            skipped: {relPath: string, lineCount: number, smiRef: string|null, reason: string}[],
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
    // SMI-5992: shared with CI's Check 3 — see scripts/file-length-policy.mjs.
    const testExempt = isExemptFromLengthCheck(relPath)

    if (lineCount > MAX_LINES) {
      if (testExempt) {
        // Test-file exemption takes precedence over (and makes redundant
        // any pre-existing) grandfather-list entry for the same path.
        skipped.push({
          relPath,
          lineCount,
          smiRef: null,
          reason:
            'test file (.test./.spec.) — exempt per scripts/file-length-policy.mjs (SMI-5992)',
        })
      } else if (grandfathered) {
        const smiRef = ignoreList.get(relPath) ?? null
        skipped.push({
          relPath,
          lineCount,
          smiRef,
          reason: smiRef
            ? `grandfathered — ${smiRef} split pending`
            : 'grandfathered — see scripts/check-file-length.ignore for the tracking issue',
        })
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

  // SMI-5992: `reason` is computed in checkFiles() itself (test-file
  // exemption or grandfather-list, each with its own message) — main()
  // just prints it, so the two skip reasons stay in one place.
  for (const { relPath, reason } of skipped) {
    console.log(`  ${relPath}: skipped (${reason})`)
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
