/**
 * SMI-5432 W0.2 — shared fixtures for the retrieval-liveness-check.sh test suite.
 *
 * Extracted from retrieval-liveness-check.test.ts to keep the test file under the
 * 500-line gate without splitting test CASES across files (which would dodge the
 * gate). These are pure, reusable helpers — the test logic stays in the .test.ts.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { makeFixtureTempDir } from './git-fixture-env.js'

/** Create a SQLite fixture DB using the sqlite3 CLI (binding-independent). */
export function createFixtureDB(
  dbPath: string,
  opts: {
    retrievalTs?: string[]
    frontmatterTs?: string[]
    skipFrontmatterTable?: boolean
  } = {}
): void {
  mkdirSync(dirname(dbPath), { recursive: true })
  const stmts: string[] = [
    'CREATE TABLE IF NOT EXISTS retrieval_events (id TEXT PRIMARY KEY, ts TEXT NOT NULL, trigger TEXT, hook_outcome TEXT);',
  ]
  if (!opts.skipFrontmatterTable) {
    stmts.push(
      'CREATE TABLE IF NOT EXISTS frontmatter_lint_events (id TEXT PRIMARY KEY, ts TEXT NOT NULL);'
    )
  }
  for (const ts of opts.retrievalTs ?? []) {
    stmts.push(
      `INSERT INTO retrieval_events VALUES ('${ts}', '${ts}', 'session_start_priming', 'primed');`
    )
  }
  if (!opts.skipFrontmatterTable) {
    for (const ts of opts.frontmatterTs ?? []) {
      stmts.push(`INSERT INTO frontmatter_lint_events VALUES ('${ts}', '${ts}');`)
    }
  }
  execFileSync('sqlite3', [dbPath, stmts.join('\n')], { encoding: 'utf8' })
}

/** ISO timestamp N days ago (fresh = recent, stale = old). */
export function isoAgo(days: number): string {
  return new Date(Date.now() - days * 864e5).toISOString()
}

/**
 * Create a fake-gh script; returns its path and a capture file path.
 * `gh issue list` → the existing issue number (or nothing); `gh issue create`
 * → an issue URL (real `gh` prints the URL, NOT JSON — the script parses the
 * trailing number out of it).
 */
export function createGhScript(
  home: string,
  opts: { existingIssueNum?: number } = {}
): { scriptPath: string; captureFile: string } {
  const captureFile = join(home, 'gh-calls.log')
  const { existingIssueNum } = opts
  const listBranch =
    existingIssueNum != null ? `  list) printf '%d\\n' "${existingIssueNum}" ;;` : '  list) ;;'
  const script = [
    '#!/bin/bash',
    `printf '%s\\n' "cmd:$*" >> "${captureFile}"`,
    'case "$2" in',
    listBranch,
    `  create) printf 'https://github.com/o/r/issues/42\\n' ;;`,
    '  comment) ;;',
    'esac',
  ].join('\n')
  const scriptPath = join(home, 'fake-gh.sh')
  writeFileSync(scriptPath, script, { mode: 0o755 })
  return { scriptPath, captureFile }
}

/**
 * The resolver's "ambiguous" verdict requires two directories whose names differ
 * ONLY in case to coexist — physically impossible on a case-INSENSITIVE
 * filesystem (default macOS APFS), where they collapse into one entry. CI runs on
 * case-SENSITIVE Linux (ext4) inside Docker, so the ambiguous branch IS exercised
 * there. This is the OPPOSITE of a forbidden `skipIf(inDocker)`: it RUNS in
 * Docker/CI and skips only on a case-insensitive host where the scenario cannot
 * be constructed at all.
 */
function detectCaseSensitiveFs(): boolean {
  const d = makeFixtureTempDir('fs-case-probe')
  try {
    mkdirSync(join(d, 'AaA'))
    mkdirSync(join(d, 'aaa')) // throws EEXIST on a case-insensitive FS
    return true
  } catch {
    return false
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
}

export const CASE_SENSITIVE_FS = detectCaseSensitiveFs()
